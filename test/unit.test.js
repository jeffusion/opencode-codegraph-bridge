import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import publicPlugin from "../src/index.js"
import * as publicModule from "../src/index.js"
import {
  acquireInitLock,
  backgroundTaskForRoot,
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

test("enabled 开关可关闭所有接管", async () => {
  assert.deepEqual(Object.keys(publicModule), ["default"])
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-disabled-"))
  try {
    await mkdir(join(root, ".git"))
    const hooks = await publicPlugin({ directory: root, worktree: root }, { enabled: false })
    const config = {}
    hooks.config(config)
    assert.deepEqual(config, {})
    const output = { system: [] }
    await hooks["experimental.chat.system.transform"]({}, output)
    assert.deepEqual(output.system, [])
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
  const runtime = { nodePath: "/opt/codegraph/node", shimPath: "/opt/codegraph/npm-shim.js", workerPath: "/opt/plugin/worker.js" }
  const config = { mcp: { existing: { type: "remote" } } }
  assert.equal(registerMcp(config, runtime, "/repo"), true)
  assert.deepEqual(config.mcp.codegraph, mcpConfig(runtime, "/repo"))
  const user = { mcp: { codegraph: { enabled: false, command: ["user-server"] } } }
  assert.equal(registerMcp(user, runtime, "/repo"), false)
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

test("system hook 只在 config 完成后非阻塞触发，并按 retryAt 节流复查", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-bridge-retry-"))
  let statusCalls = 0
  let workerCalls = 0
  let clock = 1_000
  const runtime = { nodePath: "/node", shimPath: "/shim", cliPath: "/cli", workerPath: "/worker" }
  try {
    await mkdir(join(root, ".git"))
    const plugin = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      readStatus: async () => {
        statusCalls += 1
        return { status: null, ok: false, diagnostic: "mock failure" }
      },
      spawnWorker: async () => {
        workerCalls += 1
        return { success: false, message: "mock worker failure" }
      },
      now: () => clock,
    })
    const hooks = await plugin({ directory: root, worktree: root, client: { app: { log: async () => {} } } })
    await hooks["experimental.chat.system.transform"]({}, { system: [] })
    assert.equal(statusCalls, 0, "config 完成前不得启动后台 status")

    const config = {}
    hooks.config(config)
    assert.ok(config.mcp.codegraph)
    const firstTask = backgroundTaskForRoot(root)
    assert.ok(firstTask)
    await firstTask
    assert.equal(statusCalls, 1)
    assert.equal(workerCalls, 1)

    const notReadyOutput = { system: [] }
    await hooks["experimental.chat.system.transform"]({}, notReadyOutput)
    assert.deepEqual(notReadyOutput.system, [])
    assert.equal(statusCalls, 1, "失败后 retryAt 窗口内不得重复 status/init")

    clock += 30_001
    await hooks["experimental.chat.system.transform"]({}, { system: [] })
    const secondTask = backgroundTaskForRoot(root)
    assert.ok(secondTask)
    await secondTask
    assert.equal(statusCalls, 2, "节流窗口后允许 status 复查")
    assert.equal(workerCalls, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("system hook 只在 ready 后注入英文 CodeGraph 提示并转义项目根路径", async () => {
  const prefix = process.platform === "win32" ? "codegraph-bridge-prompt-" : 'codegraph-bridge-prompt-"'
  const root = await mkdtemp(join(tmpdir(), prefix))
  const runtime = { nodePath: "/node", shimPath: "/shim", cliPath: "/cli", workerPath: "/worker" }
  try {
    await mkdir(join(root, ".git"))
    const plugin = createCodeGraphPlugin({}, {
      resolveRuntime: () => runtime,
      readStatus: async () => ({
        status: {
          initialized: true,
          projectPath: root,
          lastIndexed: "2026-01-01T00:00:00.000Z",
          fileCount: 1,
          index: { state: "complete", pendingRefs: 0 },
        },
        ok: true,
      }),
    })
    const hooks = await plugin({ directory: root, worktree: root, client: { app: { log: async () => {} } } })
    const beforeConfig = { system: [] }
    await hooks["experimental.chat.system.transform"]({}, beforeConfig)
    assert.deepEqual(beforeConfig.system, [])

    const config = {}
    hooks.config(config)
    const task = backgroundTaskForRoot(root)
    assert.ok(task)
    await task

    const output = { system: [] }
    await hooks["experimental.chat.system.transform"]({}, output)
    assert.deepEqual(output.system, [
      `When CodeGraph tools are available in this session, use their exploration capability first to locate and understand relevant code before broad searches or reading unrelated files. Follow their provided instructions and use returned context for targeted reads; avoid re-fetching context already available. If the tools are unavailable or results are insufficient or stale, fall back to permitted file-reading and search tools. Project root: ${JSON.stringify(root)}`,
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
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
