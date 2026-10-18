# 贡献指南

感谢关注 `dsh-android-phone`。欢迎 Bug 报告、功能建议和代码提交。

提 PR 之前，请花两分钟读完「硬约定」一节 —— 这个项目有几个坑是踩过才知道的，写在 [AGENTS.md](AGENTS.md) 里。

## 报告 Bug / 提建议

请走 Issue 模板：

- **Bug 反馈** —— 画面、控制、截图、安装出问题时用。模板会要求你贴 `npm run doctor` 输出和手机信息，这些字段能省掉至少一轮来回。
- **功能建议** —— 说清使用场景；有参考实现给个链接。

提问前先看 README 的「常见问题」，大部分「未发现设备 / 画面不动 / 点了没反应」都在那里有答案。

## 开发环境

通用要求：

- Windows 10/11
- **Node ≥ 22.15**（跑离线测试需要；插件运行时只需 ≥ 20）
- Git for Windows（提供 Git Bash，供 `.githooks` 使用）
- 一台开了 USB 调试的安卓手机（只有真机测试需要）

首次准备：

```powershell
npm install                 # 离线测试依赖（react / react-dom / jsdom）
npm run hooks               # 启用 .githooks（仅本机生效，不随仓库传播）
npm run install:profile     # 装进 DSH profile
```

装完重启 DSH，侧栏出现「📱 手机」tab（需要 better-sidebar）或「插件」页里能改设置（不需要 better-sidebar）。

`npm run doctor` 会用 10 项检查告诉你环境是否齐备。

## 改哪里、怎么生效

| 改动 | 生效方式 |
|---|---|
| `client.js` | **Ctrl+Shift+R** 硬刷新侧栏 |
| `index.js` / `src/**` / `cordis.patch.yml` | **重启 DSH** |
| `skills/**` / `actions/**` | `npm run install:profile` 后重启 DSH |
| `README` / `test/**` / `AGENTS.md` | 不用管 |

profile 里装的是**指向本仓库的 junction**，所以改完仓库文件就生效，不用重装。只有这几种情况需要重跑 `npm run install:profile`：换机器、挪了仓库目录、改了 `package.json` 的 `name`、profile 的 `node_modules` 被删了。

> 注意：`git checkout` 切分支或回滚会**立刻**改变 DSH 正在加载的代码，切完记得重启 DSH 再验收。

## 测试

```powershell
npm run ci            # 提 PR 前必跑：静态校验 + 离线回归
npm test              # 只跑离线回归（拼接 35 项 + 侧栏 UI 86 项）
npm run test:device   # 真机回归（会占用手机）
```

- 报告写到 `test/reports/`（已 gitignore）。
- **离线回归**不需要手机：拼接算法用真实截图做逐像素比对，侧栏 UI 用 jsdom 真挂载 React 渲染。
- **真机回归**会操作手机：跑之前把手机放一边，别让它锁屏；四个套件依次是工具与协议编码、单会话长跑、HTTP 接口、京东全链路。
- 真机测试的**行为守则**：会抢手机焦点（打开设置/京东等 App）；不要在登着别人账号的手机上跑到购买/支付路径；截图与日志别带隐私信息；跑完确认没有残留 `adb reverse localabstract:scrcpy_*`（`npm run doctor` 不检查这个，用 `adb reverse --list` 看）。

## 代码约定（摘要，完整版见 AGENTS.md）

- **不引入运行时依赖**。插件运行时零 npm 依赖；`devDependencies` 只给测试用。
- **`client.js` 是单文件**。DSH 的 `__ModuleLoader__` 只加载一个 factory，不能用 JSX / TypeScript / `import`，只能用 `React.createElement`（代码里的 `h`）。
- **`scripts/install.ps1` 必须 UTF-8 BOM + LF**。Windows PowerShell 5.1 读无 BOM 的 `.ps1` 会按 ANSI 解码，中文变乱码并报一堆假的 `Missing closing '}'`。`npm run ci` 会检查这一点。
- **协议以源码为准**。控制消息 / 帧头的字节布局以 scrcpy v5.0.1 的 `ref/` 源码为依据，不要凭记忆改；改了要在 PR 里说明依据。
- **不要提交构建/调试产物**：`test/reports/`、`recon/`、`out/`、`*.bak-*`、`PROBE-*` 都已在 `.gitignore`。
- **`vendor/` 里的二进制不做修改**，升级请整包替换并在 PR 里注明来源与版本。

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<类型>(<范围>): <描述>
```

| 类型 | 说明 |
|---|---|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `perf` | 性能/延迟优化 |
| `refactor` | 重构（不改变行为） |
| `style` | UI / 格式调整 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建、依赖、杂项 |

范围示例：`client`、`host`、`video`、`control`、`adb`、`longshot`、`install`、`docs`。

一个提交只做一件事。逻辑改动与格式化、逻辑改动与文档改动分开提交。

## Pull Request 流程

1. Fork 并从 `master` 拉分支（分支名建议 `feat/xxx`、`fix/xxx`）
2. 改动后跑 `npm run ci`，确认静态校验与离线回归通过
3. 涉及 UI 的改动**附截图**（用离屏渲染或直接截侧栏）；涉及真机的改动附 `npm run doctor` 输出
4. 按 PR 模板填写变更说明、测试情况、检查清单
5. 等审查。可能需要按意见修改 —— 请用新提交追加，不要 force-push 覆盖已有审查记录

## 许可证

本项目以 [Apache License 2.0](LICENSE) 授权。提交 PR 即视为你同意以同一许可证授权你的贡献，**无需签署 CLA**。

第三方组件的许可证与来源见 [NOTICE](NOTICE)。新增第三方代码或二进制前请先确认许可证兼容，并在 `NOTICE` 里补充。
