import { Transform } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { resolveCodexProjectRoot } from "./project.mjs"

function lineStream(onLine) {
  const decoder = new StringDecoder("utf8")
  let pending = ""
  return new Transform({
    transform(chunk, encoding, done) {
      pending += decoder.write(chunk)
      const drain = async () => {
        let end
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          await onLine(line, this)
        }
      }
      drain().then(() => done(), done)
    },
    flush(done) {
      pending += decoder.end()
      Promise.resolve(pending ? onLine(pending, this) : undefined).then(() => done(), done)
    },
  })
}

/** Emit upstream responses atomically so local replies cannot split their JSON. */
export function createCodexOutputFramer() {
  return lineStream((line, stream) => { stream.push(`${line}\n`) })
}

/** Keep cold-start queries away from the unpublished database, without delaying the MCP handshake. */
export function createCodexIndexingGate(root, state, output, recover = async () => false) {
  return lineStream(async (line, stream) => {
    let request
    try { request = JSON.parse(line) } catch { stream.push(`${line}\n`); return }
    const target = request?.params?.arguments?.projectPath
    const managed = state.phase !== "ready" && request?.method === "tools/call" &&
      typeof request.params?.name === "string" && request.params.name.startsWith("codegraph_") &&
      (target === undefined || (typeof target === "string" && resolveCodexProjectRoot(target).root === root))
    if (!managed || request.id === undefined) { stream.push(`${line}\n`); return }
    // Another session may have published the index after this worker timed out
    // waiting for its lock. Retry only readiness verification, never indexing.
    if (state.phase === "failed" && await recover()) state.phase = "ready"
    if (state.phase === "ready") { stream.push(`${line}\n`); return }
    const text = state.phase === "failed"
      ? `CodeGraph automatic initialization failed for ${root}: ${state.message}. Use built-in file-reading and search tools for now; fix the initialization failure before retrying.`
      : `CodeGraph is still initializing ${root} in the background. Index readiness has not been confirmed yet. Use built-in file-reading and search tools for now, then retry CodeGraph later in this session. No manual codegraph init or MCP restart is needed.`
    output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      content: [{ type: "text", text }],
    } })}\n`)
  })
}
