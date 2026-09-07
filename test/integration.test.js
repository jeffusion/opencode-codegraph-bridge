/*
 * 真实集成测试：npm install 后运行。
 * 使用 /tmp 的临时 Git 项目、真实 MCP initialize/tools/list（同一连接且在
 * 等待 worker 前发出）、explore 独有符号和文件修改后的 watcher 验证。CODEGRAPH_NO_DAEMON=1
 * 只用于测试隔离；生产默认不设置。测试只关闭自己创建的 MCP 子进程。
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"
import publicPlugin from "../src/index.js"
import {
  acquireInitLock,
  backgroundTaskForRoot,
  codeGraphDataDir,
  isReadyStatus,
  readStatus,
  releaseInitLock,
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

function startMcp(config, root) {
  const command = config.mcp.codegraph.command
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: { ...process.env, ...config.mcp.codegraph.environment, CODEGRAPH_NO_DAEMON: "1" },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  const connection = { process: child, nextId: 0, pending: new Map() }
  let stderrTail = ""
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
    stderrTail = `${stderrTail}${chunk}`.slice(-MAX_STDERR)
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
    const diagnostic = stderrTail ? `；stderr：${stderrTail}` : ""
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
  let initLock
  let workerTask
  try {
    execFileSync("git", ["init", "--quiet", root])
    const firstSymbol = "CodeGraphBridgeIntegrationUniqueSymbol"
    const firstValue = "CG_BRIDGE_SOURCE_BEFORE_9F2A"
    await writeFile(join(root, "sample.js"), `export function ${firstSymbol}() { return "${firstValue}" }\n`)

    const logs = []
    const hooks = await publicPlugin({
      directory: root,
      worktree: root,
      client: { app: { log: async ({ body }) => logs.push(body.message) } },
    })
    const config = {}
    // Hold the plugin lock so initialize/tools/list are guaranteed to happen
    // before the real worker begins indexing, without altering production code.
    initLock = acquireInitLock(codeGraphDataDir(root), root)
    assert.equal(initLock.kind, "acquired")
    hooks.config(config)
    workerTask = backgroundTaskForRoot(root)
    assert.equal(config.mcp.codegraph.type, "local")
    const runtime = resolveRuntime()
    assert.deepEqual(config.mcp.codegraph.command, [
      runtime.nodePath,
      runtime.shimPath,
      "serve",
      "--mcp",
      "--path",
      root,
    ])

    ;({ connection, lines } = startMcp(config, root))
    const initialize = await request(connection, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opencode-codegraph-bridge-integration", version: "0.1.0" },
    })
    assert.ok(initialize.result?.capabilities?.tools)
    notification(connection, "notifications/initialized", {})
    // This request is deliberately sent on the same connection before worker readiness.
    const tools = await request(connection, "tools/list", {})
    assert.ok(tools.result?.tools?.some((tool) => tool.name === "codegraph_explore"))
    const beforeIndex = await request(connection, "tools/call", {
      name: "codegraph_explore",
      arguments: { query: firstSymbol },
    })
    assert.ok(!beforeIndex.result?.content?.some((item) => item.type === "text" && item.text.includes("sample.js") && item.text.includes(firstValue)))
    releaseInitLock(initLock.lockPath)
    initLock = null

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
    assert.ok(logs.some((line) => line.includes("后台首次索引完成")))
  } finally {
    if (initLock?.kind === "acquired") releaseInitLock(initLock.lockPath)
    if (connection) await stopMcp(connection, lines)
    if (workerTask) await workerTask.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
