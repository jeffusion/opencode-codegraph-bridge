import { dirname } from "node:path"
import { createRequire } from "node:module"
import { applyEdits, modify } from "jsonc-parser"
import {
  compareVersions,
  parseConfig,
  safeDirectory,
  safeFile,
  sameSnapshot,
  snapshot,
  stableVersion,
  withConfigLock,
  writeExisting,
} from "./config-file.js"

const PACKAGE_NAME = "opencode-codegraph-bridge"
const require = createRequire(import.meta.url)
const PACKAGE_VERSION = require("../package.json").version

function equalValue(left, right) {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equalValue(item, right[index]))
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equalValue(left[key], right[key]))
  }
  return false
}

function entryPackage(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.package === "string") {
    return entry.package
  }
  return null
}

function isTargetPackage(spec) {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`))
}

function validTargetSpec(spec) {
  if (spec === PACKAGE_NAME) return null
  const prefix = `${PACKAGE_NAME}@`
  if (typeof spec !== "string" || !spec.startsWith(prefix)) return false
  const version = spec.slice(prefix.length)
  if (version === "latest") return null
  return stableVersion(version) ? version : false
}

function isDisabled(entry) {
  const options = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.options : null
  return !!options && typeof options === "object" && !Array.isArray(options) &&
    (options.disabled === true || options.enabled === false)
}

function replaceVersion(content, index, entry, version) {
  const entryPath = ["plugins", index]
  const path = typeof entry === "string" ? entryPath : [...entryPath, "package"]
  const changed = applyEdits(content, modify(content, path, `${PACKAGE_NAME}@${version}`, {}))
  const before = parseConfig(content)
  const after = parseConfig(changed)
  if (!before || !after || !Array.isArray(before.plugins) || !Array.isArray(after.plugins)) return null
  const expected = structuredClone(before)
  if (typeof entry === "string") expected.plugins[index] = `${PACKAGE_NAME}@${version}`
  else expected.plugins[index].package = `${PACKAGE_NAME}@${version}`
  return equalValue(after, expected) ? changed : null
}

/**
 * Safely rewrite an already-selected v2 plugin config entry. This function does
 * not discover config files, determine their provenance, or perform network I/O.
 * @param {string} path Absolute, trusted candidate configuration file path.
 * @param {string | { package: string, options?: object }} expectedEntry
 * @param {string} version Stable version to write.
 * @returns {Promise<boolean>} True only when a write was committed.
 */
export async function updateV2PluginVersion(path, expectedEntry, version, { validate } = {}) {
  if (typeof path !== "string" || !stableVersion(version)) return false
  const expectedPackage = entryPackage(expectedEntry)
  if (!expectedPackage || !isTargetPackage(expectedPackage) || validTargetSpec(expectedPackage) === false || isDisabled(expectedEntry)) return false
  const pinnedVersion = validTargetSpec(expectedPackage)
  if (compareVersions(version, PACKAGE_VERSION) <= 0 || (pinnedVersion && compareVersions(version, pinnedVersion) <= 0)) return false
  const file = await safeFile(path, true)
  if (!file || !await safeDirectory(dirname(file.path))) return false

  return withConfigLock(dirname(file.path), async () => {
    if (validate && !await validate()) return false
    const before = await snapshot(file.path)
    if (!before || (before.stat.mode & 0o222) === 0) return false
    const config = parseConfig(before.content)
    if (!config || !Array.isArray(config.plugins) || Object.hasOwn(config, "plugin")) return false
    if (config.plugins.some(Array.isArray)) return false

    const matching = config.plugins
      .map((entry, index) => ({ entry, index, spec: entryPackage(entry) }))
      .filter(({ spec }) => isTargetPackage(spec))
    if (matching.length !== 1 || !equalValue(matching[0].entry, expectedEntry)) return false
    if (validTargetSpec(matching[0].spec) === false || matching[0].spec !== expectedPackage) return false

    const changed = replaceVersion(before.content, matching[0].index, matching[0].entry, version)
    if (!changed || changed === before.content || !sameSnapshot(before, await snapshot(file.path))) return false
    return writeExisting(file.path, before, changed)
  })
}
