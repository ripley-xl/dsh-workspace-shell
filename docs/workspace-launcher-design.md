# 工作区启动器、本机与 SSH Web Host 设计

日期：2026-11-03。状态：已批准，进入实现。

## 目标与边界

本轮将新建工作区从弹窗改为真正的 launcher 页签，统一本机与 SSH Web Host，并提供 Chrome 风格页签、拖拽排序、官方主题样式复用和 Web 打开耗时诊断。

约束：

- 只修改本工作区插件和自有 controller，不修改 DSH 源码。
- 同一 Shell 插件支持 Native Desktop 和 dsh web 安装。dsh web 的当前 Web profile 就是 Local，不需要也不创建 Desktop profile。
- Desktop 保留唯一永久 Local；Web 支持多视图；TUI 支持多实例。
- 远程只支持 Web。远端 DSH 只监听 `127.0.0.1`，本地 Guest 只访问本地回环转发地址。
- 不实现持久 TUI Host。关闭 TUI 页签仍停止对应实例。
- Browser 在未知 profile 的类型选择中显示但禁用。
- 不复制官方 CSS 文件，不把 SSH 凭据、认证 URL 或 Session 正文写入公开快照。

## 页签状态与竞态

### 移除数字 generation

页签元数据不再暴露数字 generation。当前性由两个条件确定：

1. 页签当前记录的对象身份仍与操作开始时一致。
2. 操作所属运行记录仍是 controller 中的当前运行，且未被 AbortController 取消。

重试、launcher 转换、关闭重开都会创建新的记录对象。旧回调即使携带相同页签 ID，也不能修改新记录。

### launcher 类型

新增 `launcher` 类型。点击 `+` 立即创建并选中“新建工作区”页签，不打开弹窗，不启动 Host。

launcher 可直接关闭。关闭时不产生 Host 副作用。

点击“打开工作区”或从 Host 行新建页签时：

- 保留页签 ID 和排列位置。
- 用新的记录对象替换 launcher 的类型、标题和内容。
- 原 launcher 的运行失效并清理，目标 provider 从当前容器启动。
- 启动失败后显示安全错误，可重试或关闭。
- 旧回调不能修改替换后的 Web/TUI 页签。

### 拖拽排序

- 从页签正文按下，移动超过 4px 后捕获指针并进入拖拽。
- 关闭按钮、`+`、菜单和其它控件不启动拖拽。
- 经过其它页签中点时实时重排，接近左右边缘时自动滚动。
- 重排只改变数组顺序，不改变 ID、当前记录、活动状态或 provider 运行。
- Local 可排序但仍不可关闭。
- 松开提交当前顺序，Escape 恢复拖拽前顺序，pointer cancel 安全结束。
- 不支持拖出创建新窗口，不新增跨重启持久化。

## 运行平台与 Guest

### Native Desktop

使用现有隔离 webview、Native lease 和 partition。窗口空白区双击缩放只在 Native 生效。

### dsh web

- 使用浏览器 iframe Guest，不需要 Desktop profile 或 Native bridge。
- 当前 Web profile 是永久 Local，其它本机 profile 与 SSH Host 仍可打开为独立视图。
- iframe 使用脚本和同源所需的最小 sandbox 能力，不开放 Node、下载或任意弹窗。
- 父页面不读取跨域 Guest DOM，不读取认证 URL 内容。
- 页签、Host、SSH、TUI 和测量逻辑与 Native 共用。

### Guest cwd 通道

Native 与浏览器 Guest 统一使用来源校验的 `postMessage` 请求/响应，只返回 string|null 的有效 cwd。Guest 只接受实际 `window.parent`，并在首个合法请求后锁定其 origin；父页面校验 event.origin、event.source、当前 Guest、requestId 和当前导航，并带超时。该通道不依赖认证重定向会清除的 query、fragment 或 `window.name`。父页面不执行任意 Guest 脚本，也不读取跨域 DOM。

## Chrome 页签与窗口行为

