# DSH SSH Remote

SSH Remote 在本地和远程 DSH Web 之间切换。Desktop 使用当前窗口内的沙箱 Webview；普通浏览器使用整页导航。两种形态都不在同一页面混合两端插件、配置或 Session。

**工作区框架正在进入本机多 profile 阶段。** 0.2.0 源码已接入常驻 Local、Web/TUI 同级页签、provider 接口及运行时工具；已应用更新，用户重开后确认新版入口可见；真实 Web/TUI 启动与切换尚待验收，见[本机页签说明](</Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/local-workspace-tabs.md>)。旧版框架的 macOS 初验记录仍见[第一阶段记录](</Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/frame-redraw.md>)。SSH 管理器尚未迁入新框架，旧 Guest 仍在中央面板。

已接入窗口内的主机选择与备份通知：管理页面卸载后仍保留每台主机最近一次待检查的备份元数据，插件卸载或页面重载时清空。备份记录不含凭据值或认证地址；Guest 仍未移出中央面板。

实现依据见[设计说明](<docs/ssh-remote-design.md>)，当前测试范围见[验证记录](<docs/ssh-remote-p2-validation.md>)。

## 包结构

| 包 | 安装位置 | 职责 |
| --- | --- | --- |
| `dsh-workspace-shell` | 仅 Desktop 的 `desktop` profile | 页签框架、launcher、SSH 管理、本机 Web/TUI 运行时、通知中心、Guest 通道 |
| `dsh-workspace-guest` | 所有 guest Web profile（`web`、SSH 远端、以后新增的 profile） | 会话状态上报与通知桥、cwd 读取、跨 Host 会话登记/导航；不挂框架 |

宿主端的本机 Web 运行时用 `--patch` 注入 guest 包作为兜底；远端运行包内置 `plugins/guest`，由连接补丁注入，远端 profile 无需安装插件。

## 已实现

