import { createRequire } from "node:module"
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { applyEdits, modify, parse, parseTree } from "jsonc-parser"

const require = createRequire(import.meta.url)
const PACKAGE_NAME = "opencode-codegraph-bridge"
const PACKAGE_VERSION = require("../package.json").version
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const SOURCE_FILES = ["config.json", "opencode.json", "opencode.jsonc"]
const LOCK_NAME = ".opencode-codegraph-bridge.update.lock"
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_BODY_BYTES = 64 * 1024

/** @param {unknown} value */
function stableVersion(value) {
  if (typeof value !== "string") return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
  const a = stableVersion(left)
  const b = stableVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

/** @param {unknown} value */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

/** @param {unknown} left @param {unknown} right */
function equalValue(left, right) {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equalValue(item, right[index]))
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equalValue(left[key], right[key]))
  }
  return false
}

/** @param {unknown} entry */
function pluginSpec(entry) {
  if (typeof entry === "string") return { spec: entry, tuple: false }
  if (Array.isArray(entry) && typeof entry[0] === "string" && entry.length > 0) return { spec: entry[0], tuple: true }
  return null
}

/** @param {unknown} spec */
function allowedSpec(spec) {
  if (typeof spec !== "string") return null
  if (spec === PACKAGE_NAME || spec === `${PACKAGE_NAME}@latest`) return { pinned: null }
  const prefix = `${PACKAGE_NAME}@`
  if (!spec.startsWith(prefix)) return null
  const pinned = spec.slice(prefix.length)
  return stableVersion(pinned) ? { pinned } : null
}

