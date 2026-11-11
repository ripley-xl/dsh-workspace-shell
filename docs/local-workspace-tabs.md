# 工作区页签与本地/SSH 工作区

## 当前版本

- Workspace Shell：`0.5.17`，见[插件清单](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/packages/shell/package.json)。
- SSH Remote manager：`0.3.6`，见[manager 清单](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/packages/manager/package.json)。
- 远程 controller：`0.2.2`，见[版本常量](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/controller/src/constants.js)。
- 目标 DSH：远端运行包 `0.2.2-rc.1`（内置 pnpm `11.28.5`）；本机 CLI 页签仍按 `0.2.1-rc.5` 校验。终端资产为 xterm `6.0.0`、addon-fit `0.11.0`。
- 设计和验收口径见[工作区设计文档](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/workspace-launcher-design.md)。

本轮只修改插件、controller 和开发工作区，没有修改 DSH 源码。Native、Web 和 TUI 的公共生命周期保持一致；dsh web 使用 iframe Guest，不使用 Node、下载或任意弹窗能力。

## 页签与 launcher

- `Local` 永久保留当前 Client 和原有页面状态，不可关闭。
- 点击 `+` 创建真正的 launcher 页签；选择 Open 后在原页签内转换，保留 ID、位置和选中状态。
- 页签使用记录身份对象和当前运行检查处理迟到回调，不再使用数值 generation。
- Chrome 风格页签支持实时拖拽、边缘滚动、键盘操作、关闭、Escape 回滚和窄窗口布局。
- 拖拽越过 4px 阈值后显示跟随指针的页签副本，原位置变为占位槽；经过其它页签中点时实时重排，页签位置用 140ms 过渡更新。`prefers-reduced-motion: reduce` 时保留副本跟随，关闭倾斜、入场和位置过渡。
- 副本只参与显示和坐标计算，不改变页签记录、排序回调、顺序持久化或 Surface 挂载顺序。
- 页签重排只改变页签条和记录顺序；已挂载的远端 Surface 保持创建时的 DOM 顺序。Desktop 的 Web Guest 是 Electron `<webview>`，移动它的 DOM 节点会让原生视图脱离，内容显示为空白。
- 拖拽和键盘排序结果按 profile 记在 Host 存储里；重建 Client 或重启 Desktop 后，重新打开的工作区按记忆位置插入，关闭过的页签保留原槽位。
- 页签可设置自定义显示名和五色标记（蓝、绿、橙、红、灰，或无）。悬停页签上的铅笔按钮、双击页签或按 F2 打开编辑器；名称留空并选择“无”保存即恢复默认。
- 自定义信息按与顺序相同的页签身份保存，同一身份的多个视图共享；Local 可编辑，launcher 和没有稳定身份的扩展页签不可编辑。自定义名称只替换页签文字、悬浮提示、无障碍名称和窗口标题，不修改原始 tab 标题，也不写 SSH 主机记录或连接别名。
- 自定义信息落在 `<DSH_HOME>/storages/workspace_shell/tab_appearance/default.json`，最多 64 条，只含身份、名称和颜色。
- 页签右键菜单：Web Host 页签（`profile-ui`，排除 Local）提供「等空闲后重启」「立即重启」，页签未 ready 时两项置灰。选中后先激活该页签，再由该页签的 Guest 调用 Host 自己的重启路由；Guest 页面不再有侧栏底部按钮或设置页入口（Shell `0.5.77` / Guest `0.6.2`，协议见[页签右键重启](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/tab-restart-menu-design.md)）。
- 页签文字宽度：页签最小宽度 88px、最大宽度 360px（窄窗口 72/240px）；SSH 连接名在页签文字中的份额上限由 40% 提高到 60%（窄窗口 50%），`anydev` 这类短名不再被截断；超长自定义名仍以省略号收尾。
- 右侧栏恢复：右栏 Slot 的 occupant 一次渲染异常会被 DSH 槽位核心永久移出（abdication），而右侧栏 store 仍报告 expanded，页头只在 collapsed 时渲染的展开按钮随之消失，面板不可达。Shell `0.5.17` 观察 `rightbar` 与 `rightbar.session`，发现「有注册项但全部被移出」时把条目从 abdication 集合恢复并 markDirty，让新的错误边界按当前状态重渲染；最多重试 3 次（120/400/1200ms），健康保持 2s 后重置额度，超过额度则收起右栏让页头按钮重新可用。
初次读取不可用时本次会话不显示编辑入口；保存失败时保留原显示并报安全错误码；损坏记录按无自定义处理，下一次保存覆盖。
- 顺序只记页签身份（Local、`web:<profile>`、`tui:<profile>`、`session:<id>`、`ssh:<host>:<profile>`），落在 `<DSH_HOME>/storages/workspace_shell/tab_order/default.json`，最多 64 条，超限先淘汰已关闭的。
- 身份 token 不含标题、URL、cwd、token 或会话正文；存储不可用或数据损坏时按追加处理，拖拽、打开页签和 launcher 不受影响，下一次拖拽覆盖坏记录。
- 不恢复页签本身，不自动连接 SSH，不启动 Host 或 TUI；同一 profile 多开的页签共用身份，按打开顺序相邻插入。
- launcher 显示本机与 SSH 来源，不自动连接未启用的 SSH 记录。
- 本机列表隐藏 Desktop、headless 和无有效能力的 profile；Web 排在 TUI 前面。未识别 profile 显示“未识别”。
- 名称包含 `tui` 的 profile 使用通用 TUI 适配，匹配不区分大小写；DSH TUI 和 Pi TUI 保留各自的严格适配。
- 通用 TUI 的启动命令可以编辑。命令解析为可执行文件和参数，不经过 shell，shell 操作符只作为普通参数。

