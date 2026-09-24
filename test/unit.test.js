import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import publicPlugin from "../src/index.js"
import * as publicModule from "../src/index.js"
import {
  acquireInitLock,
  createCodeGraphPlugin,
  isReadyStatus,
  inspectCodeGraphData,
  LOCK_NAME,
  mcpConfig,
  normalizeProjectRoot,
  parseJsonOutput,
  registerMcp,
  releaseInitLock,
} from "../src/internal.js"

function mockContext({ location, options = {} }) {
  const servers = new Map()
  const hooks = new Map()
  return {
    location,
    options,
    servers,
    hooks,
    mcp: {
      transform: async (transform) => transform({
        get: (name) => servers.get(name),
        set: (name, config) => servers.set(name, config),
      }),
    },
    session: {
      hook: async (name, callback) => hooks.set(name, callback),
    },
  }
}

test("legacy 公开入口仅导出默认函数", async () => {
  assert.deepEqual(Object.keys(publicModule), ["default"])
  assert.equal(typeof publicPlugin, "function")
})

test("v2 插件 enabled 关闭所有接管", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-disabled-"))
  const runtime = { nodePath: "/node", cliPath: "/cli", workerPath: "/worker", launcherPath: "/launcher" }
  try {
    await mkdir(join(root, ".git"))
    const ctx = mockContext({ location: { directory: root }, options: { enabled: false } })
    await createCodeGraphPlugin({}, { resolveRuntime: () => runtime, updateRunner: async () => false })(ctx)
    assert.equal(ctx.servers.size, 0)
    assert.equal(ctx.hooks.size, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("后台更新不阻塞 MCP 注册，失败不影响插件；禁用时不调用", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-update-"))
  const runtime = { nodePath: "/node", cliPath: "/cli", workerPath: "/worker", launcherPath: "/launcher" }
  try {
    await mkdir(join(root, ".git"))
    let rejectUpdate
    let calls = 0
    const setup = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      updateRunner: () => { calls++; return new Promise((_, reject) => { rejectUpdate = reject }) },
    })
    const ctx = mockContext({ location: { directory: root } })
    await setup(ctx)
    assert.equal(ctx.servers.has("codegraph"), true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
    rejectUpdate(new Error("network failure"))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(ctx.servers.has("codegraph"), true)

    let disabledCalls = 0
    const disabledSetup = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      updateRunner: () => { disabledCalls++ },
    })
    await disabledSetup(mockContext({ location: { directory: root }, options: { enabled: false } }))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(disabledCalls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("后台来源检查异步使用当前 location，缺少 API 或列表失败时跳过", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-source-check-"))
  const runtime = { nodePath: "/node", cliPath: "/cli", workerPath: "/worker", launcherPath: "/launcher" }
  try {
    await mkdir(join(root, ".git"))
    const verified = []
    const validPlugin = {
      id: "opencode-codegraph-bridge",
      source: { type: "package", target: "opencode-codegraph-bridge@1.2.3" },
      features: { server: true },
      state: { status: "active" },
    }
    const setup = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      pluginList: async (input) => {
        assert.deepEqual(input, { location: { directory: root } })
        return { location: { directory: root }, data: [validPlugin] }
      },
      updateRunner: async (_projectRoot, { sourceCheck }) => { verified.push(await sourceCheck()) },
    })
    await setup(mockContext({ location: { directory: root } }))
    assert.deepEqual(verified, [])
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(verified, ["opencode-codegraph-bridge@1.2.3"])

    let rejectedCheck = false
    const failedListSetup = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      pluginList: async () => { throw new Error("list unavailable") },
      updateRunner: async (_projectRoot, { sourceCheck }) => {
        try { await sourceCheck() } catch { rejectedCheck = true }
      },
    })
    await failedListSetup(mockContext({ location: { directory: root } }))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(rejectedCheck, true)

    let missingApiCalls = 0
    const missingApiSetup = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      updateRunner: async (_projectRoot, { sourceCheck }) => { missingApiCalls += await sourceCheck() ? 1 : 0 },
    })
    await missingApiSetup(mockContext({ location: { directory: root } }))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(missingApiCalls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("就绪条件拒绝空索引和不完整状态", () => {
  const base = {
    initialized: true,
    projectPath: process.cwd(),
    lastIndexed: "2026-01-01T00:00:00.000Z",
    fileCount: 1,
    index: { state: "complete", pendingRefs: 0 },
  }
  assert.equal(isReadyStatus(base, process.cwd(), true), true)
  assert.equal(isReadyStatus({ ...base, projectPath: "/tmp/other" }, process.cwd(), true), false)
  assert.equal(isReadyStatus({ ...base, fileCount: 0 }, process.cwd(), true), false)
  assert.equal(isReadyStatus({ ...base, index: { state: "failed", pendingRefs: 0 } }, process.cwd(), true), false)
  assert.equal(isReadyStatus(base, process.cwd(), false), false)
})

test("MCP 注册只补充缺失键并保留用户配置", () => {
  const runtime = { nodePath: "/opt/codegraph/node", cliPath: "/opt/codegraph/cli.js", workerPath: "/opt/plugin/worker.js", launcherPath: "/opt/plugin/mcp-launcher.js" }
  const root = process.cwd()
  const config = { mcp: { existing: { type: "remote" } } }
  assert.equal(registerMcp(config, runtime, root), true)
  assert.deepEqual(config.mcp.codegraph, mcpConfig(runtime, root))
  assert.deepEqual(config.mcp.codegraph.command, [
    runtime.nodePath,
    "--liftoff-only",
    "--disable-warning=ExperimentalWarning",
    runtime.launcherPath,
  ])
  assert.equal(config.mcp.codegraph.cwd, root)
  assert.equal(config.mcp.codegraph.disabled, false)
  const user = { mcp: { codegraph: { enabled: false, command: ["user-server"] } } }
  assert.equal(registerMcp(user, runtime, root), false)
  assert.deepEqual(user.mcp.codegraph.command, ["user-server"])
})

test("根目录只接受 Git 根/worktree 并拒绝过宽目录", () => {
  assert.equal(normalizeProjectRoot("/", undefined).root, null)
  assert.equal(normalizeProjectRoot(process.env.HOME, undefined).root, null)
})

test("非 Git 目录跳过，Git worktree 文件可接受", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-root-"))
  try {
    assert.equal(normalizeProjectRoot(root, undefined).root, null)
    await writeFile(join(root, ".git"), "gitdir: /tmp/not-used\n")
    assert.equal(normalizeProjectRoot(root, root).root, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("状态输出只解析 JSON 对象行", () => {
  assert.deepEqual(parseJsonOutput("warning\n{\"initialized\":true}\n"), { initialized: true })
  assert.equal(parseJsonOutput("not json"), null)
})

test("数据目录符号链接在 status 前被拒绝", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-safety-"))
  const outside = await mkdtemp(join(tmpdir(), "codegraph-bridge-outside-"))
  try {
    try {
      await symlink(outside, join(root, ".codegraph"), "dir")
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("当前平台不允许创建符号链接")
        return
      }
      throw error
    }
    assert.equal(inspectCodeGraphData(root).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("仅以 location.directory 为根并使 MCP cwd 与验证根对齐", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-prompt-"))
  const runtime = { nodePath: "/node", cliPath: "/cli", workerPath: "/worker", launcherPath: "/launcher" }
  try {
    await mkdir(join(root, ".git"))
    const nested = join(root, "nested")
    await mkdir(nested)
    const setup = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      updateRunner: async () => false,
    })
    const subdirectory = mockContext({
      location: { directory: nested, project: { canonical: root, directory: root } },
    })
    await setup(subdirectory)
    assert.equal(subdirectory.servers.size, 0)
    assert.equal(subdirectory.hooks.size, 0)

    const ctx = mockContext({
      location: { directory: root },
    })
    await setup(ctx)
    assert.deepEqual(ctx.servers.get("codegraph"), mcpConfig(runtime, root))
    const output = { system: [] }
    ctx.hooks.get("context")(output)
    assert.deepEqual(output.system, [{
      type: "text",
      text: "When CodeGraph tools are available in this session, use their exploration capability first to locate and understand relevant code before broad searches or reading unrelated files. Follow their provided instructions and use returned context for targeted reads; avoid re-fetching context already available. If the tools are unavailable or results are insufficient or stale, fall back to permitted file-reading and search tools.",
    }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("延迟执行的 MCP transform 完成 set 后启用已注册提示 hook，重复 transform 不重复注册", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-deferred-"))
  const runtime = { nodePath: "/node", cliPath: "/cli", workerPath: "/worker", launcherPath: "/launcher" }
  try {
    await mkdir(join(root, ".git"))
    let transformCallback
    const servers = new Map()
    const hooks = []
    const ctx = {
      location: { directory: root },
      options: {},
      mcp: { transform: async (callback) => { transformCallback = callback } },
      session: { hook: async (name, callback) => hooks.push({ name, callback }) },
    }
    await createCodeGraphPlugin({}, { resolveRuntime: () => runtime, updateRunner: async () => false })(ctx)
    assert.equal(hooks.length, 1)
    assert.equal(hooks[0].name, "context")

    const output = { system: [] }
    hooks[0].callback(output)
    assert.deepEqual(output.system, [])

    const editor = {
      get: (name) => servers.get(name),
      set: (name, config) => servers.set(name, config),
    }
    transformCallback(editor)
    transformCallback(editor)
    assert.deepEqual(servers.get("codegraph"), mcpConfig(runtime, root))
    hooks[0].callback(output)
    assert.equal(output.system.length, 1)
    assert.equal(hooks.length, 1)

    servers.set("codegraph", { type: "local", command: ["user-server"], disabled: true })
    transformCallback(editor)
    const afterReplacement = { system: [] }
    hooks[0].callback(afterReplacement)
    assert.deepEqual(afterReplacement.system, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("不安全根与用户已有 MCP 不注入、不注册提示 hook", async () => {
  const runtime = { nodePath: "/node", cliPath: "/cli", workerPath: "/worker", launcherPath: "/launcher" }
  const setup = createCodeGraphPlugin({}, { resolveRuntime: () => runtime, updateRunner: async () => false })
  const plain = await mkdtemp(join(tmpdir(), "codegraph-bridge-skip-"))
  try {
    const unsafe = mockContext({ location: { directory: homedir() } })
    await setup(unsafe)
    assert.equal(unsafe.servers.size, 0)
    assert.equal(unsafe.hooks.size, 0)

    const user = mockContext({ location: { directory: plain } })
    user.servers.set("codegraph", { type: "local", command: ["user-server"] })
    await mkdir(join(plain, ".git"))
    await setup(user)
    assert.deepEqual(user.servers.get("codegraph"), { type: "local", command: ["user-server"] })
    assert.equal(user.hooks.size, 1)
    const output = { system: [] }
    user.hooks.get("context")(output)
    assert.deepEqual(output.system, [])
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})

test("初始化锁使用原子目录且不强抢活锁", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codegraph-bridge-lock-"))
  try {
    const first = acquireInitLock(dataDir, dataDir)
    assert.equal(first.kind, "acquired")
    const second = acquireInitLock(dataDir, dataDir)
    assert.equal(second.kind, "busy")
    releaseInitLock(first.lockPath)
    const third = acquireInitLock(dataDir, dataDir)
    assert.equal(third.kind, "acquired")
    releaseInitLock(third.lockPath)
    await mkdir(join(dataDir, LOCK_NAME))
    assert.equal(acquireInitLock(dataDir, dataDir).kind, "incomplete")
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
