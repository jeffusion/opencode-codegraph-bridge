import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { discoverV2UpdateTarget } from "../src/update-v2-discovery.js"

const roots = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "v2-discovery-"))
  roots.push(root)
  const location = join(root, "workspace", "project")
  const home = join(root, "home")
  await mkdir(location, { recursive: true })
  await mkdir(home, { recursive: true })
  return { root, location, home, env: { XDG_CONFIG_HOME: join(root, "xdg") } }
}

async function config(path, contents = { plugins: ["opencode-codegraph-bridge@1.2.3"] }) {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true })
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("discovers a unique user-global registration", async () => {
  const f = await fixture()
  const path = join(f.env.XDG_CONFIG_HOME, "opencode", "opencode.json")
  await config(path, { plugins: [{ package: "opencode-codegraph-bridge", options: { enabled: true } }] })
  assert.deepEqual(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }), {
    path,
    entry: { package: "opencode-codegraph-bridge", options: { enabled: true } },
  })
})

test("discovers unique direct and hidden project registrations", async () => {
  for (const hidden of [false, true]) {
    const f = await fixture()
    const path = join(f.location, ...(hidden ? [".opencode"] : []), "opencode.jsonc")
    await config(path)
    assert.equal((await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }))?.path, path)
  }
})

test("declines ancestor, duplicate candidate, and legacy v1 registrations", async () => {
  const f = await fixture()
  const local = join(f.location, "opencode.json")
  await config(local)
  await config(join(f.root, "workspace", "opencode.jsonc"))
  assert.equal(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }), null)

  const g = await fixture()
  await config(join(g.location, "opencode.json"))
  await config(join(g.env.XDG_CONFIG_HOME, "opencode", "opencode.json"))
  assert.equal(await discoverV2UpdateTarget(g.location, { env: g.env, home: g.home }), null)

  const h = await fixture()
  await config(join(h.location, "opencode.json"), { plugin: ["opencode-codegraph-bridge"] })
  assert.equal(await discoverV2UpdateTarget(h.location, { env: h.env, home: h.home }), null)
})

test("declines opaque package aliases and invalid plugin field types", async () => {
  for (const opaquePackage of [
    "file:///tmp/opencode-codegraph-bridge/src/server.js",
    "another@npm:opencode-codegraph-bridge",
  ]) {
    const f = await fixture()
    await config(join(f.env.XDG_CONFIG_HOME, "opencode", "opencode.json"))
    await config(join(f.location, "opencode.json"), { plugins: [{ package: opaquePackage }] })
    assert.equal(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }), null)
  }

  for (const contents of [{ plugins: "opencode-codegraph-bridge" }, { plugin: "opencode-codegraph-bridge" }]) {
    const f = await fixture()
    await config(join(f.location, "opencode.json"), contents)
    assert.equal(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }), null)
  }
})

test("declines explicit environment overrides and relative XDG config paths", async () => {
  const f = await fixture()
  await config(join(f.location, "opencode.json"))
  assert.equal(await discoverV2UpdateTarget(f.location, { env: { ...f.env, OPENCODE_CONFIG: "custom.json" }, home: f.home }), null)
  assert.equal(await discoverV2UpdateTarget(f.location, { env: { XDG_CONFIG_HOME: "relative" }, home: f.home }), null)
})

test("declines unsafe symlinks and malformed JSONC", async () => {
  const f = await fixture()
  const target = join(f.root, "outside.json")
  await config(target)
  await symlink(target, join(f.location, "opencode.json"))
  assert.equal(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }), null)

  const g = await fixture()
  await mkdir(g.location, { recursive: true })
  await writeFile(join(g.location, "opencode.jsonc"), '{ "plugins": [,] }')
  assert.equal(await discoverV2UpdateTarget(g.location, { env: g.env, home: g.home }), null)
})

test("ignores unrelated ordinary plugins", async () => {
  const f = await fixture()
  const path = join(f.location, "opencode.json")
  await config(path, { plugins: ["other-plugin@2.0.0", { package: "another-plugin", options: { enabled: true } }] })
  assert.equal(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }), null)
})
