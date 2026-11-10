# DSH Workspace Shell

DeepSeek Harness 的工作区插件：在同一个窗口里开多个页签，本机与远程的 dsh web 工作区并排使用。

## 包结构

| 包 | 安装位置 | 职责 |
| --- | --- | --- |
| `dsh-workspace-shell`（宿主端） | 仅 Desktop 的 `desktop` profile | 页签框架、launcher、SSH 管理、本机 Web/TUI 运行时、Desktop 通知中心、Guest 适配器 |
| `dsh-workspace-guest`（来宾端） | 所有 guest Web profile（本机 `web`、SSH 远端、以后新增的） | 会话状态上报与通知桥、cwd 读取、跨 Host 会话登记与导航、剪贴板兜底；不挂框架 |

宿主端只装在 Desktop；会被当作 Web Guest 打开的 profile 只装来宾端。来宾端 Host 侧提供 `/api/workspace-session-hosts/*` 路由，Client 侧提供 `conversation.input.dock` 的占用提示和打开会话的页面入口。

## 能力

- **工作区页签**：Local 常驻，`+` 打开 launcher，可选本机 profile 的 Web/TUI 或 SSH 主机；支持拖拽排序、自定义名称和五色标记，顺序与外观按 profile 保存。
- **本机 Web/TUI 运行时**：同一窗口内 start/attach 本机 Web Host，关闭页签只释放 Guest；TUI 使用固定同源 iframe，支持多开与独立停止。宿主端启动本机 Web Host 时注入来宾端作为兜底；profile 自己装了来宾端时不再注入。
- **跨 Host 会话导航**：会话被其它 Host 使用时给出提示，一键前往对应页签并带入未发送的文字。
- **Desktop 原生通知**：本地与远程 Web 页签的回合结束、等待批准、等待回答、计划确认透传为系统通知；同一会话只保留一条，点击切到对应页签并打开会话。远程页签由运行包内置的来宾端上报，远端 profile 不必安装插件。
- **剪贴板兜底**：来宾页面的 `navigator.clipboard.writeText` 被权限策略或焦点检查拒绝时，改用临时 textarea + `execCommand('copy')`；浏览器 guest 的 iframe 委派 `clipboard-write`。
- **SSH Remote**：OpenSSH 配置导入、严格主机密钥检查、ProxyJump/ProxyCommand、远端运行包安装与复用、插件快照与一键安装、配置同步与备份。

## 目录

- `packages/shell`：宿主端页签框架、Guest 适配器、通知中心与本机运行时。
- `packages/guest`：来宾端会话登记、通知桥、cwd 与剪贴板兜底。
- `packages/manager`：SSH 主机管理、远端运行时与插件/配置同步。
- `packages/status`：远端运行包内的状态与插件同步插件。
- `controller`：远端运行包构建、实例 supervisor 与 CLI。
- `test`：`p0`/`p1`/`p2` 单元、集成和真实环境用例。
- `scripts`：Client 构建、打包、测试与本地验收脚本。

## 构建

需要 Node 22+ 和 pnpm。

```sh
pnpm install
node scripts/build-shell-client.mjs
node scripts/build-guest-client.mjs
node scripts/build-manager-client.mjs
```

生成发行包（依次产出 manager、guest、shell 三个 tgz）：

```sh
node scripts/package-workspace-bundle.mjs <输出目录>
node scripts/verify-workspace-bundle.mjs <输出目录>
```

## 安装

宿主端装进 Desktop 的 profile：

```sh
dsh plugin --profile desktop add file:<输出目录>/dsh-workspace-shell-<版本>.tgz
```

来宾端装进每个 guest Web profile：

```sh
dsh plugin --profile web add file:<输出目录>/dsh-workspace-guest-<版本>.tgz
```

远端运行包内置 `plugins/guest`，连接补丁会自动注入，不需要在远端 profile 安装插件。装好后重启 Desktop。

## 验证

```sh
node scripts/test.mjs          # 具名测试
node scripts/build-shell-client.mjs --check
node scripts/build-guest-client.mjs --check
node scripts/build-manager-client.mjs --check
```

设计与验收说明见 [`docs/`](docs/)。

## 许可

MIT，见 [LICENSE](LICENSE)。
