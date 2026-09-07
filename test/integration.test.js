/*
 * 真实集成测试：npm install 后运行。
 * 使用 /tmp 的临时 Git 项目、真实 MCP initialize/tools/list（同一连接且在
 * 等待 worker 前发出）、explore 独有符号和文件修改后的 watcher 验证。CODEGRAPH_NO_DAEMON=1
 * 只用于测试隔离；生产默认不设置。测试只关闭自己创建的 MCP 子进程。
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import publicPlugin from "../src/index.js"
import {
  codeGraphDataDir,
  isReadyStatus,
  LOCK_NAME,
  readStatus,
  resolveRuntime,
} from "../src/internal.js"

const REQUEST_TIMEOUT = 30_000
const MAX_STDERR = 16 * 1024

function request(connection, method, params) {
  const id = ++connection.nextId
  return new Promise((resolve, reject) => {
    if (connection.protocolError) {
      reject(connection.protocolError)
      return
    }
    const timer = setTimeout(() => {
      connection.pending.delete(id)
      reject(new Error(`MCP ${method} 请求超时`))
    }, REQUEST_TIMEOUT)
    connection.pending.set(id, { resolve, reject, timer })
    connection.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

function notification(connection, method, params) {
  connection.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
}

async function waitForReady(runtime, root) {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const result = await readStatus(runtime, root, 30_000)
    if (result.ok && isReadyStatus(result.status, root, true)) return
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error("后台索引在限定时间内未达到 ready")
}

async function waitForLockGone(root) {
  const lockPath = join(codeGraphDataDir(root), LOCK_NAME)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await lstat(lockPath)
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`初始化锁未清理：${lockPath}`)
}

function startMcp(config, root, options = {}) {
  const command = config.mcp.codegraph.command
  const environment = { ...process.env, ...config.mcp.codegraph.environment, ...options.environment }
  if (options.noDaemon === false) delete environment.CODEGRAPH_NO_DAEMON
  else environment.CODEGRAPH_NO_DAEMON = "1"
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: environment,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  const connection = { process: child, nextId: 0, pending: new Map(), stderr: "" }
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line)
      const pending = connection.pending.get(message.id)
      if (!pending) return
      connection.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message)
    } catch (error) {
      const protocolError = new Error(`MCP stdout 出现非 JSON：${error.message}`)
      connection.protocolError = protocolError
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(protocolError)
      }
      connection.pending.clear()
    }
  })
  child.stderr.on("data", (chunk) => {
    connection.stderr = `${connection.stderr}${chunk}`.slice(-MAX_STDERR)
  })
  child.once("error", (error) => {
    connection.protocolError = error
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    connection.pending.clear()
  })
  child.once("close", (code, signal) => {
    if (connection.pending.size === 0) return
    const diagnostic = connection.stderr ? `；stderr：${connection.stderr}` : ""
    const error = new Error(`MCP 子进程异常退出 code=${code} signal=${signal}${diagnostic}`)
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    connection.pending.clear()
  })
  return { connection, lines }
}

async function stopMcp(connection, lines) {
  lines.close()
  const killTree = (signal) => {
    try {
      process.kill(process.platform === "win32" ? connection.process.pid : -connection.process.pid, signal)
    } catch {
      // It may have exited between the check and the signal.
    }
  }
  if (!connection.process.killed) killTree("SIGTERM")
  let closed = false
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!closed) killTree("SIGKILL")
      resolve()
    }, 5_000)
    connection.process.once("close", () => {
      closed = true
      clearTimeout(timer)
      resolve()
    })
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-"))
  let connection
  let lines
  let unsafeRoot
  let outsideData
  let unsafeConnection
  let unsafeLines
  let badRoot
  let badConnection
  let badLines
  try {
    execFileSync("git", ["init", "--quiet", root])
    const firstSymbol = "CodeGraphBridgeIntegrationUniqueSymbol"
    const firstValue = "CG_BRIDGE_SOURCE_BEFORE_9F2A"
    await writeFile(join(root, "sample.js"), `export function ${firstSymbol}() { return "${firstValue}" }\n`)

    const hooks = await publicPlugin({
      directory: root,
      worktree: root,
      client: { app: { log: async () => {} } },
    })
    const config = {}
    hooks.config(config)
    assert.equal(config.mcp.codegraph.type, "local")
    assert.equal(config.mcp.codegraph.enabled, true)
    const runtime = resolveRuntime()
    assert.deepEqual(config.mcp.codegraph.command, [
      runtime.nodePath,
      "--liftoff-only",
      "--disable-warning=ExperimentalWarning",
      runtime.launcherPath,
    ])
    assert.equal(config.mcp.codegraph.command.includes(root), false)
    assert.equal(config.mcp.codegraph.command.includes("--path"), false)

    ;({ connection, lines } = startMcp(config, root))
    const initialize = await request(connection, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opencode-codegraph-bridge-integration", version: "0.1.0" },
      rootUri: pathToFileURL(root).href,
    })
    assert.ok(initialize.result?.capabilities?.tools)
    notification(connection, "notifications/initialized", {})
    // These requests deliberately run on the same connection before readiness.
    const tools = await request(connection, "tools/list", {})
    assert.ok(tools.result?.tools?.some((tool) => tool.name === "codegraph_explore"))

    await waitForReady(runtime, root)
    const explored = await request(connection, "tools/call", {
      name: "codegraph_explore",
      arguments: { query: firstSymbol },
    })
    assert.notEqual(explored.result?.isError, true)
    assert.ok(explored.result?.content?.some((item) => item.type === "text" && item.text.includes("sample.js") && item.text.includes(firstValue)))

    const secondSymbol = "CodeGraphBridgeWatcherUniqueSymbol"
    const secondValue = "CG_BRIDGE_SOURCE_AFTER_61B7"
    await writeFile(join(root, "sample.js"), `export function ${secondSymbol}() { return "${secondValue}" }\n`, { flag: "a" })
    const deadline = Date.now() + 60_000
    let watched = false
    while (Date.now() < deadline) {
      const result = await request(connection, "tools/call", {
        name: "codegraph_explore",
        arguments: { query: secondSymbol },
      })
      if (result.result?.content?.some((item) => item.type === "text" && item.text.includes("sample.js") && item.text.includes(secondValue))) {
        watched = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    assert.equal(watched, true, "watcher 未在限定时间内同步修改")

    badRoot = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-worker-failure-"))
    execFileSync("git", ["init", "--quiet", badRoot])
    await mkdir(join(badRoot, ".codegraph"))
    await writeFile(join(badRoot, ".codegraph", "codegraph.db"), "not a sqlite database\n")
    ;({ connection: badConnection, lines: badLines } = startMcp(config, badRoot))
    const badInitialize = await request(badConnection, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opencode-codegraph-bridge-worker-failure", version: "0.1.0" },
      rootUri: pathToFileURL(badRoot).href,
    })
    assert.ok(badInitialize.result?.capabilities?.tools)
    notification(badConnection, "notifications/initialized", {})
    const badTools = await request(badConnection, "tools/list", {})
    assert.ok(badTools.result?.tools?.some((tool) => tool.name === "codegraph_explore"))
    const badCall = await request(badConnection, "tools/call", { name: "codegraph_status", arguments: {} })
    assert.ok(badCall.result?.content)
    const failureDeadline = Date.now() + 30_000
    while (!badConnection.stderr.includes("首次初始化失败") && Date.now() < failureDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.match(badConnection.stderr, /首次初始化失败/)
    const badPing = await request(badConnection, "ping", {})
    assert.deepEqual(badPing.result, {})
    assert.equal(badConnection.process.exitCode, null)
    await stopMcp(badConnection, badLines)
    badConnection = null
    await waitForLockGone(badRoot)

    unsafeRoot = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-symlink-"))
    outsideData = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-outside-"))
    execFileSync("git", ["init", "--quiet", unsafeRoot])
    await symlink(outsideData, join(unsafeRoot, ".codegraph"), "dir")
    const outsideBefore = await readdir(outsideData)
    ;({ connection: unsafeConnection, lines: unsafeLines } = startMcp(config, unsafeRoot, {
      noDaemon: false,
      environment: {
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: "100",
        CODEGRAPH_DAEMON_MAX_IDLE_MS: "100",
        CODEGRAPH_DAEMON_CLIENT_SWEEP_MS: "50",
      },
    }))
    const unsafeInitialize = await request(unsafeConnection, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opencode-codegraph-bridge-symlink", version: "0.1.0" },
      rootUri: pathToFileURL(unsafeRoot).href,
    })
    assert.ok(unsafeInitialize.result?.capabilities?.tools)
    notification(unsafeConnection, "notifications/initialized", {})
    const unsafeTools = await request(unsafeConnection, "tools/list", {})
    assert.ok(unsafeTools.result?.tools?.some((tool) => tool.name === "codegraph_explore"))
    const unsafeCall = await request(unsafeConnection, "tools/call", {
      name: "codegraph_status",
      arguments: {},
    })
    assert.ok(unsafeCall.result?.content)
    await stopMcp(unsafeConnection, unsafeLines)
    unsafeConnection = null
    await waitForLockGone(unsafeRoot)
    assert.equal((await lstat(join(unsafeRoot, ".codegraph"))).isSymbolicLink(), true)
    assert.deepEqual(await readdir(outsideData), outsideBefore, "符号链接数据目录不得被首次初始化自动写入")
  } finally {
    try {
      if (connection) await stopMcp(connection, lines)
    } finally {
      try {
        if (unsafeConnection) await stopMcp(unsafeConnection, unsafeLines)
      } finally {
        try {
          if (badConnection) await stopMcp(badConnection, badLines)
        } finally {
          try {
            if (connection) await waitForLockGone(root)
            if (badRoot) await waitForLockGone(badRoot)
            if (unsafeRoot) await waitForLockGone(unsafeRoot)
          } finally {
            await rm(root, { recursive: true, force: true })
            if (badRoot) await rm(badRoot, { recursive: true, force: true })
            if (unsafeRoot) await rm(unsafeRoot, { recursive: true, force: true })
            if (outsideData) await rm(outsideData, { recursive: true, force: true })
          }
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
