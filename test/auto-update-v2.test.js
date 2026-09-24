import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { hasVerifiedPackagePlugin, runV2AutoUpdate } from "../src/auto-update-v2.js"

const PACKAGE = "opencode-codegraph-bridge"
const version = "999.0.0"
const sourceProof = async () => `${PACKAGE}@1.0.0`

async function fixture(t, { global = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bridge-auto-update-"))
  const home = join(root, "home")
  const location = join(root, "project")
  await mkdir(join(location, ".git"), { recursive: true })
  const config = global ? join(home, ".config", "opencode", "opencode.json") : join(location, "opencode.jsonc")
  await mkdir(join(config, ".."), { recursive: true })
  const env = { XDG_CONFIG_HOME: join(home, ".config") }
  await writeFile(config, JSON.stringify({ plugins: [`${PACKAGE}@1.0.0`] }))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, home, location, config, env }
}

const fetchPayload = (payload) => async (url, options) => {
  assert.equal(url, `https://registry.npmjs.org/${PACKAGE}/latest`)
  assert.equal(options.redirect, "error")
  return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(payload) }
}

test("自动更新发现并仅改全局配置的版本 spec", async (t) => {
  const f = await fixture(t, { global: true })
  await writeFile(f.config, JSON.stringify({ plugins: [{ package: `${PACKAGE}@1.0.0`, options: { enabled: true } }] }, null, 2))
  assert.equal(await runV2AutoUpdate(f.location, { env: f.env, home: f.home, sourceCheck: sourceProof, fetch: fetchPayload({ name: PACKAGE, version }), log: () => {} }), true)
  assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")), { plugins: [{ package: `${PACKAGE}@${version}`, options: { enabled: true } }] })
})

test("@latest 字符串与 object entry 按精确来源 target 更新为 registry 固定版本", async (t) => {
  const f = await fixture(t)
  const cases = [
    { entry: `${PACKAGE}@latest`, expected: `${PACKAGE}@${version}` },
    { entry: { package: `${PACKAGE}@latest`, options: { enabled: true } }, expected: { package: `${PACKAGE}@${version}`, options: { enabled: true } } },
  ]
  for (const { entry, expected } of cases) {
    await writeFile(f.config, JSON.stringify({ plugins: [entry] }))
    assert.equal(await runV2AutoUpdate(f.location, {
      env: f.env, home: f.home,
      sourceCheck: async () => `${PACKAGE}@latest`,
      fetch: fetchPayload({ name: PACKAGE, version }), log: () => {},
    }), true)
    assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")), { plugins: [expected] })
  }
})

test("@latest 来源 target 与磁盘 spec 不完全一致时跳过；非更高响应不写入", async (t) => {
  const f = await fixture(t)
  const latest = `${PACKAGE}@latest`
  await writeFile(f.config, JSON.stringify({ plugins: [latest] }))
  const before = await readFile(f.config, "utf8")
  let calls = 0
  assert.equal(await runV2AutoUpdate(f.location, {
    env: f.env, home: f.home, sourceCheck: async () => PACKAGE,
    fetch: async () => { calls++; throw new Error("must not fetch") },
  }), false)
  assert.equal(calls, 0)
  assert.equal(await readFile(f.config, "utf8"), before)

  for (const payloadVersion of ["0.0.1", "0.5.0"]) {
    assert.equal(await runV2AutoUpdate(f.location, {
      env: f.env, home: f.home, sourceCheck: async () => latest,
      fetch: fetchPayload({ name: PACKAGE, version: payloadVersion }),
    }), false)
    assert.equal(await readFile(f.config, "utf8"), before)
  }
})

test("自动更新支持当前项目候选，且无候选/冲突时不请求网络", async (t) => {
  const f = await fixture(t)
  let calls = 0
  const fetch = async () => {
    calls++
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ name: PACKAGE, version }) }
  }
  await writeFile(f.config, JSON.stringify({ plugins: ["another-plugin"] }))
  assert.equal(await runV2AutoUpdate(f.location, { env: f.env, home: f.home, sourceCheck: sourceProof, fetch }), false)
  assert.equal(calls, 0)
  await writeFile(f.config, JSON.stringify({ plugins: [`${PACKAGE}@1.0.0`, `${PACKAGE}@2.0.0`] }))
  assert.equal(await runV2AutoUpdate(f.location, { env: f.env, home: f.home, sourceCheck: sourceProof, fetch }), false)
  assert.equal(calls, 0)
  await writeFile(f.config, JSON.stringify({ plugins: [`${PACKAGE}@1.0.0`] }))
  assert.equal(await runV2AutoUpdate(f.location, { env: f.env, home: f.home, sourceCheck: sourceProof, fetch, log: () => {} }), true)
  assert.equal(calls, 1)
})

test("registry 异常、超时、超限及非法或非稳定响应均不写配置", async (t) => {
  const f = await fixture(t)
  const before = await readFile(f.config, "utf8")
  const cases = [
    async () => { throw new Error("network") },
    async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
    async () => ({ ok: true, headers: { get: () => "70000" }, text: async () => "{}" }),
    fetchPayload({ name: "wrong", version }),
    fetchPayload({ name: PACKAGE, version: "1.2.3-beta.1" }),
    async () => ({ ok: false }),
  ]
  for (const fetch of cases) {
    assert.equal(await runV2AutoUpdate(f.location, { env: f.env, home: f.home, sourceCheck: sourceProof, fetch }), false)
    assert.equal(await readFile(f.config, "utf8"), before)
  }
})

