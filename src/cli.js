#!/usr/bin/env node
import { createRequire } from "node:module"
import { lstat, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { isAbsolute, join } from "node:path"
import { parseArgs } from "node:util"
import { CONFIG_FILES, compareVersions, ensureSafeDirectory, parseConfig, pluginSpec, replaceConfigValue, safeFile, snapshot, withConfigLock, writeExisting, writeNew } from "./config-file.js"

const require = createRequire(import.meta.url)
const { name: PACKAGE_NAME, version: PACKAGE_VERSION } = require("../package.json")
const SCHEMA = "https://opencode.ai/config.json"

function usage() {
  return "Usage: npx opencode-codegraph-bridge install [--format v1|v2]\n\nRegister this package in your global OpenCode config.\nNew configs default to v1 (plugin array) for compatibility; use --format v2 for the plugins array."
}

/** @param {NodeJS.ProcessEnv} env */
function configDirectory(env) {
  const xdg = env.XDG_CONFIG_HOME
  if (xdg !== undefined && !isAbsolute(xdg)) throw new Error("XDG_CONFIG_HOME must be an absolute path.")
  return join(xdg || join(homedir(), ".config"), "opencode")
}

/** @param {unknown} spec */
function ownSpec(spec) {
  if (spec === PACKAGE_NAME) return { pinned: null }
  if (typeof spec !== "string") return null
  const prefix = `${PACKAGE_NAME}@`
  if (!spec.startsWith(prefix)) return null
  const version = spec.slice(prefix.length)
  return /^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, version) !== null
    ? { pinned: version }
    : { unsupported: true }
}

/** @param {unknown} spec */
function opaqueSpec(spec) {
  return typeof spec === "string" && (/^(file:|git\+|git:|git@|github:|https?:|\.{1,2}\/|\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(spec) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec) || spec.includes("@npm:"))
}

/** @param {unknown} entry */
function disabledTuple(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) return entry.options?.enabled === false
  return Array.isArray(entry) && entry.slice(1).some((option) => option && typeof option === "object" && !Array.isArray(option) && option.enabled === false)
}

/** @param {unknown} entry */
function entrySpec(entry) {
  if (typeof entry === "string") return { spec: entry, format: "string" }
  if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.package === "string") return { spec: entry.package, format: "object" }
  const parsed = pluginSpec(entry)
  return parsed ? { spec: parsed.spec, format: "legacy" } : null
}

/** @param {string} directory */
async function candidates(directory) {
  const found = []
  for (const name of CONFIG_FILES) {
    const path = join(directory, name)
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe config file: ${path}`)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
    if (!await safeFile(path, true)) throw new Error(`Unsafe or read-only config file: ${path}`)
    const file = await snapshot(path)
    const config = file && parseConfig(file.content)
    if (!file || !config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Invalid OpenCode config: ${path}`)
    for (const key of ["plugins", "plugin"]) {
      if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error(`Invalid ${key} array: ${path}`)
    }
    found.push({ name, path, file, config })
  }
  return found
}

/** @param {Awaited<ReturnType<candidates>>} files */
function decide(files, requestedFormat) {
  const matches = []
  let opaque = false
  const populatedFormats = new Set()
  for (const file of files) {
    if (file.config.plugin !== undefined && file.config.plugins !== undefined) throw new Error(`Both plugin and plugins arrays are present in ${file.path}; resolve the format manually.`)
    if (file.config.plugin?.length) populatedFormats.add("v1")
    if (file.config.plugins?.length) populatedFormats.add("v2")
    for (const key of ["plugins", "plugin"]) for (const [index, entry] of (file.config[key] || []).entries()) {
      if (key === "plugin" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        throw new Error(`Object plugin entry found in the v1 plugin array in ${file.path}; manually correct it to a string or [string, options] entry.`)
      }
      const parsed = entrySpec(entry)
      if (key === "plugins" && Array.isArray(entry)) throw new Error(`Tuple plugin entry found in the v2 plugins array in ${file.path}; use a string or {package, options} entry.`)
      if (!parsed) continue
      const own = ownSpec(parsed.spec)
      if (own?.unsupported) throw new Error(`Unsupported existing ${PACKAGE_NAME} spec in ${file.path}; confirm it manually.`)
      if (own) matches.push({ file, key, index, entry, format: parsed.format, configFormat: key === "plugin" ? "v1" : "v2", ...own })
      else if (opaqueSpec(parsed.spec)) opaque = true
    }
  }
  if (matches.length > 1) throw new Error(`Multiple ${PACKAGE_NAME} entries found; resolve them manually.`)
  if (populatedFormats.size > 1) throw new Error("Existing plugin entries use both v1 and v2 formats; resolve the config manually before installing.")
  if (matches.length === 1) {
    if (requestedFormat && requestedFormat !== matches[0].configFormat) throw new Error(`Requested ${requestedFormat} format conflicts with the existing ${matches[0].configFormat} entry; no migration was performed.`)
    return { type: "existing", ...matches[0] }
  }
  if (opaque) throw new Error("An opaque file, git, or npm-alias plugin is present; confirm the config manually before adding this plugin.")
  const existingFormat = populatedFormats.values().next().value
  if (requestedFormat && existingFormat && requestedFormat !== existingFormat) throw new Error(`Requested ${requestedFormat} format conflicts with existing ${existingFormat} plugin entries; no migration was performed.`)
  const file = ["opencode.jsonc", "opencode.json", "config.json"]
    .map((name) => files.find((candidate) => candidate.name === name))
    .find(Boolean)
  const fileFormat = file?.config.plugin !== undefined ? "v1" : file?.config.plugins !== undefined ? "v2" : undefined
  const format = existingFormat || fileFormat || requestedFormat || "v1"
  if (fileFormat && fileFormat !== format) throw new Error(`Selected config file uses ${fileFormat} format but existing plugins use ${format}; resolve the config manually before installing.`)
  if (requestedFormat && format !== requestedFormat) throw new Error(`Requested ${requestedFormat} format conflicts with existing ${format} plugin config; no migration was performed.`)
  return file ? { type: "append", file, format } : { type: "create", format }
}

