import { createRequire } from "node:module"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { updatePluginVersion } from "./update.js"

const require = createRequire(import.meta.url)
const LOCK_NAME = ".opencode-codegraph-auto.init.lock"
const MAX_OUTPUT = 16 * 1024
const STATUS_TIMEOUT_MS = 20_000
const WORKER_TIMEOUT_MS = 10 * 60_000
const CHILD_KILL_GRACE_MS = 3_000

/** @typedef {{ enabled?: boolean }} CodeGraphBridgeOptions */
/** @typedef {{ nodePath: string, cliPath: string, workerPath: string, launcherPath: string }} Runtime */

/**
 * Resolve only files from this plugin's own dependency tree. In particular,
 * this deliberately does not use process.execPath: OpenCode may be running in
 * Bun, while CodeGraph's bundled Node is required for node:sqlite/WASM.
 *
 * @returns {Runtime}
 */
export function resolveRuntime() {
  const packageJson = require.resolve("@colbymchenry/codegraph/package.json")
  const packageRequire = createRequire(packageJson)
  const platformPackage = `@colbymchenry/codegraph-${process.platform}-${process.arch}`
  const nodeName = process.platform === "win32" ? "node.exe" : "node"
  return {
    nodePath: realpathSync(packageRequire.resolve(`${platformPackage}/${nodeName}`)),
    cliPath: realpathSync(packageRequire.resolve(`${platformPackage}/lib/dist/bin/codegraph.js`)),
    workerPath: realpathSync(join(dirname(fileURLToPath(import.meta.url)), "worker.js")),
    launcherPath: realpathSync(join(dirname(fileURLToPath(import.meta.url)), "mcp-launcher.js")),
  }
}

/** @param {string} value */
function normalizeRealpath(value) {
  try {
    return realpathSync(resolve(value))
  } catch {
    return null
  }
}

/**
 * OpenCode supplies project roots already, so this intentionally does not walk
 * ancestors or scan a workspace. A root without .git is not indexed.
 *
 * @param {string | undefined | null} directory
 * @param {string | undefined | null} worktree
 * @returns {{ root: string } | { root: null, reason: string }}
 */
export function normalizeProjectRoot(directory, worktree) {
  const candidate = typeof worktree === "string" && worktree ? worktree : directory
  if (typeof candidate !== "string" || !candidate) {
    return { root: null, reason: "OpenCode 未提供项目目录" }
  }
  const root = normalizeRealpath(candidate)
  if (!root || !statIsDirectory(root)) {
    return { root: null, reason: "项目目录不存在或不可读" }
  }
  const unsafe = unsafeRootReason(root)
  if (unsafe) return { root: null, reason: `项目根目录过宽（${unsafe}）` }
  if (!isGitRoot(root)) {
    return { root: null, reason: "项目根目录不是 Git 根或 worktree（缺少 .git）" }
  }
  return { root }
}

/** @param {string} value */
function statIsDirectory(value) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} root */
function isGitRoot(root) {
  try {
    const git = lstatSync(join(root, ".git"))
    return git.isDirectory() || git.isFile()
  } catch {
    return false
  }
}

/** @param {string} root */
function unsafeRootReason(root) {
  const filesystemRoot = parse(root).root
  if (root === filesystemRoot) return "文件系统根目录"
  const home = normalizeRealpath(homedir()) || resolve(homedir())
  const same = process.platform === "win32" || process.platform === "darwin"
    ? (value) => value.toLowerCase()
    : (value) => value
  const r = same(root)
  const h = same(home)
  if (r === h) return "用户 home 目录"
  if (h.startsWith(`${r}${sep}`)) return "用户 home 的祖先目录"
  return null
}

/** @param {string} root */
export function codeGraphDataDir(root) {
  const raw = process.env.CODEGRAPH_DIR?.trim()
  const valid = raw && raw !== "." && !raw.includes("..") && !raw.includes("/") &&
    !raw.includes("\\") && !parse(raw).root
  return join(root, valid ? raw : ".codegraph")
}

/**
 * Check links before every status call. `status` opens the database and may
 * maintain it, so a symlink must be rejected before the CLI gets a chance to
 * follow it outside the project.
 * @param {string} root
 */
export function inspectCodeGraphData(root) {
  const dataDir = codeGraphDataDir(root)
  const dbPath = join(dataDir, "codegraph.db")
  try {
    let dirStat
    try {
      dirStat = lstatSync(dataDir)
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, dataDir, dbPath }
      throw error
    }
    if (dirStat.isSymbolicLink()) return { ok: false, reason: `${dataDir} 是符号链接，拒绝访问` }
    if (!dirStat.isDirectory()) return { ok: false, reason: `${dataDir} 不是目录` }
    const realDir = realpathSync(dataDir)
    let dbStat
    try {
      dbStat = lstatSync(dbPath)
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, dataDir, dbPath }
      throw error
    }
    if (dbStat.isSymbolicLink()) return { ok: false, reason: `${dbPath} 是符号链接，拒绝访问` }
    if (!dbStat.isFile()) return { ok: false, reason: `${dbPath} 不是数据库文件` }
    const realDb = realpathSync(dbPath)
    if (dirname(realDb) !== realDir) return { ok: false, reason: `${dbPath} 真实路径越出 CodeGraph 数据目录` }
    return { ok: true, dataDir, dbPath }
  } catch (error) {
    return { ok: false, reason: `${dataDir} 无法安全检查：${error.message}` }
  }
}

