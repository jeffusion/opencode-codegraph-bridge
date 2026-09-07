import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REQUEST_TIMEOUT_MS = 5_000

function tail(current, chunk) {
  return `${current}${chunk}`.slice(-16 * 1024)
}

async function fileHash(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function directorySnapshot(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      hash: entry.isDirectory() ? null : await fileHash(join(path, entry.name)),
    })))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function waitForMcp(port, root, server) {
  const url = `http://127.0.0.1:${port}/mcp?directory=${encodeURIComponent(root)}`
  const deadline = Date.now() + 60_000
  let lastError = ""
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (response.status === 401) throw new Error("OpenCode server 返回 401；隔离测试不应继承 server auth")
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
    } catch (error) {
      if (error.message?.includes("401")) throw error
      lastError = error.message
    }
    if (server.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`OpenCode /mcp 未就绪：${lastError}；stderr：${server.stderr}`)
}

async function stopServer(server) {
  let leaderClosedFlag = false
  const killTree = (signal) => {
    try {
      process.kill(process.platform === "win32" ? server.process.pid : -server.process.pid, signal)
    } catch {
      // Process may have exited between polling and termination.
    }
  }
  const leaderClosed = new Promise((resolve) => {
    if (server.process.exitCode !== null || server.process.signalCode !== null) {
      leaderClosedFlag = true
      resolve()
      return
    }
    server.process.once("close", () => {
      leaderClosedFlag = true
      resolve()
    })
  })
  const groupAlive = () => {
    if (process.platform === "win32") return server.process.exitCode === null && server.process.signalCode === null
    try {
      process.kill(-server.process.pid, 0)
      return true
    } catch (error) {
      return error?.code === "EPERM"
    }
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitForGroupGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (groupAlive() && Date.now() < deadline) await wait(100)
    return !groupAlive()
  }

  killTree("SIGTERM")
  await Promise.race([leaderClosed, wait(5_000)])
  if (groupAlive()) killTree("SIGKILL")
  await Promise.race([leaderClosed, wait(5_000)])
  if (!(await waitForGroupGone(5_000))) throw new Error("OpenCode 自有进程组在终止宽限后仍存活")
  if (!leaderClosedFlag) {
    await Promise.race([leaderClosed, wait(5_000)])
    if (!leaderClosedFlag) throw new Error("OpenCode 自有主进程未发送 close")
  }
}

async function main() {
  const probe = spawnSync(process.env.OPENCODE_BIN || "opencode", ["--version"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) {
    console.log(`SKIP: opencode 不可用${probe.error ? `（${probe.error.message}）` : `（退出码 ${probe.status}）`}`)
    return
  }

  const root = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-smoke-"))
  let server
  let hooksSnapshot
  let globalAgentsHash
  try {
    execFileSync("git", ["init", "--quiet", root])
    await writeFile(join(root, "smoke.js"), "export function OpenCodeCodeGraphSmoke() { return 'smoke' }\n")
    hooksSnapshot = await directorySnapshot(join(root, ".git", "hooks"))
    globalAgentsHash = await fileHash(join(homedir(), ".config", "opencode", "AGENTS.md"))
    const configPath = join(root, "isolated-opencode.json")
    const pluginUrl = pathToFileURL(join(sourceRoot, "src", "index.js")).href
    await writeFile(configPath, `${JSON.stringify({ plugin: [pluginUrl] }, null, 2)}\n`)
    const config = JSON.parse(await readFile(configPath, "utf8"))
    assert.deepEqual(config, { plugin: [pluginUrl] })
    assert.equal(config.mcp, undefined, "smoke 配置不得静态声明 MCP")

    const port = 41000 + (process.pid % 1000)
    const environment = {
      ...process.env,
      OPENCODE_TEST_HOME: join(root, "test-home"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed-config"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      // This is an isolated process group; it must not use the caller's daemon.
      CODEGRAPH_NO_DOWNLOAD: "1",
      CODEGRAPH_NO_DAEMON: "1",
    }
    for (const key of Object.keys(environment).filter((key) => key.startsWith("OPENCODE_CONFIG"))) {
      delete environment[key]
    }
    delete environment.OPENCODE_SERVER_PASSWORD
    delete environment.OPENCODE_SERVER_USERNAME
    environment.OPENCODE_CONFIG = configPath
    const child = spawn(process.env.OPENCODE_BIN || "opencode", [
      "serve", "--hostname", "127.0.0.1", "--port", String(port),
    ], {
      cwd: root,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    server = { process: child, stderr: "", exitCode: null }
    child.stdout.on("data", () => {})
    child.stderr.on("data", (chunk) => { server.stderr = tail(server.stderr, chunk) })
    child.once("exit", (code) => { server.exitCode = code })

    const status = await waitForMcp(port, root, server)
    assert.equal(status.codegraph?.status, "connected", `CodeGraph 未连接：${JSON.stringify(status)}`)
    assert.equal(Object.keys(status).filter((name) => name === "codegraph").length, 1)
    const effectiveResponse = await fetch(`http://127.0.0.1:${port}/config?directory=${encodeURIComponent(root)}`)
    if (effectiveResponse.status === 401) throw new Error("OpenCode server 返回 401；未成功隔离 server auth")
    assert.equal(effectiveResponse.ok, true, `OpenCode /config 失败：HTTP ${effectiveResponse.status}`)
    const effective = await effectiveResponse.json()
    assert.deepEqual(effective.plugin, [pluginUrl], "effective config 必须只包含本测试 file URL 插件")
    assert.deepEqual(Object.keys(effective.mcp || {}), ["codegraph"], "effective config 的 MCP 必须只有动态 CodeGraph")
    console.log("OpenCode smoke passed: isolated file-URL plugin dynamically connected CodeGraph MCP")
  } finally {
    try {
      if (server) await stopServer(server)
    } finally {
      try {
        if (hooksSnapshot) assert.deepEqual(await directorySnapshot(join(root, ".git", "hooks")), hooksSnapshot, "插件不得修改 Git hooks")
        if (globalAgentsHash !== undefined) assert.equal(await fileHash(join(homedir(), ".config", "opencode", "AGENTS.md")), globalAgentsHash, "插件不得修改全局 AGENTS.md")
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