/** @param {unknown} spec */
function belongsToPackage(spec) {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`))
}

/** @param {unknown} value */
function validOrigin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return pluginSpec(value.spec) && typeof value.source === "string" &&
    (value.scope === "local" || value.scope === "global")
}

/** @param {any} config */
function configuredTarget(config) {
  if (!Array.isArray(config?.plugin) || !Array.isArray(config?.plugin_origins)) return null
  const plugin = config.plugin
  const matching = plugin
    .map((entry, index) => ({ entry, index, parsed: pluginSpec(entry) }))
    .filter(({ parsed }) => parsed && belongsToPackage(parsed.spec))
  if (matching.length !== 1 || !allowedSpec(matching[0].parsed.spec)) return null
  const origins = config.plugin_origins
  if (origins.some((origin) => !validOrigin(origin))) return null
  for (const origin of origins) {
    if (origins.filter((candidate) => equalValue(candidate, origin)).length !== 1) return null
    if (plugin.filter((entry) => equalValue(entry, origin.spec)).length !== 1) return null
  }
  const own = origins.filter((origin) => equalValue(origin.spec, matching[0].entry))
  if (own.length !== 1) return null
  if (!isAbsolute(own[0].source)) return null
  const parsed = pluginSpec(matching[0].entry)
  return {
    entry: clone(matching[0].entry),
    index: matching[0].index,
    source: own[0].source,
    scope: own[0].scope,
    pinned: allowedSpec(parsed.spec).pinned,
  }
}

/** @param {string} left @param {string} right */
function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value
  return normalize(resolve(left)) === normalize(resolve(right))
}

/** @param {string} path @param {boolean} writable */
async function safeFile(path, writable = false) {
  if (!isAbsolute(path)) return null
  const requested = resolve(path)
  try {
    const link = await lstat(requested)
    if (!link.isFile() || link.isSymbolicLink()) return null
    if (!samePath(await realpath(requested), requested)) return null
    if (writable && (link.mode & 0o222) === 0) return null
    return { path: requested, mode: link.mode & 0o7777, stat: link }
  } catch {
    return null
  }
}

/** @param {string} path */
async function safeDirectory(path) {
  if (!isAbsolute(path)) return null
  const requested = resolve(path)
  try {
    const link = await lstat(requested)
    if (!link.isDirectory() || link.isSymbolicLink()) return null
    if (!samePath(await realpath(requested), requested)) return null
    return requested
  } catch {
    return null
  }
}

/** @param {string} content */
function parseConfig(content) {
  const errors = []
  const treeErrors = []
  const value = parse(content, errors, { allowTrailingComma: true })
  const tree = parseTree(content, treeErrors, { allowTrailingComma: true })
  const allErrors = [...errors, ...treeErrors]
  if (!tree || !value || allErrors.length > 0 || hasDuplicateKeys(tree)) return null
  return value
}

/** @param {any} node */
function hasDuplicateKeys(node) {
  if (!node) return false
  if (node.type === "object") {
    const keys = node.children.map((property) => property.children?.[0]?.value)
    if (new Set(keys).size !== keys.length) return true
  }
  return node.children?.some((child) => hasDuplicateKeys(child)) || false
}

/** @param {string} path @param {unknown} expectedEntry */
async function readTarget(path, expectedEntry) {
  const file = await safeFile(path)
  if (!file) return null
  try {
    const content = await readFile(file.path, "utf8")
    const value = parseConfig(content)
    if (!Array.isArray(value?.plugin)) return null
    const matches = value.plugin
      .map((entry, index) => ({ entry, index, parsed: pluginSpec(entry) }))
      .filter(({ parsed }) => parsed && belongsToPackage(parsed.spec))
    if (matches.length !== 1 || !equalValue(matches[0].entry, expectedEntry)) return null
    return { ...file, content, value, index: matches[0].index }
  } catch {
    return null
  }
}

/** @param {{ source: string, scope: string, entry: unknown }} target */
async function locateTarget(target) {
  const directFile = await readTarget(target.source, target.entry)
  if (directFile) return directFile
  if (target.scope !== "global") return null
  const directory = await safeDirectory(target.source)
  if (!directory) return null
  const matches = []
  for (const name of SOURCE_FILES) {
    const path = join(directory, name)
    try {
      const link = await lstat(path)
      if (link.isSymbolicLink()) return null
      if (!link.isFile()) continue
    } catch (error) {
      if (error?.code === "ENOENT") continue
      return null
    }
    const match = await readTarget(path, target.entry)
    if (!match) {
      try {
        const content = await readFile(path, "utf8")
        if (!parseConfig(content)) return null
      } catch {
        return null
      }
      continue
    }
    matches.push(match)
  }
  return matches.length === 1 ? matches[0] : null
}

/** @param {string} content @param {number} index @param {unknown} entry @param {string} version */
function replaceSpec(content, index, entry, version) {
  const path = Array.isArray(entry) ? ["plugin", index, 0] : ["plugin", index]
  const original = parseConfig(content)
  if (!original || !Array.isArray(original.plugin)) return null
  const changed = applyEdits(content, modify(content, path, `${PACKAGE_NAME}@${version}`, {}))
  const value = parseConfig(changed)
  if (!value || !Array.isArray(value.plugin)) return null
  const expected = clone(original)
  expected.plugin[index] = Array.isArray(entry)
    ? [`${PACKAGE_NAME}@${version}`, ...expected.plugin[index].slice(1)]
    : `${PACKAGE_NAME}@${version}`
  if (!equalValue(value, expected)) return null
  return changed
}

/** @param {string} path */
async function snapshot(path) {
  const file = await safeFile(path)
  if (!file) return null
  try {
    const content = await readFile(path, "utf8")
    const after = await lstat(path)
    if (after.ino !== file.stat.ino || after.mtimeMs !== file.stat.mtimeMs) return null
    return { ...file, content, stat: after }
  } catch {
    return null
  }
}

/** @param {any} left @param {any} right */
function sameSnapshot(left, right) {
  return !!left && !!right && left.content === right.content && left.stat.dev === right.stat.dev &&
    left.stat.ino === right.stat.ino && left.stat.mode === right.stat.mode && left.stat.mtimeMs === right.stat.mtimeMs
}

/** @param {any} target @param {string} version @param {Map<string, Promise<boolean>>} inflight @param {(() => void) | undefined} onWrite */
function writeTarget(target, version, inflight, onWrite) {
  const key = target.path
  const existing = inflight.get(key)
  if (existing) return existing
  const task = (async () => {
    const lockPath = join(dirname(target.path), LOCK_NAME)
    try {
      await mkdir(lockPath)
    } catch (error) {
      if (error?.code === "EEXIST") return false
      return false
    }
    let temporary = null
    try {
      const current = await readTarget(target.path, target.expectedEntry)
      if (!current || !sameSnapshot(target, current)) return false
      const before = await snapshot(target.path)
      if (!before || !sameSnapshot(current, before) || (before.stat.mode & 0o222) === 0) return false
      const changed = replaceSpec(before.content, current.index, target.expectedEntry, version)
      if (!changed || changed === before.content) return false
      onWrite?.()
      temporary = join(dirname(target.path), `.${target.path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
      await writeFile(temporary, changed, { flag: "wx", mode: before.mode })
      await chmod(temporary, before.mode)
      const beforeRename = await snapshot(target.path)
      if (!sameSnapshot(before, beforeRename)) return false
      await rename(temporary, target.path)
      temporary = null
      return true
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {})
      await rm(lockPath, { recursive: true, force: true }).catch(() => {})
    }
  })()
  inflight.set(key, task)
  return task.finally(() => inflight.delete(key))
}

