# opencode-codegraph-bridge

**CodeGraph Bridge for OpenCode**：一个独立的 OpenCode 插件。安装时使用 `@colbymchenry/codegraph@^1.6.0`，即 `>=1.6.0 <2.0.0` 的稳定版本范围；自动注册 CodeGraph MCP，在后台完成首次索引，并在索引健康后给系统提示。

## 本地安装

本项目尚未发布到 npm，npm 名称为 `opencode-codegraph-bridge`。从 GitHub clone 后，在 clone 目录运行 `npm ci` 安装依赖，然后在现有 OpenCode 配置的 `plugin` 数组中追加本地入口，不要覆盖其他插件。项目 `package-lock.json` 当前精确锁定已解析的 `1.6.0` 及其完整性校验值，用于复现；消费者的安装/更新由各自包管理器和 lock 文件决定，插件启动时不会联网升级依赖：

```json
{
  "plugin": ["file:///绝对路径/opencode-codegraph-bridge/src/index.js"]
}
```

例如：

```sh
git clone https://github.com/jeffusion/opencode-codegraph-bridge.git
cd opencode-codegraph-bridge
npm ci
realpath src/index.js  # 将输出转换为 file:// URL 放入 OpenCode 配置
```

修改配置后重启 OpenCode。首发到 npm 后，也可由 OpenCode 安装 `opencode-codegraph-bridge`；首发前请使用 clone 后生成的本地 file URL。需要关闭时，将该条目改为 plugin tuple：

```json
{
  "plugin": [["file:///绝对路径/opencode-codegraph-bridge/src/index.js", { "enabled": false }]]
}
```

## 版本与发布

版本号、`CHANGELOG.md`、`package.json` 和 `package-lock.json` 由 Release Please 自动维护。`.release-please-manifest.json` 首发保持为空对象，根目录 `.` 使用 Node strategy；配置支持 `initial-version: 0.1.0`。在 `0.x` 期间，规范 `feat` 产生 minor、`fix` 产生 patch，breaking change 产生 minor，不会自动合并 Release Please PR。

当前唯一初始 feature commit `85df0cd4e7c00befe7ba16433c505969e904e95d` 会由首次 Release Please PR 提议 `0.1.0`。用户审核并合并该 PR 后，Release Please 创建 GitHub `v0.1.0` Release；默认 `NPM_PUBLISH_ENABLED` 未设置，发布 job 会跳过。用户随后手工发布 npm `0.1.0`、配置 Trusted Publishing，再在 GitHub 仓库变量中手工设置 `NPM_PUBLISH_ENABLED=true`。以后合并的 Release Please PR 才会触发自动发布；npm 版本不可重复使用。

GitHub Token 创建的 bot PR 通常不会触发 `pull_request` CI；Release Please 创建或更新可信的同仓库 PR 后，会用 `GITHUB_TOKEN` 自动 dispatch `ci.yml` 到该 PR head。不要把原 `pull_request` 的 `action_required` 误称为通过，应查看 dispatch workflow 的同一 SHA。CI 仍保留 Actions → CI → Run workflow 和 `gh workflow run ci.yml --ref <发版分支>` 供手工排障，发布 workflow 自身也会重新执行完整测试和打包检查。

插件使用自己的依赖解析 CodeGraph 及其匹配平台包，不使用全局安装路径，也不把 Bun 的 `process.execPath` 当作 Node。

## 行为与边界

- `config` 阶段直接注册 `mcp.codegraph`：命令是插件依赖中的绝对 bundled Node、绝对 `npm-shim.js`，参数为 `serve --mcp --path <项目根>`；设置 `CODEGRAPH_NO_DOWNLOAD=1`，不在运行时联网自愈。
- 项目根取 OpenCode 的 `worktree`（有则优先）或 `directory`，规范化为 `realpath`。只有自身含 `.git` 目录或 worktree `.git` 文件的根才处理；home、home 的祖先、文件系统根和非 Git 目录会跳过，不会自动向上/向下扫描。
- MCP 注册不等待索引。首次索引由独立的 bundled Node worker 执行：`CodeGraph.init(root, { index: false })`、`indexAll()`，不调用 CLI `init --yes`，因此不会安装 Git hooks；CodeGraph 自己的 watcher/daemon 行为不被关闭。
- 索引锁位于项目 CodeGraph 数据目录中的 `.opencode-codegraph-auto.init.lock`，使用原子 `mkdir`，记录 worker PID。该锁名为兼容并发互斥而保留，即使 npm 包改名也不会改变。其他进程只会有限、低频等待；死锁或残缺锁提示手动修复，不强抢、不删除/重建已有数据库。
- 可用状态必须满足 `status <root> --json` 的 `initialized`、匹配 `projectPath`、`index.state=complete`、非空 `lastIndexed`、`pendingRefs=0`，且至少有一个索引文件；仅目录存在或退出码为 0 不算 ready。健康现有索引不会再次 init/index/sync。
- ready 后系统提示结构问题优先使用 CodeGraph MCP，文本检索仍可使用 grep，并以 JSON 编码项目根，避免换行注入；插件不修改权限。
- `CODEGRAPH_DIR` 等环境变量原样传给 MCP/worker，插件按 CodeGraph 的单目录名规则定位数据，避免索引到错误目录。缺少匹配平台包、状态失败或索引失败都会友好降级，不影响聊天。
- 可用 plugin tuple 的 `{ "enabled": false }` 关闭插件。若用户已有 `mcp.codegraph` 键（包括 `disabled`/禁用配置），插件完全尊重，不覆盖、不自动初始化；用户自己的 MCP 配置接管生命周期。

插件不会写全局 `OpenCode/AGENTS.md`，不会写 Git hooks，也不会修改被索引仓库的 `.gitignore`；CodeGraph 自己的数据目录仍由上游管理。

## 测试

```sh
npm run test:unit
npm run test:integration
npm run test:opencode
```

`test/integration.test.js` 会创建临时 Git 项目，验证同一连接的 `initialize`/`tools/list`、`explore` 独有符号和 watcher 修改；测试只清理自己创建的进程。测试隔离使用 `CODEGRAPH_NO_DAEMON=1`，生产默认不设置。

`test/opencode-smoke.js` 使用临时 XDG 目录和 `OPENCODE_CONFIG`，配置只包含项目文件 URL 插件、不继承全局插件/provider，也不调用 LLM；通过 OpenCode server 的 `/mcp` 状态确认没有静态 `mcp` 配置仍出现并连接 CodeGraph。找不到 `opencode` 时明确输出 `SKIP`。
