# 宿主端与来宾端拆包

日期：2026-11-09。版本：Shell `0.5.27`、Guest `0.5.27`、manager `0.3.12`。

## 为什么拆

之前一个 `dsh-workspace-shell` 要装进所有 profile：Desktop、本机 Web、SSH 远端。guest profile 因此也带着页签框架、launcher、SSH 管理和本机运行时。这些代码在 guest 里不运行，但会增加依赖、插件冲突面和升级成本。

拆成两个包：

| 包 | 装在哪 | 做什么 |
| --- | --- | --- |
| `dsh-workspace-shell`（宿主端） | 仅 Desktop 的 `desktop` profile | 页签框架、launcher、SSH 管理、本机 Web/TUI 运行时、通知中心、Guest 适配器 |
| `dsh-workspace-guest`（来宾端） | 所有 guest Web profile（本机 `web`、SSH 远端、以后新增的） | 会话状态上报与通知桥、cwd 读取、跨 Host 会话登记/导航与草稿接收；不挂框架、不启动 Host |

## 边界

来宾端 Host 侧：`/api/workspace-session-hosts/*` 路由、view 登记与 command 轮询、状态查询。  
来宾端 Client 侧：`conversation.input.dock` 的占用提示、通知采集与上报、cwd 标量、打开会话的全局入口。

宿主端保留：页签与 Surface、launcher、本机运行时管理、SSH manager 集成、通知中心（把来宾端上报转成系统通知）、Guest 适配器（webview 的 console 通道、`executeJavaScript` 下发导航）。

两端只通过 guest 通道通信，来宾端不知道页签身份，宿主端不读取来宾端会话正文。

## 源码复用

跨 Host 的会话登记代码只有一份，放在 `packages/guest`：

- `session-host/`：Host 路由与 Client 轮询/草稿应用；
- `src/host/session-hosts.js`、`session-views.js`：登记、锁与 view broker。

宿主端通过 `dsh-workspace-guest/session-host` 导入 Host 模块；宿主端 Client 构建时从 `packages/guest/session-host/` 读取同一份 Client 源文件并拼进自己的 bundle。来宾端 Client 由 `scripts/build-guest-client.mjs` 从 guest 包自己的源构建。

## 注入路径

- **本机 Web**：宿主端启动 Web Host 时用 `--patch <guest>/cordis.patch.yml` 注入来宾端。profile 里装来宾端也可以，二者只会加载一次。
- **SSH 远端**：连接补丁在启动远端 Host 时插入 `<runtime>/plugins/guest/index.js`；运行包构建时把整个 `packages/guest` 复制到 `plugins/guest`，远端 profile 不需要安装插件。
- 运行包内不再有 `guest-cwd`、`guest-notify` 两个单独插件，它们的能力并入来宾端。

## 打包

`scripts/package-workspace-bundle.mjs` 依次产出 manager、guest、shell 三个 tgz；shell 的 `dsh-workspace-guest` 依赖在打包时改写成 guest 的 tgz 绝对路径，`@local/dsh-ssh-remote` 同理指向 manager 的 tgz。

`verify-workspace-bundle.mjs` 解包三个 tgz、校验关键文件，并用临时 profile 加载 bundle 组合。

## 迁移

本次只交付包和接线，**没有改任何现有 profile**。迁移步骤：

1. Desktop：装 `dsh-workspace-shell-0.5.27.tgz`（会自动带上 guest 依赖）。
2. `web` 等 guest profile：卸掉旧的 `dsh-workspace-shell`，装 `dsh-workspace-guest-0.5.27.tgz`。
3. 远端：换用带 `plugins/guest` 的新运行包；连接补丁会自动插入来宾端。

迁移前，旧 profile 里的单包 Shell 仍按原方式工作（来宾端标记会阻止两个通知桥重复安装）。

## 测试

- 全量具名测试通过；
- 三个 Client 构建 `--check` 通过；
- 打包后 `verify-workspace-bundle.mjs` 通过；
- 来宾端 cwd 与通知桥有独立单测（`test/p2/ui/shell-guest-cwd.test.mjs`、`shell-guest-notify.test.mjs`）。
