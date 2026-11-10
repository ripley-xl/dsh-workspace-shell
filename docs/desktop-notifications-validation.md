# Desktop 通知透传验证记录

日期：2026-11-09。版本：Workspace Shell `0.5.23`。环境：macOS，Desktop 0.2.2-rc.1，本机 `desktop` + `web` profile 均装 0.5.23。

## 已通过

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| 本地回合结束 | 本地页签跑 90 秒回合，期间切到其它页签 | 收到「回合结束 · 本地」，点击切回本地页签并停在该会话 |
| 本地等待回答 | 切走后由 `ask_user_question` 发起提问 | 收到「等待你回答 · 本地」，点击切回本地页签并显示问题卡片 |
| 本机 Web Guest 回合结束 | `web` profile 页签跑约 60 秒回合，发送后切走 | 收到「回合结束 · <页签名>」，点击切到该 Web 页签并打开会话 |
| 远程 SSH Guest 回合结束 | anydev 远程页签跑约 60 秒回合，发送后切走 | 收到「回合结束 · anydev」，点击切回该页签并打开会话 |

0.5.22 首次实机测试发现点击通知只打开会话、不切换页签；本地分支没有先激活页签。0.5.23 改为先激活目标页签再打开会话，上面三条均为 0.5.23 的结果。

## 未覆盖

- 真正的批准请求尚未实机验证（当前调试会话禁用了批准）；

- 窗口最小化时的通知与点击回前台；
- 系统通知权限被拒绝时的降级。

## 远程通道的一个坑

远端 Host 的登录重定向只保留 URL 的 fragment、清掉查询参数，而 Shell 原来只在非 SSH 视图里把 `workspaceShellEmbedded=1` 写进 fragment。SSH 视图因此丢掉了嵌入标记，伴生插件判断自己不在嵌入页，直接不安装，远程页签就永远不上报。

修复：所有 Guest 的 URL fragment 都带 `workspaceShellEmbedded=1`（SSH 视图只带这一个标记，非 SSH 视图仍带会话窗口/父实例/页签 token）。验证时远程页面重新打开后，通知恢复。

## 相关事实

- Desktop 的 Web Guest 是 `<webview>`，页面内 `window.parent === window`，不能靠 `postMessage` 回传；guest 用 `console.log` 带前缀上报，父框架监听 `console-message`。
- 点击后的导航由父框架 `executeJavaScript` 调用 guest 暴露的 `__workspaceShellOpenSession(id)`。
- 本机验证使用 Electron 44.7.0 的 Desktop；独立 Electron 24 探针确认了 console 事件与 `executeJavaScript` 的行为。

## 2026-11-10 通知内容 v2 实机验收

环境：macOS，Desktop 应用，desktop profile 装本仓库构建的 Workspace Shell（本地文件安装）。dsh-pet 的通知关闭，dsh-composer-plus 的「后台通知」关闭。

| 场景 | 结果 |
| --- | --- |
| 计划待确认 | 标题「<会话名> · 计划待确认」，正文为计划首个非空行 |
| 等待批准 | 标题「<会话名> · 正在申请权限」，正文「工具「bash」：理由」 |
| 回合结束 | 标题为会话名，正文为本轮最后一段回复 |
| 重复通知 | 同一事件只弹一条；dsh-pet 与 dsh-composer-plus 都不再弹 |

顺带确认了来源区分：Shell 的通知 tag 是 `workspace-shell:<sessionId>`，Composer Plus 是 `dsh:<sessionId>`。旧版实机里那个「已完成。」空框来自 Composer Plus 在拿不到回复正文时的兜底文案，不是 Shell。

未覆盖：旧远端运行包（未重建）下的降级文案，实机未验证。