## 本地 Web 与 TUI

| 类型 | 打开方式 | 关闭行为 |
| --- | --- | --- |
| Web | 同一窗口、同一 profile 复用本插件拥有的 Host，可创建多个独立视图 | 关闭视图只释放 Guest；显式停止 Host 才停止进程并关闭关联视图 |
| TUI | 每次打开都创建独立 PTY 和 Cordis Host，同 profile、同 cwd 也可多开 | 关闭页签停止该实例；进程正常退出后关闭对应页签 |
| Browser | 保留扩展点，不提供默认可用 Browser 创建入口 | 不创建占位实例 |

Web Host 只复用同一窗口拥有的 running 实例。外部进程、其它窗口和其它插件创建的进程不属于本插件。

TUI 使用固定同源 iframe 和 MessageChannel。输出读取串行，等待 xterm 写入 ACK 后推进游标；输入按 UTF-8 拆分，隐藏时停止输入、聚焦和 resize。首个 ready 不再依赖后台页签可能暂停的 `requestAnimationFrame`。

### 默认工作目录

新建 TUI 表单按以下来源填写 cwd：

1. 当前 Web 页签中唯一主会话的有效工作目录；
2. 当前 TUI 页签的启动目录；
3. 当前选中工作区；
4. 无法可靠读取时保留空白，要求手填。

Web Guest 使用[窄 companion](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/packages/shell/guest-cwd/client.js)读取 `sessions.list` 中主会话的 `workingDirectory`。它不读取 Session 正文，也不返回 Session ID、标题或原始 URL。

cwd 使用带版本和 requestId 的 `postMessage` 请求/响应。父页校验 source、origin、requestId 和当前 launcher；Guest 只接受实际 `window.parent`，并在首个合法请求后锁定其 origin。该校验不依赖认证重定向会清除的 query、fragment 或 `window.name`。

异步结果不能覆盖用户已编辑的目录，也不能写入后来创建的 launcher。

## SSH Web

SSH 只支持远程 Web，不提供远程 TUI 或 Browser。远端 DSH 监听 `127.0.0.1`；本机 Guest 使用回环 SSH 端口转发，不开放公网监听。

SSH profile 行只提供“新建页签”和“停止”。“新建页签”复用现有健康 Host，没有可复用实例时启动 Host；界面不再提供单独的“接入新页签”按钮。`0.3.2` 已在 Desktop 验证此按钮可打开原有持久 Host，记录见[单一打开入口验收](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-single-open/verification.md)。

- 连接页提供 autoConnect、设置、重启、断开和删除。
- 设置页管理端口转发；新增连接只接受 OpenSSH alias。
- 停止远程 Web Host 需要确认，只关闭该实例的关联页签。
- 断开 SSH 不停止远端 Host；现有远程页签转为灰色离线状态。
- 远程页签按“连接状态点 → SSH 连接名 → 页签标题”显示。绿点要求当前通道和网关可用。
- 同一 SSH 连接可共享 SSH 通道和 controller，但每个 profile 有独立的 Host、网关、lease 和启动操作。
- 同一远程 Host 可创建多个 Guest 视图；关闭一个视图不影响其它视图。
- 旧 controller 的默认 `web` 重连省略它不支持的 profile 参数；非默认 profile 要求支持 profile 的新 controller。
- 远程没有显式 profile 目录时仍保留运行时内置的 `web`；其它未声明的 profile 不会因此被允许。

