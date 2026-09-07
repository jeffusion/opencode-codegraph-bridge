import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import { readStatus, resolveRuntime } from "../src/internal.js"

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

function startMcp(command, root, environment) {
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: { ...process.env, ...environment, CODEGRAPH_NO_DAEMON: "1" },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  const session = { process: child, nextId: 0, pending: new Map(), stderr: "", exitCode: null }
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line)
      const pending = session.pending.get(message.id)
      if (!pending) return
      session.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message)
    } catch (error) {
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      session.pending.clear()
    }
  })
  child.stderr.on("data", (chunk) => { session.stderr = tail(session.stderr, chunk) })
  child.once("exit", (code) => { session.exitCode = code })
  return { session, lines }
}

function mcpRequest(session, method, params) {
  const id = ++session.nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id)
      reject(new Error(`MCP ${method} 请求超时；stderr：${session.stderr}`))
    }, 60_000)
    session.pending.set(id, { resolve, reject, timer })
    session.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

function mcpNotification(session, method, params) {
  session.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
}

async function probeProject(command, environment, root, symbol, otherSymbol) {
  const { session, lines } = startMcp(command, root, environment)
  try {
    const initialize = await mcpRequest(session, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opencode-codegraph-bridge-smoke", version: "0.1.0" },
      rootUri: pathToFileURL(root).href,
    })
    assert.ok(initialize.result?.capabilities?.tools)
    mcpNotification(session, "notifications/initialized", {})
    const status = await mcpRequest(session, "tools/call", { name: "codegraph_status", arguments: {} })
    assert.notEqual(status.result?.isError, true)
    if (!symbol) return
    const runtime = resolveRuntime()
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      const explored = await mcpRequest(session, "tools/call", { name: "codegraph_explore", arguments: { query: symbol } })
      const text = explored.result?.content?.map((item) => item.text || "").join("\n") || ""
      if (text.includes(symbol)) {
        assert.equal(text.includes(otherSymbol), false, `CodeGraph 串读了另一个项目：${text}`)
        const statusDeadline = Date.now() + 60_000
        let current
        while (Date.now() < statusDeadline) {
          current = await readStatus(runtime, root)
          if (current.ok) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        assert.equal(current?.ok, true, `CodeGraph status 读取失败：${current?.diagnostic}；MCP stderr：${session.stderr}`)
        assert.equal(typeof current?.status?.projectPath, "string", `CodeGraph status 缺少 projectPath：${JSON.stringify(current?.status)}`)
        assert.equal(resolve(current?.status?.projectPath), resolve(root), `CodeGraph projectPath 错误：${JSON.stringify(current?.status)}；MCP stderr：${session.stderr}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error(`CodeGraph 未在限定时间内找到 ${symbol}`)
  } finally {
    lines.close()
    await stopServer({ process: session.process, stderr: session.stderr, exitCode: session.exitCode })
  }
}

async function main() {
  const probe = spawnSync(process.env.OPENCODE_BIN || "opencode", ["--version"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) {
    console.log(`SKIP: opencode 不可用${probe.error ? `（${probe.error.message}）` : `（退出码 ${probe.status}）`}`)
    return
  }

  const serverRoot = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-server-"))
  const firstRoot = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-first-"))
  const secondRoot = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-second-"))
  let outsideRoot
  let outsideSnapshot
  let server
  let hooksSnapshot
  let globalAgentsHash
  try {
    for (const projectRoot of [serverRoot, firstRoot, secondRoot]) execFileSync("git", ["init", "--quiet", projectRoot])
    await writeFile(join(firstRoot, "first.js"), "export function OpenCodeSmokeFirstUniqueSymbol() { return 'first-only' }\n")
    await writeFile(join(secondRoot, "second.js"), "export function OpenCodeSmokeSecondUniqueSymbol() { return 'second-only' }\n")
    hooksSnapshot = await directorySnapshot(join(serverRoot, ".git", "hooks"))
    globalAgentsHash = await fileHash(join(homedir(), ".config", "opencode", "AGENTS.md"))
    const configPath = join(serverRoot, "isolated-opencode.json")
    const pluginUrl = pathToFileURL(join(sourceRoot, "src", "index.js")).href
    await writeFile(configPath, `${JSON.stringify({ plugin: [pluginUrl] }, null, 2)}\n`)
    const config = JSON.parse(await readFile(configPath, "utf8"))
    assert.deepEqual(config, { plugin: [pluginUrl] })
    assert.equal(config.mcp, undefined, "smoke 配置不得静态声明 MCP")

    const port = 41000 + (process.pid % 1000)
    const environment = {
      ...process.env,
      OPENCODE_TEST_HOME: join(serverRoot, "test-home"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: join(serverRoot, "managed-config"),
      XDG_CONFIG_HOME: join(serverRoot, "xdg-config"),
      XDG_DATA_HOME: join(serverRoot, "xdg-data"),
      XDG_STATE_HOME: join(serverRoot, "xdg-state"),
      XDG_CACHE_HOME: join(serverRoot, "xdg-cache"),
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
    const startServer = () => {
      const child = spawn(process.env.OPENCODE_BIN || "opencode", [
        "serve", "--hostname", "127.0.0.1", "--port", String(port),
      ], {
        cwd: serverRoot,
        env: environment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
      const nextServer = { process: child, stderr: "", exitCode: null }
      child.stdout.on("data", () => {})
      child.stderr.on("data", (chunk) => { nextServer.stderr = tail(nextServer.stderr, chunk) })
      child.once("exit", (code) => { nextServer.exitCode = code })
      return nextServer
    }
    const assertMcpConnected = async (projectRoot) => {
      const status = await waitForMcp(port, projectRoot, server)
      assert.equal(status.codegraph?.status, "connected", `CodeGraph 未连接：${JSON.stringify(status)}`)
      assert.equal(Object.keys(status).filter((name) => name === "codegraph").length, 1)
      return status
    }

    server = startServer()
    await assertMcpConnected(firstRoot)
    await assertMcpConnected(secondRoot)
    const effectiveResponses = await Promise.all([firstRoot, secondRoot].map((projectRoot) =>
      fetch(`http://127.0.0.1:${port}/config?directory=${encodeURIComponent(projectRoot)}`)))
    for (const effectiveResponse of effectiveResponses) {
      if (effectiveResponse.status === 401) throw new Error("OpenCode server 返回 401；未成功隔离 server auth")
      assert.equal(effectiveResponse.ok, true, `OpenCode /config 失败：HTTP ${effectiveResponse.status}`)
    }
    const [firstEffective, secondEffective] = await Promise.all(effectiveResponses.map((response) => response.json()))
    for (const effective of [firstEffective, secondEffective]) {
      assert.deepEqual(effective.plugin, [pluginUrl], "effective config 必须只包含本测试 file URL 插件")
      assert.deepEqual(Object.keys(effective.mcp || {}), ["codegraph"], "effective config 的 MCP 必须只有动态 CodeGraph")
      assert.equal(effective.mcp.codegraph.enabled, true)
    }
    assert.deepEqual(firstEffective.mcp.codegraph.command, secondEffective.mcp.codegraph.command, "两个目录必须使用相同 rootless command")
    const command = firstEffective.mcp.codegraph.command
    assert.equal(command.includes("--path"), false)
    assert.equal(command.includes("serve"), false)
    assert.equal(command.includes("--mcp"), false)
    assert.equal(command.includes(firstRoot), false)
    assert.equal(command.includes(secondRoot), false)
    await probeProject(command, firstEffective.mcp.codegraph.environment, firstRoot, "OpenCodeSmokeFirstUniqueSymbol", "OpenCodeSmokeSecondUniqueSymbol")
    await probeProject(command, secondEffective.mcp.codegraph.environment, secondRoot, "OpenCodeSmokeSecondUniqueSymbol", "OpenCodeSmokeFirstUniqueSymbol")

    await stopServer(server)
    server = null
    outsideRoot = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-smoke-outside-"))
    const externalData = join(outsideRoot, "external-codegraph")
    await rename(join(secondRoot, ".codegraph"), externalData)
    await symlink(externalData, join(secondRoot, ".codegraph"), "dir")
    outsideSnapshot = await directorySnapshot(externalData)
    server = startServer()
    await assertMcpConnected(firstRoot)
    await assertMcpConnected(secondRoot)
    await probeProject(command, secondEffective.mcp.codegraph.environment, secondRoot)
    console.log("OpenCode smoke passed: rootless CodeGraph MCP connected for two projects across restart")
  } finally {
    try {
      if (server) await stopServer(server)
    } finally {
      try {
        if (hooksSnapshot) assert.deepEqual(await directorySnapshot(join(serverRoot, ".git", "hooks")), hooksSnapshot, "插件不得修改 Git hooks")
        if (globalAgentsHash !== undefined) assert.equal(await fileHash(join(homedir(), ".config", "opencode", "AGENTS.md")), globalAgentsHash, "插件不得修改全局 AGENTS.md")
        if (outsideSnapshot) assert.deepEqual(await directorySnapshot(join(outsideRoot, "external-codegraph")), outsideSnapshot, "符号链接数据目录不得被首次初始化自动写入")
      } finally {
        await Promise.all([serverRoot, firstRoot, secondRoot].map((projectRoot) => rm(projectRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })))
        if (outsideRoot) await rm(outsideRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
