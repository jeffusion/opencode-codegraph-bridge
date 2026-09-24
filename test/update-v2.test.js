import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { updateV2PluginVersion } from "../src/update-v2.js"

const PACKAGE = "opencode-codegraph-bridge"
const FROM = `${PACKAGE}@0.1.0`
const TO = "99.0.0"

async function inTemp(callback) {
  const dir = await mkdtemp(join(tmpdir(), "plugin-update-v2-"))
  try {
    await callback(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("v2 plugins string 可更新，保留 JSONC 与所有其它 entries", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "opencode.jsonc")
    const original = `{
  // keep comment
  "plugins": ["${PACKAGE}", "other-plugin@1.2.3", "@opencode/plugin@2.0.1"],
  "other": { "keep": true }
}
`
    await writeFile(path, original)
    assert.equal(await updateV2PluginVersion(path, PACKAGE, TO), true)
    const changed = await readFile(path, "utf8")
    assert.equal(changed, original.replace(`"${PACKAGE}"`, `"${PACKAGE}@${TO}"`))
    assert.match(changed, /other-plugin@1\.2\.3/)
    assert.match(changed, /@opencode\/plugin@2\.0\.1/)
  })
})

test("v2 plugins object 固定版本只改 package 并保留 options", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "config.json")
    const entry = { package: FROM, options: { enabled: true, profile: "keep" } }
    const original = JSON.stringify({ plugins: [entry, "other"] }, null, 2)
    await writeFile(path, original)
    assert.equal(await updateV2PluginVersion(path, entry, TO), true)
    const saved = JSON.parse(await readFile(path, "utf8"))
    assert.deepEqual(saved.plugins[0], { package: `${PACKAGE}@${TO}`, options: entry.options })
    assert.equal(saved.plugins[1], "other")
  })
})

test("@latest 字符串与 object entry 可更新为固定稳定版本", async () => {
  await inTemp(async (dir) => {
    const stringPath = join(dir, "latest-string.json")
    const stringOriginal = JSON.stringify({ plugins: [`${PACKAGE}@latest`] })
    await writeFile(stringPath, stringOriginal)
    assert.equal(await updateV2PluginVersion(stringPath, `${PACKAGE}@latest`, TO), true)
    assert.deepEqual(JSON.parse(await readFile(stringPath, "utf8")), { plugins: [`${PACKAGE}@${TO}`] })

    const objectPath = join(dir, "latest-object.json")
    const entry = { package: `${PACKAGE}@latest`, options: { enabled: true } }
    await writeFile(objectPath, JSON.stringify({ plugins: [entry] }))
    assert.equal(await updateV2PluginVersion(objectPath, entry, TO), true)
    assert.deepEqual(JSON.parse(await readFile(objectPath, "utf8")), {
      plugins: [{ package: `${PACKAGE}@${TO}`, options: entry.options }],
    })
  })
})

test("legacy plugin、外部 @opencode/plugin、disabled 与非稳定 spec 不写入", async () => {
  await inTemp(async (dir) => {
    const legacyPath = join(dir, "legacy.json")
    const legacy = JSON.stringify({ plugin: [PACKAGE], plugins: ["other"] })
    await writeFile(legacyPath, legacy)
    assert.equal(await updateV2PluginVersion(legacyPath, PACKAGE, TO), false)
    assert.equal(await readFile(legacyPath, "utf8"), legacy)

    const externalPath = join(dir, "external.json")
    const external = JSON.stringify({ plugins: ["@opencode/plugin@2.0.15", "other"] })
    await writeFile(externalPath, external)
    assert.equal(await updateV2PluginVersion(externalPath, "@opencode/plugin@2.0.15", TO), false)
    assert.equal(await readFile(externalPath, "utf8"), external)

    const disabledPath = join(dir, "disabled.json")
    const disabled = { package: FROM, options: { enabled: false } }
    const disabledContent = JSON.stringify({ plugins: [disabled] })
    await writeFile(disabledPath, disabledContent)
    assert.equal(await updateV2PluginVersion(disabledPath, disabled, TO), false)
    assert.equal(await readFile(disabledPath, "utf8"), disabledContent)

    const pinnedPath = join(dir, "range.json")
    const ranged = JSON.stringify({ plugins: [`${PACKAGE}@^0.1.0`] })
    await writeFile(pinnedPath, ranged)
    assert.equal(await updateV2PluginVersion(pinnedPath, `${PACKAGE}@^0.1.0`, TO), false)
    assert.equal(await readFile(pinnedPath, "utf8"), ranged)
  })
})

