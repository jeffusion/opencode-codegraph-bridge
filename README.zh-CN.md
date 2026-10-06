# CodeGraph Bridge for OpenCode and Codex

无需手工配置 MCP 服务或执行首次索引，即可在 OpenCode 中使用 CodeGraph 的结构化代码探索能力。本包支持 OpenCode v1、v2 配置格式，以及 Codex 原生插件。

[English](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/README.md)

[![npm version](https://img.shields.io/npm/v/opencode-codegraph-bridge?logo=npm)](https://www.npmjs.com/package/opencode-codegraph-bridge)
[![npm license](https://img.shields.io/npm/l/opencode-codegraph-bridge)](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
[![CI](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml)

## 为什么使用

CodeGraph 能回答纯文本搜索难以回答的代码结构问题，但需要配置 MCP 服务并建立初始索引。本插件只会为安全的 Git 项目根完成这些工作，其他情况不会干预 OpenCode。

## 功能

- 仅当对应的 v1 或 v2 MCP 配置尚不存在时注册 CodeGraph MCP 服务。
- 后台建立首次索引，MCP 注册不会等待索引完成。
- 为安全的 Git 根成功注入 MCP 服务后注册 session context 提示：v1 使用 `experimental.chat.system.transform`，v2 使用 `ctx.session.hook('context')`；提示建议在 CodeGraph 工具可用时使用它。
- 使用本包安装的 `@colbymchenry/codegraph` 依赖（`^1.6.0`），不依赖全局 `codegraph` 命令。

## 快速开始

为保持向后兼容，安装器默认使用旧版 v1 格式。安装后请重启 OpenCode：

```sh
npx opencode-codegraph-bridge install
```

若要明确写入 v2 配置，请使用：

```sh
npx opencode-codegraph-bridge install --format v2
```

安装器会将本次运行包的精确版本写入标准全局 OpenCode 配置目录（`$XDG_CONFIG_HOME/opencode`，或 `~/.config/opencode`），并保留现有配置格式。如果请求的格式与现有配置冲突，安装会停止，需手工确认并解决冲突，不会自动转换或覆盖。安装器不会修改 `AGENTS.md` 或 MCP 配置。

## Codex 安装与使用

需要 PATH 中可用的 Node.js、npm/npx、Git 和官方 Codex CLI；Linux 上以 Codex **0.160.0** 验证。执行一次：

```sh
npx opencode-codegraph-bridge install --host codex
```

安装器在 `${CODEX_HOME:-~/.codex}/codegraph-bridge/marketplace` 生成版本化的本地插件，调用官方 `codex plugin marketplace add` 和 `codex plugin add` 注册，再核对来源、版本和启用状态。它不直接编辑 `config.toml`、`hooks.json` 或 `AGENTS.md`。同版重复执行不写入；已有较高版本不降级，已禁用插件不重新启用。同名但不同来源的插件或 marketplace 会停止安装，保留原内容。更新使用同一条命令，bridge 版本来自本次运行的包版本。

安装后重启 Codex。在 CLI 的 `/hooks` 中审核并信任插件命令 hook，即可启用自动提示。Codex 要求审核具体 hook 定义；安装或启用插件不会自动信任 hook，定义变化后也可能需要重新审核。安装器不会绕过这项要求。参考[官方 Hook 文档](https://learn.chatgpt.com/docs/hooks)。

Codex 的提示通过 `SessionStart`（startup、resume、clear、compact）和 `SubagentStart` 的 `additionalContext` 加入 developer context；与 OpenCode 的 system hook 接口不同。插件同时提供 `codegraph-exploration` skill。提示明确说明首次索引在后台进行，工具出现并不代表索引已就绪，结果不足时应继续使用允许的文件读取和搜索工具。

原生 MCP 使用独立键 `codegraph_bridge`，以固定 bridge 版本的 `npx --yes --prefer-offline` 启动。本包仍保留 CodeGraph **`^1.6.0`** 范围依赖；新 npm 缓存可能解析出范围内不同的 CodeGraph 版本。首次启动需要访问 npm 获取包及平台依赖，随后复用 npm 缓存；启动超时为 120 秒，失败不阻止 Codex 会话。Codex 会话 cwd 通过 Git 解析到安全仓库根目录，支持子目录及 worktree；在非 Git 目录不会索引。EOF、SIGTERM、SIGINT 会清理 bridge 自己的 launcher 和初始化 worker，共享 CodeGraph daemon 由 CodeGraph 自行管理。

已有手工配置的 CodeGraph MCP 会保留。若出现重复工具，可在 Codex 的 MCP 管理界面禁用其中一个；插件不会接管或删掉既有服务。提示建议一致使用一个 CodeGraph 服务。

高级用法：直接启动 stdio MCP（stdout 仅包含协议消息，诊断写 stderr）：

```sh
opencode-codegraph-bridge mcp --host codex --project /path/to/repository
```

只生成可搬移的 marketplace，不安装：

```sh
node src/cli.js package-codex --output /tmp/codegraph-codex-marketplace
```

输出目录须不存在或为空，插件的提示脚本自包含，不依赖 npm 缓存位置。生成后的 MCP 仍通过 npm 获取对应 bridge 版本，因此发版前使用本地 registry 的打包测试；不要以 npm 上的同号旧包验证未发布代码。删除安装请使用 `codex plugin remove codegraph-bridge@codegraph-bridge`；需要时再使用 `codex plugin marketplace remove codegraph-bridge`。本地生成文件保留供检查。

CLI 与 app-server 的真实加载、MCP 调用及 SessionStart developer context 已有自动化测试；resume/clear/compact 与 SubagentStart 的输出契约有单元覆盖，尚未逐项进行真实宿主端验证。桌面端与 IDE 依赖各自内置 Codex 的原生插件能力，本项目尚未完成这些界面的运行验证。

## 配置

OpenCode v1 使用 `plugin`，v2 使用 `plugins`。添加 bridge 时应沿用现有格式，并保留其他所有条目。

v1 中，启用插件时可直接使用包名字符串；禁用时使用 tuple 形式：

```json
{
  "plugin": [
    ["opencode-codegraph-bridge", { "enabled": false }]
  ]
}
```

v2 使用对象条目；将 `options.enabled` 设为 `false` 可禁用插件：

```json
{
  "plugins": [
    { "package": "opencode-codegraph-bridge", "options": { "enabled": false } }
  ]
}
```

v1 与 v2 插件配置格式不可互换。不需要手工执行 `npm install`、全局安装 `codegraph`，也不需要全局 `OpenCode/AGENTS.md`。插件从 OpenCode 上下文获取项目位置，并且只索引安全的 Git 根目录；CodeGraph 数据存放在该项目的 `.codegraph` 中（或你设置的有效 `CODEGRAPH_DIR` 名称）。

## 使用方式

索引就绪后，直接提出结构化问题，例如：

> 认证中间件在哪里注册，它保护了哪些路由？

> 从这个 API 端点追踪到数据库写入的调用路径。

如果 CodeGraph 不可用，或结果不足以回答问题，OpenCode 仍可使用常规的文件读取和文本搜索工具。

## 工作方式

1. 对于安全的 Git 根，插件仅在尚无对应 MCP 配置时注入本地 CodeGraph MCP 服务，然后注册 session context 提示：v1 使用 `experimental.chat.system.transform`，v2 使用 `ctx.session.hook('context')`。提示建议在 CodeGraph 工具可用时使用它；注册提示不会等待健康索引就绪。
2. 独立 Node worker 按需检查项目，并在后台建立首次索引。
3. 后续文件变化由 CodeGraph MCP 服务监视。

MCP 配置键因 OpenCode 格式而异：v1 使用 `mcp.codegraph` 和 `enabled` 标记；v2 使用 `mcp.servers.codegraph` 和 `disabled` 标记。例如，禁用的 v1 配置为 `"mcp": { "codegraph": { "enabled": false } }`；对应的 v2 配置为 `"mcp": { "servers": { "codegraph": { "disabled": true } } }`。已有 MCP 配置（包括已禁用的条目）绝不会被覆盖，该配置自行管理其生命周期。

插件没有其他选项。不同的 OpenCode v1/v2 版本可能具备不同能力；此处的兼容说明不代表承诺支持所有 v1 子版本。

## 更新

v1 仍按来源感知方式自动更新：仅当 `plugin_origins` 提供可信且可识别的来源时才尝试更新，否则跳过。v2 自动更新仅适用于安全的 Git 根目录。插件会在后台有限范围检查当前目录的 `opencode.json`/`opencode.jsonc`、`.opencode/opencode.json`/`.opencode/opencode.jsonc`，以及用户 XDG 配置目录下的 `opencode/opencode.json`/`opencode/opencode.jsonc`；祖先目录只进行只读重复项检查。v1 和 v2 都支持本包裸名、`@latest` 或明确固定的稳定版本；版本范围、其他 tag 和预发布版本都会跳过。符合条件的 v2 条目可以是字符串，也可以是 `{ "package": "...", "options": ... }`，其他选项会保留。更新前，宿主 `plugin.list` 中的 package target 必须与待写入磁盘条目的 package spec 字符串完全一致。OpenCode 插件列表还必须确认本包是唯一的 active server 且来源为 package；本地路径来源、自动发现或无法取得插件列表时都会跳过。写入前会再次核对磁盘条目，因此等待更新期间（包括重启时）用户若修改配置，更新就会跳过。成功更新时，裸名或 `@latest` 会替换为明确固定的稳定版本。这些是保守验证，并不表示能够精确判断每个插件条目的配置来源。禁用条目、多处或冲突匹配、opaque 的 file/Git/alias spec、`OPENCODE_CONFIG*` 环境覆盖，以及损坏或符号链接文件都会跳过更新。两版差异不只是配置路径：v1 使用 `plugin` 条目（字符串或 tuple）及 `plugin_origins` API；v2 使用 `plugins` 条目（字符串或对象）及宿主 `plugin.list` API。版本查询使用公开 npm registry 的 `latest` 版本。更新只修改配置文件，需重启 OpenCode 才会生效。CLI 的 `install --format v2` 是独立的安装路径，不会改变此自动更新行为。

## 平台说明

CodeGraph 的平台运行时从本包依赖树中解析。本 bridge 已在 Linux 验证；其他系统能否使用取决于 CodeGraph 是否提供相应的平台包。

## 排障

| 问题 | 检查方式 |
| --- | --- |
| 没有 CodeGraph MCP 工具 | 在 OpenCode 中打开 Git 项目根目录；已有 `mcp.servers.codegraph`（v2）或 `mcp.codegraph`（v1）会按设计优先；再查看 OpenCode 日志是否提示 CodeGraph 依赖缺失。 |
| npm 镜像返回 404 | 先运行 `npm config get registry`，再用 `npm view opencode-codegraph-bridge version --registry=https://registry.npmjs.org/` 显式检查官方包。仅在你确有意图时更改 registry。 |

## 开发

```sh
git clone https://github.com/jeffusion/opencode-codegraph-bridge.git
cd opencode-codegraph-bridge && npm ci
npm run test:unit && npm run test:integration && npm run test:opencode
npm run test:codex && npm run test:codex:pack
```

本地开发时，根据 OpenCode 配置格式选择入口。v1 插件入口可指向 `./src/index.js` 或包根目录的 `index.js`。v2 的 `package` 指向包含 `server.js` 的包目录。请保留其他插件。

v1 示例：

```json
{
  "plugin": ["/absolute/path/opencode-codegraph-bridge/src/index.js"]
}
```

v2 示例：

```json
{
  "plugins": [
    { "package": "/absolute/path/opencode-codegraph-bridge" }
  ]
}
```

## 发布

参见[更新日志](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/CHANGELOG.md)、[GitHub Releases](https://github.com/jeffusion/opencode-codegraph-bridge/releases) 和中文版[发布指南](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/RELEASING.md)。

## 贡献

请先通过 issue 提交缺陷或建议，再提交带有相关测试的聚焦 PR。提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

[MIT](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
