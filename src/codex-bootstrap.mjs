import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Embedded into .mcp.json: legacy Codex does not expand plugin paths in args. */
export async function runNpxMcp(packageSpec) {
  const prefix = await mkdtemp(join(tmpdir(), "codegraph-npm-"))
  try {
    return await new Promise((resolveResult, reject) => {
      const child = spawn("npx", ["--prefix", prefix, "--yes", "--prefer-offline", packageSpec, "mcp", "--host", "codex"], {
        cwd: process.cwd(), env: process.env, shell: false,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      })
      const input = process.stdin
      let stopping = false
      let stopCode
      let timer
      const kill = (signal) => {
        try {
          if (process.platform === "win32") child.kill(signal)
          else process.kill(-child.pid, signal)
        } catch { /* The owned group may already have exited. */ }
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
      process.on("SIGTERM", onTerm)
      process.on("SIGINT", onInt)
      input.once("end", onEnd)
      input.once("error", onEnd)
      process.stdout.once("error", onEnd)
      child.stdin.on("error", () => {})
      child.stdout.pipe(process.stdout, { end: false })
      child.stderr.pipe(process.stderr, { end: false })
      input.pipe(child.stdin)
      if (input.readableEnded) stop()
      const cleanup = async () => {
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
        process.stdout.removeListener("error", onEnd)
        process.removeListener("SIGTERM", onTerm)
        process.removeListener("SIGINT", onInt)
        input.pause()
      }
      child.once("error", async (error) => { await cleanup(); reject(error) })
      child.once("close", async (code, signal) => { await cleanup(); resolveResult(stopCode ?? code ?? (signal === "SIGINT" ? 130 : 143)) })
    })
  } finally { await rm(prefix, { recursive: true, force: true }) }
}
