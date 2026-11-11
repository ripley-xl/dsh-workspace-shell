# 页签右键重启

日期：2026-11-11。目标版本：Shell `0.5.77` / Guest `0.6.2`。

## 1. 现状

Guest Web Host 的重启入口在页面里：侧栏底部一个 `⟳` 按钮，设置页一行「重启此 Host」，两处都打开同一个确认层（等空闲后重启 / 立即重启 / 取消）。

Guest 页面被工作区页签框住时，这个位置不对：用户看到的是页签，重启的对象也是页签背后的 Host，入口却埋在页面侧栏底部。

## 2. 决定

用户 2026-11-11 选定：

1. 只有 Web Host 页签出现重启项。本地页签是 Desktop 本身，launcher 和 TUI 页签背后没有可重启的 Web Host，都不显示。
2. 右键页签直接给两项：「等空闲后重启」「立即重启」。不再弹页内确认层。
3. Guest 页面删除全部重启入口：侧栏底部按钮和设置页那一行都删。独立浏览器里打开的 Guest 页面因此没有重启入口。

## 3. 架构

重启仍然由 Guest 执行。端口保留、回执、忙闲判断都在 Guest 的 `host-restart.js` 里，页签只是把入口搬到了外面。

```
页签右键菜单 (chrome-tabs)
  → frame.js          只给 Web Host 页签提供两项，选中后先激活页签
  → workspace.restartTab(tabId, mode)
  → tab-controller.invoke(tabId, 'restartHost', mode)
  → Guest adapter     desktop-guest.js / browser-guest.js
  → Guest 页面        host-restart-control.js
      GET  /api/workspace-host/status
      POST /api/workspace-host/restart {mode, force}
      显示「正在重启」覆盖层 → 轮询自身 origin → reload
```

## 4. 传输协议

两种嵌入方式沿用已有通道的校验方式。

| 嵌入方式 | 下行 | 上行 |
| --- | --- | --- |
| iframe（浏览器里的工作区 Shell） | `postMessage` 请求 | `postMessage` 响应 |
| `<webview>`（Desktop） | `executeJavaScript` 调用 Guest 页面的全局函数 | 函数返回值 |

- 请求类型 `workspace-shell-host-restart-request`，版本 `1`，字段 `requestId`、`mode`（`now` / `wait`）。
- 响应类型 `workspace-shell-host-restart-response`，版本 `1`，字段 `requestId`、`ok`、`code`。
- iframe：Guest 只接受 `event.source === window.parent`、与 `workspaceShellParentOrigin` 一致的 origin、合法 `requestId`；同一 `requestId` 只处理一次。
- webview：Guest 在 `window.__workspaceShellRestartHost(mode)` 上暴露入口，参数只接受两种模式字符串，不来自 frame 或 URL。
- 页签未 ready、Guest 没装、Guest 版本旧（没有该全局函数）时，适配器返回 `{ok:false, code:'HOST_RESTART_UNAVAILABLE'}`，Shell 在页头错误位显示文案。

## 5. Guest 侧执行顺序

1. `GET /api/workspace-host/status`。
2. `supervised` → 返回 `HOST_RESTART_SUPERVISED`；`allowRestart === false` → 返回 `HOST_RESTART_DISABLED`。
3. `POST /api/workspace-host/restart`：`mode: 'now'` 时带 `force: true`，`mode: 'wait'` 时交给 Host 每 5 秒复检活跃任务。
4. 成功：显示覆盖层「正在重启，等待 Host 回来…」，每 2 秒探测自身 origin，回来后等 1.2 秒 reload。
5. 失败：返回 Host 的错误码，覆盖层不显示。

错误码沿用 Host 路由：`HOST_RESTART_BUSY`、`HOST_RESTART_COOLDOWN`、`HOST_RESTART_UNAVAILABLE`；新增 `HOST_RESTART_INVALID_MODE`、`HOST_RESTART_IN_PROGRESS`。

## 6. 边界

- 页签 `phase !== 'ready'` 时两项置灰；页签没有 Guest（如未装 Guest 的 profile）时点了报 `HOST_RESTART_UNAVAILABLE`。
- 重启后端口变化时，页签不会自己换地址，与既有行为一致；新地址见终端输出或工作区页签。
- 页签菜单只承载重启，不合并关闭、编辑等已有入口。

## 7. 实现落点

| 文件 | 职责 |
| --- | --- |
| `packages/guest/src/host-restart-control.js` | 命令通道、状态校验、覆盖层、重启后轮询与 reload |
| `packages/guest/src/entry.js` | 用新模块替换旧的 `createGuestRestart` |
| `packages/shell/src/chrome-tabs.js` | 页签右键菜单（定位、键盘、焦点、关闭时机）与样式 |
| `packages/shell/src/frame.js` | 只给 Web Host 页签提供两项；激活页签后调用重启；错误文案 |
| `packages/shell/src/workspace-client.js` | `restartTab(tabId, mode)`：校验页签种类，调用控制器 |
| `packages/shell/src/tab-controller.js` | `invoke(id, method, ...args)`：只对当前 run 的 handle 发起调用 |
| `packages/shell/src/desktop-guest.js` | webview 侧 `restartHost`：`executeJavaScript` 调全局函数 |
| `packages/shell/src/browser-guest.js` | iframe 侧 `restartHost`：请求 / 响应通道 |

## 8. 测试

- `shell-chrome-tabs`：右键打开菜单、只对有菜单项的页签拦截原生菜单、键盘上下与 Enter、Escape 关闭并还原焦点、点击外部关闭、禁用项不可选、菜单定位不越界。
- `shell-tab-controller`：`invoke` 对未 ready / 无此方法 / 已关闭页签报安全错误码，正常调用返回 handle 结果。
- `shell-desktop-guest` / `shell-browser-guest`：`restartHost` 的 ready、模式校验、超时、错误码与结果校验。
- `shell-workspace-client`：`restartTab` 只接受 `profile-ui` 页签且排除 `local`，错误码透传。
- Guest 命令控制：iframe 请求校验与响应、webview 全局函数、失败不显示覆盖层、成功后才轮询。
