# Desktop 通知透传

日期：2026-11-09。实现版本：Workspace Shell `0.5.23`。

## 范围

Desktop 窗口里的本地 Web 页签和远程 Web 页签，在回合结束或等待用户交互时，弹系统通知。点击通知切到对应页签并打开对应会话。

不在范围：

- 普通浏览器打开的 Web 不弹系统通知；
- TUI 页签没有可采集的前端状态；
- 页签关闭后不再产生事件；
- webview 通道依赖页内 `console.log`，guest 页面的控制台会多出带前缀的日志行；DSH 自身的日志采集不读这些行。

## 方案

页内采集，经 guest 通道报给 Desktop Shell，由 Shell 统一弹原生通知。

每个 DSH Web 页面都装着 Shell Client。它在页内订阅会话状态，事件发到父框架，父框架决定发不发、发什么、点了去哪。

另两条路不采用：

- **Host 侧采集**：要跨 Host 订阅状态并处理认证，改动面大；页签活着时页内采集已经够用。
- **各 Web 页自己弹 `Notification`**：跨域 iframe 拿不到通知权限，也定位不到页签，点击跳不回 Desktop。

## 数据流

1. 页内的 Shell Client 订阅 `ctx.uiSession.sessionStatus` 和 `ctx.sessions.list`。
2. 嵌入页把事件报给父框架，顶层页（Desktop 自己的 Host）直接交给通知中心。
3. Desktop Shell 判定是否抑制，不抑制就构造 `new Notification()`。
4. 点击后激活页签，通知该页签打开会话，并尝试聚焦窗口。

嵌入页有两种承载方式，回传通道不同：

| 承载 | 判断 | 上报 | 下发导航 |
| --- | --- | --- | --- |
| 浏览器模式的 iframe | `window.parent !== window` | `postMessage` 到父框架 | `postMessage` 到 iframe |
| Desktop 的 `<webview>` | URL 参数 `workspaceShellEmbedded=1` | `console.log` 带固定前缀 | 父框架 `executeJavaScript` 调页内全局函数 |

`<webview>` 的页面是独立顶层文档，`window.parent === window`，没有可用的 `postMessage` 父框架。所以 Desktop 侧监听 webview 元素的 `console-message` 事件，用固定前缀区分普通日志；导航由父框架用 `executeJavaScript` 调用 guest 暴露的 `__workspaceShellOpenSession(id)`。

## 事件判定

| 场景 | 判定 | 通知正文 |
| --- | --- | --- |
| 回合结束 | `running` 由 `true` 变为 `false`，且没有待处理交互 | 回合结束 |
| 等待批准 | `pendingInteraction.kind === 'approval'` 首次出现 | 等待你确认：工具名或原因 |
| 等待回答 | `pendingInteraction.kind === 'question'` 首次出现 | 等待你回答：问题摘要 |
| 计划待确认 | `pendingInteraction.kind === 'plan-review'` 首次出现 | 计划等待你确认 |
| 其他交互 | 未知 `pendingInteraction.kind` | 需要你处理 |

- 首个状态快照只记录，不发通知，避免新开页签补发历史。
- 同一个 `pendingInteraction.key` 只发一次；换成新 key 视为新请求。
- 同一会话用同一个 `tag`，后一条通知覆盖前一条，不堆叠。
- `running` 由 `false` 变 `true` 不发文。

## 抑制规则

同时满足以下三条时不发：

1. Desktop 窗口聚焦；
2. 事件所属页签处于激活状态；
3. 该会话正在这个页签的主视图里显示。

其余情况都发：窗口在后台、在别的页签、同一页签里看的是另一个会话。

窗口聚焦用 `focus` / `blur` 事件跟踪，不用 `document.hasFocus()`。Desktop 的 Web Guest 是 `<webview>`，焦点在里面时顶层文档的 `hasFocus()` 不可靠。

## 通知内容

- 标题：会话显示名（`displayTitle`），最多 200 字符。
- 正文：场景文案；有细节时写成「场景：细节」；末尾附页签显示名（自定义名优先，没有则用页签原标题）。
- 归一化：折叠连续空白、去掉控制字符、超长截断。

中英文文案内置在 Shell 中，按当前界面语言选择。

## 点击导航

1. 关闭被点击的通知。
2. `window.focus()`，尽力把窗口带到前台。
3. 页签为 `local`：直接调用 `ctx.uiWorkspace.openSession(sessionId)`。
4. 其他页签：先 `workspace.activate(tabId)`；激活成功后向该页签发 `workspace-shell-open-session`，页内收到后调用 `ctx.uiWorkspace.openSession(sessionId)`。
5. 页签已关闭、激活失败或页内没有响应时不报错，通知点击只完成已完成的步骤。

## 通道协议

guest 到父框架：

```json
{
  "type": "workspace-shell-notification",
  "version": 1,
  "event": "turn-end" | "attention",
  "kind": "approval" | "question" | "plan-review" | "attention",
  "sessionId": "<identifier>",
  "title": "<session title>",
  "detail": "<short detail>",
  "viewing": true
}
```

父框架到 iframe guest：

```json
{
  "type": "workspace-shell-open-session",
  "version": 1,
  "requestId": "<random uuid, no dashes>",
  "sessionId": "<identifier>"
}
```

webview 的导航调用：

```js
window.__workspaceShellOpenSession("<sessionId>")
```

`<sessionId>` 由父框架先用 JSON 编码，页内函数再校验标识符格式。

校验：

- iframe 父框架只接受来自该 guest `contentWindow`、且 `event.origin` 等于 guest origin 的消息；
- iframe guest 只接受来自 `window.parent`、且 origin 等于 URL 参数 `workspaceShellParentOrigin` 的消息；登录重定向会清掉 query，因此 fragment 里的同名参数同样有效；
- Desktop 父框架只解析 `console-message` 中带 `__workspace-shell-notification__` 前缀的文本，其余日志忽略；
- 两端都检查 `type`、`version`、会话 ID 格式、字段类型与长度上限；
- 未知字段丢弃，超长字段拒绝整条消息；
- 通知正文只作纯文本，不渲染 HTML。

## 错误处理

- 通知权限不是 `granted` 时跳过，并在控制台记一次。
- `new Notification` 抛错时只记一次，不影响页面。
- 状态读取或订阅失败时安静停用通知，不影响页签、会话和输入。
- 通知中心在 Shell 卸载时关闭已弹出的通知并移除监听。

## 测试

单测覆盖：

- 基线不发、`running` 转移、待处理交互去重与换代；
- 抑制三条规则的真值组合；
- 中英文文案、标题回退、截断；
- guest 通道两种承载（iframe 的 postMessage、webview 的 console 标记）与来源、origin、版本、字段上限校验；
- 点击后激活页签并发送打开会话请求；
- 已关闭页签、未知会话、无通知权限时不抛错。

实机验收：

- 本地页签跑一个长回合，切到别的页签，收通知并点击回跳；
- SSH 远程页签重复同样流程；
- 批准、提问、计划确认各一次；
- 窗口在后台时收到通知。

## 未实现

- 通知总开关和分场景开关；
- 一次结束多个会话时的汇总通知；
- Host 侧事件采集（页签关闭后仍可通知）。