/**
 * @param {unknown} status
 * @param {string | undefined} [expectedRoot]
 * @param {boolean} [workerSucceeded]
 */
export function isReadyStatus(status, expectedRoot, workerSucceeded = true) {
  const rootMatches = !expectedRoot || (
    typeof status?.projectPath === "string" &&
    normalizeRealpath(status.projectPath) === normalizeRealpath(expectedRoot)
  )
  return workerSucceeded && !!status && rootMatches && status.initialized === true &&
    typeof status.projectPath === "string" &&
    status.index?.state === "complete" &&
    typeof status.lastIndexed === "string" && status.lastIndexed.length > 0 &&
    status.index?.pendingRefs === 0 && Number(status.fileCount) > 0
}

/**
 * The status command is the source of truth. Its output is capped because a
 * broken executable must never be able to fill OpenCode's memory/logs.
 *
 * @param {Runtime} runtime
 * @param {string} root
 * @param {number} [timeoutMs]
 */
export function readStatus(runtime, root, timeoutMs = STATUS_TIMEOUT_MS) {
  const safety = inspectCodeGraphData(root)
  if (!safety.ok) return Promise.resolve({ status: null, ok: false, diagnostic: safety.reason })
  return runChild(runtime.nodePath, ["--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.cliPath, "status", root, "--json"], {
    cwd: root,
    env: childEnv(),
    timeoutMs,
  }).then((result) => {
    const status = parseJsonOutput(result.stdout)
    return {
      status,
      ok: result.code === 0 && !result.error && !!status,
      diagnostic: result.stderr || result.stdout || (result.error ? result.error.message : "status 命令退出异常"),
    }
  })
}

/** @param {string} stdout */
export function parseJsonOutput(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === "object") return value
    } catch {
      // A diagnostic line is not the JSON status payload.
    }
  }
  return null
}

/** @param {Runtime} runtime @param {string} root @param {number} [hostPid] */
export function workerCommand(runtime, root, hostPid = process.pid) {
  return {
    command: runtime.nodePath,
    args: ["--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.workerPath, root, String(hostPid)],
  }
}

/** @param {Runtime} runtime */
export function mcpConfig(runtime) {
  return {
    type: "local",
    command: [runtime.nodePath, "--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.launcherPath],
    environment: { CODEGRAPH_NO_DOWNLOAD: "1" },
    enabled: true,
  }
}

/** @param {any} config @param {Runtime} runtime */
export function registerMcp(config, runtime) {
  config.mcp ??= {}
  if (Object.prototype.hasOwnProperty.call(config.mcp, "codegraph")) return false
  config.mcp.codegraph = mcpConfig(runtime)
  return true
}

/** @param {string} dataDir @param {string} root */
export function acquireInitLock(dataDir, root) {
  const lockPath = join(dataDir, LOCK_NAME)
  try {
    mkdirSync(dataDir, { recursive: true })
    if (existsSync(dataDir) && lstatSync(dataDir).isSymbolicLink()) return { lockPath, kind: "unsafe" }
    mkdirSync(lockPath)
  } catch (error) {
    if (error?.code !== "EEXIST") return { lockPath, kind: "error", error }
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"))
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { lockPath, kind: "incomplete" }
      try {
        process.kill(owner.pid, 0)
        return { lockPath, kind: "busy", pid: owner.pid }
      } catch {
        return { lockPath, kind: "dead", pid: owner.pid }
      }
    } catch {
      return { lockPath, kind: "incomplete" }
    }
  }
  try {
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, root, startedAt: new Date().toISOString() }), "utf8")
    return { lockPath, kind: "acquired" }
  } catch (error) {
    return { lockPath, kind: "incomplete", error }
  }
}

/** @param {string} lockPath */
export function releaseInitLock(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"))
    if (owner.pid === process.pid) rmSync(lockPath, { recursive: true, force: true })
  } catch {
    // A damaged lock is deliberately left for manual inspection.
  }
}

/** @returns {Record<string, string>} */
function childEnv() {
  return { ...process.env, CODEGRAPH_NO_DOWNLOAD: "1" }
}

