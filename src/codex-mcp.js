import { spawn } from "node:child_process"
import { resolveCodexProjectRoot } from "./project.mjs"
import { inspectCodeGraphData, resolveRuntime } from "./internal.js"

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
  return new Promise((resolveResult, reject) => {
    const child = spawn(runtime.nodePath, ["--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.launcherPath], {
      cwd: project.root, env: { ...process.env, ...options.env, CODEGRAPH_NO_DOWNLOAD: "1", CODEGRAPH_BRIDGE_STAGE_INIT: "1" }, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
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
      stopCode = code
      input.unpipe(child.stdin)
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
    output.once("error", onOutputError)
    child.stdin.on("error", () => {})
    child.stdout.pipe(output, { end: false })
    child.stderr.pipe(diagnostic, { end: false })
    input.pipe(child.stdin)
    if (input.readableEnded) stop()
    const cleanup = async () => {
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
      input.unpipe(child.stdin)
      input.removeListener("end", onEnd)
      input.removeListener("error", onEnd)
      output.removeListener("error", onOutputError)
      process.removeListener("SIGTERM", onTerm)
      process.removeListener("SIGINT", onInt)
      input.pause()
    }
    child.once("error", async (error) => { await cleanup(); reject(error) })
    child.once("close", async (code, signal) => { await cleanup(); resolveResult(stopCode ?? code ?? (signal === "SIGINT" ? 130 : 143)) })
  })
}
