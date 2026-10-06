// Full artifact path: npm pack -> isolated registry/cache -> generated exact npx
// -> official Codex app-server -> real MCP tool. No public bridge package fallback.
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"
import { request as httpsRequest } from "node:https"
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { PLUGIN_ID } from "../src/codex-plugin.js"
import { CODEX_PROMPT } from "../src/guidance.mjs"
import { absent, descendants, fixture, gone, repository, rpc, until } from "./codex-test-support.mjs"

const execute = promisify(execFile)
const pkg = createRequire(import.meta.url)("../package.json")
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
async function registry(tarball) {
  const tar = await readFile(tarball)
  const integrity = `sha512-${createHash("sha512").update(tar).digest("base64")}`
  const hits = []
  let url
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0])
    if (path === `/${pkg.name}` || path === `/${pkg.name}/${pkg.version}`) {
      hits.push("metadata")
      const version = { ...pkg, dist: { tarball: `${url}/bridge.tgz`, integrity } }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(path.endsWith(`/${pkg.version}`) ? version : { name: pkg.name, "dist-tags": { latest: pkg.version }, versions: { [pkg.version]: version } }))
      return
    }
    if (path === "/bridge.tgz") { hits.push("tarball"); res.setHeader("content-type", "application/octet-stream"); res.end(tar); return }
    // Only transitive packages can reach the upstream registry.
    if (path.includes(pkg.name)) { res.writeHead(404); res.end("no bridge fallback"); return }
    const upstream = httpsRequest(`https://registry.npmjs.org${req.url}`, { method: req.method, headers: { ...req.headers, host: "registry.npmjs.org" } }, (response) => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    upstream.on("error", (error) => { res.writeHead(502); res.end(error.message) })
    req.pipe(upstream)
  })
  url = await listen(server)
  return { server, url, hits }
}
async function provider() {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    if (req.method !== "POST" || !req.url.includes("responses")) {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ data: [{ id: "bridge-test-model", object: "model" }] }))
      return
    }
    requests.push(JSON.parse(body))
    const message = { id: "msg_bridge_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Test complete.", annotations: [] }] }
    const response = { id: "resp_bridge_test", object: "response", created_at: 1, status: "completed", model: "bridge-test-model", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Test complete." },
      { type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text: "Test complete." },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ]
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  return { server, url: await listen(server), requests }
}

