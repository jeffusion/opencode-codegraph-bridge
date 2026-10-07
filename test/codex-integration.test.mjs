// Linux integration: close/signals target only the CLI leader. Group kill is
// reserved for finally cleanup and can never turn an assertion into a pass.
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, rename, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { installCodex, PLUGIN_ID } from "../src/codex-plugin.js"
import { isReadyStatus, readStatus, resolveRuntime, LOCK_NAME } from "../src/internal.js"
import { absent, descendants, fixture, gone, initialize, repository, rpc, until } from "./codex-test-support.mjs"

const execute = promisify(execFile)
const runtime = resolveRuntime()
const cli = resolve("src/cli.js")
const linux = process.platform !== "linux" ? "requires Linux /proc" : false
function start(root, daemon = false) {
  const env = { ...process.env, CODEGRAPH_NO_DOWNLOAD: "1", CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: "1000", CODEGRAPH_DAEMON_MAX_IDLE_MS: "120000", CODEGRAPH_DAEMON_CLIENT_SWEEP_MS: "100" }
  delete env.CODEGRAPH_DIR
  if (!daemon) env.CODEGRAPH_NO_DAEMON = "1"
  else delete env.CODEGRAPH_NO_DAEMON
  return rpc(process.execPath, [cli, "mcp", "--host", "codex", "--project", root], { cwd: root, env })
}
async function ready(root, client) {
  let last
  try {
  await until(async () => {
    const status = await readStatus(runtime, root, 10_000)
    last = status
    return status.ok && isReadyStatus(status.status, root)
  }, "background index did not reach ready", 180_000)
  } catch (error) {
    throw new Error(`${error.message}; last status=${JSON.stringify(last)}; stderr=${client?.diagnostics() || "unavailable"}`)
  }
}
async function shutdown(client, root, mode, owned) {
  if (mode === "EOF") client.child.stdin.end()
  else process.kill(client.child.pid, mode)
  await until(() => client.child.exitCode !== null || client.child.signalCode !== null, `${mode} did not stop leader`, 20_000)
  const exit = await client.closed
  assert.equal(exit.code, mode === "EOF" ? 0 : mode === "SIGTERM" ? 143 : 130)
  await until(() => gone(owned), `${mode} left a running owned process`, 12_000)
  await until(() => absent(join(root, ".codegraph", LOCK_NAME)), `${mode} left initialization lock`, 12_000)
}

test("CLI MCP: initialize/list 先于后台 ready，explore 与 watcher，EOF 主进程清理", { skip: linux, timeout: 240_000 }, async () => fixture(async (tmp) => {
  const root = await repository(join(tmp, "repo"))
  const client = start(root)
  try {
    await initialize(client, root)
    await ready(root, client)
    const result = await client.request("tools/call", { name: "codegraph_explore", arguments: { query: "CodexBridgeInitialSymbol" } })
    assert.notEqual(result.isError, true)
    assert.ok(result.content.some((item) => item.text?.includes("sample.js") && item.text.includes("CODEX_BEFORE_65C1")))
    await writeFile(join(root, "sample.js"), 'export function CodexBridgeWatcherSymbol() { return "CODEX_AFTER_80A9" }\n', { flag: "a" })
    await until(async () => {
      const watched = await client.request("tools/call", { name: "codegraph_explore", arguments: { query: "CodexBridgeWatcherSymbol" } })
      return watched.content?.some((item) => item.text?.includes("sample.js") && item.text.includes("CODEX_AFTER_80A9"))
    }, "watcher did not expose changed source")
    const owned = (await descendants(client.child.pid)).map((row) => row.pid)
    assert.ok(owned.length >= 2, "must observe real launcher")
    await shutdown(client, root, "EOF", owned)
  } finally { await client.cleanup() }
}))

for (const mode of ["SIGTERM", "SIGINT"]) test(`CLI MCP: ${mode} 只发给 leader，worker/launcher 与锁自动清理`, { skip: linux, timeout: 60_000 }, async () => fixture(async (tmp) => {
  const root = await repository(join(tmp, "repo"))
  const client = start(root)
  try {
    await initialize(client, root)
    await until(async () => (await descendants(client.child.pid)).length >= 3 || !(await absent(join(root, ".codegraph", LOCK_NAME))), "no worker/lock observed", 15_000)
    const owned = (await descendants(client.child.pid)).map((row) => row.pid)
    await shutdown(client, root, mode, owned)
  } finally { await client.cleanup() }
}))