test("hard timeout 覆盖忽略 abort 的 fetch、未结束 body，并丢弃超时后的响应", async (t) => {
  const f = await fixture(t)
  const before = await readFile(f.config, "utf8")
  let updates = 0
  const update = async () => { updates++; return true }

  assert.equal(await runV2AutoUpdate(f.location, {
    env: f.env, home: f.home, sourceCheck: sourceProof, timeoutMs: 20, update,
    fetch: () => new Promise(() => {}),
  }), false)

  let canceled = false
  assert.equal(await runV2AutoUpdate(f.location, {
    env: f.env, home: f.home, sourceCheck: sourceProof, timeoutMs: 20, update,
    fetch: async () => ({
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { canceled = true } }) },
    }),
  }), false)
  assert.equal(canceled, true)

  let resolveFetch
  const late = runV2AutoUpdate(f.location, {
    env: f.env, home: f.home, sourceCheck: sourceProof, timeoutMs: 20, update,
    fetch: () => new Promise((resolve) => { resolveFetch = resolve }),
  })
  assert.equal(await late, false)
  resolveFetch({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ name: PACKAGE, version }) })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(updates, 0)
  assert.equal(await readFile(f.config, "utf8"), before)
})

test("网络等待期间候选变化时不写入", async (t) => {
  const f = await fixture(t)
  let resolveFetch
  const pending = runV2AutoUpdate(f.location, {
    env: f.env, home: f.home, sourceCheck: sourceProof,
    fetch: () => new Promise((resolve) => { resolveFetch = resolve }),
  })
  while (!resolveFetch) await new Promise((resolve) => setImmediate(resolve))
  await writeFile(f.config, JSON.stringify({ plugins: [`${PACKAGE}@2.0.0`] }))
  resolveFetch({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ name: PACKAGE, version }) })
  assert.equal(await pending, false)
  assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")), { plugins: [`${PACKAGE}@2.0.0`] })
})

test("运行 package target 与磁盘 spec 不一致时不请求网络或写入", async (t) => {
  const f = await fixture(t)
  await writeFile(f.config, JSON.stringify({ plugins: [`${PACKAGE}@0.4.0`] }))
  const before = await readFile(f.config, "utf8")
  let calls = 0
  assert.equal(await runV2AutoUpdate(f.location, {
    env: f.env, home: f.home, sourceCheck: async () => `${PACKAGE}@0.5.0`,
    fetch: async () => { calls++; throw new Error("must not fetch") },
  }), false)
  assert.equal(calls, 0)
  assert.equal(await readFile(f.config, "utf8"), before)
})

test("网络等待期间 package target 改变时不写入", async (t) => {
  const f = await fixture(t)
  let currentTarget = `${PACKAGE}@1.0.0`
  let resolveFetch
  const pending = runV2AutoUpdate(f.location, {
    env: f.env, home: f.home, sourceCheck: async () => currentTarget,
    fetch: () => new Promise((resolve) => { resolveFetch = resolve }),
  })
  while (!resolveFetch) await new Promise((resolve) => setImmediate(resolve))
  currentTarget = `${PACKAGE}@0.5.0`
  resolveFetch({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ name: PACKAGE, version }) })
  assert.equal(await pending, false)
  assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")), { plugins: [`${PACKAGE}@1.0.0`] })
})

test("plugin.list 按 2.0.15 {location,data} contract 验证唯一 active server package", () => {
  const location = "/tmp/project"
  const validPlugin = {
    id: PACKAGE,
    source: { type: "package", target: `${PACKAGE}@1.2.3` },
    features: { server: true },
    state: { status: "active" },
  }
  const result = (data) => ({ location: { directory: location }, data })
  assert.equal(hasVerifiedPackagePlugin(result([validPlugin]), location), `${PACKAGE}@1.2.3`)
  assert.equal(hasVerifiedPackagePlugin(result([{ ...validPlugin, source: { type: "package", target: PACKAGE } }]), location), PACKAGE)
  for (const invalid of [
    result([{ ...validPlugin, source: { type: "local", path: "/local" } }]),
    result([{ ...validPlugin, source: { type: "sdk" } }]),
    result([{ ...validPlugin, state: { status: "failed", error: "failed" } }]),
    result([{ ...validPlugin, features: {} }]),
    result([validPlugin, validPlugin]),
    { data: [validPlugin] },
    { location: { directory: "/other" }, data: [validPlugin] },
    [validPlugin],
  ]) assert.equal(hasVerifiedPackagePlugin(invalid, location), false)
  assert.equal(hasVerifiedPackagePlugin(result([{ ...validPlugin, source: { type: "package", target: `${PACKAGE}@latest` } }]), location), `${PACKAGE}@latest`)
})

test("未提供来源证明时自动更新 fail closed，不请求网络", async (t) => {
  const f = await fixture(t)
  let calls = 0
  const result = await runV2AutoUpdate(f.location, {
    env: f.env, home: f.home,
    fetch: async () => { calls++; throw new Error("must not fetch") },
  })
  assert.equal(result, false)
  assert.equal(calls, 0)
})