/** @param {Response} response @param {number} maxBytes @param {AbortSignal} signal */
async function limitedBody(response, maxBytes, signal) {
  if (!response.body?.getReader) {
    const text = await response.text()
    return text.length <= maxBytes ? text : null
  }
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener("abort", cancel, { once: true })
  const chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(part.value)
    }
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** @param {{ fetch?: Function, version?: string, timeoutMs?: number, maxBodyBytes?: number, onWrite?: () => void }} dependencies */
export function createVersionUpdater(dependencies = {}) {
  const fetchFn = dependencies.fetch || globalThis.fetch
  const version = dependencies.version || PACKAGE_VERSION
  const timeoutMs = dependencies.timeoutMs || DEFAULT_TIMEOUT_MS
  const maxBodyBytes = dependencies.maxBodyBytes || MAX_BODY_BYTES
  const onWrite = dependencies.onWrite
  let latestPromise = null
  /** @type {Map<string, Promise<boolean>>} */
  const inflight = new Map()

  const latestVersion = () => {
    if (latestPromise) return latestPromise
    latestPromise = (async () => {
      if (typeof fetchFn !== "function" || !stableVersion(version)) return null
      const controller = new AbortController()
      let timer
      try {
        const request = (async () => {
          const response = await fetchFn(REGISTRY_URL, { signal: controller.signal, redirect: "error" })
          if (!response?.ok) return null
          const content = await limitedBody(response, maxBodyBytes, controller.signal)
          if (!content) return null
          let payload
          try {
            payload = JSON.parse(content)
          } catch {
            return null
          }
          return payload?.name === PACKAGE_NAME && stableVersion(payload.version) ? payload.version : null
        })()
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("registry timeout")), timeoutMs)
        })
        return await Promise.race([request, timeout])
      } catch {
        return null
      } finally {
        if (timer) clearTimeout(timer)
        controller.abort()
      }
    })()
    return latestPromise
  }

  /** @param {any} config @param {{ onSuccess?: (version: string) => void }} [callbacks] */
  return async function updatePluginVersion(config, callbacks = {}) {
    const configured = configuredTarget(config)
    if (!configured) return false
    const target = await locateTarget(configured)
    if (!target) return false
    const latest = await latestVersion()
    if (!latest || compareVersions(latest, version) <= 0 ||
      (configured.pinned && compareVersions(latest, configured.pinned) <= 0)) return false
    const changed = await writeTarget({ ...target, expectedEntry: configured.entry }, latest, inflight, onWrite)
    if (changed) callbacks.onSuccess?.(latest)
    return changed
  }
}

export const updatePluginVersion = createVersionUpdater()
export { PACKAGE_NAME, REGISTRY_URL }
