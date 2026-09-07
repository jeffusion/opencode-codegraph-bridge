# opencode-codegraph-bridge

[English](README.md)

**CodeGraph Bridge for OpenCode** 将 OpenCode 与 [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph) 集成：注册 `codegraph` MCP 服务、后台执行首次索引，并在索引健康后加入简短系统提示。

## 安装

npm 包为 [`opencode-codegraph-bridge`](https://www.npmjs.com/package/opencode-codegraph-bridge)。将它追加到现有 OpenCode 配置的 `plugin` 数组中，不要替换其他插件，然后重启 OpenCode。OpenCode 启动时会自动获取插件及其 npm 依赖；这与 CodeGraph 本身不同，CodeGraph 启动时不会下载或升级依赖。

```json
{
  "plugin": ["opencode-codegraph-bridge"]
}
```

需要禁用时使用 plugin tuple：

```json
{
  "plugin": [["opencode-codegraph-bridge", { "enabled": false }]]
}
```

不需要全局安装 `codegraph`，也不需要写入全局 `OpenCode/AGENTS.md`。

## 行为

- 仅当 `mcp.codegraph` 不存在时补充配置。已有的 `mcp.codegraph`（包括 disabled 配置）完全保留，并由用户配置接管生命周期。
- 项目根来自 OpenCode 的 `worktree` 或 `directory`，并规范化为 `realpath`。只接受包含 `.git` 的 Git 根或 worktree；home、文件系统根、home 祖先和非 Git 目录会跳过，不自动扫描。
- 通过包管理器安装 CodeGraph `^1.6.0`。本仓库 lockfile 当前精确解析为 `1.6.0`，用于复现；插件启动时不会自动升级依赖或联网下载。匹配的平台包从插件自身依赖树解析，不使用全局安装路径，也不把 Bun 可执行文件当作 Node。
- 首次索引由独立 Node worker 异步执行，不阻塞 MCP 注册和首次握手。健康且非空的索引 ready 后，系统提示会建议结构问题优先使用 CodeGraph，文本检索使用 grep。
- 后续文件变化由 CodeGraph MCP watcher 处理。初始化仅限安全 Git 根，并使用兼容锁名 `.opencode-codegraph-auto.init.lock`；该锁名因并发互斥兼容性保留，npm 包改名不会改变它。

失败、不支持的平台、残缺索引和不安全数据路径都会友好降级，不阻塞聊天。插件不会安装 Git hooks、修改权限，也不会写入被索引仓库的 `.gitignore`。

## 可选的源码开发

仅进行源码开发时，可以 clone 仓库并按 lockfile 安装依赖：

```sh
git clone https://github.com/jeffusion/opencode-codegraph-bridge.git
cd opencode-codegraph-bridge
npm ci
```

然后在 OpenCode 中使用 `src/index.js` 的绝对 file URL，例如：

```json
{
  "plugin": ["file:///absolute/path/opencode-codegraph-bridge/src/index.js"]
}
```

保留其他已有插件条目。本地源码安装同样不需要全局 CodeGraph。

## 测试

```sh
npm run test:unit
npm run test:integration
npm run test:opencode
```

版本号、`CHANGELOG.md`、`package.json` 和 `package-lock.json` 由 Release Please 管理。首次发布和后续发布流程见 [RELEASING.md](https://github.com/jeffusion/opencode-codegraph-bridge/blob/main/RELEASING.md)，该文档目前保留为中文。
