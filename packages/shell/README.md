# dsh-workspace-shell

DeepSeek Harness 工作区插件：同一个窗口里开多个页签，本机与远程的 dsh web 工作区并排使用。

页签栏、launcher、本机 Web/TUI 运行时、跨 Host 的会话登记和 SSH 远程工作区都在这个包里，安装这一个包即可。

## 安装

在 DSH 的插件页安装 `dsh-workspace-shell`。插件随 profile 生效，不需要改 DSH 源码。

## 目录

- `index.js`：Host 侧入口，本机运行时服务、HTTP 路由和 `workspace_runtime` 工具。
- `client.js`：渲染页签栏和 frame 的 Client 半。
- `session-host/`：跨 Host 的会话登记。
- `ssh-remote/`：SSH 主机管理、远端运行时安装和远端 Web Guest。
- `guest-cwd/`：注入到 Web Guest 的窄 companion，只读取当前主会话的工作目录。

## 文档

- [根目录 README](../../README.md)
- [工作区页签与本地/SSH 工作区](../../docs/local-workspace-tabs.md)
