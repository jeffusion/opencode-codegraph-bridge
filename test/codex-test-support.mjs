import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createInterface } from "node:readline"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until(predicate, message, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error(message)
}
export async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "codex-integration-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}
export async function repository(root) {
  await mkdir(root, { recursive: true })
  execFileSync("git", ["init", "--quiet", root])
  await writeFile(join(root, "sample.js"), 'export function CodexBridgeInitialSymbol() { return "CODEX_BEFORE_65C1" }\n')
  return root
}
export function rpc(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] })
  let id = 0
  let stderr = ""
  const pending = new Map()
  const events = []
  const lines = createInterface({ input: child.stdout })
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })))
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-32_000) })
  function fail(error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
  }
  child.once("error", fail)
  child.once("close", () => fail(new Error(`RPC exited: ${stderr}`)))
  child.stdin.on("error", () => {})
  lines.on("line", (line) => {
    let message
    try { message = JSON.parse(line) } catch { fail(new Error(`Non-JSON stdout: ${line}`)); return }
    const entry = pending.get(message.id)
    if (entry && !message.method) {
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    } else events.push(message)
  })
  return {
    child, closed, events, diagnostics: () => stderr,
    request(method, params, timeout = 60_000) {
      const next = ++id
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(next); reject(new Error(`RPC timeout ${method}: ${stderr}; recent events=${JSON.stringify(events.slice(-8))}`)) }, timeout)
        pending.set(next, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`)
      })
    },
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`) },
    // This is final cleanup only. Tests must prove leader-only shutdown before calling it.
    async cleanup() {
      const owned = await descendants(child.pid)
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL") } catch {}
      }
      for (const group of new Set(owned.filter((row) => row.group !== child.pid).map((row) => row.group))) {
        // The MCP launcher has its own detached group; include it only in final
        // fallback cleanup after assertions have already passed or failed.
        try { process.kill(-group, "SIGKILL") } catch {}
      }
      lines.close()
      fail(new Error("RPC cleanup"))
      await Promise.race([closed, delay(2_000)])
    },
  }
}
export async function processes() {
  const rows = []
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue
    try {
      const raw = await readFile(`/proc/${name}/stat`, "utf8")
      const tail = raw.slice(raw.lastIndexOf(")") + 2).split(" ")
      rows.push({ pid: Number(name), state: tail[0], parent: Number(tail[1]), group: Number(tail[2]) })
    } catch {}
  }
  return rows
}
export async function descendants(pid) {
  const rows = await processes()
  const ids = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true }
  }
  return rows.filter((row) => ids.has(row.pid))
}
export async function gone(ids) {
  // A reparented zombie owns no descriptors/locks and cannot be killed; /proc may
  // retain it until the container's init reaps it. Treat only running processes as live.
  return !(await processes()).some((row) => ids.includes(row.pid) && row.state !== "Z")
}
export async function absent(path) {
  try { await lstat(path); return false } catch (error) { if (error.code === "ENOENT") return true; throw error }
}
export async function initialize(client, root) {
  const result = await client.request("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-bridge-test", version: "1" },
    rootUri: new URL(`file://${root}`).href,
  })
  assert.ok(result.capabilities.tools)
  client.notify("notifications/initialized")
  const tools = await client.request("tools/list", {})
  assert.ok(tools.tools.some((tool) => tool.name === "codegraph_explore"))
}