test("共享 daemon: 两个 CLI 客户端，关闭一个另一个继续 ping/explore，最后 idle 清理", { skip: linux, timeout: 240_000 }, async () => fixture(async (tmp) => {
  const root = await repository(join(tmp, "repo"))
  // CodeGraph chooses direct mode on a fresh checkout without .codegraph.
  // The cold background path has its own test above; prepare this independent
  // sharing fixture with CodeGraph's official CLI so a cold-start failure cannot
  // hide whether closing one shared client disrupts the other.
  await execute(runtime.nodePath, ["--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.cliPath, "init", root, "--yes"], {
    cwd: root, env: { ...process.env, CODEGRAPH_NO_DOWNLOAD: "1" }, timeout: 120_000,
  })
  const first = start(root, true)
  let second
  let daemon
  try {
    await initialize(first, root)
    await ready(root, first)
    // Tool registration is intentionally faster than detached daemon startup.
    await until(async () => !await absent(join(root, ".codegraph", "daemon.pid")), "shared daemon did not start", 15_000)
    daemon = JSON.parse(await readFile(join(root, ".codegraph", "daemon.pid"), "utf8"))
    assert.ok(daemon.pid > 0)
    second = start(root, true)
    await initialize(second, root)
    assert.equal(JSON.parse(await readFile(join(root, ".codegraph", "daemon.pid"), "utf8")).pid, daemon.pid)
    const sharedProcesses = new Set((await descendants(daemon.pid)).map((row) => row.pid))
    const owned = (await descendants(first.child.pid)).filter((row) => !sharedProcesses.has(row.pid)).map((row) => row.pid)
    await shutdown(first, root, "EOF", owned)
    assert.equal(await gone([daemon.pid]), false)
    assert.deepEqual(await second.request("ping", {}), {})
    const result = await second.request("tools/call", { name: "codegraph_explore", arguments: { query: "CodexBridgeInitialSymbol" } })
    assert.ok(result.content.some((item) => item.text?.includes("CODEX_BEFORE_65C1")))
    const secondOwned = (await descendants(second.child.pid)).map((row) => row.pid)
    await shutdown(second, root, "SIGTERM", secondOwned)
    await until(async () => await gone([daemon.pid]) && await absent(join(root, ".codegraph", "daemon.pid")), "daemon did not idle-exit after last client", 15_000)
  } finally {
    await first.cleanup()
    await second?.cleanup()
    if (daemon && !await gone([daemon.pid])) { try { process.kill(daemon.pid, "SIGKILL") } catch {} }
  }
}))

test("官方 codex CLI 0.160.0/0.160.1: 临时 CODEX_HOME 安装、list、重复同版零写、禁用不重新启用", { timeout: 120_000 }, async (t) => fixture(async (tmp) => {
  const codex = process.env.CODEX_TEST_BINARY || "codex"
  let version
  try { version = (await execute(codex, ["--version"])).stdout.trim() } catch { t.skip("official Codex CLI unavailable"); return }
  assert.match(version, /^codex-cli 0\.160\.[01]$/)
  const env = { ...process.env, CODEX_HOME: join(tmp, "home") }
  const first = await installCodex({ env, codex })
  assert.equal(first.changed, true)
  const list = JSON.parse((await execute(codex, ["plugin", "list", "--json"], { env })).stdout)
  assert.equal(list.installed.find((entry) => entry.pluginId === PLUGIN_ID)?.enabled, true)
  const config = join(env.CODEX_HOME, "config.toml")
  const before = await stat(config)
  const content = await readFile(config, "utf8")
  assert.equal((await installCodex({ env, codex })).changed, false)
  assert.equal(await readFile(config, "utf8"), content)
  assert.equal((await stat(config)).mtimeMs, before.mtimeMs)
  // Seed a prior native-plugin version only in this isolated fixture, install it
  // through the real CLI, then verify the bridge upgrades through the same API.
  const entry = list.installed.find((item) => item.pluginId === PLUGIN_ID)
  const oldBundle = join(first.store, "plugins", "codegraph-bridge-0.0.1")
  await rename(entry.source.path, oldBundle)
  const manifestPath = join(oldBundle, ".codex-plugin", "plugin.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.version = "0.0.1"
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const inventoryPath = join(oldBundle, ".bridge-files.json")
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"))
  inventory[".codex-plugin/plugin.json"] = createHash("sha256").update(await readFile(manifestPath)).digest("hex")
  await writeFile(inventoryPath, JSON.stringify(inventory))
  const descriptor = join(first.store, ".agents", "plugins", "marketplace.json")
  await writeFile(descriptor, JSON.stringify({ name: "codegraph-bridge", plugins: [{ name: "codegraph-bridge", source: { source: "local", path: "./plugins/codegraph-bridge-0.0.1" } }] }))
  await execute(codex, ["plugin", "add", PLUGIN_ID, "--json"], { env })
  const oldList = JSON.parse((await execute(codex, ["plugin", "list", "--json"], { env })).stdout)
  assert.equal(oldList.installed.find((item) => item.pluginId === PLUGIN_ID).version, "0.0.1")
  assert.equal((await installCodex({ env, codex })).changed, true)
  const upgraded = JSON.parse((await execute(codex, ["plugin", "list", "--json"], { env })).stdout).installed.find((item) => item.pluginId === PLUGIN_ID)
  assert.equal(upgraded.version, first.version)
  assert.equal(upgraded.source.path, entry.source.path)
  assert.equal(upgraded.enabled, true)
  // 0.160.0 exposes add/remove/list but no disable command; represent a user's
  // existing disabled setting solely inside the temporary test fixture.
  const currentConfig = await readFile(config, "utf8")
  assert.match(currentConfig, /enabled = true/)
  await writeFile(config, currentConfig.replace("enabled = true", "enabled = false"))
  assert.equal((await installCodex({ env, codex })).disabled, true)
  assert.equal(JSON.parse((await execute(codex, ["plugin", "list", "--json"], { env })).stdout).installed.find((entry) => entry.pluginId === PLUGIN_ID).enabled, false)
}))
