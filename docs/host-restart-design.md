# Web Host 自重启与来宾上报

日期：2026-11-10。目标版本：Guest `0.6.0` / Shell `0.5.35`。状态：设计定稿，实现中。

## 1. 现状：Host 是怎么被管理的

三种 Host，三套管理方式，都不认「不是自己启动的 Host」。

**本机 Web Host**（Desktop 里的 Web 页签）。Shell 运行在 `desktop` profile，`packages/shell/src/host/local-runtimes.js` 用 `subprocess.spawn` 直接拉起
`dsh --profile <id> --no-open --host 127.0.0.1 --port 0`，把它当子进程：

- 从 stdout 解析 `dsh web: <url>`（含 token）拿到页面地址；
- 内存里存一条 record（`runtimeId` 是 Shell 生成的 UUID，外加 `phase`/`url`/`exit`），不落盘；
- 按 `ownerId`（客户端租约）判权限，同一 profile 只允许一个活跃 Host（`PROFILE_HOST_CONFLICT`）；
- 子进程退出 → 记录 `exited`，不再有别的信息源。

所以这条链路只在「Shell 自己的子进程活着」时成立：Host 一旦被外部重启，Shell 手上的 record 就指向一个死进程，新进程不可见、不可 attach、不可 stop——这就是「重启后没法管理」。

**远端 Web Host**（SSH）。走 `controller/src`：`startInstance` 先起 supervisor（`instanceId` = UUID），supervisor 再拉起 Host；实例有 `record.json`、租约文件、健康检查，`attach` 用最新 `instanceId` + 认证 URL。重启由 controller 编排，重启后必须重新 `attach`（见 `docs/ssh-remote-design.md:421`）。

**来宾注册**（已存在的上报机制）。`packages/guest/src/host/session-hosts.js` 让每个 Guest Host 在
`/tmp/dsh-workspace-<uid>-<sha256(DSH_HOME)[:16]>/<instanceId>.sock` 上开一个 Unix socket（`0700` 目录、`0600` socket），对端靠列目录 + `inspect`/`attach` 互问。`instanceId` 每次启动随机生成，只用于「会话归属」，不承担 Host 生命周期。

结论：能力已经有了，缺的是 Host 生命周期这一层上报，以及 Shell 侧的发现与接管。

## 2. 目标与非目标

目标：

1. Web profile 里的 Host 能自己重启（产品面参考 `dsh-restart-now`，编排原理参考 `dshmarket`）。
2. 重启不破坏 Shell 的管理：Guest 主动上报 Host 卡，Shell 发现、接管、恢复页签。
3. 不是 Shell 启动的 Host（终端里 `dsh web`）也能被 Shell 接管。
4. 受 controller 管理的 Host 禁止自重启（supervisor 已经管着它，两边同时动手会打架）。

非目标：

- 不改动远端 controller 的实例模型（只加一个环境标记）。
- 不做跨机器上报（远端 Host 的卡只落远端 DSH_HOME）。
- 不恢复会话、不搬运行中的 Agent。

## 3. 架构

```
┌─ Shell (desktop Host) ─────────────────┐        ┌─ Guest Host (web profile) ────────┐
│ host-discovery.js                      │        │ host-card.js                      │
│  读 <DSH_HOME>/workspace-hosts/*.json  │◀───────│  启动写卡、5s 心跳、退出删卡      │
│  校验 uid/权限/pid/心跳/url            │  文件  │  instanceId / hostKey / pid / port│
│ local-runtimes.js                      │        │  / url / argv / supervised        │
│  启动时注入 DSH_WORKSPACE_HOST_KEY     │        │                                   │
│  退出后同 hostKey 新卡 → 接管          │        │ host-restart.js                   │
│                                        │        │  POST /api/workspace-host/restart │
│                                        │        │  → 独立助手：等端口释放 → 重启    │
└────────────────────────────────────────┘        └───────────────────────────────────┘
```

上报走文件（跨平台、Shell 不必先知道端口），live 判定走 `pid` + 心跳。Unix socket 的会话协议不变。

## 4. 数据契约

