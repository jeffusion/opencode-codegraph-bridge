import { existsSync, lstatSync } from "node:fs"
import { join } from "node:path"
import {
  LOCK_NAME,
  acquireInitLock,
  codeGraphDataDir,
  inspectCodeGraphData,
  isReadyStatus,
  readStatus,
  releaseInitLock,
  resolveRuntime,
} from "./internal.js"

const root = process.argv[2]
const hostPid = Number(process.argv[3]) || process.ppid
const WAIT_MS = 30_000
const POLL_MS = 1_000
let abortController = new AbortController()
let stopping = false
let activeGraph = null
let activeLockPath = null
let forceExitTimer = null
const parentWatch = setInterval(() => {
  if (!parentAlive()) {
    requestStop()
  }
}, POLL_MS)

process.on("SIGTERM", () => {
  requestStop()
})
process.on("SIGINT", () => {
  requestStop()
})

function output(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function parentAlive() {
  try {
    process.kill(hostPid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

function requestStop() {
  if (stopping) return
  stopping = true
  abortController.abort()
  forceExitTimer = setTimeout(() => {
    try {
      activeGraph?.destroy()
    } catch {
      // The process is exiting; do the lock cleanup even if graph close fails.
    }
    if (activeLockPath) releaseInitLock(activeLockPath)
    process.exit(2)
  }, 5_000)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dbPath(rootPath) {
  return join(codeGraphDataDir(rootPath), "codegraph.db")
}

async function waitForLock(dataDir) {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (stopping || !parentAlive()) return { kind: "parent-gone" }
    const lock = acquireInitLock(dataDir, root)
    if (lock.kind !== "busy") return lock
    await sleep(POLL_MS)
  }
  return { kind: "busy-timeout" }
}

async function main() {
  if (!root) {
    output({ success: false, message: "缺少项目根目录参数" })
    process.exitCode = 2
    return
  }
  let runtime
  try {
    runtime = resolveRuntime()
    const beforeSafety = inspectCodeGraphData(root)
    if (!beforeSafety.ok) {
      output({ success: false, message: `${beforeSafety.reason}；请手动检查，不会自动删除或重建` })
      process.exitCode = 1
      return
    }
    if (!parentAlive()) {
      output({ success: false, message: "OpenCode 宿主已退出" })
      process.exitCode = 2
      return
    }
    const before = await readStatus(runtime, root)
    if (stopping || !parentAlive()) {
      output({ success: false, message: "OpenCode 宿主已退出" })
      process.exitCode = 2
      return
    }
    if (before.ok && isReadyStatus(before.status, root)) {
      output({ success: true, ready: true, message: "已有健康索引" })
      return
    }

    const dataDir = codeGraphDataDir(root)
    const db = dbPath(root)
    if (existsSync(dataDir) && !lstatSync(dataDir).isDirectory()) {
      output({ success: false, message: `${dataDir} 不是目录，请手动修复后重试` })
      process.exitCode = 1
      return
    }
    const lock = await waitForLock(dataDir)
    if (lock.kind !== "acquired") {
      const detail = lock.kind === "busy-timeout"
        ? "其他 CodeGraph 初始化进程持续持锁"
        : lock.kind === "dead"
          ? "发现已结束进程留下的初始化锁"
          : lock.kind === "incomplete"
            ? "发现不完整的初始化锁"
            : lock.kind === "parent-gone"
              ? "OpenCode 宿主已退出"
              : "初始化锁目录不可安全使用"
      output({ success: false, message: `${detail}：${join(dataDir, LOCK_NAME)}；请手动检查/修复后重试，不会自动删除或重建数据库` })
      process.exitCode = lock.kind === "parent-gone" ? 2 : 1
      return
    }

    let graph
    try {
      if (stopping || !parentAlive()) {
        output({ success: false, message: "OpenCode 宿主已退出" })
        process.exitCode = 2
        return
      }
      activeLockPath = lock.lockPath
      // The lock is held, so status and DB are checked again to close the race
      // with another process that finished immediately before our mkdir.
      const afterSafety = inspectCodeGraphData(root)
      if (!afterSafety.ok) {
        output({ success: false, message: `${afterSafety.reason}；请手动检查，不会自动删除或重建` })
        process.exitCode = 1
        return
      }
      const after = await readStatus(runtime, root)
      if (stopping || !parentAlive()) {
        output({ success: false, message: "OpenCode 宿主已退出" })
        process.exitCode = 2
        return
      }
      if (after.ok && isReadyStatus(after.status, root)) {
        output({ success: true, ready: true, message: "其他进程已完成健康索引" })
        return
      }
      if (existsSync(db)) {
        output({ success: false, message: `已有数据库但索引未达到可用条件：${db}；请手动运行 CodeGraph 修复命令，不会删除或重建` })
        process.exitCode = 1
        return
      }
      if (stopping || !parentAlive()) {
        output({ success: false, message: "OpenCode 宿主已退出" })
        process.exitCode = 2
        return
      }
      const sdk = await import("@colbymchenry/codegraph")
      // npm-sdk.js re-exports the platform CommonJS bundle. Depending on the
      // host's CJS/ESM interop, its default is either the class or that bundle.
      const exported = sdk.default
      const CodeGraph = typeof exported === "function"
        ? exported
        : exported?.default || exported?.CodeGraph || sdk.CodeGraph
      graph = await CodeGraph.init(root, { index: false })
      activeGraph = graph
      const result = await graph.indexAll({ signal: abortController.signal })
      if (stopping || !parentAlive()) {
        output({ success: false, message: "OpenCode 宿主已退出，后台索引已终止" })
        process.exitCode = 2
        return
      }
      if (result?.success !== true) {
        output({ success: false, message: "CodeGraph indexAll 未报告成功；请手动检查索引" })
        process.exitCode = 1
        return
      }
      const finalStatus = await readStatus(runtime, root)
      if (stopping || !parentAlive()) {
        output({ success: false, message: "OpenCode 宿主已退出，后台索引已终止" })
        process.exitCode = 2
        return
      }
      const ready = finalStatus.ok && isReadyStatus(finalStatus.status, root, true)
      output({ success: true, ready, message: ready ? "后台索引完成" : "索引完成但状态未达到可用条件" })
      if (!ready) process.exitCode = 1
    } finally {
      try {
        graph?.destroy()
      } catch {
        // Cleanup still runs if destroy itself reports an error.
      }
      releaseInitLock(lock.lockPath)
      activeGraph = null
      activeLockPath = null
    }
  } catch (error) {
    output({ success: false, message: `${message(error)}；不会删除或重建已有数据库` })
    process.exitCode = 1
  }
}

main().catch((error) => {
  output({ success: false, message: message(error) })
  process.exitCode = 1
}).finally(() => {
  clearInterval(parentWatch)
  if (forceExitTimer) clearTimeout(forceExitTimer)
})
