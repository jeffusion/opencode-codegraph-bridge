import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { createCodeGraphPlugin } from "../src/internal.js"
import { createVersionUpdater, PACKAGE_NAME, REGISTRY_URL } from "../src/update.js"

// Keep updater tests independent from the repository package version.
const TEST_CURRENT_VERSION = "0.1.1"
const TEST_LATEST_VERSION = "0.2.0"

async function tempRoot(prefix, callback) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function localConfig(file, entry = PACKAGE_NAME) {
  return {
    plugin: [entry],
    plugin_origins: [{ spec: entry, source: file, scope: "local" }],
  }
}

function latestResponse(name = PACKAGE_NAME, version = TEST_LATEST_VERSION) {
  return { ok: true, text: async () => JSON.stringify({ name, version }) }
}

function testUpdater(options = {}) {
  return createVersionUpdater({ version: TEST_CURRENT_VERSION, ...options })
}

test("更新 JSONC tuple 时只替换 spec 并保留注释、选项和 CRLF", async () => {
  await tempRoot("codegraph-bridge-update-jsonc-", async (root) => {
    const file = join(root, "opencode.jsonc")
    const entry = [PACKAGE_NAME, { enabled: false, profile: "keep" }]
    const slimEntry = "some-slim-plugin"
    const fileEntry = "file:///tmp/other-plugin.js"
    const original = "{\r\n  // preserve this comment\r\n  \"plugin\": [[\"opencode-codegraph-bridge\", { \"enabled\": false, \"profile\": \"keep\" }]],\r\n  \"other\": { \"keep\": true }\r\n}\r\n"
    await writeFile(file, original)
    let calls = 0
    let requestedUrl = ""
    const update = testUpdater({
      fetch: async (url) => {
        calls += 1
        requestedUrl = url
        return latestResponse()
      },
    })

    assert.equal(await update({
      plugin: [entry, slimEntry, fileEntry],
      plugin_origins: [
        { spec: entry, source: file, scope: "local", sourceKind: "explicit" },
        { spec: slimEntry, source: "https://example.invalid/slim", scope: "global" },
        { spec: fileEntry, source: "file:///tmp/other-config.json", scope: "local" },
      ],
    }), true)
    assert.equal(calls, 1)
    assert.equal(requestedUrl, REGISTRY_URL)
    const changed = await readFile(file, "utf8")
    assert.match(changed, /preserve this comment/)
    assert.match(changed, /\r\n/)
    assert.match(changed, /"profile": "keep"/)
    assert.equal(changed, original.replace(`"${PACKAGE_NAME}"`, `"${PACKAGE_NAME}@${TEST_LATEST_VERSION}"`))
    assert.deepEqual(parse(changed).plugin, [[`${PACKAGE_NAME}@${TEST_LATEST_VERSION}`, { enabled: false, profile: "keep" }]])
    assert.deepEqual(parse(changed).other, { keep: true })

    const plainFile = join(root, "config.json")
    await writeFile(plainFile, JSON.stringify({ plugin: [PACKAGE_NAME], keep: "other" }))
    assert.equal(await update(localConfig(plainFile)), true)
    const plainChanged = await readFile(plainFile, "utf8")
    assert.equal(plainChanged, JSON.stringify({ plugin: [`${PACKAGE_NAME}@${TEST_LATEST_VERSION}`], keep: "other" }))
    assert.deepEqual(parse(plainChanged).plugin, [`${PACKAGE_NAME}@${TEST_LATEST_VERSION}`])
    assert.equal(calls, 1)

    const compactFile = join(root, "compact.json")
    const compactOriginal = `{"plugin":[ [ "${PACKAGE_NAME}" , {"enabled":false} ]],"keep":1}`
    await writeFile(compactFile, compactOriginal)
    const compactEntry = [PACKAGE_NAME, { enabled: false }]
    assert.equal(await update(localConfig(compactFile, compactEntry)), true)
    assert.equal(await readFile(compactFile, "utf8"), compactOriginal.replace(`"${PACKAGE_NAME}"`, `"${PACKAGE_NAME}@${TEST_LATEST_VERSION}"`))
  })
})

