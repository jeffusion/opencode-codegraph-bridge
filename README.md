# CodeGraph Bridge for OpenCode

Use CodeGraph's structural code exploration in OpenCode without manually wiring an MCP server or running the first index. This package supports both OpenCode v1 and v2 configuration formats.

[中文](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/opencode-codegraph-bridge?logo=npm)](https://www.npmjs.com/package/opencode-codegraph-bridge)
[![npm license](https://img.shields.io/npm/l/opencode-codegraph-bridge)](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
[![CI](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml)

## Why

CodeGraph can answer structural questions that plain text search cannot, but its MCP server and initial index need setup. This plugin performs that setup only for a safe Git project root and otherwise leaves OpenCode alone.

## Features

- Registers the CodeGraph MCP server only when the corresponding v1 or v2 MCP entry is not already configured.
- Builds the first index in the background, so MCP registration does not wait for indexing.
- After successfully injecting the MCP server for a safe Git root, registers session-context guidance using `experimental.chat.system.transform` in v1 and `ctx.session.hook('context')` in v2; the guidance recommends CodeGraph when its tools are available.
- Uses the installed `@colbymchenry/codegraph` dependency (`^1.6.0`), not a global `codegraph` command.

## Quick start

The installer defaults to the legacy v1 format for backward compatibility. Restart OpenCode after installation:

```sh
npx opencode-codegraph-bridge install
```

To explicitly write a v2 configuration, use:

```sh
npx opencode-codegraph-bridge install --format v2
```

The installer writes the exact package version for this invocation to the standard global OpenCode config directory (`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`). It preserves the existing configuration format; if the requested format conflicts with the existing configuration, installation stops and you must resolve the conflict manually. It does not change `AGENTS.md` or MCP configuration.

## Configuration

OpenCode v1 uses `plugin`; v2 uses `plugins`. Keep the existing format and retain all other entries when adding the bridge.

For v1, an enabled plugin can be a package string; use the tuple form to disable it:

```json
{
  "plugin": [
    ["opencode-codegraph-bridge", { "enabled": false }]
  ]
}
```

For v2, use an object entry; set `options.enabled` to `false` to disable it:

```json
{
  "plugins": [
    { "package": "opencode-codegraph-bridge", "options": { "enabled": false } }
  ]
}
```

The v1 and v2 plugin configuration formats are not interchangeable. No manual `npm install`, global `codegraph` installation, or global `OpenCode/AGENTS.md` entry is required. The plugin gets the project location from OpenCode's context and only indexes a safe Git root; CodeGraph data is stored in that project under `.codegraph` (or the valid `CODEGRAPH_DIR` name you set).

## Usage

After the index is ready, ask normal structural questions, for example:

> Where is authentication middleware registered, and which routes does it protect?

> Trace the call path from this API endpoint to the database write.

If CodeGraph is unavailable or its result is insufficient, OpenCode can still use its ordinary file-reading and text-search tools.

## How it works

1. For a safe Git root, the plugin injects a local CodeGraph MCP server only if one is not already configured, then registers session-context guidance using `experimental.chat.system.transform` in v1 or `ctx.session.hook('context')` in v2. The guidance recommends CodeGraph when its tools are available; registering it does not wait for a healthy index.
2. A separate Node worker checks the project and builds the first index in the background when needed.
3. The CodeGraph MCP server watches later file changes.

The MCP configuration key differs by OpenCode format: v1 uses `mcp.codegraph` and its `enabled` flag; v2 uses `mcp.servers.codegraph` and its `disabled` flag. For example, a disabled v1 entry is `"mcp": { "codegraph": { "enabled": false } }`; the v2 equivalent is `"mcp": { "servers": { "codegraph": { "disabled": true } } }`. An existing entry, including a disabled one, is never replaced; that configuration owns its own lifecycle.

There are no other plugin options. OpenCode v1/v2 versions may differ in available capabilities; this compatibility statement does not promise support for every v1 subversion.

## Updating

For v1, automatic updating remains source-aware: an update is attempted only when `plugin_origins` provides a trusted, identifiable source; otherwise it is skipped. For v2, automatic updating is limited to a safe Git root. In the background, the plugin checks only the current directory's `opencode.json`/`opencode.jsonc`, `.opencode/opencode.json`/`.opencode/opencode.jsonc`, and the user's XDG config `opencode/opencode.json`/`opencode.jsonc`. Ancestor directories are checked read-only for duplicates. Both versions support the bare package name, `@latest`, or an explicitly pinned stable version; version ranges, other tags, and prereleases are skipped. An eligible v2 entry may be a string or `{ "package": "...", "options": ... }`; other options are preserved. Before updating, the host's `plugin.list` package target must exactly match the package spec string in the disk entry to be written. OpenCode's plugin list must also confirm that this package is the sole active server and its source is a package; local-path sources, automatic discovery, or an unavailable plugin list cause the update to be skipped. At write time, the on-disk entry is checked again, so a user edit while the update is waiting (including a restart) causes it to be skipped. A successful update replaces a bare name or `@latest` with an explicitly pinned stable version. These are conservative checks, not a claim that the exact configuration source of each plugin entry can be determined. Disabled entries, multiple/conflicting matches, opaque file/Git/alias specs, `OPENCODE_CONFIG*` environment overrides, or damaged/symlinked files are also skipped. The two versions do not differ only in config paths: v1 uses `plugin` entries (strings or tuples) and its `plugin_origins` API, while v2 uses `plugins` entries (strings or objects) and the host’s `plugin.list` API. Version lookup uses the public npm `latest` version. Only the configuration file is changed; restart OpenCode for the update to take effect. The CLI's `install --format v2` is a separate installation path and does not change this auto-update behavior.

## Platform notes

CodeGraph's platform-specific runtime is resolved from this package's dependency tree. This bridge is validated on Linux; availability on other systems depends on the corresponding CodeGraph platform package.

## Troubleshooting

| Problem | Check |
| --- | --- |
| No CodeGraph MCP tools | Open the Git project root in OpenCode; an existing `mcp.servers.codegraph` (v2) or `mcp.codegraph` (v1) entry deliberately takes precedence; then check OpenCode logs for a missing CodeGraph dependency. |
| npm mirror returns 404 | Inspect `npm config get registry`, then diagnose the official package explicitly with `npm view opencode-codegraph-bridge version --registry=https://registry.npmjs.org/`. Change your registry only if you intend to. |

## Development

```sh
git clone https://github.com/jeffusion/opencode-codegraph-bridge.git
cd opencode-codegraph-bridge && npm ci
npm run test:unit && npm run test:integration && npm run test:opencode
```

For local development, use the entry form for the OpenCode configuration format in use. In v1, point the plugin entry to `./src/index.js` or the package-root `index.js`. In v2, point `package` at the absolute package directory containing `server.js`. Retain other plugins.

v1 example:

```json
{
  "plugin": ["/absolute/path/opencode-codegraph-bridge/src/index.js"]
}
```

v2 example:

```json
{
  "plugins": [
    { "package": "/absolute/path/opencode-codegraph-bridge" }
  ]
}
```

## Releases

See the [Changelog](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/CHANGELOG.md), [releases](https://github.com/jeffusion/opencode-codegraph-bridge/releases), and the Chinese [release guide](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/RELEASING.md).

## Contributing

Open an issue for a bug or proposal, then send a focused PR with relevant tests. Use [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
