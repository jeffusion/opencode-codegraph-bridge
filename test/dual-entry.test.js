import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import legacy from "../index.js"
import serverPlugin from "../server.js"
import { createCodeGraphPlugin } from "../src/internal.js"

const runtime = { nodePath: "/node", cliPath: "/cli", workerPath: "/worker", launcherPath: "/launcher" }

test("包根 legacy 入口保持 default-only 函数导出", async () => {
  const module = await import("../index.js")
  assert.deepEqual(Object.keys(module), ["default"])
  assert.equal(typeof legacy, "function")
})

test("./server 同时提供 v2 setup 和 v1 server adapter", async () => {
  assert.equal(serverPlugin.id, "opencode-codegraph-bridge")
  assert.equal(typeof serverPlugin.setup, "function")
  assert.equal(typeof serverPlugin.server, "function")

  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-dual-"))
  try {
    await mkdir(join(root, ".git"))
    const v1 = await legacy({ directory: root }, {}, { resolveRuntime: () => runtime, updatePluginVersion: async () => false })
    const config = {}
    v1.config(config)
    assert.deepEqual(config.mcp.codegraph, {
      type: "local",
      command: [runtime.nodePath, "--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.launcherPath],
      environment: { CODEGRAPH_NO_DOWNLOAD: "1" },
      enabled: true,
    })
    const output = { system: [] }
    await v1["experimental.chat.system.transform"]({}, output)
    assert.equal(output.system.length, 1)

    const servers = new Map()
    const hooks = new Map()
    await createCodeGraphPlugin({}, { resolveRuntime: () => runtime, updateRunner: async () => false })({
      location: { directory: root },
      options: {},
      mcp: { transform: async (callback) => callback({ get: (key) => servers.get(key), set: (key, value) => servers.set(key, value) }) },
      session: { hook: async (name, callback) => hooks.set(name, callback) },
    })
    const v2Mcp = servers.get("codegraph")
    assert.equal(v2Mcp.type, "local")
    assert.equal(v2Mcp.cwd, root)
    assert.equal(v2Mcp.disabled, false)
    assert.equal(v2Mcp.command.at(-1), runtime.launcherPath)
    assert.deepEqual(v2Mcp.environment, { CODEGRAPH_NO_DOWNLOAD: "1" })
    assert.equal(hooks.has("context"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
