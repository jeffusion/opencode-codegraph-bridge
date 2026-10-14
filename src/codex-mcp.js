import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveCodexProjectRoot } from "./project.mjs"
import { inspectCodeGraphData, isReadyStatus, LOCK_NAME, readStatus, resolveRuntime } from "./internal.js"
import { createCodexIndexingGate, createCodexOutputFramer } from "./codex-indexing.mjs"
import { runCodexAutoUpdate } from "./codex-auto-update.mjs"

/** Run the platform Node, not the Node/Bun that happened to launch npm. */
export async function runCodexMcp(options = {}) {
  const project = resolveCodexProjectRoot(options.project || process.cwd())
  if (!project.root) throw new Error(project.reason)
  const safety = inspectCodeGraphData(project.root)
  if (!safety.ok) throw new Error(safety.reason)
  const runtime = options.runtime || resolveRuntime()
  const input = options.stdin || process.stdin
  const output = options.stdout || process.stdout
  const diagnostic = options.stderr || process.stderr
  const updateController = new AbortController()
  const updating = runCodexAutoUpdate({ env: { ...process.env, ...options.env }, signal: updateController.signal,
    log: (message) => diagnostic.write(`[opencode-codegraph-bridge] ${message}\n`) })
  return new Promise((resolveResult, reject) => {
    const child = spawn(runtime.nodePath, ["--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.launcherPath], {
      cwd: project.root, env: { ...process.env, ...options.env, CODEGRAPH_NO_DOWNLOAD: "1", CODEGRAPH_BRIDGE_STAGE_INIT: "1" }, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "ipc"],
    })
    const state = { phase: "initializing" }
    const gate = createCodexIndexingGate(project.root, state, output, async () => {
      const current = inspectCodeGraphData(project.root)
      if (!current.ok || !existsSync(current.dbPath) || existsSync(join(current.dataDir, LOCK_NAME))) return false
      const status = await readStatus(runtime, project.root, 5_000)
      return status.ok && isReadyStatus(status.status, project.root)
    })
    const frames = createCodexOutputFramer()
    child.on("message", (message) => {
      if (message?.type !== "codegraph-bridge-initialization") return
      state.phase = message.success ? "ready" : "failed"
      state.message = message.message
    })
    let stopping = false
    let timer
    let stopCode
    const kill = (signal) => {
      try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch { /* The owned process group may already have exited. */ }
    }
    const stop = (signal = "SIGTERM", code = 0) => {
      if (stopping) return
      stopping = true
      updateController.abort()
      stopCode = code
      input.unpipe(gate)
      gate.unpipe(child.stdin)
      gate.destroy()
      child.stdin.end()
      kill(signal)
      timer = setTimeout(() => kill("SIGKILL"), 8_000)
    }
    const onTerm = () => stop("SIGTERM", 143)
    const onInt = () => stop("SIGINT", 130)
    const onEnd = () => stop()
    const onOutputError = () => stop()
    process.on("SIGTERM", onTerm)
    process.on("SIGINT", onInt)
    input.once("end", onEnd)
    input.once("error", onEnd)
    gate.once("error", onEnd)
    frames.once("error", onEnd)
    output.once("error", onOutputError)
    child.stdin.on("error", () => {})
    child.stdout.pipe(frames).pipe(output, { end: false })
    child.stderr.pipe(diagnostic, { end: false })
    input.pipe(gate).pipe(child.stdin)
    if (input.readableEnded) stop()
    const cleanup = async () => {
      updateController.abort()
      // The launcher can exit before its worker; retain bounded group cleanup.
      kill("SIGTERM")
      const deadline = Date.now() + 8_000
      if (process.platform !== "win32" && child.pid) {
        while (Date.now() < deadline) {
          try { process.kill(-child.pid, 0) } catch { break }
          await new Promise((done) => setTimeout(done, 50))
        }
        kill("SIGKILL")
      }
      clearTimeout(timer)
      input.unpipe(gate)
      gate.destroy()
      frames.unpipe(output)
      frames.destroy()
      input.removeListener("end", onEnd)
      input.removeListener("error", onEnd)
      output.removeListener("error", onOutputError)
      process.removeListener("SIGTERM", onTerm)
      process.removeListener("SIGINT", onInt)
      input.pause()
      await updating
    }
    child.once("error", async (error) => { await cleanup(); reject(error) })
    child.once("close", async (code, signal) => { await cleanup(); resolveResult(stopCode ?? code ?? (signal === "SIGINT" ? 130 : 143)) })
  })
}
