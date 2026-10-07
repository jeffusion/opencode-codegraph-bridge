import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, parse } from "node:path"
import { Readable } from "node:stream"
import { createRequire } from "node:module"
import { resolveCodexProjectRoot } from "../src/project.mjs"
import { contextForEvent, runHook } from "../src/codex-hook.mjs"
import { CODEX_PROMPT } from "../src/guidance.mjs"
import { installCodex, packageCodex, pluginFiles, PLUGIN_ID } from "../src/codex-plugin.js"
import { absent, descendants, gone, rpc, until } from "./codex-test-support.mjs"

const pkg = createRequire(import.meta.url)("../package.json")
const hash = (data) => createHash("sha256").update(data).digest("hex")
async function temporary(fn) {
  const root = await mkdtemp(join(tmpdir(), "codex-unit-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}
async function git(root) {
  await mkdir(root, { recursive: true })
  execFileSync("git", ["init", "--quiet", root])
  return root
}
async function tree(root, result = {}, prefix = "") {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const key = join(prefix, entry.name)
    const path = join(root, entry.name)
    const info = await stat(path)
    result[key] = { mtime: info.mtimeMs, inode: info.ino, mode: info.mode }
    if (entry.isDirectory()) await tree(path, result, key)
    else result[key].hash = hash(await readFile(path))
  }
  return result
}
function fake(home) {
  const store = join(home, "codegraph-bridge", "marketplace")
  const state = { installed: [], marketplaces: [], calls: [], failAdd: false }
  state.entry = (version = pkg.version, enabled = true) => ({
    name: "codegraph-bridge", pluginId: PLUGIN_ID, version, enabled,
    source: { source: "local", path: join(store, "plugins", `codegraph-bridge-${version}`) },
    marketplaceSource: { sourceType: "local", source: store },
  })
  state.command = async (binary, args) => {
    state.calls.push([binary, ...args])
    if (binary !== "codex") return "v1"
    if (args.join(" ") === "plugin list --json") return JSON.stringify({ installed: state.installed })
    if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify({ marketplaces: state.marketplaces })
    if (args[1] === "marketplace" && args[2] === "add") {
      state.marketplaces = [{ name: "codegraph-bridge", root: store, marketplaceSource: { sourceType: "local", source: store } }]
      return "{}"
    }
    if (args[1] === "add") {
      if (state.failAdd) throw new Error("simulated plugin add failure")
      state.installed = [state.entry()]
      return "{}"
    }
    throw new Error(`Unexpected command: ${args}`)
  }
  state.install = () => installCodex({ env: { ...process.env, CODEX_HOME: home }, command: state.command })
  state.store = store
  return state
}

test("Codex Git 根：子目录、worktree、符号链接及被污染的 GIT 环境", async () => temporary(async (root) => {
  const repo = await git(join(root, "repo"))
  const child = join(repo, "nested", "deeper")
  await mkdir(child, { recursive: true })
  assert.equal(resolveCodexProjectRoot(child).root, repo)
  await writeFile(join(repo, "sample.js"), "export const sample = 1\n")
  execFileSync("git", ["-C", repo, "add", "sample.js"])
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"])
  const worktree = join(root, "worktree")
  execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", worktree])
  assert.equal(resolveCodexProjectRoot(worktree).root, worktree)
  const linked = join(root, "linked")
  await symlink(child, linked)
  assert.equal(resolveCodexProjectRoot(linked).root, repo)
  const before = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
  try {
    process.env.GIT_DIR = join(worktree, ".git")
    process.env.GIT_WORK_TREE = worktree
    assert.equal(resolveCodexProjectRoot(child).root, repo)
  } finally {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value
  }
  for (const invalid of [null, "", join(root, "missing"), join(repo, "sample.js"), root, parse(root).root, homedir(), dirname(homedir())]) {
    assert.equal(resolveCodexProjectRoot(invalid).root, null, String(invalid))
  }
}))

test("Hook 只为受支持事件与安全 Git cwd 输出 additionalContext", async () => temporary(async (root) => {
  const repo = await git(join(root, "repo"))
  for (const source of ["startup", "resume", "clear", "compact"]) {
    assert.deepEqual(contextForEvent({ hook_event_name: "SessionStart", source, cwd: repo }), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CODEX_PROMPT },
    })
  }
  assert.equal(contextForEvent({ hook_event_name: "SubagentStart", cwd: repo }).hookSpecificOutput.additionalContext, CODEX_PROMPT)
  for (const event of [null, [], {}, { hook_event_name: "SessionStart", source: "other", cwd: repo },
    { hook_event_name: "SessionEnd", cwd: repo }, { hook_event_name: "SubagentStart", cwd: root },
    { hook_event_name: "SessionStart", source: "startup", cwd: homedir() }]) assert.deepEqual(contextForEvent(event), {})
  for (const input of ["{", "null", "x".repeat(65537), JSON.stringify({ hook_event_name: "SubagentStart", cwd: repo })]) {
    let out = ""
    await runHook(Readable.from([input.slice(0, 10), input.slice(10)]), { write: (value) => { out += value } })
    assert.equal(out.split("\n").length, 2)
    const parsed = JSON.parse(out)
    assert.equal(Boolean(parsed.hookSpecificOutput), input.startsWith('{"hook_event_name"'))
  }
}))

