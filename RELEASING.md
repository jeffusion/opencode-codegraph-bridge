# 发布说明

仓库：`jeffusion/opencode-codegraph-bridge`；npm 包：`opencode-codegraph-bridge`。版本号、`CHANGELOG.md`、`package.json` 和 `package-lock.json` 由 Release Please 维护，不手造历史 changelog，也不自动合并 Release Please PR。

## 首次 `0.1.0` 流程

当前唯一初始 feature commit `85df0cd4e7c00befe7ba16433c505969e904e95d` 会触发首次 Release Please PR。由于 `.release-please-manifest.json` 为空对象、root `.` 使用 Node strategy 且配置 `initial-version: 0.1.0`，该 PR 应提议 `0.1.0`，并更新 package/lock/changelog。用户需要审核 PR 的版本、变更范围和生成的 changelog 后手工合并；不要让机器人自动合并。

合并后 Release Please 创建 GitHub `v0.1.0` Release。仓库变量 `NPM_PUBLISH_ENABLED` 默认未设置，所以同一 workflow 的 npm publish job 会跳过。此时由用户手工完成 npm 首发：

1. 在 npm 网站确认账号、登录 email 和 2FA 已准备好，在本地手工执行 `npm login`，按 npm 提示完成认证。
2. 在项目目录执行：

   ```sh
   npm ci
   npm run test:unit
   npm run test:integration
   npm pack --dry-run
   npm publish --access public
   ```

3. 首发成功后，在 npm 网页该包的 **Settings → Trusted publishing** 添加 GitHub Actions trusted publisher：owner `jeffusion`、repository `opencode-codegraph-bridge`、workflow `release.yml`（填写 workflow 文件名，不填全路径）。environment 留空；如果 UI 提供选项，允许 direct publish。
4. 在 GitHub 仓库设置中手工创建变量 `NPM_PUBLISH_ENABLED=true`。不要自动设置它，也不要创建 `NPM_TOKEN`、`NODE_AUTH_TOKEN` 或其他发布 secret。

首次发布前无法为尚不存在的包配置 Trusted Publishing；发布授权前也不能真实验证 GitHub OIDC。Release workflow 使用 `id-token: write`，依赖 npm CLI 的 OIDC/provenance 行为，不添加 `--provenance`。

不要再次发布 `0.1.0` 或再次创建同版本 Release：npm 版本不可重用。若首次 publish 在 npm 尚未接受该版本前失败，可修复后手工重试；一旦 npm 已接受，重试会因版本已存在而失败，应等待下一版本。

## 后续 Release Please 版本

在 `0.x` 中，规范 commit 约定为：`feat` → minor、`fix` → patch、breaking change → minor。Release Please PR 合并后创建对应稳定 `vX.Y.Z` Release，`release.yml` 严格校验 tag 与 package 版本，再在 `NPM_PUBLISH_ENABLED=true` 时自动执行 npm publish。workflow 只处理稳定版本，不自动 bump、不自动打 tag。

需要升级版本时，不手工编辑 changelog；正常提交规范 commit，让 Release Please 生成 PR。若确实要手工准备下一个版本，用户可执行：

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "release: v0.1.1"
git push origin main
```

随后在 GitHub 新建指向正确提交的 `v0.1.1` Release。以上 Git 命令仅供用户手工操作，本项目不会替用户执行；不要在本地手工打 tag。

## CI 与失败重跑

GitHub Token 创建的 Release Please PR 通常不会触发 `pull_request` CI；Release Please 创建或更新可信的同仓库 PR 后，`release.yml` 会用 `GITHUB_TOKEN` 自动 dispatch `ci.yml` 到该 PR head。不要把原 `pull_request` 的 `action_required` 误称为通过，应查看 dispatch workflow 的同一 SHA。需要手工排障时可在 Actions → CI → Run workflow 选择发版分支，或运行：

```sh
gh workflow run ci.yml --ref <发版分支>
```

不要声称 bot PR 已通过 CI；发布 job 仍会执行完整 `npm ci`、unit、integration 和 pack 检查。若 publish job 已实际失败，应在同一次 workflow 中只重新运行失败的 publish job，而不是重新运行整轮 Release Please：整轮重跑可能得到 `release_created=false`，导致 publish job 被跳过。若 npm 已接受该版本，不能靠重跑绕过不可变版本规则。

Release Please workflow 使用 `push main` 和 `workflow_dispatch`，不使用 `release.published` 触发；publish 只在 Release Please 成功创建稳定 release 且 `NPM_PUBLISH_ENABLED=true` 时运行。