### 4.1 Host 卡

目录 `<DSH_HOME>/workspace-hosts/`，权限 `0700`；文件 `<instanceId>.json`，权限 `0600`，原子写（`<name>.tmp` → rename）。

```jsonc
{
  "version": 1,
  "instanceId": "a1b2…",        // 32 hex，每次启动随机
  "hostKey": "profile:web",     // 稳定逻辑身份：Shell 注入 DSH_WORKSPACE_HOST_KEY，否则 profile:<name>
  "profile": "web",
  "pid": 62430,
  "port": 62430,
  "url": "http://127.0.0.1:62430/?token=…",  // 认证 URL（ctx.connection.authenticatedUrl）
  "startedAt": "2026-11-10T06:57:45.000Z",
  "heartbeatAt": "2026-11-10T06:57:50.000Z",
  "supervised": false,          // true = controller 管着，禁止自重启
  "cwd": "/Users/…",
  "argv": ["/path/node", "…/bin.js", "--profile", "web"],
  "dshVersion": "0.2.2-rc.1",
  "guestVersion": "0.6.0"
}
```

失效判定（Shell 侧）：`version !== 1`、字段类型不符、`url` 不是本机回环、`pid` 不存活、`heartbeatAt` 超过 30s 且 pid 不存活 → 忽略；`supervised` 为真只影响重启，不影响接管。

### 4.2 回执

`<profileDir>/.workspace-host-restart.json`，`0600`。助手写，新 Host 启动后读：

```jsonc
{ "at": "…", "ok": true, "pid": 1234, "port": 62430, "url": "http://…", "error": null }
```

新 Host 的 `/api/workspace-host/status` 回传它，界面显示「上次重启：成功，停机约 N 秒」或失败原因。

## 5. 路由契约（Guest Host）

前缀 `/api/workspace-host`。全部要求同源（`Origin` 缺省或与本 Host 同 authority），并复用 DSH 的 cookie 鉴权。

| 路由 | 方法 | 入参 | 出参 |
| --- | --- | --- | --- |
| `/status` | GET | — | `{ ok, supervised, busy: {tasks, jobs}, cooldownMs, lastRestart }` |
| `/restart` | POST | `{ mode: "now"\|"wait"\|"cancel", force?: boolean }` | `{ ok, mode, startedAt }` / `{ ok:false, code }` |

错误码：`HOST_RESTART_DISABLED`（`allowRestart: false`）、`HOST_RESTART_SUPERVISED`、`HOST_RESTART_BUSY`（`force` 可越过）、`HOST_RESTART_COOLDOWN`、`HOST_RESTART_UNAVAILABLE`。

等待模式：Host 每 5s 复检活跃任务，安静即派发；30 分钟封顶，封顶时按强制处理。

## 6. 重启编排（助手）

与 `dshmarket` 相同的是「重放原始启动调用」，不同的一点是**优先保住端口**：DSH 的登录 cookie 绑定 `authority`（`127.0.0.1:<port>`），换端口就等于换站点，页签必须重新导航。所以：

1. Host 写请求文件到 `tmpdir`：`pid`、`port`、`argv`、`cwd`、`env`（过滤掉 `DSH_SESSION_ID`/`DSH_WEB_URL`/`DSH_SHELL`/`ELECTRON_RUN_AS_NODE`）、回执路径、健康检查地址。
2. detached 派生助手（`process.execPath` + helper.js，`stdio: ignore`），Host 自己不退出，等助手 ack 后再被结束。
3. 助手：等 Host 退出（10s，超时 SIGTERM，再 5s SIGKILL）→ 等端口释放（`net.connect` 失败，10s）→ 用 `--port <旧端口>` 重放 argv（`--port 0` 或缺失时补上）→ 轮询健康（任意 HTTP 响应即算起来，401 也算）→ 写回执。
4. 端口被占导致新 Host 起不来 → 退化为 `--port 0` 再试一次，回执里带新 URL。
5. 冷却 5s，跨进程用回执时间判定。

## 7. Shell 接管