test("原生插件固定当前精确版本、保留 CodeGraph 依赖且可独立运行 Hook", async () => temporary(async (root) => {
  assert.equal(pkg.dependencies["@colbymchenry/codegraph"], "^1.6.0")
  const files = await pluginFiles()
  const manifest = JSON.parse(files[".codex-plugin/plugin.json"])
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.skills, "./skills/")
  const mcp = JSON.parse(files[".mcp.json"]).mcpServers.codegraph_bridge
  assert.equal(mcp.command, "node")
  assert.deepEqual(mcp.args.slice(0, 2), ["--input-type=module", "--eval"])
  assert.ok(mcp.args[2].includes(`runNpxMcp("${pkg.name}@${pkg.version}")`))
  assert.equal(mcp.env.CODEGRAPH_NO_DOWNLOAD, "1")
  const target = join(root, "market")
  await packageCodex(target)
  const repo = await git(join(root, "repo"))
  const bundle = join(target, "plugins", `codegraph-bridge-${pkg.version}`)
  const result = execFileSync(process.execPath, [join(bundle, "src", "codex-hook.mjs")], {
    cwd: root, input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: repo }), encoding: "utf8",
  })
  assert.equal(JSON.parse(result).hookSpecificOutput.additionalContext, CODEX_PROMPT)
  await assert.rejects(packageCodex(target), /empty safe directory/)
  const empty = join(root, "empty")
  await mkdir(empty)
  await packageCodex(empty)
  assert.ok(await stat(join(empty, ".agents", "plugins", "marketplace.json")))
}))

test("首次安装通过官方命令，重复同版文件及目录零写", async () => temporary(async (root) => {
  const state = fake(join(root, "home"))
  assert.equal((await state.install()).changed, true)
  const before = await tree(state.store)
  state.calls = []
  assert.deepEqual(await state.install(), { changed: false, disabled: false, version: pkg.version, store: state.store })
  assert.deepEqual(await tree(state.store), before)
  assert.ok(state.calls.every((call) => !call.includes("add")))
}))

