import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, isAbsolute, resolve } from "node:path"
import { applyEdits, modify, parse, parseTree } from "jsonc-parser"

export const CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"]
export const LOCK_NAME = ".opencode-codegraph-bridge.update.lock"

/** @param {unknown} value */
export function stableVersion(value) {
  if (typeof value !== "string") return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

/** @param {string} left @param {string} right */
export function compareVersions(left, right) {
  const a = stableVersion(left)
  const b = stableVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

/** @param {unknown} entry */
export function pluginSpec(entry) {
  if (typeof entry === "string") return { spec: entry, tuple: false }
  if (Array.isArray(entry) && entry.length > 0 && typeof entry[0] === "string") return { spec: entry[0], tuple: true }
  return null
}

/** @param {string} left @param {string} right */
function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value
  return normalize(resolve(left)) === normalize(resolve(right))
}

/** @param {string} path @param {boolean} writable */
export async function safeFile(path, writable = false) {
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
export async function safeDirectory(path) {
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
export function parseConfig(content) {
  const errors = []
  const treeErrors = []
  const value = parse(content, errors, { allowTrailingComma: true })
  const tree = parseTree(content, treeErrors, { allowTrailingComma: true })
  if (!tree || !value || [...errors, ...treeErrors].length > 0 || hasDuplicateKeys(tree)) return null
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

/** @param {string} content @param {Array<string | number>} path @param {unknown} value */
export function replaceConfigValue(content, path, value) {
  const original = parseConfig(content)
  if (!original) return null
  const changed = applyEdits(content, modify(content, path, value, {}))
  return parseConfig(changed) ? changed : null
}

/** @param {string} path */
export async function snapshot(path) {
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
export function sameSnapshot(left, right) {
  return !!left && !!right && left.content === right.content && left.stat.dev === right.stat.dev &&
    left.stat.ino === right.stat.ino && left.stat.mode === right.stat.mode && left.stat.mtimeMs === right.stat.mtimeMs
}

/** @param {string} path @param {any} expected @param {string} content */
export async function writeExisting(path, expected, content) {
  let temporary = null
  try {
    const before = await snapshot(path)
    if (!before || !sameSnapshot(expected, before) || (before.stat.mode & 0o222) === 0) return false
    temporary = `${dirname(path)}/.${path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(temporary, content, { flag: "wx", mode: before.mode })
    await chmod(temporary, before.mode)
    if (!sameSnapshot(before, await snapshot(path))) return false
    await rename(temporary, path)
    temporary = null
    return true
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {})
  }
}

/** @param {string} path @param {string} content */
export async function writeNew(path, content) {
  let handle
  let temporary
  try {
    temporary = `${dirname(path)}/.${path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(content, "utf8")
    await handle.close()
    handle = null
    await link(temporary, path)
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
    if (temporary) await rm(temporary, { force: true }).catch(() => {})
  }
}

/** @param {string} directory */
export async function ensureSafeDirectory(directory) {
  if (!isAbsolute(directory) || !await safeExistingAncestors(directory, true)) return null
  try {
    await mkdir(directory, { recursive: true })
  } catch {
    return null
  }
  return await safeExistingAncestors(directory, true) ? safeDirectory(directory) : null
}

/** @param {string} directory @param {boolean} requireWritableNearest */
async function safeExistingAncestors(directory, requireWritableNearest) {
  let nearest = null
  for (let current = resolve(directory); ; current = dirname(current)) {
    try {
      const entry = await lstat(current)
      if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(await realpath(current), current)) return false
      nearest ||= entry
    } catch (error) {
      if (error?.code !== "ENOENT") return false
    }
    if (current === dirname(current)) return !!nearest && (!requireWritableNearest || (nearest.mode & 0o222) !== 0)
  }
}

/** @param {string} directory @param {() => Promise<boolean>} task */
export async function withConfigLock(directory, task) {
  const lock = `${directory}/${LOCK_NAME}`
  try {
    await mkdir(lock)
  } catch {
    return false
  }
  try {
    return await task()
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => {})
  }
}