`autoConnect=true` 在 Desktop 启动后立即异步连接，不阻塞启动或认证；运行中开启也会立即连接。旧实例已停止时允许自动创建新实例。本机 DSH 版本变化不改变远端运行包，只影响运行包选择偏好；插件自带运行包变化后，manager 以新运行包另起实例。其他运行包的实例视为其他 Desktop 的独立实例，不停止也不接入。关闭 autoConnect 会断开当前通道，不停止远端 Host。

连接或打开 profile Host 后，manager 按 `createdBy` 运行包身份区分实例：与当前 DSH 版本/构建相同但由旧 controller 运行包启动的实例（如 `0.2.2-rc.1-controller-0.2.1-linux-x64-glibc`）是独立实例，manager 不接入也不停止它，会以当前运行包另起一个；由旧 DSH 版本钉死、被远端判为 `incompatible-version` 的官方远端插件，本机有对应新版本时先备份远端 profile，再 remove 后 install 到本机版本。插件安装只有返回 restart-required 才重启该 Host（HMR 应用不重启）；需要用户批准 build script 的插件标记为待批准且不重试，其它单项失败只记录，均不阻断连接。

## 远程运行时与传输

运行时 ID 同时包含 DSH 版本、controller 版本和平台，例如 `0.2.2-rc.1-controller-0.2.1-linux-x64-glibc`。不同 controller 的运行时安装到不同目录，旧运行时不会被新 digest 覆盖。

manager 安装包包含目标平台 artifact，打包安装后不再依赖源码目录中的 `controller/artifacts`。catalog 优先使用与偏好版本匹配的 artifact，其次使用带 controller 版本的最新 artifact；没有匹配偏好版本时仍可使用自带运行包。

SFTP 使用无进度超时：持续上传大文件时重置计时，真正断流仍按超时失败。远程命令失败可携带经过脱敏和截断的 stderr 诊断，认证 URL、token 和私钥不进入日志。

## 打开耗时

launcher 的“Recent open timings”记录 input、connect、instance、forward、Host、lease、load 和 total 的可用阶段，并区分新建与复用。耗时记录不包含 URL、token、私钥或 Session 内容。

## 构建与交付

```sh
node scripts/test.mjs --test-concurrency=4
node scripts/build-shell-client.mjs --out-dir artifacts/workspace-tabs/launcher-staging
node scripts/build-shell-client.mjs --out-dir artifacts/workspace-tabs/launcher-staging --check
node scripts/build-manager-client.mjs --check
node controller/scripts/build-runtime.mjs --platform linux --arch x64 --libc glibc
```

最终验收包：

- [Workspace Shell 0.3.1](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-native-click/local-dsh-workspace-shell-0.3.1.tgz)
- [SSH Remote manager 0.2.0](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-cwd/local-dsh-ssh-remote-0.2.0.tgz)

## 验证结果

2026-11-11 页签右键重启：Shell `0.5.77` / Guest `0.6.2` 把 Web Host 重启入口从 Guest 页面（侧栏底部 ⟳ 与设置页那一行）移到页签右键菜单；菜单提供「等空闲后重启」「立即重启」，页签未 ready 时置灰，选中后先激活页签，再由该页签的 Guest 调用 Host 自己的重启路由。Guest 页面只保留执行、状态覆盖层和重启后自动 reload。新增 48 项用例：`shell-chrome-tabs` 菜单 6 项、`shell-frame` 2 项、`shell-tab-controller` 4 项、`shell-workspace-client` 5 项、`shell-desktop-guest` 3 项、`shell-browser-guest` 4 项、`shell-guest-restart-control` 24 项；全量 **1080 项，1077 通过，0 失败，3 跳过**（`--test-concurrency=4`）。验收用两个临时 profile（验收后已删除）：`wsh-shell` 作为工作区 Shell 在 Chrome 里运行，`wsh-guest` 装 Guest `0.6.2` 作为页签里的 Web Host。右键 Web Host 页签出现「等空闲后重启」「立即重启」；两个入口各触发一次重启，Host 进程分别从 63728 换成 66905、从 66905 换成 68958，端口保持 59063，页面在 Host 回来后自动 reload 并恢复可交互；本地页签右键不出现菜单；Guest 页面里已搜不到「重启此 Host」入口。截图见 [页签右键菜单](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-tab-restart-0.5.77/tab-menu.jpg)。Desktop 的 `<webview>` 路径未重启验收（会中断当前会话），由 `shell-desktop-guest` 用例和 Electron `executeJavaScript` 实测覆盖。安装包见 [release-tab-restart-0.5.77](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-tab-restart-0.5.77)。

