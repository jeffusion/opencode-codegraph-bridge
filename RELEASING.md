# 发布说明

当前仓库名为 `jeffusion/opencode-codegraph-bridge`，npm 包名为 `opencode-codegraph-bridge`。以下操作由项目所有者手工完成；本项目不保存 npm token，也不在本地自动执行发布。

## 首次发布 `0.1.0`

1. 在 npm 网站确认账号、登录 email 和 2FA 已准备好，在本地手工执行 `npm login`，按 npm 提示完成认证。
2. 在项目目录执行：

   ```sh
   npm ci
   npm run test:unit
   npm run test:integration
   npm pack --dry-run
   npm publish --access public
   ```

3. 首次发布包后，在 npm 网页该包的 **Settings → Trusted publishing** 添加 GitHub Actions trusted publisher：owner `jeffusion`、repository `opencode-codegraph-bridge`、workflow `release.yml`（填写 workflow 文件名，不填全路径）。environment 留空；如果页面提供选项，允许 direct publish。

首次发布前无法在 npm 网页为尚不存在的包完成 Trusted Publishing 配置；发布授权前也不能真实验证 GitHub OIDC。Trusted Publishing 不需要 GitHub `NPM_TOKEN`，release workflow 仅使用 `id-token: write`，不读取或设置 `NODE_AUTH_TOKEN`。

不要再次发布 `0.1.0`：npm 版本不可重用。若首次 publish 在包尚未成功创建前失败，可修复后重跑同一 release；一旦 npm 已接受该版本，后续重跑会因版本已存在而失败，应改用新版本。workflow 只处理稳定的 `vX.Y.Z` Release，不自动 bump。

## 后续版本

以下命令和 GitHub 操作由用户手工完成，不要现在执行：

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "release: v0.1.1"
git push origin main
```

然后在 GitHub 新建指向正确提交的 `v0.1.1` Release；`release.yml` 会在 Release published 后校验 tag 与 package 版本并发布。不要在本地手工打 tag，也不要重复创建 `v0.1.0` Release。
