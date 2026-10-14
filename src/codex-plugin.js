import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { compareVersions, ensureSafeDirectory, safeDirectory, safeFile, sameSnapshot, snapshot, writeExisting, writeNew } from "./config-file.js"

const execute = promisify(execFile)
const source = dirname(fileURLToPath(import.meta.url))
const pkg = createRequire(import.meta.url)("../package.json")
export const PLUGIN_NAME = "codegraph-bridge"
export const PLUGIN_ID = `${PLUGIN_NAME}@${PLUGIN_NAME}`
const OWNER = `${pkg.name}:codex-marketplace:v1`
const PENDING_INSTALL = ".install-pending.json"
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const digest = (value) => createHash("sha256").update(value).digest("hex")

export async function pluginFiles() {
  // Keep the bootstrap self-contained. Legacy Codex passes path variables in
  // MCP args literally, and setting MCP cwd to the plugin loses the project.
  const bootstrap = `${await readFile(join(source, "codex-bootstrap.mjs"), "utf8")}\nprocess.exitCode = await runNpxMcp(${JSON.stringify(`${pkg.name}@${pkg.version}`)})\n`
  const files = {
    ".codex-plugin/plugin.json": json({ name: PLUGIN_NAME, version: pkg.version,
      description: "CodeGraph structural exploration, background indexing and session guidance",
      skills: "./skills/", mcpServers: "./.mcp.json", hooks: "./hooks/hooks.json" }),
    ".mcp.json": json({ mcpServers: { codegraph_bridge: {
      command: "node", args: ["--input-type=module", "--eval", bootstrap],
      env: { CODEGRAPH_NO_DOWNLOAD: "1" }, startup_timeout_sec: 120, required: false,
    } } }),
    "hooks/hooks.json": json({ hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/src/codex-hook.mjs"', timeout: 5 }] }],
      SubagentStart: [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/src/codex-hook.mjs"', timeout: 5 }] }],
    } }),
    "skills/codegraph-exploration/SKILL.md": `---\nname: codegraph-exploration\ndescription: Explore repository structure, locate symbols, trace callers and dependencies using available CodeGraph tools.\n---\n\nUse the available CodeGraph exploration tools for structural code questions. Follow their tool instructions and use returned context for targeted file reads. Initial indexing runs in the background: tool availability alone does not mean the index is ready. If indexing is incomplete, tools are unavailable, or results are insufficient or stale, continue with permitted file reads and searches. When multiple CodeGraph servers are available, use one consistently. Never claim that indexing succeeded without checking the tool result.\n`,
  }
  for (const name of ["codex-hook.mjs", "project.mjs", "guidance.mjs"]) files[`src/${name}`] = await readFile(join(source, name), "utf8")
  return files
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === "ENOENT") return false; throw error }
}

async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    if (!await ensureSafeDirectory(dirname(path))) throw new Error(`Unsafe plugin directory: ${path}`)
    await writeFile(path, content, { flag: "wx", mode: 0o600 })
  }
  await writeFile(join(root, ".bridge-files.json"), json(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, digest(text)]))), { flag: "wx", mode: 0o600 })
}

async function verifyBundle(root, expectedFiles) {
  if (!await safeDirectory(root) || !await safeFile(join(root, ".bridge-files.json"))) throw new Error(`Unsafe owned plugin: ${root}`)
  const hashes = JSON.parse(await readFile(join(root, ".bridge-files.json"), "utf8"))
  const expectedNames = Object.keys(await pluginFiles()).sort()
  if (JSON.stringify(Object.keys(hashes).sort()) !== JSON.stringify(expectedNames)) throw new Error(`Invalid plugin inventory: ${root}`)
  for (const [name, hash] of Object.entries(hashes)) {
    const path = join(root, name)
    if (!await safeFile(path) || digest(await readFile(path)) !== hash || (expectedFiles && digest(expectedFiles[name]) !== hash)) throw new Error(`Owned plugin was modified: ${path}`)
  }
}

