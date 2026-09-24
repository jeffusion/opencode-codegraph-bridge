import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mcpConfig, readStatus, resolveRuntime } from "../src/internal.js"

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
    return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
      const entryPath = join(path, entry.name)
      if (entry.isDirectory()) return { name: entry.name, type: "directory", entries: await directorySnapshot(entryPath) }
      return { name: entry.name, type: entry.isSymbolicLink() ? "symlink" : "file", hash: await fileHash(entryPath) }
    }))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

function safeDiagnostic(value, server) {
  let text = typeof value === "string" ? value : JSON.stringify(value)
  for (const secret of [server.password, server.authorization]) {
    if (secret) text = text.replaceAll(secret, "[REDACTED]")
  }
  return text
}

function apiHeaders(root, server) {
  return {
    authorization: server.authorization,
    "x-opencode-directory": encodeURIComponent(root),
  }
}

async function getApiJson(port, route, root, server) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    headers: apiHeaders(root, server),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 401) throw new Error("OpenCode v2 API 认证失败")
  if (!response.ok) throw new Error(`GET ${route} 返回 HTTP ${response.status}`)
  return response.json()
}

async function waitForMcpApi(port, root, server, pluginPath) {
  const deadline = Date.now() + 60_000
  let lastError = ""
  let pluginDiagnostic = "尚未读取 GET /api/plugin"
  while (Date.now() < deadline) {
    try {
      const plugins = await getApiJson(port, "/api/plugin", root, server)
      assert.ok(Array.isArray(plugins.data), `GET /api/plugin 必须返回 data 数组：${safeDiagnostic(plugins, server)}`)
      assert.equal(resolve(plugins.location?.directory || ""), resolve(root),
        `GET /api/plugin 未采用 x-opencode-directory：${safeDiagnostic(plugins.location, server)}`)
      const targetPlugin = plugins.data.find((entry) => entry.id === "opencode-codegraph-bridge"
        || entry.source?.path && resolve(entry.source.path) === resolve(pluginPath)
        || entry.source?.target && resolve(entry.source.target) === resolve(pluginPath))
      pluginDiagnostic = targetPlugin
        ? safeDiagnostic({ source: targetPlugin.source, features: targetPlugin.features, state: targetPlugin.state }, server)
        : safeDiagnostic({ target: "opencode-codegraph-bridge", loaded: false, plugins: plugins.data.map(({ id, source, features, state }) => ({ id, source, features, state })) }, server)
      if (targetPlugin?.state?.status === "failed") {
        throw new Error(`CODEGRAPH_PLUGIN_FAILED: ${pluginDiagnostic}`)
      }
      const mcp = await getApiJson(port, "/api/mcp", root, server)
      assert.ok(Array.isArray(mcp.data), `GET /api/mcp 必须返回 data 数组：${safeDiagnostic(mcp, server)}`)
      assert.equal(resolve(mcp.location?.directory || ""), resolve(root),
        `GET /api/mcp 未采用 x-opencode-directory：${safeDiagnostic(mcp.location, server)}`)
      const codegraph = mcp.data.find((entry) => entry.name === "codegraph")
      if (codegraph?.status?.status === "connected" && targetPlugin?.state?.status === "active"
        && targetPlugin.features?.server === true) return { mcp, plugin: targetPlugin }
      if (codegraph?.status?.status === "failed") {
        throw new Error(`CODEGRAPH_MCP_FAILED: ${safeDiagnostic(codegraph, server)}; plugin=${pluginDiagnostic}`)
      }
      lastError = codegraph
        ? `codegraph MCP 状态为 ${codegraph.status?.status || "未知"}：${safeDiagnostic(codegraph, server)}`
        : `尚未注册 codegraph MCP；当前服务器：${safeDiagnostic(mcp.data, server)}`
      if (targetPlugin && (targetPlugin.state?.status !== "active" || targetPlugin.features?.server !== true)) {
        lastError += `；插件未处于可用 server 状态：${pluginDiagnostic}`
      }
    } catch (error) {
      if (error.message?.includes("认证失败")) throw error
      if (error.message?.startsWith("CODEGRAPH_MCP_FAILED:") || error.message?.startsWith("CODEGRAPH_PLUGIN_FAILED:")) throw error
      lastError = safeDiagnostic(error.message, server)
    }
    if (server.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`OpenCode codegraph MCP 未连接：${lastError}；目标插件 source/features/state：${pluginDiagnostic}；stdout：${safeDiagnostic(server.stdout, server)}；stderr：${safeDiagnostic(server.stderr, server)}`)
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
    const pluginPath = sourceRoot
    const plugin = { package: pluginPath }
    await writeFile(configPath, `${JSON.stringify({ plugins: [plugin] }, null, 2)}\n`)
    const config = JSON.parse(await readFile(configPath, "utf8"))
    assert.deepEqual(config, { plugins: [plugin] })
    assert.equal(config.plugin, undefined, "smoke 配置必须使用 v2 plugins")
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
    environment.OPENCODE_SERVER_USERNAME = "opencode"
    environment.OPENCODE_SERVER_PASSWORD = `isolated-smoke-${process.pid}`
    environment.OPENCODE_CONFIG = configPath
    const startServer = () => {
      const child = spawn(process.env.OPENCODE_BIN || "opencode", [
        "serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "debug", "--print-logs",
      ], {
        cwd: serverRoot,
        env: environment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
      const nextServer = {
        process: child,
        stderr: "",
        stdout: "",
        authorization: `Basic ${Buffer.from(`${environment.OPENCODE_SERVER_USERNAME}:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
        exitCode: null,
      }
      child.stdout.on("data", (chunk) => { nextServer.stdout = tail(nextServer.stdout, chunk) })
      child.stderr.on("data", (chunk) => { nextServer.stderr = tail(nextServer.stderr, chunk) })
      child.once("exit", (code) => { nextServer.exitCode = code })
      return nextServer
    }
    const assertMcpApiContext = async (projectRoot) => {
      const connected = await waitForMcpApi(port, projectRoot, server, pluginPath)
      assert.equal(connected.plugin.id, "opencode-codegraph-bridge")
      assert.equal(typeof connected.plugin.source?.type, "string", "插件响应必须包含 source")
      assert.equal(resolve(connected.plugin.source.path), resolve(join(pluginPath, "server.js")),
        "宿主必须加载真实仓库插件目录的根 server.js")
      assert.equal(connected.plugin.state.status, "active")
      assert.equal(connected.plugin.features.server, true)
      console.log(`OpenCode plugin ${projectRoot}: ${safeDiagnostic({
        source: connected.plugin.source,
        features: connected.plugin.features,
        state: connected.plugin.state,
      }, server)}`)
      return connected
    }

    server = startServer()
    await assertMcpApiContext(firstRoot)
    await assertMcpApiContext(secondRoot)
    const configResponses = await Promise.all([firstRoot, secondRoot].map((projectRoot) =>
      fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: {
          authorization: server.authorization,
          "x-opencode-directory": encodeURIComponent(projectRoot),
        },
      })))
    for (const configResponse of configResponses) {
      assert.equal(configResponse.status, 200, `OpenCode GET /api/config 失败：HTTP ${configResponse.status}`)
    }
    const [firstConfigEntries, secondConfigEntries] = await Promise.all(configResponses.map((response) => response.json()))
    for (const configEntries of [firstConfigEntries, secondConfigEntries]) {
      assert.ok(Array.isArray(configEntries), `GET /api/config 必须返回 Config.Entry[]：${JSON.stringify(configEntries)}`)
      const testConfig = configEntries.find((entry) => entry.type === "document" && resolve(entry.path) === resolve(configPath))
      assert.ok(testConfig, `GET /api/config 未列出隔离测试配置：${JSON.stringify(configEntries)}`)
      assert.deepEqual(testConfig.info?.plugins, [plugin], "隔离配置 document 必须使用 v2 plugins")
      assert.equal(testConfig.info?.plugin, undefined, "隔离配置 document 不得使用旧版 plugin 字段")
    }
    const runtime = resolveRuntime()
    const firstMcpConfig = mcpConfig(runtime, firstRoot)
    const secondMcpConfig = mcpConfig(runtime, secondRoot)
    const command = firstMcpConfig.command
    const mcpEnvironment = firstMcpConfig.environment
    assert.equal(firstMcpConfig.cwd, firstRoot)
    assert.equal(secondMcpConfig.cwd, secondRoot)
    assert.deepEqual(command, secondMcpConfig.command)
    assert.deepEqual(mcpEnvironment, secondMcpConfig.environment)
    assert.equal(command.includes("--path"), false)
    assert.equal(command.includes("serve"), false)
    assert.equal(command.includes("--mcp"), false)
    assert.equal(command.includes(firstRoot), false)
    assert.equal(command.includes(secondRoot), false)
    await probeProject(command, mcpEnvironment, firstRoot, "OpenCodeSmokeFirstUniqueSymbol", "OpenCodeSmokeSecondUniqueSymbol")
    await probeProject(command, mcpEnvironment, secondRoot, "OpenCodeSmokeSecondUniqueSymbol", "OpenCodeSmokeFirstUniqueSymbol")

    await stopServer(server)
    server = null
    outsideRoot = await mkdtemp(join(tmpdir(), "opencode-codegraph-bridge-smoke-outside-"))
    const externalData = join(outsideRoot, "external-codegraph")
    const previousData = join(outsideRoot, "previous-codegraph")
    await rename(join(secondRoot, ".codegraph"), previousData)
    await mkdir(externalData)
    await writeFile(join(externalData, "smoke-sentinel.txt"), "external-codegraph-sentinel\n")
    await symlink(externalData, join(secondRoot, ".codegraph"), "dir")
    const linkedData = join(secondRoot, ".codegraph")
    assert.equal((await lstat(linkedData)).isSymbolicLink(), true, "第二项目 .codegraph 必须是符号链接")
    assert.equal(resolve(await readlink(linkedData)), resolve(externalData), "第二项目 .codegraph 必须指向新建的外部目录")
    outsideSnapshot = await directorySnapshot(externalData)
    server = startServer()
    await assertMcpApiContext(firstRoot)
    await assertMcpApiContext(secondRoot)
    await probeProject(command, mcpEnvironment, secondRoot)
    assert.deepEqual(await directorySnapshot(externalData), outsideSnapshot,
      "OpenCode 进程运行期间不得修改符号链接外部数据目录")
    await stopServer(server)
    server = null
    assert.deepEqual(await directorySnapshot(externalData), outsideSnapshot,
      "OpenCode 进程停止后符号链接外部数据目录仍不得有任何变化")
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
