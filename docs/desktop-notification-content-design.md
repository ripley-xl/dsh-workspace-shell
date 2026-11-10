# Desktop 通知内容设计

日期：2026-11-10。状态：已实现并实机验收（macOS：计划待确认、批准、回合结束各一条，均只弹一条）。

v1 只做「场景 + 理由」，回合结束没有内容。本版按 dsh-pet 的通知水位重写：正文放内容本身，失败与截断在标题上标出来；同时把 dsh-pet 自己的通知关掉，避免同一事件弹两条。

## 范围

Shell 统一发通知，覆盖 Desktop 本地页签与每个 Web Guest（本机 Web、SSH 远端）。guest 各自在自己的 Host 上采集并上报，不因为 dsh-pet 只装在本机而丢通知。

不做：

- 自定义通知图标。macOS 的 Web Notification 显示应用图标，`icon` 选项不生效，dsh-pet 设了也看不到；
- 通知按钮与直接答复；
- `agent/error`（不走 turn/end 的 Agent 级错误）——目前只有 dsh-pet 监听这个事件，Shell 不监听。

## 内容规格

| 事件 | 标题 | 正文 |
| --- | --- | --- |
| 回合结束（完成，有回复） | 会话名 | 本轮最后一段助手回复，最多 120 字 |
| 回合结束（完成，无回复） | 不发通知 | 计划模式等以工具调用收尾的回合没有回复正文，只发一条空通知没有意义 |
| 回合结束（失败） | 会话名 · 生成失败 | 错误信息 |
| 回合结束（输出截断） | 会话名 · 输出被截断 | 已达到输出 token 上限 |
| 回合结束（其他原因） | 会话名 | 最后一段回复；没有回复时不发通知 |
| 等待批准 | 会话名 · 正在申请权限 | 工具「bash」：理由 |
| 等待回答 | 会话名 · 模型在等你回答 | 第一问文本 + 计数后缀 |
| 计划待确认 | 会话名 · 计划待确认 | 计划首个非空行 |
| 其他交互 | 会话名 · 需要你处理 | `pendingInteraction.kind` |

标题里的「会话名」是 `displayTitle`；为空时退到「会话」。

细节规则：

- 批准理由取 `displayReason`（用 `ctx.locale.resolveText()` 解析语言表）→ `reason` → 工具名。有理由时写成「工具「bash」：理由」，没有工具名时只写理由。
- 提问后缀：多问或有多选项时追加「（第 1/3 问 · 3 个选项）」，英文用 `(1/3 · 3 options)`；后缀在截断之后追加，不会被截掉。
- 计划取 `questions[0].detail` 的首个非空行，去掉行首 `#`；没有 `detail` 时退到 `header`、`question`。
- 所有细节最多 120 字，超出末尾加「…」；折叠连续空白与控制字符。

示例（中文）：

```
标题：通知内容优化 · 生成失败
正文：rate limited

标题：通知内容优化
正文：已把通知正文改成单行，并补了 4 个单测，全量 1187 条通过。

标题：通知内容优化 · 正在申请权限
正文：工具「bash」：允许本次操作使用 danger-full-access 权限：写 /tmp 下的验收文件
```

## 数据来源

页面的状态库只知道「回合从 running 变成 idle」，没有回复正文，也没有失败原因。为此在共享的 session-host 宿主模块里加一个回合结束跟踪器：

- 订阅 `ctx.on('session/event')`：`assistant/message` 记最后一段文本，`turn/end` 记结束原因（`completed` / `error` / `max-tokens` / `aborted` / `interrupted` / `blocked` / `other`）与错误信息，保留 10 分钟、最多 256 条。
- 新路由 `POST /api/workspace-session-hosts/turn-end`，入参 `{ sessionId }`，返回 `{ reason, text, error }` 或 `null`。
- 页面在检测到回合结束时拉一次这条路由，1.2 秒内没有结果就按无内容发送，通知不会因为 Host 慢而丢掉。

这个跟踪器在 Desktop profile 和每个 Web Guest 的 Host 里都跑，所以本地页签与 Web/SSH 页签拿到的是同一套内容。

## 通道协议

沿用 version 1，新增两个可选字段：

```json
{ "reason": "completed | error | max-tokens | aborted | interrupted | blocked | other", "error": "<short message>" }
```

- 缺省 `reason` 视为 `completed`，缺省 `error` 为空串。
- 旧 Shell 只读已知字段，忽略这两个字段；旧 Guest 不发，新 Shell 按 `completed` 处理。
- 未知 `reason` 拒绝整条消息。

## 去重

这台机器上还有两个会发会话通知的插件，都要让路：

- `dsh-pet`：`~/.dsh/dsh-pet/main-config.jsonc` 里 `notificationsEnabled` 改为 `false`。其余功能（桌宠、碎碎念、工作状态）不受影响。
- `dsh-composer-plus`：它自带「后台通知」，覆盖回合结束、审批、提问、计划审阅，在 **设置 → Composer Plus** 里关掉。它在拿不到回复正文时会退化成「已完成。」，这正是之前那个空内容框的来源。

Shell 是唯一的通知来源；它覆盖 dsh-pet 原本覆盖的回合结束、批准、提问，另外补上计划待确认。代价是 `agent/error` 这类 Agent 级错误暂时没有通知。

## 兼容与降级

- 旧远端运行包内置的 guest 没有这条路由：回合结束通知 1.2 秒后降级为只有「回合结束」，不丢通知；重建运行包后才有回复正文。为此通道带 `textKnown` 字段：Host 明确回答「没有回复正文」才不发那条，Host 无法回答时仍然发降级文案。
- 旧 Guest 发来的旧式详情原样显示；旧 Shell 收到新字段忽略。
- 路由返回 `null`、网络失败、会话已被清理：按无内容处理。

## 测试

单测：

- 回合结束跟踪器：文本取最后一段、折叠与截断、错误原因、未知原因、过期清理、销毁；
- monitor：Host 有内容、Host 失败、失败回合保留 reason/error、通知受 Host 回答门控；
- 通道：`reason` 白名单、`error` 长度、旧字段兼容；
- 通知中心：标题后缀、正文取内容、失败与截断文案、英文文案。

实机（macOS）：

- 计划待确认一条，标题带「· 计划待确认」，正文是计划首行；
- 批准一条，标题带「· 正在申请权限」，正文是「工具「bash」：…」；
- 回合结束一条，正文是本轮最后一段回复；
- 同时确认 dsh-pet 不再弹第二条。

## 未实现

- 通知按钮与直接答复；
- `agent/error` 事件的通知；
- 自定义图标。