/** @param {{ args?: string[], env?: NodeJS.ProcessEnv, stdout?: { write: (text: string) => unknown }, stderr?: { write: (text: string) => unknown } }} options */
export async function run(options = {}) {
  const args = options.args || process.argv.slice(2)
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  let parsed
  try {
    parsed = parseArgs({ args, options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, format: { type: "string" } }, allowPositionals: true, strict: false, tokens: true })
  } catch {
    stderr.write(`${usage()}\n`)
    return 1
  }
  if (parsed.tokens.some((token) => token.kind === "option" && !["help", "version", "format"].includes(token.name)) ||
    parsed.positionals.some((value) => value !== "install") || parsed.positionals.length > 1) {
    stderr.write(`${usage()}\n`)
    return 1
  }
  if (parsed.values.help) {
    stdout.write(`${usage()}\n`)
    return 0
  }
  if (parsed.values.version) {
    stdout.write(`${PACKAGE_VERSION}\n`)
    return 0
  }
  if (parsed.positionals[0] !== "install") {
    stderr.write(`${usage()}\n`)
    return 1
  }
  const requestedFormat = parsed.values.format
  if (requestedFormat !== undefined && requestedFormat !== "v1" && requestedFormat !== "v2") {
    stderr.write("--format must be v1 or v2.\n")
    return 1
  }
  try {
    const directory = await ensureSafeDirectory(configDirectory(options.env || process.env))
    if (!directory) throw new Error("OpenCode config directory is unsafe.")
    const result = await withConfigLock(directory, async () => {
      const files = await candidates(directory)
      const plan = decide(files, requestedFormat)
      const spec = `${PACKAGE_NAME}@${PACKAGE_VERSION}`
      if (plan.type === "existing") {
        const existingSpec = entrySpec(plan.entry).spec
        if (plan.pinned && compareVersions(plan.pinned, PACKAGE_VERSION) >= 0) return { path: plan.file.path, spec: existingSpec, disabled: disabledTuple(plan.entry), changed: false }
        const path = plan.format === "object" ? [plan.key, plan.index, "package"]
          : Array.isArray(plan.entry) ? [plan.key, plan.index, 0] : [plan.key, plan.index]
        const changed = replaceConfigValue(plan.file.file.content, path, spec)
        if (!changed) throw new Error(`Could not update config: ${plan.file.path}`)
        if (!await writeExisting(plan.file.path, plan.file.file, changed)) throw new Error(`Config changed while installing: ${plan.file.path}`)
        return { path: plan.file.path, spec, disabled: disabledTuple(plan.entry), changed: true }
      }
      if (plan.type === "append") {
        const key = plan.format === "v1" ? "plugin" : "plugins"
        const plugins = plan.file.config[key]
        const changed = replaceConfigValue(plan.file.file.content, plugins ? [key, -1] : [key], plugins ? spec : [spec])
        if (!changed || !await writeExisting(plan.file.path, plan.file.file, changed)) throw new Error(`Config changed while installing: ${plan.file.path}`)
        return { path: plan.file.path, spec, disabled: false, changed: true }
      }
      const path = join(directory, "opencode.json")
      const key = plan.format === "v1" ? "plugin" : "plugins"
      if (!await writeNew(path, `${JSON.stringify({ $schema: SCHEMA, [key]: [spec] }, null, 2)}\n`)) throw new Error(`Could not create config: ${path}`)
      return { path, spec, disabled: false, changed: true }
    })
    if (!result) throw new Error("OpenCode config is busy; try again after the other process finishes.")
    stdout.write(`${result.changed ? "Registered" : "Already registered"} ${result.spec || `${PACKAGE_NAME}@${PACKAGE_VERSION}`} in ${result.path}. Restart OpenCode to apply.${result.disabled ? " It remains disabled and was not enabled." : ""}\n`)
    return 0
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "Install failed."}\n`)
    return 1
  }
}

if (process.argv[1]) {
  Promise.all([realpath(process.argv[1]), realpath(fileURLToPath(import.meta.url))]).then(([entry, module]) => {
    if (entry === module) run().then((code) => { process.exitCode = code })
  }).catch(() => {})
}
