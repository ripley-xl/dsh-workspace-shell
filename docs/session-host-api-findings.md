# 跨 Host 会话接口核查

核查版本：DSH `0.2.1-rc.5`。日期：2026-11-04。插件实现：Shell `0.5.2` / SSH `0.3.1`，已安装到 Desktop 和真实 Web profile，双向 Native Guest 草稿跳转及原 Host 退出后的接续通过实机验证。

## 采用的接口

| 能力 | 接口 | 用法与限制 |
| --- | --- | --- |
| 原生历史与发送 | 原有会话 UI | 插件不替换历史、不拦截会话行、不禁用发送。 |
| 捕获发送失败 | 保留中的 `Session.prompt()` | 观察原始结果，仅处理 `session/writer-held`；提交前保存该请求的文本。 |
| 当前 Host 的 Agent | `agents.get(id)` | 确认此 Host 报告的实际 Agent，不等同于全局写锁查询。 |
| 目标会话选择 | `uiWorkspace.openSession(id)`、`sessions.retain()` | 等待目标绑定就绪并重新核验实例和选中会话。 |
| 文本草稿追加 | `conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' })` | 返回 `applied` 才确认接收；已有输入追加新段落，保留目标附件。 |
| 输入区提示 | `conversation.input.dock` | 使用标准 session、`useSession` 和 locale 服务，仅显示失败与接收提示。 |
| 现有 Host 接入 | `connection.authenticatedUrl()` | 由目标主动提供本机回环 HTTP 地址，不扫描其他进程凭据。 |
| 冷会话继续 | `sessionController.resolveAgent()` | 正常发送路径调用；写锁校验仍由 DSH 执行。 |

公开 Session 没有提交事件订阅。本插件在保留的绑定上包装 `prompt()`，保持参数、返回值和异常语义，卸载时恢复自身包装，不覆盖其他后装包装。重新生成的绑定由 `sessions.list` 保留状态更新重新观察。升级 DSH 时必须复核这一入口。

## 锁与登记

JSONL 后端通过 `flock(2)` 排除其他进程写入，进程退出后内核释放锁。`session.lock` 文件是否存在不表示锁是否仍被持有，不能删除它来接管会话。

`session/writer-held` 只携带会话 ID，不包含 Host 身份。插件在真实发送失败后，查询同一用户私有目录中的 Unix socket。登记范围同时核对 home 与 JSONL 根目录身份，实例 ID 每次激活重新生成；只有目标实时报告 `agents.get(id)` 才确认归属。

未参与登记、不可达、重复报告或没有 Agent 报告时保持未知。未知不阻止用户按原生流程再次发送，也不宣称写锁空闲。

## 协议

- Host 路由：`/api/workspace-session-hosts/{status,attach,views,command,view/update,view/ack,view/remove}`。不再提供 `history` 路由。
- HTTP 请求沿用宿主认证，限制为 64 KiB；草稿序列化大小限制为 48 KiB。
- 视图用 Client 激活时生成的 ID 登记。`select` 定位目标会话，`goto` 由父框架执行导航；草稿只附在待处理命令中。
- 回执核对请求、目标视图、会话以及草稿传递 ID。取消、失效和超时不产生成功结果。
- 视图发现和公共快照不含认证 URL 或草稿正文。认证 URL 仅用于 Guest 接入，草稿仅留在内存请求与输入框中。
- Guest 的窗口、父 Host、页签标识同时放入 query 和 fragment，以兼容登录重定向；这些标识不是凭据。

## 核心与 SSH 开关

Shell 默认导出继承 Cordis `Group` 的核心入口。注册服务与本地运行时由该入口直接启动，唯一子组件为默认开启的 SSH。Host 和 Client 入口均不再依赖单独的 `workspace-session-host` 组件。

实际 DSH 插件管理器跳过 `group: true` 的组件行，但仍允许按 `ssh-remote` 定位子组件。真实 Loader 测试已确认 SSH 关闭、重开、持久化关闭后重新激活 bundle，核心服务均按预期保留或重新创建。

嵌入 Guest 不提供 Client `workspaceShell` 服务。SSH 必须在 factory 声明 `inject` 前同时检查 query 与 fragment，嵌入时返回空依赖；仅在 `apply()` 中提前返回不足以避免 Web 启动器判定插件一直 pending。0.5.2 已修复，最终包浏览器回归包含 SSH 组件。

## 边界

- 去重记录按目标 Client 生命周期保存，最多 1024 条；重载后可能再次追加同一草稿。
- 只转文本，不转来源附件。附件、引用 chip 的跨 Native Guest 行为没有完整实机验收。
- 来源取消与目标接收可能交错，目标已经追加的文字不会回滚；来源不宣称跳转成功，文字也不清空。
- 支持本机共享存储，不提供跨机器会话合并。每个参与 Host 都必须加载新版 Shell。
- 用户授权后已修改真实 Web profile 的 Shell 安装依赖，原有配置和依赖保留；未修改 DSH 源码或 Electron 应用包。
- 原生会话目录没有立即显示其他 Host 新建的会话；重启后可见，本轮没有改动目录刷新机制。
- 关闭 Native Guest 后重建 Client 时旧草稿没有恢复；当前 Client 的追加保证不等于跨页签关闭持久化。

## 核查来源

以下路径相对于 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`：

- `dsh-api-session-controller/lib/types/client/sessions/{service,session}.js`
- `dsh-api-session-controller/lib/types/agent.js`
- `dsh-session-persistence-jsonl/lib/index.js`
- `dsh-client-ui-conversation/lib/types/client/contract/{input,slots}.d.ts`
- `dsh-plugin-manager/lib/index.js`
- `dsh-host-plugin-inventory/lib/index.js`

本地实现位于 `packages/shell/session-host/` 与 `packages/shell/src/host/session-{hosts,views}.js`。