for (const mode of ["EOF", "SIGTERM", "SIGINT"]) test(`生成的 npm bootstrap: 保留项目 cwd、独立 prefix、${mode} 清理`, { skip: process.platform !== "linux", timeout: 30_000 }, async () => temporary(async (root) => {
  const bin = join(root, "bin with spaces")
  const project = await git(join(root, "project with spaces"))
  await mkdir(bin)
  await writeFile(join(bin, "npx"), `#!/usr/bin/env node
const { spawn } = require("node:child_process")
const { createInterface } = require("node:readline")
// Observe group cleanup beyond the npm leader, without a registry or daemon.
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { cwd: process.cwd(), args: process.argv.slice(2) } }) + "\\n")
})
`, { mode: 0o755 })
  const generated = JSON.parse((await pluginFiles())[".mcp.json"]).mcpServers.codegraph_bridge
  const client = rpc(generated.command, generated.args, { cwd: project, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  let prefix
  try {
    const result = await client.request("probe", {})
    assert.equal(result.cwd, project)
    assert.equal(result.args[0], "--prefix")
    prefix = result.args[1]
    assert.notEqual(prefix, project)
    assert.deepEqual(await readdir(prefix), [])
    assert.deepEqual(result.args.slice(2), ["--yes", "--prefer-offline", `${pkg.name}@${pkg.version}`, "mcp", "--host", "codex"])
    await until(async () => (await descendants(client.child.pid)).length >= 3, "stub worker not observed")
    const owned = (await descendants(client.child.pid)).map(row => row.pid)
    if (mode === "EOF") client.child.stdin.end()
    else process.kill(client.child.pid, mode)
    await until(() => client.child.exitCode !== null || client.child.signalCode !== null, "bootstrap leader did not stop", 20_000)
    assert.equal((await client.closed).code, mode === "EOF" ? 0 : mode === "SIGTERM" ? 143 : 130)
    await until(() => gone(owned), "bootstrap left running descendants", 10_000)
    assert.equal(await absent(prefix), true)
  } finally { await client.cleanup() }
}))

test("禁用插件保持禁用；已装更高版本不降级且零写", async () => temporary(async (root) => {
  for (const [version, enabled] of [[pkg.version, false], ["999.0.0", true], ["0.0.1", false]]) {
    const state = fake(join(root, version))
    await state.install()
    if (version !== pkg.version) await rename(state.entry().source.path, state.entry(version).source.path)
    state.installed = [state.entry(version, enabled)]
    const before = await tree(state.store)
    state.calls = []
    const result = await state.install()
    assert.equal(result.changed, false)
    assert.equal(result.disabled, !enabled)
    assert.equal(result.version, version)
    assert.deepEqual(await tree(state.store), before)
    assert.ok(state.calls.every((call) => !call.includes("add")))
  }
}))

test("冲突来源、重复安装和不支持的官方响应拒绝，不创建 store", async () => temporary(async (root) => {
  const cases = [
    (s) => { s.marketplaces = [{ name: "codegraph-bridge", root: root, marketplaceSource: { sourceType: "local", source: root } }] },
    (s) => { s.installed = [{ ...s.entry(), pluginId: "codegraph-bridge@other" }] },
    (s) => { s.installed = [{ ...s.entry(), source: { source: "git", path: root } }] },
    (s) => { s.installed = [s.entry(), s.entry()] },
    (s) => { s.installed = null },
    (s) => { s.installed = [{ ...s.entry(), version: "^1.0.0", source: { source: "local", path: join(s.store, "plugins", "codegraph-bridge-^1.0.0") } }] },
  ]
  for (const [index, alter] of cases.entries()) {
    const state = fake(join(root, String(index)))
    alter(state)
    await assert.rejects(state.install())
    await assert.rejects(stat(state.store), { code: "ENOENT" })
    assert.ok(state.calls.every((call) => !call.includes("add")))
  }
  await assert.rejects(installCodex({ env: { CODEX_HOME: "relative" }, command: async () => { throw new Error("must not invoke") } }), /absolute path/)
}))

test("未拥有、符号链接、损坏 bundle 与 descriptor 不覆盖；busy lock 保留", async () => temporary(async (root) => {
  const unowned = fake(join(root, "unowned"))
  await mkdir(unowned.store, { recursive: true })
  await writeFile(join(unowned.store, "keep"), "untouched")
  await assert.rejects(unowned.install(), /unowned/)
  assert.equal(await readFile(join(unowned.store, "keep"), "utf8"), "untouched")
  const outside = join(root, "outside")
  await mkdir(outside)
  const linkedHome = join(root, "linked")
  await symlink(outside, linkedHome)
  await assert.rejects(fake(linkedHome).install(), /Unsafe/)
  assert.deepEqual(await readdir(outside), [])
  for (const kind of ["file", "inventory", "descriptor", "lock"]) {
    const state = fake(join(root, kind))
    await state.install()
    state.installed = []
    const bundle = state.entry().source.path
    if (kind === "file") await writeFile(join(bundle, "src", "codex-hook.mjs"), "modified")
    if (kind === "inventory") await writeFile(join(bundle, ".bridge-files.json"), "{}")
    if (kind === "descriptor") await writeFile(join(state.store, ".agents", "plugins", "marketplace.json"), "{}")
    if (kind === "lock") await mkdir(join(state.store, ".install.lock"))
    const before = await tree(state.store)
    await assert.rejects(state.install(), /modified|inventory|busy/)
    // Failed operations may update the parent mtime by acquiring/removing their own lock.
    const after = await tree(state.store)
    for (const [path, info] of Object.entries(before)) if (info.hash) assert.deepEqual(after[path], info)
    assert.equal(Boolean(after[".install.lock"]), kind === "lock")
  }
}))

test("官方 plugin add 失败释放锁，重试复用完整版本目录", async () => temporary(async (root) => {
  const state = fake(join(root, "home"))
  state.failAdd = true
  await assert.rejects(state.install(), /simulated/)
  await assert.rejects(stat(join(state.store, ".install.lock")), { code: "ENOENT" })
  const bundle = state.entry().source.path
  const before = await tree(bundle)
  state.failAdd = false
  assert.equal((await state.install()).changed, true)
  assert.deepEqual(await tree(bundle), before)
}))

test("锁内复核保护交错升级和禁用状态，不回写 marketplace", async () => temporary(async (root) => {
  for (const [version, enabled] of [["999.0.0", true], [pkg.version, false]]) {
    const state = fake(join(root, String(enabled)))
    await state.install()
    if (version !== pkg.version) await rename(state.entry().source.path, state.entry(version).source.path)
    const original = state.command
    let reads = 0
    state.command = async (binary, args) => {
      if (args.join(" ") === "plugin list --json") {
        // A starts without a match; B installs/disables before A gets its lock.
        state.installed = ++reads === 1 ? [] : [state.entry(version, enabled)]
      }
      return original(binary, args)
    }
    state.install = () => installCodex({ env: { ...process.env, CODEX_HOME: join(root, String(enabled)) }, command: state.command })
    state.calls = []
    const descriptor = join(state.store, ".agents", "plugins", "marketplace.json")
    const before = await readFile(descriptor, "utf8")
    const result = await state.install()
    assert.equal(result.changed, false)
    assert.equal(result.version, version)
    assert.equal(result.disabled, !enabled)
    assert.ok(reads >= 2, "must query installed state again inside the lock")
    assert.ok(state.calls.every((call) => !call.includes("add")))
    assert.equal(await readFile(descriptor, "utf8"), before)
    await assert.rejects(stat(join(state.store, ".install.lock")), { code: "ENOENT" })
  }
}))
