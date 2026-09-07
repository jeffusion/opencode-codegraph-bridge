# CodeGraph Bridge for OpenCode

无需手工配置 MCP 服务或执行首次索引，即可在 OpenCode 中使用 CodeGraph 的结构化代码探索能力。

[English](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/README.md)

[![npm version](https://img.shields.io/npm/v/opencode-codegraph-bridge?logo=npm)](https://www.npmjs.com/package/opencode-codegraph-bridge)
[![npm license](https://img.shields.io/npm/l/opencode-codegraph-bridge)](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
[![CI](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffusion/opencode-codegraph-bridge/actions/workflows/ci.yml)

## 为什么使用

CodeGraph 能回答纯文本搜索难以回答的代码结构问题，但需要配置 MCP 服务并建立初始索引。本插件只会为安全的 Git 项目根完成这些工作，其他情况不会干预 OpenCode。

## 功能

- 仅当你尚未配置时注册 `mcp.codegraph`。
- 后台建立首次索引，MCP 注册不会等待索引完成。
- 仅在健康索引就绪后，加入优先使用 CodeGraph 进行结构化探索的提示。
- 使用本包安装的 `@colbymchenry/codegraph` 依赖（`^1.6.0`），不依赖全局 `codegraph` 命令。

## 快速开始

注册本次运行的版本，然后重启 OpenCode：

```sh
npx opencode-codegraph-bridge install
```

安装器只会把本次运行包的精确版本写入标准全局 OpenCode 配置目录（`$XDG_CONFIG_HOME/opencode`，或 `~/.config/opencode`）。必须重启 OpenCode 才会加载安装的插件；安装器不会修改 `AGENTS.md` 或 MCP 配置。

为避免重复加载 bridge：配置中不存在 npm bridge 条目、但含有 `file:`、git 或 npm alias 插件时，安装器会要求你手工确认配置，不会自动追加。

手工配置仍可作为替代方案：将本包加入现有配置的 `plugin` 数组，并保留其他所有条目：

```json
{
  "plugin": [
    "opencode-codegraph-bridge"
  ]
}
```

不需要手工执行 `npm install`、全局安装 `codegraph`，也不需要全局 `OpenCode/AGENTS.md`。插件只索引 OpenCode 通过 `worktree` 或 `directory` 提供的 Git 根目录；CodeGraph 数据存放在该项目的 `.codegraph` 中（或你设置的有效 `CODEGRAPH_DIR` 名称）。

## 使用方式

索引就绪后，直接提出结构化问题，例如：

> 认证中间件在哪里注册，它保护了哪些路由？

> 从这个 API 端点追踪到数据库写入的调用路径。

如果 CodeGraph 不可用，或结果不足以回答问题，OpenCode 仍可使用常规的文件读取和文本搜索工具。

## 工作方式

1. OpenCode 配置阶段，若不存在 `mcp.codegraph`，插件注册本地 CodeGraph MCP 服务。
2. 独立 Node worker 按需检查项目，并在后台建立首次索引。
3. CodeGraph 报告健康且非空的索引后，插件向聊天系统提示加入精简的 CodeGraph 使用指引。
4. 后续文件变化由 CodeGraph MCP 服务监视。

已有的 `mcp.codegraph`（包括 disabled 条目）绝不会被覆盖，该配置自行管理其生命周期。

## 配置

使用唯一支持的 tuple 选项禁用插件：

```json
{
  "plugin": [["opencode-codegraph-bridge", { "enabled": false }]]
}
```

没有其他插件选项。

## 自动更新

插件启用时会在启动阶段查询一次官方 npm registry。只有 OpenCode 能识别出唯一、明确且安全的本地或全局配置来源时，插件才可能将**自己的**包 spec 更新为最新的精确稳定版本；来源不清晰或不安全时会跳过，不会猜测写入位置。

当前 OpenCode 会话不会热加载。更新成功后，支持原生 OpenCode notification 的客户端会收到标题为 `CodeGraph Bridge` 的 OpenCode 通知：

> Update ready. Restart OpenCode to apply.

通知是否可见取决于客户端的原生 OpenCode notification 支持。更新器不会修改 CodeGraph 依赖、安装全局工具，或更改你的 npm registry 设置。

## 平台说明

CodeGraph 的平台运行时从本包依赖树中解析。本 bridge 已在 Linux 验证；其他系统能否使用取决于 CodeGraph 是否提供相应的平台包。

## 排障

| 问题 | 检查方式 |
| --- | --- |
| 没有 CodeGraph MCP 工具 | 在 OpenCode 中打开 Git 项目根目录；已有 `mcp.codegraph` 会按设计优先；再查看 OpenCode 日志是否提示 CodeGraph 依赖缺失。 |
| 更新后没有生效 | 重启 OpenCode；更新不会重载当前会话。 |
| npm 镜像返回 404 | 先运行 `npm config get registry`，再用 `npm view opencode-codegraph-bridge version --registry=https://registry.npmjs.org/` 显式检查官方包。仅在你确有意图时更改 registry。 |

<details>
<summary>高级：处理残留锁</summary>

仅在确认没有 bridge 或索引进程运行后操作。检查并在合适时删除受影响 OpenCode 配置旁的 `.opencode-codegraph-bridge.update.lock`，或项目中 `.codegraph/.opencode-codegraph-auto.init.lock`。插件不会自动接管残留锁。
</details>

## 开发

```sh
git clone https://github.com/jeffusion/opencode-codegraph-bridge.git
cd opencode-codegraph-bridge && npm ci
npm run test:unit && npm run test:integration && npm run test:opencode
```

本地开发时使用绝对 file URL，并保留其他插件：

```json
{
  "plugin": ["file:///absolute/path/opencode-codegraph-bridge/src/index.js"]
}
```

## 发布

参见[更新日志](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/CHANGELOG.md)、[GitHub Releases](https://github.com/jeffusion/opencode-codegraph-bridge/releases) 和中文版[发布指南](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/RELEASING.md)。

## 贡献

请先通过 issue 提交缺陷或建议，再提交带有相关测试的聚焦 PR。提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

[MIT](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/LICENSE)