test("无更新、降级和未来 pin 都不写入", async () => {
  await tempRoot("codegraph-bridge-update-version-", async (root) => {
    const file = join(root, "config.json")
    const original = JSON.stringify({ plugin: [PACKAGE_NAME] }, null, 2)
    await writeFile(file, original)

    const equal = testUpdater({ fetch: async () => latestResponse(PACKAGE_NAME, TEST_CURRENT_VERSION) })
    assert.equal(await equal(localConfig(file)), false)
    assert.equal(await readFile(file, "utf8"), original)

    const sameVersionEntry = `${PACKAGE_NAME}@${TEST_CURRENT_VERSION}`
    const sameVersionText = JSON.stringify({ plugin: [sameVersionEntry] }, null, 2)
    await writeFile(file, sameVersionText)
    const sameVersion = testUpdater({ fetch: async () => latestResponse(PACKAGE_NAME, TEST_CURRENT_VERSION) })
    assert.equal(await sameVersion(localConfig(file, sameVersionEntry)), false)
    assert.equal(await readFile(file, "utf8"), sameVersionText)

    const futureEntry = `${PACKAGE_NAME}@0.3.0`
    await writeFile(file, JSON.stringify({ plugin: [futureEntry] }, null, 2))
    const future = testUpdater({ fetch: async () => latestResponse(PACKAGE_NAME, TEST_LATEST_VERSION) })
    assert.equal(await future(localConfig(file, futureEntry)), false)
    assert.equal(await readFile(file, "utf8"), JSON.stringify({ plugin: [futureEntry] }, null, 2))
  })
})

test("非法响应、prerelease、超大版本和 timeout 都安全跳过", async () => {
  await tempRoot("codegraph-bridge-update-invalid-", async (root) => {
    const file = join(root, "config.json")
    const original = JSON.stringify({ plugin: [PACKAGE_NAME] })
    await writeFile(file, original)
    for (const response of [
      latestResponse("other-package", "9.9.9"),
      latestResponse(PACKAGE_NAME, "0.2.0-beta.1"),
      latestResponse(PACKAGE_NAME, "9007199254740992.0.0"),
    ]) {
      const update = testUpdater({ fetch: async () => response })
      assert.equal(await update(localConfig(file)), false)
    }
    let aborted = false
    const timeout = testUpdater({
      timeoutMs: 10,
      fetch: async (_url, options) => {
        options.signal.addEventListener("abort", () => { aborted = true })
        return new Promise(() => {})
      },
    })
    assert.equal(await timeout(localConfig(file)), false)
    assert.equal(aborted, true)

    const httpError = testUpdater({
      fetch: async (_url, options) => {
        assert.equal(options.redirect, "error")
        return { ok: false, status: 503 }
      },
    })
    assert.equal(await httpError(localConfig(file)), false)

    const oversized = testUpdater({
      fetch: async (_url, options) => {
        assert.equal(options.redirect, "error")
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1))
              controller.close()
            },
          }),
        }
      },
    })
    assert.equal(await oversized(localConfig(file)), false)

    let cancelled = false
    const hangingBody = testUpdater({
      timeoutMs: 10,
      fetch: async (_url, options) => {
        assert.equal(options.redirect, "error")
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"))
            },
            pull() {
              return new Promise(() => {})
            },
            cancel() {
              cancelled = true
            },
          }),
        }
      },
    })
    assert.equal(await hangingBody(localConfig(file)), false)
    assert.equal(cancelled, true)
    assert.equal(await readFile(file, "utf8"), original)
  })
})

test("来源不明确、重复候选、重复键和 file URL 不查 registry", async () => {
  await tempRoot("codegraph-bridge-update-source-", async (root) => {
    const globalDir = join(root, "global")
    await mkdir(globalDir)
    const globalEntry = [PACKAGE_NAME, { enabled: true }]
    const globalText = JSON.stringify({ plugin: [globalEntry] }, null, 2)
    await writeFile(join(globalDir, "config.json"), globalText)
    await writeFile(join(globalDir, "opencode.json"), globalText)
    let calls = 0
    const update = testUpdater({ fetch: async () => { calls += 1; return latestResponse() } })
    const globalConfig = {
      plugin: [globalEntry],
      plugin_origins: [{ spec: globalEntry, source: globalDir, scope: "global" }],
    }
    assert.equal(await update(globalConfig), false)

    const invalidSources = [
      { spec: PACKAGE_NAME, source: "OPENCODE_CONFIG_CONTENT", scope: "local" },
      { spec: PACKAGE_NAME, source: "https://example.invalid/config.json", scope: "local" },
      { spec: "file:///tmp/plugin.js", source: join(root, "file-source.json"), scope: "local" },
    ]
    for (const origin of invalidSources) {
      assert.equal(await update({ plugin: [PACKAGE_NAME], plugin_origins: [origin] }), false)
    }
    assert.equal(await update({ plugin: [PACKAGE_NAME] }), false)
    assert.equal(calls, 0)

    const globalFile = join(root, "global-config.json")
    await writeFile(globalFile, JSON.stringify({ plugin: [PACKAGE_NAME] }))
    const globalFileUpdate = testUpdater({ fetch: async () => latestResponse() })
    assert.equal(await globalFileUpdate({
      plugin: [PACKAGE_NAME],
      plugin_origins: [{ spec: PACKAGE_NAME, source: globalFile, scope: "global" }],
    }), true)
    assert.deepEqual(parse(await readFile(globalFile, "utf8")).plugin, [`${PACKAGE_NAME}@${TEST_LATEST_VERSION}`])

    const duplicate = join(root, "duplicate.json")
    await writeFile(duplicate, `{"plugin":["${PACKAGE_NAME}"],"plugin":["${PACKAGE_NAME}"]}`)
    assert.equal(await update(localConfig(duplicate)), false)
    assert.equal(calls, 0)
  })
})

