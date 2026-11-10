# DSH SSH Remote

在本地 Desktop 和远端 DSH Web 之间建立连接，把远端 Host 当成当前窗口里的工作区页签使用。远端不需要安装任何运行包：连接走普通 SSH，宿主由远端机器自己的 `dsh` 启动，并靠 Guest 发布的 Host 卡片被本机发现和接管。

**0.4.0 起移除了内置运行包、controller、supervisor 和远端状态插件。** 远端只要求有可用的 `node` 与 `dsh`，版本与本机一致。旧的 `~/.dsh/ssh-remote/` 残留可以在连接行的「⋯ → 清理远端运行包」里删掉。

## 包结构

| 包 | 安装位置 | 职责 |
| --- | --- | --- |
| `dsh-workspace-shell` | 仅 Desktop 的 `desktop` profile | 页签框架、launcher、本机 Web/TUI 运行时、通知中心、Host 卡片发现与接管 |
| `dsh-workspace-guest` | 所有 guest Web profile | 会话状态上报、Host 卡片与自重启、cwd 读取、跨 Host 会话登记 |
| `@local/dsh-ssh-remote` | 由 Shell 作为依赖带入 Desktop | SSH 连接、端口转发、上报宿主的发现/接管/停止/重启/同步/清理 |

## 远端宿主怎么被管理

- 远端 Guest 把身份写成 `<DSH_HOME>/workspace-hosts/<id>.json`（pid、端口、认证 URL、启动 argv，5 秒心跳、退出即删）。
- manager 通过 SSH 读这些卡片：`web/list` 的 profile 从远端 profile 清单读，运行中的行从卡片生成。
- 「新建页签」优先接管已有卡片；没有卡片时用远端 `dsh --profile <p> --host 127.0.0.1 --port 0 --no-open` 启动，等新卡片上报后接管；版本不一致直接报错。
- 每一行的「打开 / 重启 / 停止 / 同步并更新」：重启用卡片里的 argv 原样重放（端口不变，页签不失效）；停止按 pid 发信号；同步并更新用远端 `dsh plugin --profile <p> add` 补齐缺失插件（只升不降、不推本机 `file:`/`link:` 路径），并把本机同名 profile 缺失的配置条目追加到远端 `cordis.patch.yml`，写入前用宿主的 `--dump-config` 校验，失败自动回滚。

## 已实现

- SSH 连接（含 ProxyJump/ProxyCommand、known_hosts、密码/密钥/keyboard-interactive 认证、交互确认）；
- 端口转发（含诊断与被移除功能的兼容记录）；
- 上报宿主的发现、打开、停止、重启、插件与配置同步、旧运行包清理；
- 远端 Web 页签的会话登记、通知透传、标题与外观记忆；
- 本机 Web/TUI 运行时管理（`packages/shell` 的 launcher 路径，未受本次移除影响）。

## 使用

1. 在本地 DSH 安装并启用 `dsh-workspace-shell`（它会带入 manager 与 guest）。
2. 打开左侧 **SSH Remote**，从本机 OpenSSH 配置选择一台机器。
3. 点击连接。**不再安装或校验任何运行包**，只建立 SSH 通道。
4. 在「新建工作区」里打开远端 Web Host：已有宿主直接接管，没有就由远端 `dsh` 启动。
5. 在「其他 Web Host」里对不是本管理器启动的宿主执行打开、重启、停止、同步并更新。

## 目录

- `packages/manager`：SSH 连接、端口转发、上报宿主控制。
- `packages/shell`：Desktop 页签框架与 launcher。
- `packages/guest`：Guest 端上报、Host 卡片、自重启。
- `test/p0`、`test/p1`、`test/p2`：单元、集成和真实环境验证。

## 验证

```sh
# 管理页与 Shell Client
node scripts/build-manager-client.mjs --check
node scripts/build-shell-client.mjs --check

# 全量具名测试
node scripts/test.mjs

# 固定 Lima VM 的传输层真实测试
DSH_SSH_REMOTE_P0_VM=1 node --test test/p0/transport/*.test.mjs
DSH_SSH_REMOTE_P2_VM=1 node --test test/p2/transport/*.test.mjs
```

## 当前限制

- 远端必须有与本机版本一致的 `node` + `dsh`；不再提供跨版本的运行时兜底。
- 没有「远端升级」「设置/凭据同步」「远端插件页」：插件与配置对齐由「同步并更新」承担，且只做缺失补齐与升级，不降级。
- 旧 controller 实例不会自动停止：手动结束远端 `dsh-ssh-remote-controller` 进程后，再用清理动作删除 `~/.dsh/ssh-remote/` 下的运行包、实例和日志。
- 单个 ProxyJump 字段只接受单跳；嵌套别名链最多 8 跳。
- 真实 Agent、Terminal 和后台任务活动查询未接入。