2026-11-08 页签文字宽度与右栏恢复：Shell `0.5.17` 把页签最小/最大宽度从 64/240px 提升到 88/360px（窄窗口 56/160 → 72/240），SSH 连接名份额从 40% 提升到 60%（窄窗口 32% → 50%），`anydev` 这类短名可完整显示。右栏按钮消失的根因是 `rightbar` Slot occupant 在一次渲染异常后被槽位核心 abdicate；历史渲染器崩溃记录里对应报错为 `Sidebar Session view reference is no longer owned`（右侧栏 SessionView 在 commit 阶段 mount 晚于视图 retire）。`0.5.17` 增加有界恢复：检测到右栏条目全部被移出时恢复并重渲染，最多 3 次；失败则收起右栏让页头展开按钮恢复。安装前 live Client Inspect 显示 `rightbar` occupant `active:false`、`browserFrames:0`；热重载到 `0.5.17` 后同一页面恢复为 `active:true`、`browserFrames:1`，右栏面板无需刷新重新出现，截图见 [恢复后的右栏](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-tab-label-sidebar-0.5.17/rightbar-restored.png)。新增 `test/p2/ui/shell-slot-recovery.test.mjs` 6 项，`shell-chrome-tabs` 用例更新为 27 项；全量 **1040 项，1034 通过，0 失败，6 跳过**（`--test-concurrency=4`）。
2026-11-08 修复热重载后外观丢失：Desktop 加载 `0.5.15` 后，插件重载时旧 Shell 实例没有关闭 `workspace_shell` 存储域；新实例打开同一域失败，外观读取降级为不可用，页签编辑按钮和色条消失。`0.5.16` 在插件卸载时关闭自建域，并在域已被旧实例占用时通过 `storage.get()` 复用同一句柄；安装后无需重启 Desktop，Local 的蓝色标记和编辑按钮即恢复。截图见 [恢复后的 Desktop 页签条](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-tab-appearance-reload-0.5.16-bundle/desktop-restored.png)。新增 3 个 store 用例覆盖关闭、热重载复用和 in-flight open。全量 **1034 项，1028 通过，0 失败，6 跳过**（`--test-concurrency=4`）。

2026-11-08 页签拖拽反馈：Shell `0.5.15` 在合并 `main` 的页签自定义名称与彩色标记后，为 Chrome 页签增加跟手副本、原位占位槽和 140ms 位置过渡；`prefers-reduced-motion: reduce` 下关闭倾斜、入场和位置过渡。新增 4 个 `shell-chrome-tabs` 用例，覆盖副本跟随、拖拽与键盘过渡、reduce motion、取消与卸载清理。全量 **1031 项，1025 通过，0 失败，6 跳过**（`--test-concurrency=4`）。

2026-11-08 拖拽反馈渲染检查：用 Playwright 将 `shell-chrome-tabs` 的真实渲染树套用组件 CSS，确认副本绝对定位、背景与阴影、2° 内倾斜，占位槽为 45% 不透明度和内描边；截图见 [drag-ghost.png](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-drag-effects-0.5.15/drag-ghost.png)。真实 Desktop 窗口中的拖拽验收见下一条。

2026-11-08 Desktop 拖拽验收：重启 Desktop 加载 Shell `0.5.15` 后，用真实指针新建两个临时 launcher 页签并拖拽。拖动时页签副本跟随指针，带阴影和轻微倾斜；原位置显示降透明度的占位槽；跨过中点后页签实时重排，松开后顺序提交、副本消失。随后用 Delete 关闭两个临时 launcher，页签条恢复为单个“本地”。Local 的蓝色标记和编辑按钮同时可见。截图：[拖拽副本](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-drag-effects-0.5.15/live-ghost.png)、[重排后](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/release-drag-effects-0.5.15/live-after-reorder.png)。140ms 过渡、Escape 回滚和取消清理仍由单元测试覆盖，未在截图中量化。

2026-11-08 页签自定义名称与彩色标记：Shell `0.5.14` 新增 `test/p2/ui/shell-tab-appearance.test.mjs`、`test/p2/shell-workspace-preferences-store.test.mjs` 及页签条、Frame、Client、路由和 boot 用例；全量 **1027 项，1021 通过，0 失败，6 跳过**（`--test-concurrency=4`）。自定义信息只存身份、名称和颜色，不写 SSH 主机记录。