- 页签栏继续使用 48px 高度。
- 活动页签使用顶部圆角和内容区背景；非活动页签透明。
- 页签随可用宽度收缩，标题超长省略；页签最小/最大宽度 88/360px（窄窗口 72/240px），SSH 连接名在页签文字中的份额上限 60%（窄窗口 50%），短连接名不截断。
- 关闭按钮在悬停、聚焦或活动页签上显示。
- 页签可设置自定义显示名和五色标记；编辑按钮在悬停、聚焦或活动页签上显示，双击页签或按 F2 也可打开编辑器。
- 自定义名称只替换页签文字、悬浮提示、无障碍名称和窗口标题；颜色只用于页签左侧色条。两者都不写回 SSH 主机记录或连接别名。
- 编辑器色块使用 `--dsw-alias-state-*` token；名称留空并选择“无”保存即恢复默认。
- `+` 使用独立圆形图标按钮。
- 删除页签栏装饰图标、顶部“原布局”按钮和侧栏“工作区布局”入口。
- 插件禁用或卸载仍执行 adapter 恢复和资源清理。
- 页签栏空白区域复用现有 `data-window-drag` 行为，支持双击缩放窗口；交互控件保持 no-drag。
- 不新增私有窗口缩放 API，最终行为以 Native 实测为准。

按钮、输入框、菜单、弹窗、焦点框、字体和颜色优先复用官方 CSS 与 `--dsw-*` token。Chrome 页签形状、拖拽状态和 launcher 布局没有对应官方结构时，只补自有结构 CSS。

## launcher 页面

### 布局

页面使用双栏：

- 左栏是来源列表：本机 profile 和 SSH 连接。
- 右栏是所选来源的配置、Host 列表和状态。
- 窄窗口改为单栏，不产生横向页面滚动。

选择来源时保留当前 launcher。切换来源只更新页面，不启动或停止进程。

### 本机 profile

- Desktop/headless 不显示，`web` 优先，其余按类型和名称排序。
- 已识别 Web 直接显示 Web 配置，不显示类型选择。
- 已识别 TUI 展开工作目录和启动命令。
- 未识别 profile 才显示 Web/TUI/Browser；Browser 禁用并标注“暂未开放”。
- 所有 TUI 都显示工作目录，已知与通用 TUI 一致。

### TUI 识别与命令

- 对解析出的 bundle 名称执行 `/tui/i`，版本号不参与匹配。
- DSH/Pi 已知 adapter 保留精确版本检查和专用环境。
- 其它匹配项使用通用 TUI，不猜专用环境变量。
- 默认命令为 `dsh --profile <profileId>`，可编辑。
- 命令解析为可执行文件和参数数组，支持引号与转义，不经过 shell。
- 空命令、未闭合引号、换行、NUL、超长或过多参数显示安全错误。
- Agent 工具继续使用固定 CLI 和参数，不接受任意命令。

### cwd 默认值

点击 `+` 时记录来源页签：

- Desktop/Web 使用唯一主会话的 `projectionValues.workingDirectory`。
- 无会话时才使用实际观测到的选中 Workspace.path。
- TUI 使用该实例的启动 cwd。
- 来源页签在 launcher 激活后仍可被读取，但记录必须仍是同一对象。
- 异步结果只能写入原 launcher 的当前记录，且不能覆盖已编辑输入。
- 无可靠值时留空，不使用 profile 存储目录或原始 Session.cwd 替代。

## 持久 Web Host

### 本机与统一 Host 行

- Web Host 常驻，关闭 Web 页签只释放 Guest。
- Host 列表只显示 starting/running/stopping，exited/failed 不显示。
- 每行以 profile 名称为主标题，显示 Web、来源、状态和当前窗口视图数量。
- 对当前窗口拥有的 running Host，可按 runtimeId 新建 Web 视图。
- starting 时等待，不允许重复新建；stopping/offline/其它 owner 不可新建。
- 停止 Host 需要确认，成功后关闭当前窗口的全部关联视图。
- 读取失败时保留旧列表并标记“可能不是最新”，不能清空后假装没有 Host。
- Host 条目只含安全字段；认证 URL 只在实际打开 Guest 时进入私有通道。

### 来源身份

当前来源为 `local` 或 `ssh`。UI 显示“本机”或 SSH 连接别名。