test("重复目标、tuple、重复键、损坏 JSONC 及目标/祖先符号链接安全跳过", async () => {
  await inTemp(async (dir) => {
    const duplicate = join(dir, "duplicate.json")
    await writeFile(duplicate, JSON.stringify({ plugins: [PACKAGE, PACKAGE] }))
    assert.equal(await updateV2PluginVersion(duplicate, PACKAGE, TO), false)

    const tuple = join(dir, "tuple.json")
    const tupleContents = JSON.stringify({ plugins: [[PACKAGE, { enabled: true }]] })
    await writeFile(tuple, tupleContents)
    assert.equal(await updateV2PluginVersion(tuple, PACKAGE, TO), false)
    assert.equal(await readFile(tuple, "utf8"), tupleContents)

    const duplicateKeys = join(dir, "keys.json")
    await writeFile(duplicateKeys, `{"plugins":["${PACKAGE}"],"plugins":[]}`)
    assert.equal(await updateV2PluginVersion(duplicateKeys, PACKAGE, TO), false)
    const malformed = join(dir, "broken.jsonc")
    await writeFile(malformed, `{"plugins":["${PACKAGE}"`)
    assert.equal(await updateV2PluginVersion(malformed, PACKAGE, TO), false)

    const target = join(dir, "target.json")
    const link = join(dir, "link.json")
    await writeFile(target, JSON.stringify({ plugins: [PACKAGE] }))
    await symlink(target, link)
    assert.equal(await updateV2PluginVersion(link, PACKAGE, TO), false)
    const linkedDir = join(dir, "linked-dir")
    await symlink(dir, linkedDir)
    assert.equal(await updateV2PluginVersion(join(linkedDir, "target.json"), PACKAGE, TO), false)
  })
})

test("低于运行包/固定版本时不降级；并发至多写入一次", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "opencode.json")
    const original = JSON.stringify({ plugins: [PACKAGE] })
    await writeFile(path, original)
    assert.equal(await updateV2PluginVersion(path, PACKAGE, "0.1.0"), false)
    assert.equal(await readFile(path, "utf8"), original)

    const pinnedPath = join(dir, "pinned.json")
    const pinned = `${PACKAGE}@1.0.0`
    const pinnedContent = JSON.stringify({ plugins: [pinned] })
    await writeFile(pinnedPath, pinnedContent)
    assert.equal(await updateV2PluginVersion(pinnedPath, pinned, "1.0.0"), false)
    assert.equal(await readFile(pinnedPath, "utf8"), pinnedContent)

    const results = await Promise.all([
      updateV2PluginVersion(path, PACKAGE, TO),
      updateV2PluginVersion(path, PACKAGE, TO),
    ])
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal(await readFile(path, "utf8"), JSON.stringify({ plugins: [`${PACKAGE}@${TO}`] }))
  })
})

test("可在目标锁内执行最终来源校验并拒绝过期候选", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "opencode.json")
    const original = JSON.stringify({ plugins: [PACKAGE] })
    await writeFile(path, original)
    let validations = 0
    assert.equal(await updateV2PluginVersion(path, PACKAGE, TO, {
      validate: async () => { validations++; return false },
    }), false)
    assert.equal(validations, 1)
    assert.equal(await readFile(path, "utf8"), original)
  })
})
