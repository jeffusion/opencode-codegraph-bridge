import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { inspectCodexUpdateTarget } from "./codex-plugin.js"
import { compareVersions, snapshot, stableVersion, withConfigLock, writeExisting, writeNew } from "./config-file.js"

const pkg = createRequire(import.meta.url)("../package.json")
const REGISTRY_URL = `https://registry.npmjs.org/${pkg.name}/latest`
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Abort waits for the owned child to close before callers clean its files/locks. */
export function runUpdateCommand(binary, args, env, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const child = spawn(binary, args, { env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let error
    let timer
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024) })
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16 * 1024) })
    const killTree = (force) => {
      if (!child.pid) return
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { shell: false, stdio: "ignore" })
        killer.once("error", () => child.kill(force ? "SIGKILL" : "SIGTERM"))
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM") } catch (failure) { if (failure.code !== "ESRCH") error ||= failure }
      }
    }
    const abort = () => {
      error = signal.reason || new Error("Codex auto-update cancelled")
      killTree(false)
      timer = setTimeout(() => killTree(true), 2_000)
    }
    signal.addEventListener("abort", abort, { once: true })
    child.once("error", (failure) => { error = failure })
    child.once("close", (code) => {
      if (signal.aborted) killTree(true)
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      if (error) reject(error)
      else if (code !== 0) reject(new Error(`${binary} failed: ${stderr.trim()}`))
      else resolve(stdout.trim())
    })
    if (signal.aborted) abort()
  })
}

async function latestVersion(fetchImpl, signal) {
  const response = await fetchImpl(REGISTRY_URL, { signal, redirect: "error" })
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
  const reader = response.body.getReader()
  let size = 0
  const chunks = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 64 * 1024) throw new Error("npm registry response is too large")
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (metadata.name !== pkg.name || !stableVersion(metadata.version)) throw new Error("npm registry did not return a stable bridge version")
  return metadata.version
}

function abortable(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** Background startup check; only native, owned, enabled installations can update. */
export async function runCodexAutoUpdate(options = {}) {
  const env = options.env || process.env
  if (env.CODEGRAPH_BRIDGE_AUTO_UPDATE === "0") return false
  const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(options.timeoutMs || 180_000)])
  const invoke = options.command || ((binary, args, environment) => runUpdateCommand(binary, args, environment, signal))
  const inspect = () => inspectCodexUpdateTarget({ env, command: invoke, codex: options.codex || "codex", expectedVersion: pkg.version })
  const log = (message) => { try { options.log?.(message) } catch { /* Logging must not break MCP. */ } }
  let temporary
  try {
    const recent = await snapshot(join(env.CODEX_HOME || join(homedir(), ".codex"), "codegraph-bridge", "auto-update.json"))
    if (recent) {
      const checked = JSON.parse(recent.content)
      const now = (options.now || Date.now)()
      if (checked.version === pkg.version && Number.isFinite(checked.checkedAt) && checked.checkedAt <= now && now - checked.checkedAt < CHECK_INTERVAL_MS) return false
    }
    const target = await inspect()
    if (!target || signal.aborted) return false
    const directory = dirname(target.store)
    const cachePath = join(directory, "auto-update.json")
    return await withConfigLock(directory, async () => {
      const cache = await snapshot(cachePath)
      if (!cache) {
        try { await lstat(cachePath); return false } catch (error) { if (error.code !== "ENOENT") return false }
      }
      const checked = cache ? JSON.parse(cache.content) : null
      const now = (options.now || Date.now)()
      if (checked && (!Number.isFinite(checked.checkedAt) || typeof checked.version !== "string")) return false
      if (checked?.version === pkg.version && checked.checkedAt <= now && now - checked.checkedAt < CHECK_INTERVAL_MS) return false
      signal.throwIfAborted()
      const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(options.checkTimeoutMs || 5_000)])
      const version = await abortable(latestVersion(options.fetch || globalThis.fetch, checkSignal), checkSignal)
      signal.throwIfAborted()
      const state = `${JSON.stringify({ checkedAt: now, version: pkg.version })}\n`
      const remember = () => cache ? writeExisting(cachePath, cache, state) : writeNew(cachePath, state)
      if (compareVersions(version, pkg.version) <= 0) { await remember(); return false }
      const live = await inspect()
      if (!live || live.config.content !== target.config.content) return false
      temporary = await mkdtemp(join(tmpdir(), "codegraph-codex-update-"))
      const candidate = options.prepare
        ? await options.prepare(version, temporary, signal)
        : await (async () => {
          await invoke("npm", ["install", "--prefix", temporary, "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `${pkg.name}@${version}`], env)
          return join(temporary, "node_modules", pkg.name)
        })()
      signal.throwIfAborted()
      const metadata = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))
      if (metadata.name !== pkg.name || metadata.version !== version) throw new Error("Downloaded bridge identity mismatch")
      const { installCodex } = await import(pathToFileURL(join(candidate, "src", "codex-plugin.js")).href)
      const result = await installCodex({ env, codex: options.codex || "codex", command: invoke,
        recoveryCommand: options.command || ((binary, args, environment) => runUpdateCommand(binary, args, environment, AbortSignal.timeout(5_000))),
        expectedVersion: pkg.version, expectedConfig: target.config, expectedInventory: target.inventory })
      if (result.changed) {
        await remember()
        log(`CodeGraph Bridge updated to ${version}; restart Codex to use it. Changed hooks may require review in /hooks.`)
      }
      return result.changed === true
    })
  } catch (error) {
    if (!signal.aborted) log(`CodeGraph Bridge auto-update skipped: ${error.message}`)
    return false
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch((error) => log(`Codex update cleanup failed: ${error.message}`))
  }
}
