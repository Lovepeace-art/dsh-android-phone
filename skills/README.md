# skills/

**这个目录默认是空的**，故意留空。

## 为什么空

插件包只负责**能力**（见 `src/`、`index.js`），业务流程与路径属于 skill。
按 DSH 的官方设计，skill 应该由用户或官方技能目录管理，而不是塞进插件包里 ——
否则会出现「插件一升级就把用户的技能覆盖掉」「profile 里写死插件绝对路径」这类问题。

## 什么情况下才该放东西进来

只有一种：**插件运行必需的技能**（缺了它插件就不可用，且没有任何外部替代）。
目前没有。真需要时用官方机制注册，不要改 profile 的 `customSkillDirs`：

```js
// 参考 @deepseek-ai/dsh-skill-office/lib/index.js
const inject = ['skills'];
function apply(ctx) {
  ctx.inject(['skills'], (s) => s.skills.registerProvider(() => provider));
}
```

provider 形状与硬约束（来自 `@deepseek-ai/dsh-skill` 的校验代码）：

- `{ name, list(): Promise<Candidate[]>, get(candidate, { signal }): Promise<{ ...summary, content }> }`
- Candidate 必填：`name` / `description` / `source`(string) / `rank`(有限数字，否则抛错)
- 可选：`invocation`（给了就要两个 boolean 都有）/ `whenToUse` / `resourceBase` / `locator`
- 排序：`rank → providerOrder → localOrder`；`RUNTIME_RANK = 250`、`BUNDLED_SKILL_RANK = 600`
- provider 模式下没有「当前技能目录」可让模型自己找，**脚本路径必须由正文给出绝对路径**

## 想给这个插件写业务流程 skill

放到 DSH 自己的技能目录里，用 12 个 `phone_*` 工具当积木，别往这个仓库塞。
例子见 git 历史里的 `jd-shop-longshot`（1.2.0 之前随包发布，之后移出）。