function market(version) {
  return { name: PLUGIN_NAME, plugins: [{ name: PLUGIN_NAME, source: { source: "local", path: `./plugins/${PLUGIN_NAME}-${version}` } }] }
}

/** Export a self-contained hook/plugin marketplace without installing it. */
export async function packageCodex(output) {
  if (!output) throw new Error("--output is required.")
  const target = resolve(output)
  const parent = await ensureSafeDirectory(dirname(target))
  if (!parent) throw new Error("Unsafe output parent directory.")
  if (await exists(target) && (!await safeDirectory(target) || (await readdir(target)).length)) throw new Error("Output must be absent or an empty safe directory.")
  const staging = await mkdtemp(join(parent, ".codegraph-package-"))
  try {
    await writeFile(join(staging, ".bridge-owner.json"), json({ owner: OWNER }), { flag: "wx", mode: 0o600 })
    await writeFiles(join(staging, "plugins", `${PLUGIN_NAME}-${pkg.version}`), await pluginFiles())
    await mkdir(join(staging, ".agents", "plugins"), { recursive: true })
    await writeFile(join(staging, ".agents", "plugins", "marketplace.json"), json(market(pkg.version)), { flag: "wx", mode: 0o600 })
    await rename(staging, target)
    return target
  } finally { await rm(staging, { recursive: true, force: true }) }
}

async function command(binary, args, env) {
  try {
    return (await execute(binary, args, { env, timeout: 60_000, maxBuffer: 1024 * 1024, shell: false })).stdout.trim()
  } catch (error) { throw new Error(`${binary} ${args.join(" ")} failed: ${String(error.stderr || error.message).trim()}`) }
}

async function ownedStore(store) {
  const marker = join(store, ".bridge-owner.json")
  if (!await safeDirectory(store) || !await safeFile(marker) || JSON.parse(await readFile(marker, "utf8")).owner !== OWNER) throw new Error(`Marketplace directory is not owned by this bridge: ${store}`)
  for (const name of await readdir(store)) if (![".bridge-owner.json", ".agents", "plugins", ".install.lock", PENDING_INSTALL].includes(name)) throw new Error(`Unexpected marketplace content: ${name}`)
}

async function removeSnapshot(path, expected) {
  if (!sameSnapshot(expected, await snapshot(path))) return false
  await rm(path)
  return true
}

