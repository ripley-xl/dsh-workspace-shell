# DSH Workspace Shell

DeepSeek Harness 的工作区插件：同一个窗口里开多个页签，本机与远程的 dsh web 工作区并排使用。

一个包包含全部能力：页签框架、launcher、本机 Web/TUI 运行时、跨 Host 的会话登记，以及 SSH 主机管理、远端运行时和远端 Web Guest。SSH Remote 在本地和远程 DSH Web 之间切换：Desktop 使用当前窗口内的沙箱 Webview，普通浏览器使用整页导航；两种形态都不在同一页面混合两端插件、配置或 Session。

## 安装

在 DSH 插件页安装 `dsh-workspace-shell`。SSH 远程的远端运行时由插件在连接时用 npm 安装，远端需要 Node.js 22+ 和 npm。

主机选择、备份通知和跨 Host 会话登记的行为见[组件设计](<./docs/ssh-workspace-component-design.md>)与[工作区页签设计](<./docs/local-workspace-tabs.md>)。

## 功能

- 同窗口多页签：Local、本机 Web、TUI 和 SSH 远程 Guest，切页保活、关闭释放；
- 左侧底部 SSH 入口：主机列表、连接状态和远程页签；
- 跨 Host 会话登记与跳转；
- 远端运行时按本机 DSH 版本在远端 npm 安装、复用、升级和停止；
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

1. 在 DSH 插件页安装并启用 `dsh-workspace-shell`。
2. 打开左侧 **SSH Remote**。
3. 从本机 OpenSSH 配置中选择一台机器，或输入一个已有主机别名。
4. 首次添加默认同步所有支持的配置。可在高级设置中关闭；不需要逐项选择命名空间或填写 credential refs。
5. 点击连接。首次连接会在远端用 npm 安装与本机版本一致的 DSH（需要远端有 Node.js 22+ 和 npm）。
6. Desktop 会在当前窗口的远程页签中打开 DSH Web；普通浏览器仍使用整页导航。
7. 在远端插件页分别查看本机快照与远端实时插件，并可一键安装到远程、启停或卸载远端插件。
8. Desktop 切换页签保留 Guest，关闭远端页签才释放该 Guest，不会因此停止远端 Host；普通浏览器可使用远端状态区的 **切换到本地**。

首次添加时默认同步所有支持且已配置的 API Key。凭据通过远端 `credentials.set()` 写入 DSH 管理的 `<DSH_HOME>/.credentials.yaml`，不手写 `.env`，不进入主机记录、普通配置、命令行或日志。后续连接不自动覆盖远端凭据；需要轮换时由用户显式同步。

如果同步会覆盖远端已有用户配置或插件状态，会先在远端 `web` profile 的 `.ssh-remote-backups/` 中创建权限为 `0600` 的备份。管理页提供可复制的逐项处理提示词，供用户在当前远端开新会话决定保留、恢复或合并；提示词不包含配置值或秘密。

## 目录

- `packages/shell`：插件本体，页签框架和 SSH 宿主共用一个包。
- `packages/shell/ssh-remote`：SSH 主机管理、远端安装和 Supervisor。
- `packages/shell/ssh-remote/controller`：远端 controller。
- `packages/shell/ssh-remote/plugins`：注入远端的 status 插件；`guest-cwd` 在 `packages/shell/guest-cwd`。
- `test/p0`、`test/p1`、`test/p2`：单元、集成和真实环境验证。

## 远端运行时

第一次连接时，插件通过 SSH 在远端执行 npm 安装运行时，版本取本机正在运行的 DSH 版本。

- 远端需要 Node.js 22+ 和 npm；缺失或版本过低会直接报错，提示用户自行安装。
- 远端需要能访问 npm registry；不能访问时同样报错，由用户解决网络。
- 只安装 DSH 本体和图片处理需要的 sharp 平台包，不安装 LibreOffice 和语音输入的可选大依赖。
- 安装位置在远端 `~/.dsh/ssh-remote/servers/<dsh版本+controller版本+平台>/`，成功后跳过重复安装。

## 验证

```sh
# 重建并检查 Client bundle
node scripts/build-shell-client.mjs
node scripts/build-shell-client.mjs --check

# 全量具名测试；独立 VM 和真实主机脚本不会自动执行
node scripts/test.mjs

# 固定 Lima VM 的传输层真实测试
DSH_SSH_REMOTE_P0_VM=1 node --test test/p0/transport/*.test.mjs
DSH_SSH_REMOTE_P1_VM=1 node --test test/p1/service/vm.integration.test.mjs
DSH_SSH_REMOTE_P2_VM=1 node --test test/p2/transport/*.test.mjs
```

真实测试只使用专用 Lima VM `dsh-ssh-remote-p0`，不使用用户的真实远程主机。
