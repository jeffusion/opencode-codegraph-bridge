import { lstat, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parseConfig } from "./config-file.js"

const PACKAGE_NAME = "opencode-codegraph-bridge"
const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"]

function isTarget(spec) {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`))
}

function looksOpaque(spec) {
  return /^(?:file:|git(?:\+|:|@)|github:|https?:|\.{1,2}\/|\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(spec) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec) || spec.includes("@npm:")
}

function validV2Entry(entry) {
  if (typeof entry === "string") return true
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.package !== "string") return false
  return Object.keys(entry).every((key) => key === "package" || key === "options") &&
    (!Object.hasOwn(entry, "options") || (entry.options !== null && typeof entry.options === "object" && !Array.isArray(entry.options)))
}

async function inspectDirectory(directory, nested) {
  const configDirectory = nested ? join(directory, ".opencode") : directory
  if (nested) {
    try {
      const stat = await lstat(configDirectory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { unsafe: true, files: [] }
    } catch (error) {
      if (error?.code === "ENOENT") return { unsafe: false, files: [] }
      return { unsafe: true, files: [] }
    }
  }
  const files = []
  for (const name of CONFIG_NAMES) {
    const path = join(configDirectory, name)
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || !stat.isFile() || resolve(await realpath(path)) !== resolve(path)) return { unsafe: true, files: [] }
      files.push(path)
    } catch (error) {
      if (error?.code !== "ENOENT") return { unsafe: true, files: [] }
    }
  }
  return { unsafe: false, files }
}

/**
 * Find the single existing v2 plugin registration relevant to this project.
 * Discovery is read-only and deliberately declines ambiguous or unsafe layouts.
 * @param {string} locationDirectory Absolute OpenCode location directory.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {Promise<{ path: string, entry: string | { package: string, options?: object } } | null>}
 */
export async function discoverV2UpdateTarget(locationDirectory, { env = process.env, home = homedir() } = {}) {
  if (typeof locationDirectory !== "string" || !isAbsolute(locationDirectory)) return null
  if (Object.keys(env).some((key) => key.startsWith("OPENCODE_CONFIG") && env[key] !== undefined)) return null
  const location = resolve(locationDirectory)
  const xdg = env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg !== "" && !isAbsolute(xdg)) return null
  const globalDirectory = join(xdg || join(home, ".config"), "opencode")
  const allowed = new Set([
    ...CONFIG_NAMES.map((name) => join(location, name)),
    ...CONFIG_NAMES.map((name) => join(location, ".opencode", name)),
    ...CONFIG_NAMES.map((name) => join(globalDirectory, name)),
  ].map((path) => resolve(path)))

  const paths = new Set()
  let ancestor = location
  while (true) {
    for (const nested of [false, true]) {
      const inspected = await inspectDirectory(ancestor, nested)
      if (inspected.unsafe) return null
      for (const path of inspected.files) paths.add(path)
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const global = await inspectDirectory(globalDirectory, false)
  if (global.unsafe) return null
  for (const path of global.files) paths.add(path)

  const matches = []
  for (const path of paths) {
    let config
    try {
      config = parseConfig(await readFile(path, "utf8"))
    } catch {
      return null
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return null
    if (Object.hasOwn(config, "plugin") && !Array.isArray(config.plugin)) return null
    if (Array.isArray(config.plugin)) {
      if (config.plugin.some(isTarget)) return null
      if (config.plugin.some((entry) => typeof entry !== "string" || looksOpaque(entry))) return null
    }
    if (Object.hasOwn(config, "plugins") && !Array.isArray(config.plugins)) return null
    if (!Array.isArray(config.plugins)) continue
    for (const entry of config.plugins) {
      if (!validV2Entry(entry)) return null
      const spec = typeof entry === "string" ? entry : entry && typeof entry === "object" && !Array.isArray(entry) ? entry.package : null
      if (looksOpaque(spec)) return null
      if (isTarget(spec)) {
        matches.push({ path, entry: structuredClone(entry) })
      } else if (typeof entry === "object" && typeof entry.package !== "string") {
        return null
      }
    }
  }
  if (matches.length !== 1 || !allowed.has(matches[0].path)) return null
  return matches[0]
}