2026-11-08 真实 Web 验收：Shell `0.5.14` 安装到 `web` profile，启动并重启 Host 后在浏览器中验证 Local 与 `dsh-tui` 页签的自定义名和色条；重开 TUI 页签立即显示“验收 TUI”，Host 重启后仍生效；清空名称并选择“无”后恢复原名。外观记录只含 `local` 和 `tui:dsh-tui` 的 id/name/color，SSH 主机记录 `updatedAt` 未变。验收结束后已清空自定义记录并停止临时 Host。

2026-11-08 Desktop 重启验收：Shell `0.5.14` 加载后，工作区页签条显示编辑按钮。通过原生 UI 将 Local 改为“桌面验收本机·红”并选红色，AX 树和截图确认名称与红色色条，外观记录为 `local`/red；保存前后 SSH 主机记录 SHA-256 相同。验收后清空记录并恢复“本地”。截图见 [桌面页签条](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/acceptance/desktop-tab-appearance-red.png)。

2026-11-08 页签重排与 Web Guest：连续拖拽排序后，`web · Web 4` 的 Guest 停在 `about:blank`，与空白页签的现象一致；根因是页签数组重排会移动已挂载的 `<webview>` DOM 节点。Shell `0.5.12` 让远端 Surface 按创建顺序挂载，页签条单独排序；新增 `test/p2/ui/shell-frame.test.mjs` 用例锁定 Surface 顺序。全量 **1003 项，997 通过，0 失败，6 跳过**。

2026-11-08 页签顺序记忆：Shell `0.5.11` 新增 `test/p2/ui/shell-tab-order.test.mjs`、`test/p2/shell-tab-order-store.test.mjs` 和客户端记忆顺序用例；全量 **1002 项，996 通过，0 失败，6 跳过**。拖拽手势与回归用例不变。

2026-11-04 点击修复回归：**983 项，978 通过，0 失败，5 跳过**，包含真实浏览器点击用例。完整结果见[测试日志](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/native-click-regression.log)。

`0.3.1` 修复了空 viewport 覆盖 launcher 的问题。已在 Desktop 原窗口验证中文、profile 和来源切换、关闭、重新创建及本地页签往返。安装后插件热加载，Desktop 和内部 Host 未重启。截图、包哈希及范围见[验收记录](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/artifacts/workspace-tabs/native-click-verification-20261104.md)。

浏览器用例默认跳过，避免普通单元测试操作浏览器。先用 Kimi WebBridge 将独立 `workspace-web` Host 的已认证页面打开到 `dsh-native-click` session，再运行：

```sh
DSH_LAUNCHER_BROWSER_TEST=1 node --test test/p2/ui/shell-launcher-browser.test.mjs
```

可通过 `DSH_BROWSER_SESSION` 指定 session，通过 `DSH_WEBBRIDGE_URL` 指定 daemon 地址。用例会临时调整视口、创建 launcher、验证真实鼠标命中与选择变化，最后关闭自己创建的页签并还原原活动页签；不会启动 TUI、Web Host 或 SSH 连接。

此前完整 dsh web 验收使用独立 `workspace-web` profile，不需要 Desktop profile。已验证：

1. launcher 的来源、profile 过滤、未识别类型、TUI cwd 和可编辑命令；
2. Pi TUI 实际启动、输入界面、连接状态和关闭后退出；
3. 本地 Web 新建、复用、两个视图、关闭视图保留 Host、停止 Host 清理视图；
4. anydev 运行时上传、安装、旧实例重连、远程 Web 认证与真实页面加载；
5. 远程多视图、绿点、断开后离线、重连、实例级停止和停止确认；
6. autoConnect 开启后立即连接、重启后自动连接、旧实例停止后自动创建新实例、关闭后断开；
7. 本机与 anydev Guest 的 cwd 消息通道；远程表单填入的是 anydev 当前会话目录；
8. 真实鼠标拖拽排序、Escape 回滚和阶段耗时显示。

验收结束后，anydev 的验收实例均为 stopped，autoConnect 已关闭，本地验收 Host 已退出。远程不可变运行时按设计保留，便于下次直接重连。

## 明确边界

- TUI 持久 Host 不在本轮范围；关闭 TUI 页签仍停止其实例。
- 不开放 Browser 创建，不提供远程 TUI。
- 不承诺私有 Host DOM/CSS 接口跨 DSH 版本稳定。
- 完整工作区生命周期验收在 dsh web 中完成；`0.3.1` 新增了 Desktop launcher 点击验收，不代表重新执行 Native 的 TUI/SSH 生命周期全量验收。
