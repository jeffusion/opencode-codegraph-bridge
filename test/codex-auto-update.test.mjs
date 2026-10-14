import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { installCodex, PLUGIN_ID } from "../src/codex-plugin.js"
import { runCodexAutoUpdate, runUpdateCommand } from "../src/codex-auto-update.mjs"
import { absent, gone, until } from "./codex-test-support.mjs"

const pkg = createRequire(import.meta.url)("../package.json")
const future = `${Number(pkg.version.split(".")[0]) + 1}.0.0`
const metadata = (version = future) => new Response(JSON.stringify({ name: pkg.name, version }))
async function fixture(task) {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-update-test-"))
  try { await task(root) } finally { await rm(root, { recursive: true, force: true }) }
}
async function installed(root) {
  const home = join(root, "home")
  const env = { ...process.env, CODEX_HOME: home }
  delete env.CODEGRAPH_BRIDGE_AUTO_UPDATE
  const store = join(home, "codegraph-bridge", "marketplace")
  const state = { entries: [], markets: [], fetches: 0, adds: 0, preparations: 0, logs: [], serverEnabled: true }
  const entry = (version) => ({ name: "codegraph-bridge", pluginId: PLUGIN_ID, version, enabled: true,
    source: { source: "local", path: join(store, "plugins", `codegraph-bridge-${version}`) },
    marketplaceSource: { sourceType: "local", source: store } })
  state.command = async (binary, args) => {
    if (binary !== "codex") return "v1"
    const key = args.join(" ")
    if (key === "plugin list --json") return JSON.stringify({ installed: state.entries })
    if (key === "plugin marketplace list --json") return JSON.stringify({ marketplaces: state.markets })
    if (key === "mcp list --json") {
      const bundled = JSON.parse(await readFile(join(state.entries[0].source.path, ".mcp.json"), "utf8")).mcpServers.codegraph_bridge
      return JSON.stringify([{ name: "codegraph_bridge", enabled: state.serverEnabled,
        transport: { type: "stdio", command: bundled.command, args: bundled.args } }])
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
      state.markets = [{ name: "codegraph-bridge", root: store, marketplaceSource: { sourceType: "local", source: store } }]
      return "{}"
    }
    if (args[0] === "plugin" && args[1] === "add") {
      state.adds++
      const descriptor = JSON.parse(await readFile(join(store, ".agents", "plugins", "marketplace.json"), "utf8"))
      const bundle = resolve(store, descriptor.plugins[0].source.path)
      const manifest = JSON.parse(await readFile(join(bundle, ".codex-plugin", "plugin.json"), "utf8"))
      state.entries = [entry(manifest.version)]
      return "{}"
    }
    throw new Error(`Unexpected command: ${args}`)
  }
  await installCodex({ env, command: state.command })
  await writeFile(join(home, "config.toml"), `[plugins."${PLUGIN_ID}"]\nenabled = true\n`)
  state.adds = 0
  state.options = {
    env, command: state.command, now: () => 1_000_000_000,
    fetch: async () => { state.fetches++; return metadata() },
    prepare: async (version, temporary) => {
      state.preparations++
      state.temporary = temporary
      const candidate = join(temporary, "candidate")
      await mkdir(candidate)
      await cp(resolve("src"), join(candidate, "src"), { recursive: true })
      await writeFile(join(candidate, "package.json"), JSON.stringify({ ...pkg, version }))
      await symlink(resolve("node_modules"), join(candidate, "node_modules"), "dir")
      return candidate
    },
    log: (message) => state.logs.push(message),
  }
  state.home = home
  state.store = store
  return state
}