/** Read-only proof that an enabled native installation still belongs to this bridge. */
export async function inspectCodexUpdateTarget(options = {}) {
  const env = options.env || process.env
  const invoke = options.command || command
  const cli = options.codex || "codex"
  const home = env.CODEX_HOME || join(homedir(), ".codex")
  const store = join(home, "codegraph-bridge", "marketplace")
  if (!isAbsolute(home) || !await safeDirectory(home) || !await safeFile(join(store, ".bridge-owner.json"))) return null
  await ownedStore(store)
  const listings = JSON.parse(await invoke(cli, ["plugin", "list", "--json"], env))
  const markets = JSON.parse(await invoke(cli, ["plugin", "marketplace", "list", "--json"], env))
  if (!Array.isArray(listings.installed) || !Array.isArray(markets.marketplaces)) return null
  const matches = listings.installed.filter((entry) => entry.name === PLUGIN_NAME || entry.pluginId === PLUGIN_ID)
  const namedMarkets = markets.marketplaces.filter((entry) => entry.name === PLUGIN_NAME)
  const entry = matches[0]
  const marketEntry = namedMarkets[0]
  if (matches.length !== 1 || namedMarkets.length !== 1 || entry.enabled !== true ||
    entry.pluginId !== PLUGIN_ID || entry.version !== options.expectedVersion ||
    entry.source?.source !== "local" || entry.source.path !== join(store, "plugins", `${PLUGIN_NAME}-${entry.version}`) ||
    entry.marketplaceSource?.sourceType !== "local" || resolve(entry.marketplaceSource.source) !== store ||
    marketEntry.marketplaceSource?.sourceType !== "local" || resolve(marketEntry.marketplaceSource.source) !== store || resolve(marketEntry.root) !== store) return null
  await verifyBundle(entry.source.path, entry.version === pkg.version ? await pluginFiles() : undefined)
  const descriptor = await snapshot(join(store, ".agents", "plugins", "marketplace.json"))
  if (!descriptor) return null
  const catalog = JSON.parse(descriptor.content)
  const pendingPath = join(store, PENDING_INSTALL)
  const pending = await snapshot(pendingPath)
  let recovery
  if (pending) {
    const value = JSON.parse(pending.content)
    if (value.owner !== OWNER || compareVersions(value.to, value.from) !== 1 ||
      ![value.from, value.to].includes(entry.version) || typeof value.original !== "string" ||
      JSON.stringify(JSON.parse(value.original)) !== JSON.stringify(market(value.from))) return null
    recovery = { snapshot: pending, value }
  } else if (await exists(pendingPath)) return null
  if (JSON.stringify(catalog) !== JSON.stringify(market(entry.version))) {
    if (!recovery || recovery.value.from !== entry.version || JSON.stringify(catalog) !== JSON.stringify(market(recovery.value.to))) return null
    await verifyBundle(join(store, "plugins", `${PLUGIN_NAME}-${recovery.value.to}`))
  }
  const servers = JSON.parse(await invoke(cli, ["mcp", "list", "--json"], env))
  if (!Array.isArray(servers)) return null
  const server = servers.find((item) => item.name === "codegraph_bridge")
  const bundled = JSON.parse(await readFile(join(entry.source.path, ".mcp.json"), "utf8")).mcpServers.codegraph_bridge
  if (server?.enabled !== true || server.transport?.type !== "stdio" || server.transport.command !== bundled.command ||
    JSON.stringify(server.transport.args) !== JSON.stringify(bundled.args) || server.transport.env?.CODEGRAPH_BRIDGE_AUTO_UPDATE === "0") return null
  const config = await snapshot(join(home, "config.toml"))
  const inventory = await snapshot(join(entry.source.path, ".bridge-files.json"))
  return config && inventory && (config.stat.mode & 0o222) !== 0 ? { home, store, version: entry.version, config, inventory, descriptor, recovery } : null
}

async function prepareVersion(store) {
  await ownedStore(store)
  const plugins = await ensureSafeDirectory(join(store, "plugins"))
  const config = await ensureSafeDirectory(join(store, ".agents", "plugins"))
  if (!plugins || !config) throw new Error("Unsafe owned marketplace directories.")
  const descriptor = join(config, "marketplace.json")
  if (await exists(descriptor)) {
    if (!await safeFile(descriptor)) throw new Error("Unsafe marketplace descriptor.")
    const previous = JSON.parse(await readFile(descriptor, "utf8"))
    const version = previous.plugins?.[0]?.source?.path?.match(/^\.\/plugins\/codegraph-bridge-(\d+\.\d+\.\d+)$/)?.[1]
    if (!version || JSON.stringify(previous) !== JSON.stringify(market(version))) throw new Error("Owned marketplace descriptor was modified.")
    await verifyBundle(join(plugins, `${PLUGIN_NAME}-${version}`))
  }
  const bundle = join(plugins, `${PLUGIN_NAME}-${pkg.version}`)
  const files = await pluginFiles()
  if (await exists(bundle)) await verifyBundle(bundle, files)
  else {
    const staging = await mkdtemp(join(plugins, ".staging-"))
    try { await writeFiles(staging, files); await rename(staging, bundle) }
    finally { await rm(staging, { recursive: true, force: true }) }
  }
  const temporary = join(config, `.marketplace-${process.pid}.json`)
  try {
    await writeFile(temporary, json(market(pkg.version)), { flag: "wx", mode: 0o600 })
    await rename(temporary, descriptor)
  } finally { await rm(temporary, { force: true }) }
  return bundle
}

