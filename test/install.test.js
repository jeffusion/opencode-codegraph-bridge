import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parse } from "jsonc-parser"
import { run } from "../src/cli.js"
import { writeNew } from "../src/config-file.js"

const require = createRequire(import.meta.url)
const { name, version } = require("../package.json")
const execFileAsync = promisify(execFile)

async function tempRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-install-"))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function output() {
  let out = ""
  let err = ""
  return { stdout: { write: (value) => { out += value } }, stderr: { write: (value) => { err += value } }, text: () => ({ out, err }) }
}

async function install(root, args = ["install"]) {
  const stream = output()
  const code = await run({ args, env: { ...process.env, XDG_CONFIG_HOME: join(root, "xdg") }, ...stream })
  return { code, ...stream.text() }
}

test("空目录创建标准配置，重复执行零写入", async () => {
  await tempRoot(async (root) => {
    const first = await install(root)
    const file = join(root, "xdg", "opencode", "opencode.json")
    assert.equal(first.code, 0)
    assert.match(first.out, /Restart OpenCode/)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { $schema: "https://opencode.ai/config.json", plugin: [`${name}@${version}`] })
    const before = await stat(file)
    const content = await readFile(file, "utf8")
    const second = await install(root)
    const after = await stat(file)
    assert.equal(second.code, 0)
    assert.equal(await readFile(file, "utf8"), content)
    assert.equal(after.mtimeMs, before.mtimeMs)
  })
})

test("JSONC tuple 仅替换 spec 并保留 disabled、注释、CRLF 和参数", async () => {
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    const file = join(directory, "opencode.jsonc")
    const original = `{"plugin": [["${name}@0.0.1", { "enabled": false, "keep": true }]],\r\n// retained\r\n"x": 1}\r\n`
    await writeFile(file, original)
    const result = await install(root)
    const changed = await readFile(file, "utf8")
    assert.equal(result.code, 0)
    assert.match(result.out, /remains disabled/)
    assert.match(changed, /\r\n/)
    assert.match(changed, /retained/)
    assert.deepEqual(parse(changed).plugin, [[`${name}@${version}`, { enabled: false, keep: true }]])
  })
})

test("已有条目优先其所在文件；无条目按 jsonc、json、legacy 追加", async () => {
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    const legacy = join(directory, "config.json")
    const jsonc = join(directory, "opencode.jsonc")
    await writeFile(legacy, JSON.stringify({ plugin: [`${name}@0.0.1`] }))
    await writeFile(jsonc, JSON.stringify({ plugin: ["other"] }))
    assert.equal((await install(root)).code, 0)
    assert.deepEqual(JSON.parse(await readFile(legacy, "utf8")).plugin, [`${name}@${version}`])
    assert.deepEqual(JSON.parse(await readFile(jsonc, "utf8")).plugin, ["other"])
  })
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "config.json"), JSON.stringify({ plugin: ["legacy"] }))
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugin: ["json"] }))
    await writeFile(join(directory, "opencode.jsonc"), "{ // comment\n \"plugin\": [\"jsonc\"] }")
    assert.equal((await install(root)).code, 0)
    assert.deepEqual(parse(await readFile(join(directory, "opencode.jsonc"), "utf8")).plugin, ["jsonc", `${name}@${version}`])
  })
})

test("追加 plugin 只插入新元素，保留数组中的注释和不规则空白", async () => {
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    const file = join(directory, "opencode.jsonc")
    await writeFile(file, `{"plugin":[ "one" , // keep\n["two",false] ],"x":1}`)
    assert.equal((await install(root)).code, 0)
    const changed = await readFile(file, "utf8")
    assert.match(changed, /\[ "one" , \/\/ keep/)
    assert.match(changed, /\["two",false\]/)
    assert.deepEqual(parse(changed).plugin, ["one", ["two", false], `${name}@${version}`])
  })
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    const file = join(directory, "opencode.json")
    await writeFile(file, '{"keep":true}')
    assert.equal((await install(root)).code, 0)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { keep: true, plugin: [`${name}@${version}`] })
  })
})

test("重复、unsupported、较高 pin 和不透明插件安全处理", async () => {
  for (const plugin of [[name, name], [`${name}@^1.0.0`], ["file:///plugin.js"], ["./plugin.js"], ["/plugin.js"], ["~/plugin.js"], ["owner/repo"]]) {
    await tempRoot(async (root) => {
      const directory = join(root, "xdg", "opencode")
      await mkdir(directory, { recursive: true })
      const file = join(directory, "opencode.json")
      const original = JSON.stringify({ plugin })
      await writeFile(file, original)
      const result = await install(root)
      assert.equal(result.code, 1)
      assert.equal(await readFile(file, "utf8"), original)
    })
  }
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    const file = join(directory, "opencode.json")
    const original = JSON.stringify({ plugin: [`${name}@999.0.0`] })
    await writeFile(file, original)
    const result = await install(root)
    assert.equal(result.code, 0)
    assert.match(result.out, new RegExp(`Already registered ${name}@999\\.0\\.0`))
    assert.equal(await readFile(file, "utf8"), original)
  })
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    const file = join(directory, "opencode.json")
    await writeFile(file, JSON.stringify({ plugin: [name, "./other-plugin.js"] }))
    assert.equal((await install(root)).code, 0)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugin, [`${name}@${version}`, "./other-plugin.js"])
  })
})

