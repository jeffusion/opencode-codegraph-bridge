# CodeGraph Bridge for OpenCode

无需手工配置 MCP 服务或执行首次索引，即可在 OpenCode 中使用 CodeGraph 的结构化代码探索能力。本包支持 OpenCode v1 和 v2 配置格式。

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

v1 仅在 `plugin_origins` 能提供可信且可识别的插件来源时保留自动更新；没有可信来源时会跳过更新。v2 不会自动更新。请在 OpenCode 实际使用的配置文件中手动升级本包（或使用最初安装时采用的包管理器升级），然后重启 OpenCode。

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