test("Codex 自动升级：复用安装器更新整个插件，保持旧 bundle 与当前配置，清理下载目录", async () => fixture(async (root) => {
  const state = await installed(root)
  const old = join(state.entries[0].source.path, ".mcp.json")
  const bytes = await readFile(old, "utf8")
  const config = await readFile(join(state.home, "config.toml"), "utf8")
  assert.equal(await runCodexAutoUpdate(state.options), true)
  assert.equal(state.entries[0].version, future)
  assert.equal(state.adds, 1)
  assert.equal(await readFile(old, "utf8"), bytes)
  assert.equal(await readFile(join(state.home, "config.toml"), "utf8"), config)
  assert.match(await readFile(join(state.entries[0].source.path, ".mcp.json"), "utf8"), new RegExp(`${pkg.name}@${future.replaceAll(".", "\\.")}`))
  assert.equal(await absent(state.temporary), true)
  assert.ok(state.logs.some((line) => line.includes("restart Codex")))
}))

test("Codex 自动升级：已是最新只检查一次，24 小时后重新检查", async () => fixture(async (root) => {
  const state = await installed(root)
  state.options.fetch = async () => { state.fetches++; return metadata(pkg.version) }
  assert.equal(await runCodexAutoUpdate(state.options), false)
  assert.equal(await runCodexAutoUpdate(state.options), false)
  assert.equal(state.fetches, 1)
  state.options.now = () => 1_000_000_000 + 24 * 60 * 60 * 1000
  assert.equal(await runCodexAutoUpdate(state.options), false)
  assert.equal(state.fetches, 2)
  assert.equal(state.adds, 0)
}))

