## 变更说明

<!-- 这个 PR 做了什么、为什么这么做 -->

## 变更类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 重构 / 性能优化
- [ ] UI 调整
- [ ] 文档
- [ ] 构建 / CI / 杂项

## 相关 Issue

<!-- 如有关联：Fixes #123 -->

## 测试情况

- [ ] `npm run ci` 通过（静态校验 + 离线回归）
- [ ] 涉及真机行为的改动，跑过 `npm run test:device`（会占用手机）
- [ ] UI 改动附截图（改前 / 改后）

## 检查清单

- [ ] 改 `client.js` 时：仍是单文件、无 JSX/TypeScript/`import`
- [ ] 改 `scripts/install.ps1` 时：仍是 UTF-8 BOM + LF（`npm run check` 已校验）
- [ ] 协议相关改动注明了依据（`ref/` 里对应的 scrcpy v5.0.1 源码文件与行号）
- [ ] 改了对外接口（工具名/参数/HTTP 路由）→ 已同步 `docs/tools.md`；改了使用方式 → 已同步 `docs/usage.md`
- [ ] 已读 [CONTRIBUTING.md](../CONTRIBUTING.md)，硬约定见 [AGENTS.md](../AGENTS.md)
