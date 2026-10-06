import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolveCodexProjectRoot } from "./project.mjs"
import { CODEX_PROMPT } from "./guidance.mjs"

export function contextForEvent(event) {
  if (!["SessionStart", "SubagentStart"].includes(event?.hook_event_name)) return {}
  if (event.hook_event_name === "SessionStart" && !["startup", "resume", "clear", "compact"].includes(event.source)) return {}
  if (!resolveCodexProjectRoot(event.cwd).root) return {}
  return { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: CODEX_PROMPT } }
}

export async function runHook(input = process.stdin, output = process.stdout) {
  let text = ""
  for await (const chunk of input) {
    text += chunk
    if (Buffer.byteLength(text) > 64 * 1024) { output.write("{}\n"); return }
  }
  let result = {}
  try { result = contextForEvent(JSON.parse(text)) } catch { /* Invalid input adds no context. */ }
  output.write(`${JSON.stringify(result)}\n`)
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    // A broken host input stream must not hold up a session indefinitely.
    const timer = setTimeout(() => { process.stdout.write("{}\n"); process.exit(0) }, 4_500)
    runHook().catch(() => process.stdout.write("{}\n")).finally(() => clearTimeout(timer))
  }
} catch { /* Importing the hook never runs it. */ }
