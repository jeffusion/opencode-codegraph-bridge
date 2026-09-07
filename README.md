# opencode-codegraph-bridge

[简体中文](README.zh-CN.md)

**CodeGraph Bridge for OpenCode** integrates OpenCode with [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph). It registers the `codegraph` MCP server, starts the first index in the background, and adds a short system hint once the index is healthy.

## Install

The npm package is [`opencode-codegraph-bridge`](https://www.npmjs.com/package/opencode-codegraph-bridge). Add it to the existing OpenCode `plugin` array without replacing other plugins, then restart OpenCode. When enabled, the plugin checks its npm version once at startup and may update only its own `plugin` spec to an exact stable version when OpenCode supplies one unambiguous, explicit configuration source. The check never downloads code, changes the CodeGraph dependency, or hot-reloads the current session; restart OpenCode after a successful update. There is no `autoUpdate` switch.

```json
{
  "plugin": ["opencode-codegraph-bridge"]
}
```

To disable it, use the plugin tuple:

```json
{
  "plugin": [["opencode-codegraph-bridge", { "enabled": false }]]
}
```

No global `codegraph` installation and no global `OpenCode/AGENTS.md` entry are required.

## What it does

- The plugin adds `mcp.codegraph` only when that key is absent. An existing `mcp.codegraph` entry, including a disabled entry, is left untouched and takes over its own lifecycle.
- Version self-update uses only the explicit local config file or the explicitly identified global source. A global source may be that file or one of `config.json`, `opencode.json`, and `opencode.jsonc` in its directory; ambiguous, remote, environment-backed, malformed, symlinked, or concurrently changed sources are skipped without falling back elsewhere. A leftover `.opencode-codegraph-bridge.update.lock` is treated as busy and never stolen; after confirming no bridge process is running, remove that lock directory manually.
- The project root comes from OpenCode's `worktree` or `directory`, normalized with `realpath`. Only a Git root or worktree containing `.git` is accepted; home, filesystem-root, ancestor, and non-Git directories are skipped rather than scanned.
- CodeGraph `^1.6.0` is installed through the package manager. This repository lockfile currently resolves `1.6.0` for reproducibility; the plugin does not upgrade dependencies or download them at startup. The matching platform bundle is resolved from the package's own dependency tree, not from a global install or Bun's executable.
- The first index runs asynchronously in a separate Node worker. MCP registration and its initial handshake do not wait for indexing. Once a healthy non-empty index is ready, the system hint recommends CodeGraph for structural questions and grep for text search.
- CodeGraph's MCP watcher handles later file changes. Initialization is limited to safe Git roots and uses the compatibility lock `.opencode-codegraph-auto.init.lock`; the lock name is retained so renaming the npm package does not break mutual exclusion.

Failures, unsupported platforms, incomplete indexes, unsafe data paths, and failed version checks degrade without blocking chat. The version updater may write only the confirmed plugin config entry; it does not install Git hooks, modify permissions, write `AGENTS.md` (global or project), write the indexed repository's `.gitignore`, or modify OpenCode memory/config through an SDK. Concurrent changes are skipped; the final compare-before-rename still has a narrow normal filesystem race and is not claimed as an absolute transaction.

## Optional source development

For source development only, clone the repository and install its locked dependencies:

```sh
git clone https://github.com/jeffusion/opencode-codegraph-bridge.git
cd opencode-codegraph-bridge
npm ci
```

Then use the absolute file URL of `src/index.js` in OpenCode, for example:

```json
{
  "plugin": ["file:///absolute/path/opencode-codegraph-bridge/src/index.js"]
}
```

Keep the other existing plugin entries. A local checkout does not require a global CodeGraph install.

## Tests

```sh
npm run test:unit
npm run test:integration
npm run test:opencode
```

Release Please manages versions, `CHANGELOG.md`, `package.json`, and `package-lock.json`. See [RELEASING.md](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/RELEASING.md) for the first-publish and release procedure; that document is currently maintained in Chinese.
