# 工作区页签与本地/SSH 工作区

## 版本

- 插件：`dsh-workspace-shell` `0.1.1`，页签框架、SSH 宿主和远端 controller 在同一个包里。
- 目标 DSH：运行时取本机安装的 DSH 版本；终端资产为 xterm `6.0.0`、addon-fit `0.11.0`。

插件不修改 DSH 源码。Native、Web 和 TUI 的公共生命周期保持一致；dsh web 使用 iframe Guest，不使用 Node、下载或任意弹窗能力。

## 页签与 launcher

- `Local` 永久保留当前 Client 和原有页面状态，不可关闭。
- 点击 `+` 创建 launcher 页签；选择 Open 后在原页签内转换，保留 ID、位置和选中状态。
- 页签用记录身份对象和当前运行检查处理迟到回调。
- Chrome 风格页签支持实时拖拽、边缘滚动、键盘操作、关闭、Escape 回滚和窄窗口布局。
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

TUI 使用固定同源 iframe 和 MessageChannel。输出读取串行，等待 xterm 写入 ACK 后推进游标；输入按 UTF-8 拆分，隐藏时停止输入、聚焦和 resize。

### 默认工作目录

新建 TUI 表单按以下来源填写 cwd：

1. 当前 Web 页签中唯一主会话的有效工作目录；
2. 当前 TUI 页签的启动目录；
3. 当前选中工作区；
4. 无法可靠读取时保留空白，要求手填。

Web Guest 使用[窄 companion](../packages/shell/guest-cwd/client.js)读取 `sessions.list` 中主会话的 `workingDirectory`。它不读取 Session 正文，也不返回 Session ID、标题或原始 URL。

cwd 使用带版本和 requestId 的 `postMessage` 请求/响应。父页校验 source、origin、requestId 和当前 launcher；Guest 只接受实际 `window.parent`，并在首个合法请求后锁定其 origin。该校验不依赖认证重定向会清除的 query、fragment 或 `window.name`。

异步结果不能覆盖用户已编辑的目录，也不能写入后来创建的 launcher。

## SSH Web

SSH 只支持远程 Web，不提供远程 TUI 或 Browser。远端 DSH 监听 `127.0.0.1`；本机 Guest 使用回环 SSH 端口转发，不开放公网监听。

SSH profile 行提供“新建页签”和“停止”。“新建页签”复用现有健康 Host，没有可复用实例时启动 Host。

- 连接页提供 autoConnect、设置、重启、断开和删除。
- 设置页管理端口转发；新增连接只接受 OpenSSH alias。
- 停止远程 Web Host 需要确认，只关闭该实例的关联页签。
- 断开 SSH 不停止远端 Host；现有远程页签转为灰色离线状态。
- 远程页签按“连接状态点 → SSH 连接名 → 页签标题”显示。绿点要求当前通道和网关可用。
- 同一 SSH 连接可共享 SSH 通道和 controller，但每个 profile 有独立的 Host、网关、lease 和启动操作。
- 同一远程 Host 可创建多个 Guest 视图；关闭一个视图不影响其它视图。
- 默认 `web` 重连省略 profile 参数；非默认 profile 要求 controller 支持 profile。
- 远程没有显式 profile 目录时仍保留运行时内置的 `web`；其它未声明的 profile 不会因此被允许。

`autoConnect=true` 在 Desktop 启动后立即异步连接，不阻塞启动或认证；运行中开启也会立即连接。实例已停止时允许自动创建新实例；版本升级仍需确认。关闭 autoConnect 会断开当前通道，不停止远端 Host。

## 远程运行时与传输

运行时 ID 同时包含 DSH 版本、controller 版本和平台，例如 `0.2.1-rc.5-controller-0.1.0-linux-x64-glibc`。不同版本安装到不同目录，互不覆盖。

第一次连接时，远端执行 `npm install @deepseek-ai/dsh@<本机版本>` 安装运行时，版本取本机正在运行的 DSH 版本。远端缺少 Node.js 22+、缺少 npm 或访问不了 npm registry 时报结构化错误，由用户自行处理；图片处理需要的 sharp 平台包单独补装，LibreOffice 和语音输入的可选大依赖不安装。

SFTP 使用无进度超时：持续上传大文件时重置计时，真正断流仍按超时失败。远程命令失败可携带经过脱敏和截断的 stderr 诊断，认证 URL、token 和私钥不进入日志。

## 打开耗时

launcher 的“Recent open timings”记录 input、connect、instance、forward、Host、lease、load 和 total 的可用阶段，并区分新建与复用。耗时记录不包含 URL、token、私钥或 Session 内容。

## 构建与验证

```sh
node scripts/build-shell-client.mjs
node scripts/build-shell-client.mjs --check
node scripts/test.mjs
```

浏览器用例默认跳过，避免普通单元测试操作浏览器。先用 Kimi WebBridge 将独立 `workspace-web` Host 的已认证页面打开到 `dsh-native-click` session，再运行：

```sh
DSH_LAUNCHER_BROWSER_TEST=1 node --test test/p2/ui/shell-launcher-browser.test.mjs
```

可通过 `DSH_BROWSER_SESSION` 指定 session，通过 `DSH_WEBBRIDGE_URL` 指定 daemon 地址。用例会临时调整视口、创建 launcher、验证真实鼠标命中与选择变化，最后关闭自己创建的页签并还原原活动页签；不会启动 TUI、Web Host 或 SSH 连接。

## 边界

- 关闭 TUI 页签停止其实例，TUI 不提供持久 Host。
- 不开放 Browser 创建，不提供远程 TUI。
- 不承诺私有 Host DOM/CSS 接口跨 DSH 版本稳定。
- 远程运行时依赖远端 Node.js 22+、npm 和可访问的 npm registry。
