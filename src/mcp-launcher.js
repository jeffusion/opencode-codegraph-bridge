import codegraph from "@colbymchenry/codegraph"
import { existsSync } from "node:fs"
import { inspectCodeGraphData, isReadyStatus, normalizeProjectRoot, readStatus, resolveRuntime, runInitializationWorker } from "./internal.js"

const { MCPServer } = codegraph

function report(message) {
  process.stderr.write(`[opencode-codegraph-bridge] ${message}\n`)
}

function fail(message) {
  report(message)
  process.exitCode = 1
}

async function initialize(runtime, root, inspection) {
  if (!inspection.ok) {
    report(`自动初始化已跳过：${inspection.reason}`)
    return
  }
  if (existsSync(inspection.dbPath)) {
    const current = await readStatus(runtime, root)
    if (current.ok && isReadyStatus(current.status, root, true)) return
  }
  const result = await runInitializationWorker(runtime, root, process.pid)
  if (!result.success) report(`首次初始化失败：${result.message}`)
}

async function main() {
  const cwd = process.cwd()
  const project = normalizeProjectRoot(cwd, cwd)
  if (!project.root) {
    fail(`MCP 未启动：${project.reason}`)
    return
  }
  const safety = inspectCodeGraphData(project.root)
  const runtime = resolveRuntime()
  const server = new MCPServer(project.root)
  const serving = server.start()
  void initialize(runtime, project.root, safety).catch((error) => {
    report(`首次初始化异常：${error?.message || String(error)}`)
  })
  await serving
}

main().catch((error) => fail(error?.message || String(error)))