/** @param {string} command @param {string[]} args @param {{cwd: string, env: Record<string, string | undefined>, timeoutMs: number}} options */
function runChild(command, args, options) {
  return new Promise((resolveResult) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer
    let graceTimer
    let timeoutError = null
    const appendTail = (current, text) => `${current}${text}`.slice(-MAX_OUTPUT)
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      resolveResult({ ...result, stdout, stderr })
    }
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      finish({ code: null, error })
      return
    }
    const collect = (stream, name) => stream.on("data", (chunk) => {
      const text = chunk.toString()
      if (name === "stdout") stdout = appendTail(stdout, text)
      else stderr = appendTail(stderr, text)
    })
    collect(child.stdout, "stdout")
    collect(child.stderr, "stderr")
    child.once("error", (error) => finish({ code: null, error }))
    child.once("close", (code, signal) => finish({ code, signal, error: timeoutError }))
    timer = setTimeout(() => {
      timeoutError = new Error(`子进程超时（${options.timeoutMs}ms）`)
      child.kill("SIGTERM")
      graceTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, CHILD_KILL_GRACE_MS)
    }, options.timeoutMs)
  })
}

/** @param {string} message */
function fallbackLog(message) {
  console.error(`[opencode-codegraph-bridge] ${message}`)
}

/** @param {any} input @param {string} message */
function log(input, message) {
  const appLog = input?.client?.app?.log
  if (typeof appLog === "function") {
    Promise.resolve(appLog.call(input.client.app, {
      body: { service: "opencode-codegraph-bridge", level: "info", message },
    })).catch(() => fallbackLog(message))
    return
  }
  fallbackLog(message)
}

/**
 * @param {CodeGraphBridgeOptions} [options]
 * @param {{ resolveRuntime?: typeof resolveRuntime, updatePluginVersion?: typeof updatePluginVersion }} [dependencies]
 * @returns {import("@opencode-ai/plugin").Plugin}
 */
export function createCodeGraphPlugin(options = {}, dependencies = {}) {
  const enabled = options.enabled !== false
  const resolveRuntimeFn = dependencies.resolveRuntime || resolveRuntime
  const updatePluginVersionFn = dependencies.updatePluginVersion || updatePluginVersion

  return /** @type {import("@opencode-ai/plugin").Plugin} */ (async (input) => {
    let runtime = null
    let managed = enabled
    let configCompleted = false
    let injectedMcp = null
    let updateNotified = false

    const notifyUpdate = async () => {
      if (updateNotified) return
      updateNotified = true
      try {
        await input.client?.tui?.showToast?.({
          body: {
            title: "CodeGraph Bridge",
            message: "Update ready. Restart OpenCode to apply.",
            variant: "info",
            duration: 5000,
          },
        })
      } catch {
        // Notification failure must not turn a completed update into a failure.
      }
    }

    if (managed) {
      try {
        runtime = resolveRuntimeFn()
      } catch (error) {
        managed = false
        log(input, `CodeGraph 依赖不可用，已跳过注册和索引：${error?.message || String(error)}`)
      }
    }

    /** @param {any} config */
    const config = (config) => {
      if (enabled) {
        void Promise.resolve().then(() => updatePluginVersionFn(config, {
          onSuccess: (version) => {
            log(input, `opencode-codegraph-bridge updated to ${version}; restart required.`)
            void notifyUpdate()
          },
        })).catch((error) => log(input, `opencode-codegraph-bridge 版本检查已跳过：${error?.message || String(error)}`))
      }
      if (!managed || !runtime) return
      if (Object.prototype.hasOwnProperty.call(config.mcp || {}, "codegraph")) {
        if (config.mcp.codegraph === injectedMcp) return
        managed = false
        log(input, "检测到用户已有 mcp.codegraph 配置，保持原配置并停止插件接管。")
        return
      }
      if (!registerMcp(config, runtime)) {
        managed = false
        return
      }
      injectedMcp = config.mcp.codegraph
      configCompleted = true
    }

    return {
      config,
      "experimental.chat.system.transform": async (_event, output) => {
        if (!configCompleted || !managed) return
        if (output?.system) output.system.push("When CodeGraph tools are available in this session, use their exploration capability first to locate and understand relevant code before broad searches or reading unrelated files. Follow their provided instructions and use returned context for targeted reads; avoid re-fetching context already available. If the tools are unavailable or results are insufficient or stale, fall back to permitted file-reading and search tools.")
      },
    }
  })
}

/** @param {Runtime} runtime @param {string} root @param {number} [hostPid] */
export function runInitializationWorker(runtime, root, hostPid = process.pid) {
  const { command, args } = workerCommand(runtime, root, hostPid)
  return runChild(command, args, {
    cwd: root,
    env: childEnv(),
    timeoutMs: WORKER_TIMEOUT_MS,
  }).then((result) => {
    const payload = parseJsonOutput(result.stdout)
    if (result.error) return { success: false, message: result.error.message }
    if (result.code !== 0) return { success: false, message: (payload?.message || result.stderr || `退出码 ${result.code}`).trim().slice(0, 500) }
    if (payload?.success !== true) return { success: false, message: (payload?.message || result.stderr || "worker 未报告成功").trim().slice(0, 500) }
    return { success: true, message: "ok" }
  })
}

export { LOCK_NAME }
