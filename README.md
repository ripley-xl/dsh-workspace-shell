# DSH SSH Remote

SSH Remote 在本地和远程 DSH Web 之间切换。Desktop 使用当前窗口内的沙箱 Webview；普通浏览器使用整页导航。两种形态都不在同一页面混合两端插件、配置或 Session。

**工作区框架正在进入本机多 profile 阶段。** 0.2.0 源码已接入常驻 Local、Web/TUI 同级页签、provider 接口及运行时工具；已应用更新，用户重开后确认新版入口可见；真实 Web/TUI 启动与切换尚待验收，见[本机页签说明](</Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/local-workspace-tabs.md>)。旧版框架的 macOS 初验记录仍见[第一阶段记录](</Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/frame-redraw.md>)。SSH 管理器尚未迁入新框架，旧 Guest 仍在中央面板。

已接入窗口内的主机选择与备份通知：管理页面卸载后仍保留每台主机最近一次待检查的备份元数据，插件卸载或页面重载时清空。备份记录不含凭据值或认证地址；Guest 仍未移出中央面板。

实现依据见[设计说明](<docs/ssh-remote-design.md>)，当前测试范围见[验证记录](<docs/ssh-remote-p2-validation.md>)。

## 已实现

- Desktop 多主机 Guest 基础与切页保活；当前容器仍属中央面板，SSH 尚未接入新的同级页签框架；
- 工作区页签支持拖拽和键盘排序，拖拽时显示跟手副本、原位占位槽和位置过渡；顺序按 profile 存入 Host 存储，重启后重新打开的工作区按记忆位置插入，关闭过的页签保留原槽位。只记顺序，不恢复页签本身；
- 工作区页签支持自定义显示名和五色标记；显示信息按 profile 的页签身份保存，不改写 SSH 主机记录，也不恢复页签本身；
- 页签显示宽度：页签最小/最大宽度 88/360px（窄窗口 72/240px），SSH 连接名份额 60%（窄窗口 50%），`anydev` 这类短名可完整显示；
- `0.5.17` 修复右栏展开按钮消失：右栏 Slot 条目一次渲染异常被槽位核心永久移出后，Shell 有界恢复该条目并重渲染；恢复失败时收起右栏使页头按钮回到可用状态；
- 左侧底部提供 SSH 切换入口，使用公开 `layout.selectPanel()`；
- 本地版本驱动的远端运行包安装、复用、升级和停止；远端 Host 落后时自动升级到本机版本，本机 DSH 落后于远端时拒绝连接并提示先更新本机；
- 远端 DSH 升级后，与本机版本不兼容且本机有对应新版本的官方远端插件会自动备份、remove 后 install 到本机版本（restart-required 时重启该 Host），其余插件版本不在自动范围；
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
- 远端 DSH Web 可常驻；Desktop 关闭只释放本地客户端，下次连接复用同版本健康实例；
- 回环端口转发、连接状态、脱敏诊断报告和文本导出。

## 使用

1. 在本地 DSH 中安装并启用 `packages/manager` 插件。
2. 打开左侧 **SSH Remote**。
3. 从本机 OpenSSH 配置中选择一台机器，或输入一个已有主机别名。
4. 首次添加默认同步所有支持的配置。可在高级设置中关闭；不需要逐项选择命名空间或填写 credential refs。
5. 点击连接。首次连接会安装或校验与本地完全匹配的远端 DSH 运行包。
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