- `0.5.35` Web Host 自重启：Guest 把身份写成 Host 卡（`<DSH_HOME>/workspace-hosts/`，5 秒心跳、退出即删），Guest 页面提供「重启此 Host」入口，重启按原 argv 重放并优先保住端口（保留登录 cookie，页面自己 reload）；Shell 侧发现 Host 卡并在 Host 退出后等待同身份的新卡接管，`catalog` 把不是自己启动的 Host 列为可接入行。受 controller 管理的 Host 带 `DSH_WORKSPACE_SUPERVISED`，禁止自重启。设计见[自重启与来宾上报说明](docs/host-restart-design.md)；
- `0.5.41` 插件配置同步也挂到「连接并刷新」：连上以后按「两边都装了的可移植插件」推配置条目和设置，不再只依赖升级按钮；单元测试写错误日志的噪音也一并去掉。
- `0.5.40` 远端缺失的插件配置条目现在会自动创建：- `0.5.40` 远端缺失的插件配置条目现在会自动创建：插件已装、远端又没有同 id/同名的条目时，往 profile 的 `cordis.patch.yml` 追加一条并重启一次生效；已有条目仍然只更新、不复制。
- `0.5.39` 同步插件配置的范围改为「本机与远端都装了的可移植插件 + 本次新装的插件」；- `0.5.39` 同步插件配置的范围改为「本机与远端都装了的可移植插件 + 本次新装的插件」；远端运行包重建以带上配置写入接口（`/api/ssh-remote/plugins/config`）。
- `0.5.38` 插件装完后同步它自己的配置：- `0.5.38` 插件装完后同步它自己的配置：只同步本次升级动过的插件——配置条目（经配置编辑器写回，远端先备份，密钥和本机路径不上送）和设置命名空间；配置同步失败报 `UPGRADE_CONFIG_FAILED`，已装好的插件保留。
- `0.5.37` github 等源安装的插件参与差异比对- `0.5.37` github 等源安装的插件参与差异比对：远端清单里记录的安装 spec 与本机不同（同一版本也可能是不同 commit）就按本机 spec 重装，失败时按原来的完整 spec 回滚；源安装不再进 npm 最新版比对。
- `0.5.36` 修复远端升级把 github 源安装的插件当成 npm 包查最新版、查不到就整次升级判失败- `0.5.36` 修复远端升级把 github 源安装的插件当成 npm 包查最新版、查不到就整次升级判失败（界面显示「无法访问插件 registry，该插件保持原样」）：远端清单里没有 spec 的插件先按 npm 解析，解析不到且还有别的插件能解析时视为非 npm 安装，跳过不动；只有所有插件都解析不到才报 registry 不可用。
- `0.5.35` 修复「同步并升级」点了没反应或报「请求失败 (WORKSPACE_INVALID_REQUEST)」：工作区 SSH 扩展的请求白名单漏了 `/upgrade` 和 `/upgrade/approve`，请求在客户端就被拒了，根本没到远端管理器。白名单补齐，并加了回归测试。
- `0.5.34` 诊断再往前一步：远端路由的所有失败（不止未归类异常）都记进 `~/.dsh/ssh-remote/logs/manager-errors.log`，带 HTTP 方法、路径、错误码和堆栈；界面在错误码没有对应文案时显示「请求失败 (CODE: 远端消息)」，不再吞掉远端给的原因。
- `0.5.33` 远端操作失败不再只显示「请求失败。」：无法归类的错误把 HTTP 方法、路径和堆栈写进 `~/.dsh/ssh-remote/logs/manager-errors.log`（单文件上限 512 KB），界面文案同时给出日志位置；已归类的错误码不写日志。
- `0.5.32` 远端「同步并升级」改为按差异出现：比对本机与 guest 的插件清单（排除 Desktop 独占插件和 link:/file:/本地 tar 包）与 DSH 版本，有差异才显示按钮；升级时把本机有、远端没有的可移植插件一并装到远端，需要构建批准的仍走「批准并重试」。设计见[远端插件同步说明](docs/remote-plugin-sync-design.md)；
- `0.5.31` 修复远端插件页「本机插件」列表为空：本机插件快照只在首次连接和手动同步时上传，Host 重启或换实例后远端内存里的快照丢了，页面就只剩远端自己的插件。现在每次连接、以及升级触发的 Host 重启后都会重新上传；上传失败不影响连接。
- `0.5.30` 远端插件升级在「换版本后第一次启用失败」时重试一次：DSH 在移除旧版本后第一次 enable 仍可能解析到已删除的旧包路径而报 failed，包其实已经装好，再装一次同一版本即成功；此前这会直接判失败并回滚，界面只显示「远端 Host 升级失败」。同时避免回滚时对同一目标反复重试。
- `0.5.29` 本机 Web Host 升级自己批准构建脚本：pnpm 11 因 `ERR_PNPM_IGNORED_BUILDS` 拒绝执行新依赖的构建脚本时，升级把包名写进 profile 的 `pnpm-workspace.yaml`（`allowBuilds`）后重试安装，不再停在“另有 N 个依赖的构建脚本待批准”；profile 显式 `false` 的包不覆盖，仍需人工判断的才会留在提示里。设计见[升级与对齐说明](docs/host-upgrade-design.md)；
- `0.5.27` 拆出 `dsh-workspace-guest` 来宾端包：Desktop 只装宿主端，guest profile 只装来宾端；本机 Web 由宿主端注入兜底，远端运行包内置；来宾页复制按钮增加剪贴板兜底（`writeText` 被拒时改用 `execCommand`），浏览器 guest 的 iframe 委派 `clipboard-write`；
- `0.5.26` 修复 SSH 远程页签的通知不上报：登录重定向会清掉查询参数，嵌入标记改为始终写在 URL fragment 里，远端伴生插件才能安装；
- `0.5.25` 远程 Web 页签的通知改用运行包内置伴生插件：远端 profile 不必安装 Shell，连接补丁自动加载 `guest-notify`；本地页签与本机 Web Guest 的行为不变；
- `0.5.24` 本地与远程 Web 页签的回合结束、等待批准、等待回答、计划待确认透传为 Desktop 原生通知；标题为会话名，正文带场景、细节和页签名，同一会话只保留一条；点击切到对应页签并打开会话。窗口聚焦且正看着该会话时不打扰。设计见[通知透传说明](docs/desktop-notifications-design.md)，验证结果见[通知验证记录](docs/desktop-notifications-validation.md)；
- Desktop 多主机 Guest 基础与切页保活；当前容器仍属中央面板，SSH 尚未接入新的同级页签框架；
- 工作区页签支持拖拽和键盘排序，拖拽时显示跟手副本、原位占位槽和位置过渡；顺序按 profile 存入 Host 存储，重启后重新打开的工作区按记忆位置插入，关闭过的页签保留原槽位。只记顺序，不恢复页签本身；
- 工作区页签支持自定义显示名和五色标记；显示信息按 profile 的页签身份保存，不改写 SSH 主机记录，也不恢复页签本身；
- 页签显示宽度：页签最小/最大宽度 88/360px（窄窗口 72/240px），SSH 连接名份额 60%（窄窗口 50%），`anydev` 这类短名可完整显示；
- `0.5.17` 修复右栏展开按钮消失：右栏 Slot 条目一次渲染异常被槽位核心永久移出后，Shell 有界恢复该条目并重渲染；恢复失败时收起右栏使页头按钮回到可用状态；
- `0.5.20` 取消远端运行包与本机 DSH 版本的绑定：运行包由插件自带，版本不同不再阻止连接，不同运行包的实例独立共存；
- `0.5.21` 新页签页为每个 Web Host 显示 DSH 版本（含还没运行的本机 Web profile），有更新时出现一个升级按钮：本机升 `dsh` 与插件、把 desktop 的插件和配置对齐到 `web` profile；远端换用最新内置运行包并升级插件。本机 profile 启动不再校验 CLI 版本号。设计见[升级与对齐说明](docs/host-upgrade-design.md)；
- `0.5.19` 安装态移除 dsh-context 的赞助广告与插件信息卡：删除 Client 的 recom 模块、头部整列和 Host 的广告路由；未安装该插件时不写文件，版本或布局不认识时保留原样并记录 warning；
- 左侧底部提供 SSH 切换入口，使用公开 `layout.selectPanel()`；
- 插件自带运行包的安装、复用和停止；本机 DSH 版本不要求与远端一致，只作为运行包选择偏好。不同运行包的 Desktop 各自持有独立实例，互不停止；
- 远端运行包更新后，与本机版本不兼容且本机有对应新版本的官方远端插件会自动备份、remove 后 install 到本机版本（restart-required 时重启该 Host），其余插件版本不在自动范围；
- Linux x64/arm64 与 macOS arm64/x64 运行包构建；
- SSH agent、无口令/加密私钥、密码和 keyboard-interactive 认证；
- 严格主机密钥检查、用户确认未知指纹、known_hosts 写入；
- 单跳 ProxyJump 和不经过 shell 的 ProxyCommand argv；
- 远端文件、终端、Agent、插件市场和配置能力；
- 本机插件快照、官方插件启停沿用、一键安装到远程和远端启停/卸载；
- 首次添加时默认同步所有支持的用户配置和已配置 API Key，后续连接不自动同步；
- 覆盖远端已有配置前创建远端私有备份，并提供逐项合并提示词；
- 同步预览、字段差异、冲突确认和未纳管字段保留；
- 远端实例 Supervisor、客户端租约、断线重连和安全空闲策略；
- 远端 DSH Web 可常驻；Desktop 关闭只释放本地客户端，下次连接复用同运行包健康实例；
- 回环端口转发、连接状态、脱敏诊断报告和文本导出。