- 启动：spawn 时注入 `DSH_WORKSPACE_HOST_KEY=<runtimeId>`，Host 卡带上这个 key，绑定精确。
- 运行：`startWeb` 以卡片为准（`url` 一致），stdout 解析保留为兜底（旧 Guest 没有卡片）。
- 退出：record 进入 `restarting`，最多等 20s；出现同 `hostKey` 的新卡 → 更新 `pid/port/url`、`phase: running`、`notify`，页签按新 URL 重新导航；否则回到 `exited`。
- 发现：`catalog` 增加 `source: "discovered"` 的行（不是 Shell 起的 Host，无 owner）。可以 attach、可以打开页签，不能 stop/upgrade。
- 页签：runtime URL 变化时，`profile-ui` 页签重设地址（保留页签身份、顺序与外观）。

## 8. 客户端（Guest 页）

0.6.2 起重启入口只在工作区页签：Web Host 页签右键给「等空闲后重启」「立即重启」两项，Guest 页面没有任何重启按钮。入口细节见 [页签右键重启](/Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/tab-restart-menu-design.md)。

Guest 页面保留的是执行与状态：收到页签命令后查 `/api/workspace-host/status`，`supervised` 或 `allowRestart: false` 时直接返回错误码；否则 `POST /api/workspace-host/restart`，成功后显示「正在重启」覆盖层并每 2s 探测 `GET /`，端口没变（cookie 仍在）就自动 reload。

0.6.1 及更早版本用侧栏底部按钮和设置页一行作为入口，并弹确认层；那两处入口在 0.6.2 删除。

## 9. 安全

- 卡片目录 `0700`、文件 `0600`、`uid` 必须是本进程用户；含认证 URL，按凭据对待，不写日志。
- 重启路由：只接受同源请求；`Origin` 存在且不同 authority 一律 403；`supervised` 一律拒绝。
- 助手请求文件放私有 tmp 目录（`0700`），用完删除。
- Shell 只接管本机回环 URL。

## 10. 平台与限制

- Windows 无 Unix socket，会话协议本就不可用；卡片走文件，Windows 可用。`process.kill(pid, 0)` 在 Windows 可用。
- 浏览器里点重启后，若端口变化且用户没拿到新 URL，旧页面不可恢复；终端启动的 Host 会在终端打印新地址。
- 同一 profile 同时只允许一个活跃 Host 的约束不变。

## 11. 测试

- `host-card`：原子写、心跳刷新、退出删除、pid 失效、权限与 uid。
- 助手：端口等待、端口复用、EADDRINUSE 退化、回执内容。
- `host-discovery`：脏卡、过期卡、越权 URL、跨 profile 去重。
- `local-runtimes`：注入 key、退出后接管、超时回落 `exited`、发现行不参与 stop。

## 12. 实现落点

| 文件 | 职责 |
| --- | --- |
| `packages/guest/src/host/host-card.js` | 写卡、心跳、私有目录校验、退出删除 |
| `packages/guest/src/host/host-restart.js` | 端口改写、回执、助手脚本、派发与等待编排 |
| `packages/guest/src/host/host-activity.js` | 活跃任务与安装锁探测 |
| `packages/guest/session-host/index.js` | `/api/workspace-host/status`、`/api/workspace-host/restart` 两条路由 |
| `packages/guest/src/host-restart-control.js` | 页签命令通道、状态校验、「正在重启」覆盖层、重启后轮询与 reload |
| `packages/shell/src/host/host-discovery.js` | 卡片校验、存活判定、同身份去重 |
| `packages/shell/src/host/local-runtimes.js` | 注入 `DSH_WORKSPACE_HOST_KEY`、退出后等待新卡接管、发现行、`attachDiscovered` |
| `packages/shell/src/host/routes.js` | `/web/attach-discovered` |
| `controller/src/supervisor.js` | 远端 Host 注入 `DSH_WORKSPACE_SUPERVISED=1` |

实测（2026-11-10，macOS arm64，Guest 0.6.0）：`POST /api/workspace-host/restart` 返回 200 后约 3 秒新 Host 在原端口起来，回执写入 `~/.dsh/profiles/web/.workspace-host-restart.json`（含新 token URL），重启前的登录 cookie 仍然有效（`GET /` 返回 200），新卡随启动写入。