test("只读、符号链接、外部变更和 busy 锁都不写入，同进程只写一次", async () => {
  await tempRoot("codegraph-bridge-update-safety-", async (root) => {
    const file = join(root, "config.json")
    const original = JSON.stringify({ plugin: [PACKAGE_NAME] })
    await writeFile(file, original)
    const originalMode = (await stat(file)).mode & 0o7777
    await chmod(file, 0o444)
    const readOnly = testUpdater({ fetch: async () => latestResponse() })
    assert.equal(await readOnly(localConfig(file)), false)
    await chmod(file, 0o644)

    const link = join(root, "link.json")
    await symlink(file, link)
    const symlinked = testUpdater({ fetch: async () => latestResponse() })
    assert.equal(await symlinked(localConfig(link)), false)

    await writeFile(file, original)
    const changedDuringFetch = testUpdater({
      fetch: async () => {
        await chmod(file, 0o444)
        return latestResponse()
      },
    })
    assert.equal(await changedDuringFetch(localConfig(file)), false)
    assert.equal((await stat(file)).mode & 0o7777, 0o444)
    await chmod(file, originalMode)
    await writeFile(file, original)

    await mkdir(join(root, ".opencode-codegraph-bridge.update.lock"))
    const busy = testUpdater({ fetch: async () => latestResponse() })
    assert.equal(await busy(localConfig(file)), false)
    await rm(join(root, ".opencode-codegraph-bridge.update.lock"), { recursive: true })

    let calls = 0
    let writes = 0
    const deduped = testUpdater({
      fetch: async () => { calls += 1; return latestResponse() },
      onWrite: () => { writes += 1 },
    })
    const config = localConfig(file)
    const results = await Promise.all([deduped(config), deduped(config)])
    assert.equal(results.filter(Boolean).length, 2)
    assert.equal(calls, 1)
    assert.equal(writes, 1)
    assert.equal(await deduped(config), false)
    assert.equal(await readFile(file, "utf8"), JSON.stringify({ plugin: [`${PACKAGE_NAME}@${TEST_LATEST_VERSION}`] }))
    assert.equal((await stat(file)).mode & 0o7777, originalMode)
  })
})

test("config 启动 updater 不阻塞，nongit 也更新；disabled 完全跳过", async () => {
  await tempRoot("codegraph-bridge-update-hook-", async (root) => {
    let calls = 0
    const logs = []
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const updatePluginVersion = async (_config, callbacks) => {
      calls += 1
      callbacks.onSuccess(TEST_LATEST_VERSION)
      await pending
    }
    const hooks = await createCodeGraphPlugin({}, { updatePluginVersion })({
      directory: root,
      worktree: root,
      client: { app: { log: async ({ body }) => logs.push(body.message) } },
    })
    assert.equal(hooks.config({}), undefined)
    await Promise.resolve()
    assert.equal(calls, 1)
    assert.ok(logs.some((message) => message.includes(TEST_LATEST_VERSION) && message.includes("restart required")))
    release()

    let disabledCalls = 0
    const disabled = await createCodeGraphPlugin({ enabled: false }, {
      updatePluginVersion: async () => { disabledCalls += 1 },
    })({ directory: root, worktree: root, client: { app: { log: async () => {} } } })
    disabled.config({})
    await Promise.resolve()
    assert.equal(disabledCalls, 0)
  })
})