## 使用

1. 在本地 DSH 中安装并启用 `packages/manager` 插件。
2. 打开左侧 **SSH Remote**。
3. 从本机 OpenSSH 配置中选择一台机器，或输入一个已有主机别名。
4. 首次添加默认同步所有支持的配置。可在高级设置中关闭；不需要逐项选择命名空间或填写 credential refs。
5. 点击连接。首次连接会安装或校验插件自带的远端 DSH 运行包。
6. Desktop 会在当前窗口的远程页签中打开 DSH Web；普通浏览器仍使用整页导航。
7. 在远端插件页分别查看本机快照与远端实时插件，并可一键安装到远程、启停或卸载远端插件。
8. Desktop 切换页签保留 Guest，关闭远端页签才释放该 Guest，不会因此停止远端 Host；普通浏览器可使用远端状态区的 **切换到本地**。

首次添加时默认同步所有支持且已配置的 API Key。凭据通过远端 `credentials.set()` 写入 DSH 管理的 `<DSH_HOME>/.credentials.yaml`，不手写 `.env`，不进入主机记录、普通配置、命令行或日志。后续连接不自动覆盖远端凭据；需要轮换时由用户显式同步。

如果同步会覆盖远端已有用户配置或插件状态，会先在远端 `web` profile 的 `.ssh-remote-backups/` 中创建权限为 `0600` 的备份。管理页提供可复制的逐项处理提示词，供用户在当前远端开新会话决定保留、恢复或合并；提示词不包含配置值或秘密。

