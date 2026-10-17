# @local/dsh-subagent-gate —— 原生子代理总开关

设置 → **通用设置** 里的一行开关（`settings.general.item`，order 95，在"上传 Session Log"下面）。

## 行为

| 开关 | 效果 |
|---|---|
| **关** | ① 不注入任何子代理提示词；② 往 profile 补丁写一条自维护的禁用块（见下），把 `ui-settings-subagent`、`ui-subagent` 两行停掉 → **插件页里的「子智能体」卡片消失**，会话里的子代理卡片 UI 也不再加载 |
| **开** | ① 上面那条禁用块被自动撤掉，卡片回来；② 只有**该会话确实有子代理记录**时才注入提示词；③ 无记录的会话一个字的提示词都不给 |

注入的提示词（开关打开 + 会话有记录时）：

```
[原生子代理] 本会话有 N 条子代理记录（本机原生子代理已关闭）：
- 写作子代理 [done]
- 校对子代理 [running]
说明：subagent / subagent_fork / list_agents 等原生工具在本机不存在，不要调用它们，也不要假装派过子代理。
需要派子代理时用免费桥接：freesub_run(task="…")（Qoder CN 的免费模型）。
用户问起这些历史记录时，照实说明原生子代理已被总开关关闭。
```

> 措辞就是上面这段；不满意的直接改 `index.js` 里 `systemPrompt.context(...)` 的 `text()` 返回值。

## 它写进 profile 补丁的东西（自维护块）

```yaml
# === subagent-gate: begin（由「原生子代理总开关」自动维护，勿手改）===
- id: ui-settings-subagent
  disabled: true
- id: ui-subagent
  disabled: true
# === subagent-gate: end ===
```

关 → 写入；开 → 撤掉。补丁文件是活的，写完立即重载，**不需要重启**。

## 验收记录（2026-10-16）

| 场景 | 实测 |
|---|---|
| 关：插件行被停掉 | 网页启动载荷里 `dsh-client-ui-settings-subagent` / `dsh-client-ui-subagent` 出现次数 **0** |
| 开：复原 | 两者回到 **5**，禁用块被自动删除，补丁回到基线 67 行 |
| 开 + 会话有子代理记录 | 注入上方那段提示词 |
| 开 + 会话无记录 | 注入内容 = `""` |
| 关 | 注入内容 = `""` |

## 边界（重要）

本开关只管**提示词**与**插件页可见性**，**不会**把原生"派子代理"的能力重新打开：
真正派子代理还需要 `subagent` 行的 `maxDepth > 0`，以及 `tool-subagent` 等工具行启用。
如果哪天想要"打开=真的能派"，那是第二条档位，需要显式再加（目前故意不做，因为原生子代理很贵）。

## 机制订正 + 踩坑（2026-10-16 二次修订）

设置页那行能不能出现，取决于**宿主 Config 的字段有没有标 `.volatile()`** ——
`dsh-settings` 的原文是："表单只展示活动且可唯一定位的 profile 条目中的 **volatile 字段**"。
没标 = 不会被服务 = 浏览器侧 `configForms.whileServed([namespace])` 永远不成立 = 那行永远不出现。
本插件三个字段现在都是 `.default(...).description(...).volatile()`。

> **踩坑留痕**：第一版照着另一个插件抄了
> `settings.installSection(ctx, name, Config, config, {...})`，**这个方法在 DSH 里根本不存在**
> （整个 runtime 零匹配），所以表单一直没被服务。已改成真接口
> （`settings.configure({ auto: false }, ctx.fiber)`，且做了 typeof 守卫）。

**源码改动不热重载**（宿主按路径缓存已加载模块）：本文件的改动需要**重启该实例**才生效。
而 `.volatile()` 字段的**值**改动是热的，改完立刻生效。

## v0.1.2（方案 A：把真相告诉模型）2026-10-16

关掉总开关时注入（每个会话、每次组装提示词）：

    [原生子代理] 本机原生子代理已关闭（总开关处于"关"）。
    不要调用 subagent / subagent_fork / list_agents / send_message / interrupt_agent —— 它们必然失败（maxDepth 0）。
    需要派子代理时用免费桥接：freesub_run(task="…")。

开启时：会话有子代理记录 → 注入历史记录说明；无记录 → 一个字都不注入。

### 为什么不是"把工具删掉"（查证结论，别再试了）

`dsh-tools` 的实现写死了两条约束：

    if (scope === undefined) throw new Error("tools.restrict() requires a scoped context (agent.ctx) …")
    if (unknown.length > 0) throw new Error("tools.restrict() names unknown global tool(s) …")

即：**必须在 agent 作用域调用**，且**只能点名全局工具**。而 `subagent` / `subagent_fork`
是由 **agent preset 平面**（`preset-standard` 的 `plugins` 列表）注册的 scope-local 工具，
既不在全局工具表里、也不在任何外部插件够得着的作用域里 —— **外部插件无法摘掉它们**。
（`agent/request` 也没戏：`LlmCallConfig` 里没有 tools 字段，文档明确"不能改模型可见内容"。）

所以本插件的边界是：**管得住"我注入的提示词"和"插件页可见性"，管不住 preset 给的工具**。
唯一的真删法是覆写 preset 的 plugins 列表，代价是会与「子智能体」设置页抢同一份配置 —— 已明确不做。

### 诊断

`subagent-gate\gate.log`：每次 apply / 开关变化 / 写补丁结果都留痕（这个组合里 `ctx.logger` 不存在，所以写文件）。

### 源码改动仍需重启

`hmr` 的 `root` 已指向本目录，但实测**没有触发热重载**（gate.log 无新 apply 行）。
所以改 `index.js` 后请用桌面「重启 DSH 3080」快捷方式重启一次；**开关值的改动是热的**，不需要重启。
