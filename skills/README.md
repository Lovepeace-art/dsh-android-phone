# skills/

插件自带的 skill 放在这里，每个 skill 一个子目录，子目录里必须有 `SKILL.md`：

```
skills/
└─ <skill-name>/
   ├─ SKILL.md          # 必须有：frontmatter 的 name / description / whenToUse + 正文
   └─ scripts/          # 可选：配套脚本
```

安装时 `install.ps1` 会把 **`<插件目录>\skills` 同步一份**到 profile 的
`<profile>\vendor\dsh-android-phone\skills`，再登记进
`skill-filesystem` → `customSkillDirs`，所以放进来就会被 DSH 发现。

- 注册的是 **profile 里的副本**：仓库搬家/删除都不影响技能
- 改完要**重跑一次 `npm run install:profile`**（重新同步），再重启 DSH
- 跟别的 skill 根重名会自动改名成 `<name>-2` 并同步改 `SKILL.md` 的 `name:`

## 这个目录可以是空的

`skills/` 只是约定位置，插件能力（12 个 `phone_*` 工具 + 18 个 HTTP 接口）
**完全不依赖任何 skill**。没有 skill 时安装脚本会打印
「插件包没自带 skill —— 只装插件，不注册 skill 根」并照常完成安装。

自带的 skill 属于示例 / 业务定制，可以整个删掉，只留这个 `README.md` 占位。