## 目录

- `packages/manager`：本地主机管理插件。
- `packages/status`：远端状态、插件/配置同步和返回本地插件。
- `controller`：远端安装、实例管理、Supervisor 和运行包构建。
- `test/p0`、`test/p1`、`test/p2`：单元、集成和真实环境验证。
- `controller/artifacts`：生成的版本化运行包，不纳入源码交付。

## 构建运行包

在 `dsh-workspace-shell/` 下执行：

```sh
node controller/scripts/build-runtime.mjs --platform linux --arch all --libc glibc
node controller/scripts/build-runtime.mjs --platform darwin --arch all
```

构建使用固定 Node、DSH 和 pnpm 版本，校验目标平台原生模块并生成 SHA-256 与元数据。

## 验证

```sh
# 构建并检查管理页 Client
node scripts/build-manager-client.mjs
node scripts/build-manager-client.mjs --check

# 全量具名测试；不自动执行独立 VM／本机实机脚本
node scripts/test.mjs

# 固定 Lima VM 的各阶段真实测试
DSH_SSH_REMOTE_P0_VM=1 node --test test/p0/transport/*.test.mjs
DSH_SSH_REMOTE_P1_VM=1 node --test test/p1/service/vm.integration.test.mjs
DSH_SSH_REMOTE_P2_VM=1 node --test test/p2/transport/*.test.mjs

# Linux x64 独立生命周期验证（会修改专用 VM 的测试目录）
DSH_SSH_REMOTE_P0_VM=1 node test/p0/runtime/lima-smoke.mjs

# macOS arm64 独立生命周期验证（使用临时目录）
DSH_SSH_REMOTE_MACOS_SMOKE=1 node test/p2/runtime/macos-smoke.mjs
```

真实测试只使用专用 Lima VM `dsh-ssh-remote-p0` 或独立临时目录，不使用用户的真实远程主机。

## 当前限制

- 新页签尚未完成 Native 自动点击、截图和视觉验收；当前 Kimi Bridge 未发现这个 GUI 对应的浏览器页签。
- Linux arm64 和 macOS x64 已构建并检查架构，但缺少对应真实机器的生命周期验收。
- musl 尚未完成运行验收。
- ProxyCommand 只支持直接可执行文件与参数，不支持 shell 管道、重定向或 shell 环境展开。
- 单个 ProxyJump 字段只接受单跳；嵌套别名链最多 8 跳。
- 不支持多因素组合认证和服务器要求的过期密码修改流程。
- 真实 Agent、Terminal 和后台任务活动查询尚未接入 Supervisor；活动状态未知时实例保持运行。
