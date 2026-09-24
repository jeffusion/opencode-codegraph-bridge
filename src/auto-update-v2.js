import { createRequire } from "node:module"
import { compareVersions, stableVersion } from "./config-file.js"
import { discoverV2UpdateTarget } from "./update-v2-discovery.js"
import { updateV2PluginVersion } from "./update-v2.js"

const require = createRequire(import.meta.url)
const PACKAGE_NAME = "opencode-codegraph-bridge"
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const PACKAGE_VERSION = require("../package.json").version
const MAX_BODY_BYTES = 64 * 1024
const TIMEOUT_MS = 5_000

/**
 * Validate the plugin.list result shape documented by @opencode/plugin 2.0.15.
 * Return the exact package target from active server-plugin metadata. This is
 * intentionally not normalized: a pinned target and the bare package name are
 * distinct proofs.
 * @param {unknown} result
 * @param {string} locationDirectory
 */
export function hasVerifiedPackagePlugin(result, locationDirectory) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
    result.location?.directory !== locationDirectory || !Array.isArray(result.data)) return false
  const matches = result.data.filter((plugin) => plugin?.id === PACKAGE_NAME)
  if (matches.length !== 1) return false
  const plugin = matches[0]
  if (plugin.state?.status !== "active" || plugin.features?.server !== true || plugin.source?.type !== "package") return false
  const target = plugin.source.target
  if (target === PACKAGE_NAME || target === `${PACKAGE_NAME}@latest`) return target
  const prefix = `${PACKAGE_NAME}@`
  return typeof target === "string" && target.startsWith(prefix) && !!stableVersion(target.slice(prefix.length)) ? target : false
}

function entryTarget(entry) {
  const spec = typeof entry === "string" ? entry : entry?.package
  if (spec === PACKAGE_NAME || spec === `${PACKAGE_NAME}@latest`) return spec
  const prefix = `${PACKAGE_NAME}@`
  return typeof spec === "string" && spec.startsWith(prefix) && !!stableVersion(spec.slice(prefix.length)) ? spec : null
}

async function readLimitedBody(response, onReader) {
  const contentLength = response.headers?.get?.("content-length")
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) throw new Error("registry response too large")
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("registry response too large")
    return text
  }

  const reader = response.body.getReader()
  onReader?.(reader)
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new Error("registry response too large")
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, size).toString("utf8")
}

/**
 * Check npm's public latest endpoint and update the one safely discovered v2 entry.
 * @param {string} locationDirectory
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, fetch?: typeof fetch, update?: typeof updateV2PluginVersion, log?: (message: string) => void, timeoutMs?: number, sourceCheck?: () => string | false | Promise<string | false> }} [dependencies]
 */
export async function runV2AutoUpdate(locationDirectory, dependencies = {}) {
  const { env = process.env, home, fetch: fetchImpl = globalThis.fetch, update = updateV2PluginVersion, log = console.log, timeoutMs = TIMEOUT_MS, sourceCheck } = dependencies
  try {
    if (typeof sourceCheck !== "function") return false
    const sourceTarget = await sourceCheck()
    if (typeof sourceTarget !== "string") return false
    const target = await discoverV2UpdateTarget(locationDirectory, { env, ...(home === undefined ? {} : { home }) })
    if (!target) return false
    const discoveredSpec = entryTarget(target.entry)
    if (!discoveredSpec || sourceTarget !== discoveredSpec) return false

    const controller = new AbortController()
    let response
    let reader
    let timedOut = false
    let rejectTimeout
    const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
      Promise.resolve(reader?.cancel()).catch(() => {})
      Promise.resolve(response?.body?.cancel?.()).catch(() => {})
      rejectTimeout(new Error("registry request timed out"))
    }, timeoutMs)
    try {
      const responsePromise = (async () => {
        response = await fetchImpl(REGISTRY_URL, { signal: controller.signal, redirect: "error" })
        if (timedOut) {
          Promise.resolve(response?.body?.cancel?.()).catch(() => {})
          throw new Error("registry request timed out")
        }
        if (!response?.ok) return { payload: null }
        const body = await readLimitedBody(response, (value) => { reader = value })
        return { payload: JSON.parse(body) }
      })()
      const { payload } = await Promise.race([responsePromise, timeoutPromise])
      clearTimeout(timeout)
      if (!payload) return false
      if (payload?.name !== PACKAGE_NAME || !stableVersion(payload.version)) return false
      if (compareVersions(payload.version, PACKAGE_VERSION) <= 0) return false
      const existing = typeof target.entry === "string" ? target.entry : target.entry.package
      const prefix = `${PACKAGE_NAME}@`
      const currentVersion = existing === PACKAGE_NAME || existing === `${PACKAGE_NAME}@latest` ? null : existing.startsWith(prefix) ? existing.slice(prefix.length) : null
      if (currentVersion && (!stableVersion(currentVersion) || compareVersions(payload.version, currentVersion) <= 0)) return false
      const latestSourceTarget = await sourceCheck()
      if (latestSourceTarget !== sourceTarget || latestSourceTarget !== discoveredSpec) return false

      const validate = async () => {
        const latestTarget = await discoverV2UpdateTarget(locationDirectory, { env, ...(home === undefined ? {} : { home }) })
        if (!latestTarget || latestTarget.path !== target.path || JSON.stringify(latestTarget.entry) !== JSON.stringify(target.entry) || entryTarget(latestTarget.entry) !== discoveredSpec) return false
        return await sourceCheck() === sourceTarget
      }
      const updated = await update(target.path, target.entry, payload.version, { validate })
      if (updated) log("[opencode-codegraph-bridge] 已更新配置，重启生效。")
      return !!updated
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return false
  }
}
