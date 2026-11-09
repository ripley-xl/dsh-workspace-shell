# DSH Workspace Shell

DeepSeek Harness 的工作区插件：在同一个窗口里开多个页签，本机与远程的 dsh web 工作区并排使用。

## 能力

- **工作区页签**：Local 常驻，`+` 打开 launcher，可选本机 profile 的 Web/TUI 或 SSH 主机；页签支持拖拽排序、自定义名称和五色标记，顺序与外观按 profile 保存。
- **本机 Web/TUI 运行时**：同一窗口内 start/attach 本机 Web Host，关闭页签只释放 Guest；TUI 使用固定同源 iframe，支持多开与独立停止。
- **跨 Host 会话导航**：会话被其它 Host 使用时给出提示，一键前往对应页签并带入未发送的文字。
- **Desktop 原生通知**：本地与远程 Web 页签的回合结束、等待批准、等待回答、计划确认透传为系统通知；同一会话只保留一条，点击切到对应页签并打开会话。
- **SSH Remote**：OpenSSH 配置导入、严格主机密钥检查、ProxyJump/ProxyCommand、远端运行包安装与复用、插件快照与一键安装、配置同步与备份。

## 目录

- `packages/shell`：桌面页签框架、Guest 通道、会话导航与通知采集。
- `packages/manager`：SSH 主机管理、远端运行时与插件/配置同步。
- `controller`：远端运行包构建、实例 supervisor 与 CLI。
- `test`：`p0`/`p1`/`p2` 单元、集成和真实环境用例。
- `scripts`：Client 构建、打包、测试与本地验收脚本。

## 构建

需要 Node 22+ 和 pnpm。

```sh
pnpm install
node scripts/build-shell-client.mjs
node scripts/build-manager-client.mjs
```

生成发行包：

```sh
node scripts/package-workspace-bundle.mjs <输出目录>
```

## 安装

用 DSH 自带的插件命令把发行包装进目标 profile：

```sh
dsh plugin --profile desktop add file:<输出目录>/dsh-workspace-shell-<版本>.tgz
```

装好后重启 Desktop。页签框架、通知和本机 Web/TUI 能力都在 `desktop` profile 生效；需要从 Desktop 打开本机其它 profile 时，也要把同一版本装进对应 profile。

## 验证

```sh
node scripts/test.mjs          # 具名测试
node scripts/build-shell-client.mjs --check
node scripts/build-manager-client.mjs --check
```

设计说明见 [`docs/`](docs/)。

## 许可

MIT，见 [LICENSE](LICENSE)。
