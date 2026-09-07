# CodeGraph Bridge for OpenCode

Use CodeGraph's structural code exploration in OpenCode without manually wiring an MCP server or running the first index.

[中文](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/opencode-codegraph-bridge?logo=npm)](https://www.npmjs.com/package/opencode-codegraph-bridge)
[![npm license](https://img.shields.io/npm/l/opencode-codegraph-bridge)](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
[![CI](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml)

## Why

CodeGraph can answer structural questions that plain text search cannot, but its MCP server and initial index need setup. This plugin performs that setup only for a safe Git project root and otherwise leaves OpenCode alone.

## Features

- Registers `mcp.codegraph` only when you have not already configured it.
- Builds the first index in the background, so MCP registration does not wait for indexing.
- Adds guidance to prefer CodeGraph for structural exploration only after a healthy index is ready.
- Uses the installed `@colbymchenry/codegraph` dependency (`^1.6.0`), not a global `codegraph` command.

## Quick start

Add the package to your existing OpenCode `plugin` array, keeping every other entry, then restart OpenCode:

```json
{
  "plugin": [
    "opencode-codegraph-bridge"
  ]
}
```

No manual `npm install`, global `codegraph` installation, or global `OpenCode/AGENTS.md` entry is required. The plugin only indexes the Git root supplied by OpenCode's `worktree` or `directory`; CodeGraph data is stored in that project under `.codegraph` (or the valid `CODEGRAPH_DIR` name you set).

## Usage

After the index is ready, ask normal structural questions, for example:

> Where is authentication middleware registered, and which routes does it protect?

> Trace the call path from this API endpoint to the database write.

If CodeGraph is unavailable or its result is insufficient, OpenCode can still use its ordinary file-reading and text-search tools.

## How it works

1. At OpenCode configuration time, the plugin registers a local CodeGraph MCP server if `mcp.codegraph` is absent.
2. A separate Node worker checks the project and builds the first index in the background when needed.
3. Once CodeGraph reports a healthy, non-empty index, the plugin adds focused CodeGraph guidance to the chat system prompt.
4. The CodeGraph MCP server watches later file changes.

An existing `mcp.codegraph` entry, including a disabled one, is never replaced; that configuration owns its own lifecycle.

## Configuration

Disable the plugin with its supported tuple option:

```json
{
  "plugin": [["opencode-codegraph-bridge", { "enabled": false }]]
}
```

There are no other plugin options.

## Automatic updates

When enabled, the plugin checks the official npm registry once at startup. If OpenCode identifies one unambiguous, safe local or global configuration source, the plugin may replace **only its own** package spec with the latest exact stable version. It skips an unclear or unsafe source rather than guessing.

The current OpenCode session is not hot-reloaded. After a successful update, supported OpenCode clients receive an OpenCode notification titled `CodeGraph Bridge` with:

> Update ready. Restart OpenCode to apply.

Notification availability depends on the client's native OpenCode notification support. The updater does not change CodeGraph dependencies, install global tools, or alter your npm registry setting.

## Platform notes

CodeGraph's platform-specific runtime is resolved from this package's dependency tree. This bridge is validated on Linux; availability on other systems depends on the corresponding CodeGraph platform package.

## Troubleshooting

| Problem | Check |
| --- | --- |
| No CodeGraph MCP tools | Open the Git project root in OpenCode; an existing `mcp.codegraph` entry deliberately takes precedence; then check OpenCode logs for a missing CodeGraph dependency. |
| An update did not take effect | Restart OpenCode. Updates do not reload the active session. |
| npm mirror returns 404 | Inspect `npm config get registry`, then diagnose the official package explicitly with `npm view opencode-codegraph-bridge version --registry=https://registry.npmjs.org/`. Change your registry only if you intend to. |

<details>
<summary>Advanced: recover a leftover lock</summary>

Do this only after confirming no bridge or indexing process is running. Inspect and, if appropriate, remove `.opencode-codegraph-bridge.update.lock` beside the affected OpenCode config, or `.codegraph/.opencode-codegraph-auto.init.lock` in the project. The plugin intentionally does not take over stale locks automatically.
</details>

## Development

```sh
git clone https://github.com/jeffusion/opencode-codegraph-bridge.git
cd opencode-codegraph-bridge && npm ci
npm run test:unit && npm run test:integration && npm run test:opencode
```

For local development, use an absolute file URL and retain other plugins:

```json
{
  "plugin": ["file:///absolute/path/opencode-codegraph-bridge/src/index.js"]
}
```

## Releases

See the [Changelog](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/CHANGELOG.md), [releases](https://github.com/jeffusion/opencode-codegraph-bridge/releases), and the Chinese [release guide](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/RELEASING.md).

## Contributing

Open an issue for a bug or proposal, then send a focused PR with relevant tests. Use [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