/** All Codex configuration mutations go through its supported CLI. */
export async function installCodex(options = {}) {
  const env = options.env || process.env
  const invoke = options.command || command
  const cli = options.codex || "codex"
  const home = env.CODEX_HOME || join(homedir(), ".codex")
  const updateStillAllowed = async () => {
    if (!options.expectedVersion) return true
    const target = await inspectCodexUpdateTarget({ env, command: invoke, codex: cli, expectedVersion: options.expectedVersion })
    return !!target && sameSnapshot(options.expectedConfig, target.config) && sameSnapshot(options.expectedInventory, target.inventory)
  }
  const skipped = { changed: false, skipped: true, version: options.expectedVersion }
  if (!await updateStillAllowed()) return skipped
  if (!isAbsolute(home)) throw new Error("CODEX_HOME must be an absolute path.")
  if (!await safeDirectory(home) && !await ensureSafeDirectory(home)) throw new Error("Unsafe CODEX_HOME directory.")
  const store = join(home, "codegraph-bridge", "marketplace")
  const query = async (args) => JSON.parse(await invoke(cli, args, env))
  for (const binary of ["node", "npm", "git"]) await invoke(binary, ["--version"], env)
  const inspect = async () => {
    const listings = await query(["plugin", "list", "--json"])
    const markets = await query(["plugin", "marketplace", "list", "--json"])
    if (!Array.isArray(listings.installed) || !Array.isArray(markets.marketplaces)) throw new Error("Unsupported Codex plugin list response; upgrade Codex.")
    const namedMarkets = markets.marketplaces.filter((entry) => entry.name === PLUGIN_NAME)
    if (namedMarkets.length > 1 || namedMarkets.some((entry) => entry.marketplaceSource?.sourceType !== "local" || resolve(entry.marketplaceSource.source) !== store || resolve(entry.root) !== store)) throw new Error("A different marketplace already uses the codegraph-bridge name.")
    const matches = listings.installed.filter((entry) => entry.name === PLUGIN_NAME || entry.pluginId === PLUGIN_ID)
    if (matches.length > 1) throw new Error("Multiple codegraph-bridge plugins are installed.")
    const existing = matches[0]
    if (existing) {
      if (existing.pluginId !== PLUGIN_ID || existing.source?.source !== "local" || existing.marketplaceSource?.sourceType !== "local" || resolve(existing.marketplaceSource.source) !== store || existing.source.path !== join(store, "plugins", `${PLUGIN_NAME}-${existing.version}`)) throw new Error("Existing codegraph-bridge plugin has a different source.")
      const comparison = compareVersions(existing.version, pkg.version)
      if (comparison === null) throw new Error("Existing plugin version is unsupported.")
      await ownedStore(store)
      await verifyBundle(existing.source.path, comparison === 0 ? await pluginFiles() : undefined)
      if (existing.enabled !== true || comparison >= 0) return { changed: false, disabled: existing.enabled !== true, version: existing.version, store }
    }
    return null
  }
  const unchanged = await inspect()
  if (unchanged) return unchanged
  if (!await ensureSafeDirectory(store)) throw new Error("Unsafe Codex marketplace directory.")
  const marker = join(store, ".bridge-owner.json")
  if (!await exists(marker)) {
    if ((await readdir(store)).length || !await writeNew(marker, json({ owner: OWNER }))) throw new Error("Refusing to overwrite an unowned marketplace directory.")
  }
  await ownedStore(store)
  const lock = join(store, ".install.lock")
  try { await mkdir(lock) } catch { throw new Error("Codex bridge installation is busy; retry after the other installer finishes.") }
  const descriptor = join(store, ".agents", "plugins", "marketplace.json")
  let previousDescriptor
  let stagedDescriptor
  let pendingInstall
  let committed = false
  try {
    // Another invocation may have completed or disabled the plugin after our
    // lock-free snapshot. Recheck before any version/descriptor mutation.
    const refreshed = await inspect()
    if (refreshed) return refreshed
    if (!await updateStillAllowed()) return skipped
    if (await exists(join(store, PENDING_INSTALL))) {
      const version = options.expectedVersion || (await query(["plugin", "list", "--json"])).installed?.find((entry) => entry.pluginId === PLUGIN_ID)?.version
      const target = await inspectCodexUpdateTarget({ env, command: invoke, codex: cli, expectedVersion: version })
      if (!target) throw new Error("Cannot safely recover the pending Codex bridge update; check the native installation and configuration.")
      if (target.recovery) {
        // A previous cancellation may also have cancelled its recovery query.
        // Resolve its journal under the install lock before starting a new stage.
        const original = target.recovery.value.from === target.version ? target.recovery.value.original : target.descriptor.content
        if (target.descriptor.content !== original && !await writeExisting(descriptor, target.descriptor, original)) return skipped
        if (!await removeSnapshot(join(store, PENDING_INSTALL), target.recovery.snapshot)) return skipped
      }
    }
    if (options.expectedVersion) {
      if (!await updateStillAllowed()) return skipped
      previousDescriptor = await snapshot(descriptor)
      if (!previousDescriptor || !await writeNew(join(store, PENDING_INSTALL), json({ owner: OWNER,
        from: options.expectedVersion, to: pkg.version, original: previousDescriptor.content }))) return skipped
      pendingInstall = await snapshot(join(store, PENDING_INSTALL))
    }
    const bundle = await prepareVersion(store)
    if (previousDescriptor) stagedDescriptor = await snapshot(descriptor)
    if (options.expectedVersion) {
      // Catalog registration is already verified. Do not rewrite user config
      // while downloading/upgrading, or re-enable a concurrently disabled plugin.
      if (!sameSnapshot(options.expectedConfig, await snapshot(join(home, "config.toml")))) return skipped
    } else await query(["plugin", "marketplace", "add", store, "--json"])
    await query(["plugin", "add", PLUGIN_ID, "--json"])
    const installed = (await query(["plugin", "list", "--json"])).installed?.find((entry) => entry.pluginId === PLUGIN_ID)
    if (!installed || installed.version !== pkg.version || installed.enabled !== true || installed.source?.path !== bundle) throw new Error("Codex did not confirm the expected enabled plugin version and source.")
    committed = true
    return { changed: true, disabled: false, version: pkg.version, store }
  } finally {
    try {
      if (pendingInstall && committed) await removeSnapshot(join(store, PENDING_INSTALL), pendingInstall)
      else if (previousDescriptor && pendingInstall) {
        // Cancellation may happen after the CLI committed. Query with a separate
        // bounded command before restoring only our descriptor, never user config.
        const recover = options.recoveryCommand || invoke
        const entries = JSON.parse(await recover(cli, ["plugin", "list", "--json"], env)).installed
        const installed = entries?.find((entry) => entry.pluginId === PLUGIN_ID)
        stagedDescriptor ||= await snapshot(descriptor)
        if (installed?.version === options.expectedVersion && installed.source?.source === "local" &&
          installed.source.path === join(store, "plugins", `${PLUGIN_NAME}-${options.expectedVersion}`) &&
          stagedDescriptor?.content === json(market(pkg.version))) await writeExisting(descriptor, stagedDescriptor, previousDescriptor.content)
        const current = await snapshot(descriptor)
        if ((installed?.version === options.expectedVersion && current?.content === previousDescriptor.content) ||
          (installed?.version === pkg.version && installed.source?.path === join(store, "plugins", `${PLUGIN_NAME}-${pkg.version}`))) {
          await removeSnapshot(join(store, PENDING_INSTALL), pendingInstall)
        }
      }
    } finally { await rm(lock, { recursive: true, force: true }) }
  }
}