未做：远端 controller 侧的 Host 卡不上报（远端卡只在远端 DSH_HOME 内，不跨机器）；浏览器在端口变化时仍要人工取新地址。

## 13. 拓扑约束（0.6.1 修订）

两个包的分工是硬的：

- `dsh-workspace-shell` 只装 Desktop 的 `desktop` profile；
- `dsh-workspace-guest` 只装 guest Web profile。

Desktop 的 Shell 会直接 `import 'dsh-workspace-guest/session-host'`（为了跨 Host 会话登记），所以 **`session-host/` 里不能有任何 guest 专属职责**。Host 卡、`/api/workspace-host/*` 路由都放在 guest 包入口 `packages/guest/index.js` 调用的 `applyHostLifecycle()`（`src/host/host-lifecycle.js`），只有 guest Web Host 会加载：

| 代码 | 谁会跑 |
| --- | --- |
| `session-host/index.js` | Desktop（经 Shell import）+ guest Web Host |
| `index.js` → `applyHostLifecycle` | 只有 guest Web Host |
| `client.js`（客户端入口 UI） | 只有 guest Web Host 的页面 |

把 guest 作为 **bundle** 启用到 `desktop` profile 会造成 `workspaceSessionHosts` 重复 `provide`，宿主直接崩（实测过一次）。guest 包可以以依赖形式存在于 desktop（Shell 用它解析 `cordis.patch.yml` 路径，给 Shell 启动的本机 Web Host 兜底注入），但**绝不能进 `dsh.profile.bundles`**。

`applyHostLifecycle` 里的 `profileContext.name === 'desktop'` 判断是兜底，不是设计：正确拓扑下 Desktop 根本不会加载这段代码。

## 14. web/open 改走 guest（0.5.46）

顺序：同步并更新 → **web/open 切 guest** → 拆 controller。本节是第二步。

`webOpen` 在有 SSH 通道时先走 guest：

1. 该 profile 已有存活、非受管的上报卡片 → 直接接管（复用/新建回环转发，URL 只换 host:port）；
2. 没有卡片 → 用远端自己的 `node` + `dsh`（优先取同 profile 已有卡片的 `argv`，退而用登录 shell 的 `command -v node/dsh`）起 `dsh --profile <p> --host 127.0.0.1 --port 0 --no-open`，等新卡片上报后接管；
3. 版本对不上或找不到 `dsh` → 返回 `null`，退回 controller 路径（运行包仍在，这一步还没删）。

`webAttach` / `webStop` 对 guest 实例同样走卡片：attach 复用转发，stop 按 pid 发信号。controller 管住的实例行为不变。

测试覆盖：guest 接管/启动/attach/stop，且断言没有创建 controller 实例（`state.instances` 数量不变）。

## 15. 传输开关（0.5.47）

`web/open`、上报宿主的接管都已走 guest。连接层仍可切换：

- 默认 **guest**：只建裸 SSH 通道（`SshControlChannel`），不装运行包、不起 controller；`session.connected` 判据 = 通道可用。
- `transport: controller`：保留原来的 controller 路径（运行包、status 插件、实例/租约）。

开关位置：插件配置。默认由 `packages/manager/src/host/index.js` 传入 `transport: 'guest'`；要回退，在 profile 补丁里给 `ssh-remote` 条目加：

```yaml
- id: ssh-remote
  name: "@local/dsh-ssh-remote"
  config:
    transport: controller
```

guest 模式下：`connect` 只建通道；`web/list` 的 profile 从远端 `~/.dsh/profiles/*/package.json` 读、运行中的行从卡片生成（`guestProfileHosts`）；`web/open` 只走卡片接管/远端 dsh 启动，不再回退 controller；`upgradeHost` 明确报 `UPGRADE_RUNTIME_UNAVAILABLE`（没有内置运行包可换）。

上述开关已在 0.4.0 随 controller 路径一起删除：`transport` 概念不再存在，manager 只走 guest 通道。