test("pack tarball -> 隔离 registry/cache -> 精确版本 npx -> 官方 app-server MCP 与真实 Hook developer context", { timeout: 900_000 }, async (t) => fixture(async (tmp) => {
  const codex = process.env.CODEX_TEST_BINARY || "codex"
  try { assert.match((await execute(codex, ["--version"])).stdout, /codex-cli 0\.160\.0/) } catch (error) { t.skip(`Codex 0.160.0 required: ${error.message}`); return }
  const packDir = join(tmp, "pack")
  await mkdir(packDir)
  const packed = JSON.parse((await execute("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: resolve("."), timeout: 60_000 })).stdout)
  assert.equal(packed[0].version, pkg.version)
  assert.ok(packed[0].files.some((entry) => entry.path === "src/codex-mcp.js"))
  assert.ok(packed[0].files.some((entry) => entry.path === "src/codex-plugin.js"))
  const reg = await registry(join(packDir, packed[0].filename))
  const mock = await provider()
  let app
  let daemon
  const root = await repository(join(tmp, "repo"))
  // Reuse downloaded dependency blobs if requested, but never reuse an _npx
  // installation: an unpublished same-version artifact must install new bytes.
  const cache = join(tmp, "npm-cache")
  if (process.env.CODEX_TEST_NPM_CACHE) await cp(join(process.env.CODEX_TEST_NPM_CACHE, "_cacache"), join(cache, "_cacache"), { recursive: true })
  const env = { ...process.env, CODEX_HOME: join(tmp, "home"), npm_config_registry: reg.url, npm_config_cache: cache, npm_config_audit: "false", npm_config_fund: "false", CODEGRAPH_NO_DOWNLOAD: "1", CODEGRAPH_NO_DAEMON: "1" }
  if (codex.includes("/")) env.PATH = `${dirname(resolve(codex))}:${env.PATH}`
  delete env.OPENAI_API_KEY
  delete env.CODEGRAPH_DIR
  await mkdir(env.CODEX_HOME)
  const isolatedHome = join(tmp, "system-home")
  await mkdir(isolatedHome)
  await writeFile(join(isolatedHome, ".npmrc"), `registry=${reg.url}\ncache=${env.npm_config_cache}\naudit=false\nfund=false\n`)
  env.HOME = isolatedHome
  try {
    // Populate only the isolated cache through the local registry. This invocation
    // is the same exact-version npx entry generated by pluginFiles(), with --version.
    const pinned = `${pkg.name}@${pkg.version}`
    await execute("npm", ["cache", "add", `${reg.url}/bridge.tgz`], { cwd: root, env, timeout: 60_000 })
    const prewarm = await execute("npx", ["--yes", "--prefer-offline", pinned, "--version"], { cwd: root, env, timeout: 600_000, maxBuffer: 1024 * 1024 })
    assert.equal(prewarm.stdout.trim(), pkg.version)
    assert.ok(reg.hits.includes("tarball"), "must fetch the packed artifact, never published bridge")
    // Check installed cache bytes to prevent an unnoticed old public 0.6.1 fallback.
    const npxRoot = join(env.npm_config_cache, "_npx")
    const folders = await readdir(npxRoot)
    const installed = join(npxRoot, folders[0], "node_modules", pkg.name)
    assert.equal(await readFile(join(installed, "src", "codex-mcp.js"), "utf8"), await readFile(resolve("src/codex-mcp.js"), "utf8"))
    assert.equal(await readFile(join(installed, "src", "codex-plugin.js"), "utf8"), await readFile(resolve("src/codex-plugin.js"), "utf8"))
    const installedCli = join(installed, "src", "cli.js")
    await execute(process.execPath, [installedCli, "install", "--host", "codex"], { cwd: root, env, timeout: 90_000 })
    const list = JSON.parse((await execute(codex, ["plugin", "list", "--json"], { env })).stdout)
    assert.equal(list.installed.find((entry) => entry.pluginId === PLUGIN_ID).enabled, true)
    const bundle = list.installed.find((entry) => entry.pluginId === PLUGIN_ID).source.path
    const generated = JSON.parse(await readFile(join(bundle, ".mcp.json"), "utf8")).mcpServers.codegraph_bridge
    assert.equal(generated.command, "npx")
    assert.deepEqual(generated.args, ["--yes", "--prefer-offline", pinned, "mcp", "--host", "codex"])
    const providerConfig = { name: "local test provider", base_url: mock.url, wire_api: "responses", requires_openai_auth: false }
    const configArgs = ["-c", "model=\"bridge-test-model\"", "-c", "model_provider=\"bridge-test\"", "-c", `model_providers.bridge-test=${JSON.stringify(providerConfig).replace(/"([^"\n]+)":/g, '$1=').replaceAll(":false", "=false")}`]
    app = rpc(codex, [...configArgs, "app-server"], { cwd: root, env })
    await app.request("initialize", { clientInfo: { name: "codex-bridge-pack-test", version: "1" }, capabilities: { experimentalApi: true } })
    app.notify("initialized")
    const thread = await app.request("thread/start", { cwd: root, ephemeral: true, sessionStartSource: "startup", model: "bridge-test-model", modelProvider: "bridge-test", approvalPolicy: "never", sandbox: "danger-full-access" })
    const threadId = thread.thread.id
    const hookList = await app.request("hooks/list", { cwds: [root] })
    assert.equal(hookList.data[0].hooks.filter((hook) => hook.pluginId === PLUGIN_ID).length, 2)
    assert.deepEqual(hookList.data[0].warnings, [])
    let server
    await until(async () => {
      const status = await app.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" }, 180_000)
      server = status.data?.find((entry) => entry.pluginId === PLUGIN_ID && Object.values(entry.tools || {}).some((tool) => tool.name === "codegraph_explore"))
      return server?.runtimeStatus === "connected"
    }, `generated plugin MCP did not connect: ${app.diagnostics()}`, 180_000)
    assert.ok(server.tools)
    let explored
    await until(async () => {
      explored = await app.request("mcpServer/tool/call", { threadId, server: server.name, tool: "codegraph_explore", arguments: { query: "CodexBridgeInitialSymbol" } })
      return explored.content?.some((item) => item.text?.includes("CODEX_BEFORE_65C1"))
    }, "Codex MCP call did not return indexed packed fixture source", 180_000)
    assert.notEqual(explored.isError, true)
    await app.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with Test complete. Do not call tools." }] })
    await until(() => mock.requests.length > 0, "local provider received no request", 60_000)
    await until(() => app.events.some((event) => event.method === "turn/completed"), "mock provider turn did not complete", 60_000)
    const owned = (await descendants(app.child.pid)).map((row) => row.pid)
    app.child.stdin.end()
    await until(() => app.child.exitCode !== null || app.child.signalCode !== null, "app-server EOF did not stop leader", 20_000)
    await until(() => gone(owned), "app-server EOF left live packed MCP descendants", 20_000)
    // app-server does not forward the interactive root hook-trust bypass into
    // thread ConfigOverrides in 0.160.0. Use official exec's own test-only flag
    // for actual SessionStart -> provider verification; production stays untrusted.
    const beforeRequests = mock.requests.length
    const hookRun = execute(codex, [...configArgs, "exec", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "Reply with Test complete. Do not call tools."], { cwd: root, env, timeout: 60_000, maxBuffer: 1024 * 1024 })
    // exec reads additional piped input even with a positional prompt.
    hookRun.child.stdin.end()
    await until(() => mock.requests.length > beforeRequests, "exec hook test never reached local provider", 60_000)
    const execOwned = (await descendants(hookRun.child.pid)).map((row) => row.pid)
    const completed = await hookRun
    assert.match(completed.stdout, /Test complete/)
    const input = mock.requests[beforeRequests].input
    assert.ok(Array.isArray(input))
    assert.ok(input.some((message) => message.role === "developer" && JSON.stringify(message.content).includes(CODEX_PROMPT)), `SessionStart additionalContext must reach actual provider as developer content; roles/context=${JSON.stringify(input.map((message) => ({ role: message.role, bridge: JSON.stringify(message.content).includes("CodeGraph"), content: JSON.stringify(message.content).slice(0, 600) })))}; stderr=${completed.stderr}`)
    await until(() => gone(execOwned), "official exec left live packed MCP descendants", 20_000)
    t.diagnostic(`artifact=${packed[0].filename}; registry tarball hits=${reg.hits.filter((hit) => hit === "tarball").length}; server=${server.name}; provider requests=${mock.requests.length}; actual SessionStart developer context verified`)
  } finally {
    await app?.cleanup()
    if (!await absent(join(root, ".codegraph", "daemon.pid"))) {
      daemon = JSON.parse(await readFile(join(root, ".codegraph", "daemon.pid"), "utf8"))
      if (!await gone([daemon.pid])) { try { process.kill(daemon.pid, "SIGKILL") } catch {} }
    }
    await close(reg.server)
    await close(mock.server)
  }
}))
