import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { installCodex, PLUGIN_ID } from "../src/codex-plugin.js"
import { runCodexAutoUpdate } from "../src/codex-auto-update.mjs"
import { absent, fixture } from "./codex-test-support.mjs"

const execute = promisify(execFile)
const pkg = createRequire(import.meta.url)("../package.json")
test("官方 Codex CLI：后台升级自有插件，保留旧 bundle，尊重禁用状态", { timeout: 120_000 }, async (t) => fixture(async (tmp) => {
  const codex = process.env.CODEX_TEST_BINARY || "codex"
  try { await execute(codex, ["--version"]) } catch { t.skip("official Codex CLI unavailable"); return }
  const env = { ...process.env, CODEX_HOME: join(tmp, "home"), CODEGRAPH_BRIDGE_AUTO_UPDATE: "1" }
  await mkdir(env.CODEX_HOME)
  const first = await installCodex({ env, codex })
  assert.equal(first.changed, true)
  const config = join(env.CODEX_HOME, "config.toml")
  const original = await readFile(config, "utf8")
  await writeFile(config, original.replace("enabled = true", "enabled = false"))
  let fetched = false
  assert.equal(await runCodexAutoUpdate({ env, codex, fetch: async () => { fetched = true; throw new Error("must not fetch") } }), false)
  assert.equal(fetched, false)
  await writeFile(config, original)
  const oldBundle = join(first.store, "plugins", `codegraph-bridge-${pkg.version}`)
  const oldMcp = await readFile(join(oldBundle, ".mcp.json"), "utf8")
  const next = `${Number(pkg.version.split(".")[0]) + 1}.0.0`
  let temporary
  const messages = []
  const updated = await runCodexAutoUpdate({ env, codex,
    fetch: async () => new Response(JSON.stringify({ name: pkg.name, version: next })),
    prepare: async (version, directory) => {
      temporary = directory
      const candidate = join(directory, "candidate")
      await mkdir(candidate)
      await cp(resolve("src"), join(candidate, "src"), { recursive: true })
      await writeFile(join(candidate, "package.json"), JSON.stringify({ ...pkg, version }))
      await symlink(resolve("node_modules"), join(candidate, "node_modules"), "dir")
      return candidate
    }, log: (message) => messages.push(message),
  })
  assert.equal(updated, true, JSON.stringify(messages))
  const installed = JSON.parse((await execute(codex, ["plugin", "list", "--json"], { env })).stdout).installed.find((entry) => entry.pluginId === PLUGIN_ID)
  assert.equal(installed.version, next)
  assert.equal(installed.enabled, true)
  assert.equal(await readFile(join(oldBundle, ".mcp.json"), "utf8"), oldMcp)
  assert.equal(await absent(temporary), true)
  const servers = JSON.parse((await execute(codex, ["mcp", "list", "--json"], { env })).stdout)
  assert.ok(servers.find((server) => server.name === "codegraph_bridge").transport.args.some((arg) => arg.includes(`${pkg.name}@${next}`)))
}))