页签与 Host 关联使用 runtimeId，不使用 profile 名称作为全局唯一身份。后续不同来源可以存在同名 profile。

SSH Web 页签标题依次显示连接状态点、SSH 连接名称和页签名称。状态点只在当前 SSH 通道和本地网关可用时显示绿色，未连接时为灰色；远端进程存在但当前断开时仍显示灰色。

## SSH Web Host

### 复用现有能力

复用现有 ConnectionStore、OpenSSH 解析、认证、host key 确认、运行时安装、controller、实例 lease 和回环端口转发。

controller 与 supervisor 增加 profile 支持：

- 实例记录包含 profileId；旧记录缺失时按 `web` 读取。
- list/attach/start 都校验目标 profile，不能把其它 profile 的实例接入当前视图。
- supervisor 使用 `dsh --profile <profileId>` 启动 Web，launcher 参数位于 app 参数之前。
- 每个 SSH 来源和 profile 最多复用一个健康实例；新建视图 attach 到该实例。
- 同一 SSH 连接下的 Host 共享控制通道与端口转发管理，视图使用独立 Guest lease。
- 运行时安装和版本升级自动执行：远端 Host 落后时停止旧实例并换成本机版本，本机 DSH 落后于远端时报错且不动远端；实例的运行包身份（`createdBy` 与当前 runtimeId）不一致时同样视为陈旧并自动重建；同步仍使用现有确认流程，不因选中服务器而自动放行。
- 连接后自动对齐官方远端插件：远端 DSH 判为 `incompatible-version` 且本机有安全安装目标的插件，先备份远端 profile，再 remove 后 install 本机版本；installTarget 优先，其次 `name@version`，最后 `source`，本地路径、tarball、`file:` 与含凭据的 spec 一律跳过。
- 运行时 ID 包含 DSH 版本、controller 版本和平台；不同 controller 使用独立目录，不覆盖旧运行时。
- SFTP 按上传进度计算无进度超时，持续上传大文件不受固定总时长限制。

### 网络安全

- 远端只监听 `127.0.0.1`，使用随机端口。
- 本地端口转发只监听本地回环地址。
- 远程 Web 不提供公网监听，不支持远程 TUI 或 Browser。
- 不向页签快照、Host 列表或诊断记录暴露认证 URL、私钥、密码或 token。
- SSH 断开只关闭通道和本地网关，不停止远端持久 Host；关联页签显示离线并可重连。

## SSH 列表与连接管理

### 启动时 autoConnect

每个连接保存 `autoConnect`，已有记录默认 `false`。

- `true`：Desktop 启动后立即在后台异步尝试连接，不阻塞界面；运行中开启滑钮也立即尝试。旧实例已停止时允许自动创建新实例。
- `false`：不自动连接；关闭滑钮时同时断开当前连接。远端 Host 保持运行。
- 后台自动连接不弹出阻塞式认证；需要人工认证时保持未连接，等待用户手动连接。
- 点击服务器只展开右侧内容，本身不触发自动连接。
- 手动“连接并刷新”始终可用，操作显示阶段、可取消且不能重复提交。
- 关闭 launcher 不隐式取消连接；取消必须由用户明确操作。

### 连接菜单

每个 SSH 条目提供更多菜单：

- 设置。
- 重启连接：重建 SSH 通道和网关，不停止远端 Host。
- 断开连接：保留远端 Host，关联视图进入离线状态。
- 删除：明确提示本地记录与远端 Host 的影响，删除中禁止重复提交。

菜单支持 Escape、点击外部关闭和焦点返回。

### 设置与端口转发

设置弹窗显示别名、解析后的主机、端口、身份文件路径、远端版本和端口转发。

端口转发支持列表、添加、删除、输入校验和状态反馈。失败保留草稿，成功后刷新。不得显示私钥正文或认证 token。

添加 OpenSSH 别名时只需选择或输入别名。显示名默认使用别名；用户、端口、身份文件和跳转规则由 OpenSSH 配置解析，不要求重复填写。

## 状态与交互细节