test("symlink CLI 子进程会执行真实模块", async () => {
  await tempRoot(async (root) => {
    const link = join(root, "opencode-codegraph-bridge")
    await symlink(resolve("src/cli.js"), link)
    const env = { ...process.env, XDG_CONFIG_HOME: join(root, "xdg") }
    const help = await execFileAsync(process.execPath, [link, "--help"], { env })
    const current = await execFileAsync(process.execPath, [link, "--version"], { env })
    const installed = await execFileAsync(process.execPath, [link, "install"], { env })
    assert.match(help.stdout, /Usage:/)
    assert.equal(current.stdout, `${version}\n`)
    assert.match(installed.stdout, /Registered/)
    assert.deepEqual(JSON.parse(await readFile(join(root, "xdg", "opencode", "opencode.json"), "utf8")).plugin, [`${name}@${version}`])
  })
})

test("新文件排他发布，失败不会留下目标", async () => {
  await tempRoot(async (root) => {
    const occupied = join(root, "occupied.json")
    await writeFile(occupied, "keep")
    assert.equal(await writeNew(occupied, "new"), false)
    assert.equal(await readFile(occupied, "utf8"), "keep")
    const missing = join(root, "missing", "config.json")
    assert.equal(await writeNew(missing, "new"), false)
    await assert.rejects(readFile(missing))
  })
})

test("help、version、未知参数和安全失败不写入", async () => {
  await tempRoot(async (root) => {
    const help = await install(root, ["--help"])
    const current = await install(root, ["--version"])
    const invalid = await install(root, ["--wat"])
    assert.equal(help.code, 0)
    assert.equal(current.out, `${version}\n`)
    assert.equal(invalid.code, 1)
    await assert.rejects(readFile(join(root, "xdg", "opencode", "opencode.json")))
    const stream = output()
    assert.equal(await run({ args: ["install"], env: { ...process.env, XDG_CONFIG_HOME: "relative" }, ...stream }), 1)
  })
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    const file = join(directory, "opencode.json")
    await writeFile(file, "{")
    assert.equal((await install(root)).code, 1)
    await writeFile(file, JSON.stringify({ plugin: [] }))
    await chmod(file, 0o444)
    assert.equal((await install(root)).code, 1)
    await chmod(file, 0o644)
    const target = join(directory, "target.json")
    await writeFile(target, JSON.stringify({ plugin: [] }))
    await rm(file)
    await symlink(target, file)
    assert.equal((await install(root)).code, 1)
  })
  await tempRoot(async (root) => {
    const outside = join(root, "outside")
    const linkedXdg = join(root, "linked-xdg")
    await mkdir(outside)
    await symlink(outside, linkedXdg)
    const stream = output()
    assert.equal(await run({ args: ["install"], env: { ...process.env, XDG_CONFIG_HOME: linkedXdg }, ...stream }), 1)
    await assert.rejects(stat(join(outside, "opencode")))
  })
  await tempRoot(async (root) => {
    const readonlyXdg = join(root, "readonly-xdg")
    await mkdir(readonlyXdg)
    await chmod(readonlyXdg, 0o555)
    const stream = output()
    assert.equal(await run({ args: ["install"], env: { ...process.env, XDG_CONFIG_HOME: readonlyXdg }, ...stream }), 1)
    await chmod(readonlyXdg, 0o755)
  })
  await tempRoot(async (root) => {
    const readonlyParent = join(root, "readonly-parent")
    const writableConfig = join(readonlyParent, "xdg", "opencode")
    await mkdir(writableConfig, { recursive: true })
    await chmod(readonlyParent, 0o555)
    try {
      const stream = output()
      assert.equal(await run({ args: ["install"], env: { ...process.env, XDG_CONFIG_HOME: join(readonlyParent, "xdg") }, ...stream }), 0)
      assert.deepEqual(JSON.parse(await readFile(join(writableConfig, "opencode.json"), "utf8")).plugin, [`${name}@${version}`])
    } finally {
      await chmod(readonlyParent, 0o755)
    }
  })
})

test("busy lock 与并发安装不会覆盖配置", async () => {
  await tempRoot(async (root) => {
    const directory = join(root, "xdg", "opencode")
    await mkdir(directory, { recursive: true })
    await mkdir(join(directory, ".opencode-codegraph-bridge.update.lock"))
    assert.equal((await install(root)).code, 1)
    await rm(join(directory, ".opencode-codegraph-bridge.update.lock"), { recursive: true })
    const results = await Promise.all([install(root), install(root)])
    assert.ok(results.some((result) => result.code === 0))
    const file = join(directory, "opencode.json")
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugin, [`${name}@${version}`])
  })
})