test("Codex 自动升级：默认 npm 下载指定稳定版本且不执行安装脚本", async () => fixture(async (root) => {
  const state = await installed(root)
  const prepare = state.options.prepare
  const command = state.command
  let downloaded = false
  state.options.prepare = undefined
  state.options.command = async (binary, args, env) => {
    if (binary === "npm" && args[0] === "install") {
      downloaded = true
      assert.deepEqual(args, ["install", "--prefix", args[2], "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `${pkg.name}@${future}`])
      const candidate = await prepare(future, args[2])
      await mkdir(join(args[2], "node_modules"))
      await rename(candidate, join(args[2], "node_modules", pkg.name))
      return ""
    }
    return command(binary, args, env)
  }
  assert.equal(await runCodexAutoUpdate(state.options), true)
  assert.equal(downloaded, true)
  assert.equal(await absent(state.temporary), true)
}))

test("Codex 自动升级：提交失败恢复原目录描述符，下次启动可以重试", async () => fixture(async (root) => {
  for (const mode of ["command-failed", "config-changed-after-stage", "committed-but-response-failed"]) {
    const state = await installed(join(root, mode))
    const descriptor = join(state.store, ".agents", "plugins", "marketplace.json")
    const original = await readFile(descriptor, "utf8")
    const command = state.command
    const originalPrepare = state.options.prepare
    if (mode === "config-changed-after-stage") {
      const prepare = state.options.prepare
      state.options.prepare = async (...args) => {
        const candidate = await prepare(...args)
        const source = join(candidate, "src", "codex-plugin.js")
        const content = await readFile(source, "utf8")
        await writeFile(source, content.replace("const bundle = await prepareVersion(store)",
          `const bundle = await prepareVersion(store)\n    await writeFile(join(home, "config.toml"), "# user changed config\\n")`))
        return candidate
      }
    } else {
      state.options.command = async (binary, args, env) => {
        if (binary === "codex" && args[0] === "plugin" && args[1] === "add") {
          if (mode === "committed-but-response-failed") await command(binary, args, env)
          throw new Error("cancelled during commit")
        }
        return command(binary, args, env)
      }
    }
    assert.equal(await runCodexAutoUpdate(state.options), false, mode)
    assert.equal(await absent(join(state.store, ".install.lock")), true, mode)
    assert.equal(await absent(state.temporary), true, mode)
    if (mode === "committed-but-response-failed") {
      assert.equal(state.entries[0].version, future)
      assert.match(await readFile(descriptor, "utf8"), new RegExp(`codegraph-bridge-${future.replaceAll(".", "\\.")}`))
    } else {
      assert.equal(await readFile(descriptor, "utf8"), original, mode)
      state.options.command = command
      // Keep the user's changed config and retry with a fresh snapshot.
      state.options.prepare = originalPrepare
      assert.equal(await runCodexAutoUpdate(state.options), true, mode)
    }
  }
}))

test("Codex 自动升级：显式关闭、禁用插件/MCP、本地替换来源均不请求 npm", async () => fixture(async (root) => {
  for (const mode of ["optout", "plugin-disabled", "mcp-disabled", "custom-source"]) {
    const state = await installed(join(root, mode))
    if (mode === "optout") state.options.env.CODEGRAPH_BRIDGE_AUTO_UPDATE = "0"
    if (mode === "plugin-disabled") state.entries[0].enabled = false
    if (mode === "mcp-disabled") state.serverEnabled = false
    if (mode === "custom-source") state.entries[0].source.path = root
    assert.equal(await runCodexAutoUpdate(state.options), false, mode)
    assert.equal(state.fetches, 0, mode)
    assert.equal(state.adds, 0, mode)
  }
}))

test("Codex 自动升级：恢复查询也失败时保留提交记录，下次可重试；外部修改不回滚", async () => fixture(async (root) => {
  for (const mode of ["recovery-unavailable", "manual-after-recovery-unavailable", "descriptor-customized"]) {
    const state = await installed(join(root, mode))
    const command = state.command
    const descriptor = join(state.store, ".agents", "plugins", "marketplace.json")
    const journal = join(state.store, ".install-pending.json")
    const custom = "user customized marketplace\n"
    let failed = false
    state.options.command = async (binary, args, env) => {
      if (binary === "codex" && args[0] === "plugin" && args[1] === "add") {
        failed = true
        if (mode === "descriptor-customized") await writeFile(descriptor, custom)
        throw new Error("commit unavailable")
      }
      if (failed && mode !== "descriptor-customized" && args.join(" ") === "plugin list --json") throw new Error("recovery unavailable")
      return command(binary, args, env)
    }
    assert.equal(await runCodexAutoUpdate(state.options), false)
    assert.equal(await absent(journal), false)
    assert.equal(await absent(join(state.store, ".install.lock")), true)
    state.options.command = command
    if (mode === "manual-after-recovery-unavailable") {
      const temporary = join(root, mode, "manual")
      await mkdir(temporary)
      const next = `${Number(pkg.version.split(".")[0]) + 1}.0.1`
      const candidate = await state.options.prepare(next, temporary)
      const installer = await import(pathToFileURL(join(candidate, "src", "codex-plugin.js")).href)
      assert.equal((await installer.installCodex({ env: state.options.env, command })).changed, true)
      assert.equal(state.entries[0].version, next)
      assert.equal(await absent(journal), true)
    } else if (mode === "recovery-unavailable") {
      assert.equal(await runCodexAutoUpdate(state.options), true)
      assert.equal(await absent(journal), true)
      assert.equal(state.entries[0].version, future)
    } else {
      assert.equal(await readFile(descriptor, "utf8"), custom)
      assert.equal(await runCodexAutoUpdate(state.options), false)
      assert.equal(await readFile(descriptor, "utf8"), custom)
    }
  }
}))

test("Codex 自动升级：下载准备期间用户禁用插件，不重新启用或改注册", async () => fixture(async (root) => {
  const state = await installed(root)
  const prepare = state.options.prepare
  state.options.prepare = async (...args) => {
    state.entries[0].enabled = false
    await writeFile(join(state.home, "config.toml"), `[plugins."${PLUGIN_ID}"]\nenabled = false\n`)
    return prepare(...args)
  }
  assert.equal(await runCodexAutoUpdate(state.options), false)
  assert.equal(state.entries[0].enabled, false)
  assert.equal(state.adds, 0)
  assert.equal(await absent(state.temporary), true)
}))

test("Codex 自动升级：配置/插件被修改、缓存是符号链接时保持原文件", async () => fixture(async (root) => {
  const modified = await installed(join(root, "modified"))
  await writeFile(join(modified.entries[0].source.path, "src", "guidance.mjs"), "user customization")
  assert.equal(await runCodexAutoUpdate(modified.options), false)
  assert.equal(modified.fetches, 0)
  const state = await installed(join(root, "linked"))
  const outside = join(root, "outside")
  await writeFile(outside, "keep")
  await symlink(outside, join(state.home, "codegraph-bridge", "auto-update.json"))
  assert.equal(await runCodexAutoUpdate(state.options), false)
  assert.equal(state.fetches, 0)
  assert.equal(await readFile(outside, "utf8"), "keep")
}))

test("Codex 自动升级：并发会话只有一个更新者", async () => fixture(async (root) => {
  const state = await installed(root)
  let release
  const blocked = new Promise((done) => { release = done })
  state.options.fetch = async () => { state.fetches++; await blocked; return metadata() }
  const first = runCodexAutoUpdate(state.options)
  await until(() => state.fetches === 1, "first updater did not start")
  const second = runCodexAutoUpdate(state.options)
  assert.equal(await second, false)
  release()
  assert.equal(await first, true)
  assert.equal(state.fetches, 1)
  assert.equal(state.adds, 1)
}))

test("Codex 自动升级：网络/非法版本失败不升级，下次启动可以重试", async () => fixture(async (root) => {
  const state = await installed(root)
  for (const response of [() => { throw new Error("offline") }, () => metadata("1.0.0-beta.1"), () => new Response('x'.repeat(70 * 1024)), () => metadata("0.0.1")]) {
    state.options.fetch = async () => { state.fetches++; return response() }
    assert.equal(await runCodexAutoUpdate(state.options), false)
    assert.equal(state.adds, 0)
  }
  assert.equal(state.fetches, 4)
}))

test("Codex 自动升级：忽略 abort 的 fetch 也有检查超时，迟到响应不触发安装", async () => fixture(async (root) => {
  const state = await installed(root)
  state.options.checkTimeoutMs = 10
  let delivered = false
  state.options.fetch = async () => new Promise((done) => setTimeout(() => { delivered = true; done(metadata()) }, 50))
  assert.equal(await runCodexAutoUpdate(state.options), false)
  assert.equal(delivered, false)
  await until(() => delivered, "late response did not settle")
  assert.equal(state.preparations, 0)
  assert.equal(state.adds, 0)
}))

test("Codex 更新命令：取消后等待子进程退出再清理", async () => fixture(async (root) => {
  const marker = join(root, "child.pid")
  const controller = new AbortController()
  const child = runUpdateCommand(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`], process.env, controller.signal)
  const failure = assert.rejects(child)
  await until(async () => !await absent(marker), "update child did not start")
  const pid = Number(await readFile(marker, "utf8"))
  controller.abort()
  await failure
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
}))

test("Codex 更新命令：取消会强制清理忽略 TERM 且继承管道的后代", { skip: process.platform !== "linux", timeout: 10_000 }, async () => fixture(async (root) => {
  const marker = join(root, "descendant.pid")
  const controller = new AbortController()
  const descendant = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`
  const wrapper = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'}); setInterval(() => {}, 1000)`
  const running = runUpdateCommand(process.execPath, ["-e", wrapper], process.env, controller.signal)
  const failure = assert.rejects(running)
  await until(async () => !await absent(marker), "descendant did not start")
  const pid = Number(await readFile(marker, "utf8"))
  const started = Date.now()
  controller.abort()
  await failure
  assert.ok(Date.now() - started < 4_500, "cancellation waited beyond the process-tree kill window")
  await until(() => gone([pid]), "cancelled update left a live descendant")
}))