- profile/SSH 切换只更新 launcher，不触发 Host 副作用；手动连接和启动时 autoConnect 是独立入口。
- 新响应必须匹配当前来源与当前记录，迟到响应不能覆盖后来选择。
- loading 使用固定尺寸状态区，避免列表跳动。
- empty 状态提供下一步动作，不显示无意义占位卡片。
- 失败保留旧数据和用户草稿，并提供重试。
- busy 状态禁用冲突操作，但不妨碍查看其它来源。
- 所有按钮具有文字或 aria-label；键盘焦点可见。
- 弹窗支持焦点约束、Escape 和关闭后的焦点恢复。
- 主题变化不依赖重新构建插件。

## Web 打开耗时

每次打开 Web 视图记录：

1. 输入模式切换。
2. Host 启动或复用等待。
3. Guest lease 获取。
4. 页面加载到 ready。
5. 总耗时与是否复用 Host。

SSH 另外记录连接、远程实例启动/attach 和端口转发就绪耗时。

launcher 提供默认折叠的“最近打开耗时”，只显示安全数值。旧测量的迟到结果不能覆盖更新一次打开。先根据测量定位瓶颈，再决定优化；不跳过版本、安全或 Loader 检查。

## 错误与安全

- 所有外部错误转换为稳定、安全代码或短摘要。
- 任意异步回调都校验当前记录、运行身份和取消状态。
- 停止失败保留页签和 Host 状态，不伪造成功。
- SSH 删除、停止和同步沿用现有确认；版本升级与官方远端插件对齐自动执行，仅在远端版本更新时报 `LOCAL_DSH_OUTDATED` 并提示先更新本机 DSH。
- 插件对齐时先创建远端备份再改动；`restart-required` 只重启一次对应 Host，`pendingBuilds` 标记为待用户批准且不重试、不回滚，单项或整体失败都不阻断连接。
- 不读取或复制凭据来绕过 GUI 或远程认证。
- 远程实例 profile 不匹配时拒绝 attach。
- 端口转发失效或 SSH 断开时，不新建 Guest，已有视图显示离线。

## 验证

### 状态与 Client

- launcher 创建、关闭、原地转换、重试和迟到回调。
- 数字 generation 从公开元数据移除，旧记录不能修改新记录。
- 拖拽重排、边缘滚动、Escape 恢复和 provider 不重挂载。
- 所有 TUI 的 cwd/命令字段、命令解析和通用启动。
- Web 按 runtimeId attach、跨 owner 拒绝、停止后关闭关联视图。
- autoConnect 持久化、Desktop 启动后台连接、开启后立即连接、关闭滑钮断开、后台认证不阻塞和重复操作防护。
- SSH 页签状态点反映当前连接，而非仅反映远端进程。

### SSH 与 controller

- 旧实例记录按 web 兼容读取。
- profile 启动参数、list/attach/start 过滤和错误拒绝。
- 远端与本地均为回环地址。
- 断开后远端实例保留，重连可 attach，停止才结束实例。
- 共享控制通道、lease、端口转发和清理顺序。
- 认证、安装和同步确认不回退；版本升级与不兼容官方插件对齐不需要人工确认。
- 远端实例的 createdBy 运行包身份、不兼容插件对齐顺序（备份→remove→install）与失败不阻断连接。

### 交付

- 全量具名回归。
- 暂存构建、重复检查、语法检查和分发清单。
- 本机 Web 新建/复用/停止和性能诊断实测。
- 至少一个 OpenSSH 服务器的 profile 列表、Web 打开、多视图、断开、重连和停止实测。
- 使用独立 Web 测试 profile 安装 Shell 并通过 dsh web 启动；使用浏览器自动化完整验收 launcher、页签、Host、SSH、键盘、主题和窄窗口。
- Native 只补验 webview 兼容和窗口双击缩放，不再作为完整功能验收的唯一通道。

## 实施顺序

1. 状态记录身份、launcher、原地转换与 Chrome 拖拽。
2. 本机 profile/TUI 配置、Web Host 列表和耗时测量。
3. SSH controller profile 支持、持久 Host 与 SSH 页面。
4. 设置、端口转发、全量回归和真实 GUI 验收。

持久 TUI Host 和可用 Browser 新建不在本轮。