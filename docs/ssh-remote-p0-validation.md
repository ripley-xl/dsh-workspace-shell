# SSH Remote P0 验证记录

日期：2026-11-02

## 结论

P0 已通过。验证使用专用 Lima VM `dsh-ssh-remote-p0`，没有连接用户 SSH 配置中的真实开发机。

验证环境：

- 本地：macOS，DSH `0.2.1-rc.5`；
- 远端：Linux x86_64，Ubuntu 26.04 云镜像；
- 远端初始状态：没有 Node 或 pnpm；
- 运行包：Node `v24.22.1`、DSH `0.2.1-rc.5`、pnpm `10.32.1`。

## 已验证能力

1. 本地 SSH Remote 管理插件可安装并激活，管理 Slot 已注册。
2. 自包含运行包可在无 Node、pnpm 和编译工具的远端完成安装与自检。
3. 运行包版本和构建标识与本地 DSH 完全一致。
4. SSH 私钥认证、严格主机密钥检查、SFTP、JSON 调用和 direct-tcpip 网关通过真实 VM 测试。
5. 远端 DSH Web Host 脱离启动命令后仍可重新接入。
6. 远端状态与同步插件通过受控 patch 挂载。
7. 远端认证页面通过 SSH 网关返回 HTTP 200。
8. 授权测试 API Key 只写入远端 credentials，响应和报告不包含秘密值。
9. 现有 `@nonamelego/dsh-catppuccin` 插件通过远端插件管理器安装并应用。
10. `ui-theme` 与 `dsh-catppuccin` 配置通过远端 settings 服务同步。
11. 关闭 SSH 通道后，可重新接入原健康实例。
12. 远端实例可优雅停止，使用中的运行包拒绝卸载。

## 自动化结果

- SSH 传输：`45/45` 通过，包括真实 VM 集成测试。
- Controller 与 Supervisor：`10/10` 通过。
- 管理、认证、同步和接入适配层：`16/16` 通过。
- 完整 P0 联调：`8/8` 检查通过。

完整联调的脱敏结果保存在 `ssh-remote/artifacts/p0-report.json`。该文件不纳入源码交付。

## 运行包

| 目标 | 文件 | SHA-256 |
|---|---|---|
| Linux x64 glibc | `controller/artifacts/dsh-ssh-remote-0.2.1-rc.5-linux-x64-glibc.tar.gz` | `277205841ae392283539e2cb89272b5ab0d2b331d33f04e8a464238cf24c693f` |
| Linux arm64 glibc | `controller/artifacts/dsh-ssh-remote-0.2.1-rc.5-linux-arm64-glibc.tar.gz` | `e3fa0fe03bb974e812fa13f91dcf4106e2c49e070c8a8b432278c3b10568d751` |

x64 连续构建两次，归档逐字节一致。两个包内的 Node 和 node-pty 均检查了 ELF 架构。

## 验证命令

在 `ssh-remote/` 下执行：

```sh
DSH_SSH_REMOTE_P0_VM=1 node --test test/p0/transport/*.test.mjs
node --test test/p0/runtime/controller.test.js test/p0/runtime/supervisor.test.js
DSH_SSH_REMOTE_P0_VM=1 node test/p0/run.mjs
```

## 尚未覆盖

- arm64 包只做了构建和 ELF 检查，没有在 arm64 VM 中运行。
- musl 运行包尚未验收；当前 Node 版本没有官方 arm64 musl 产物。
- 浏览器自动截图和点击验证未执行，因为当前环境缺少 `bsk` 可执行文件。
- Supervisor 的真实 Agent、终端和后台任务活动查询尚未完成。P1 必须在活动状态未知时保持实例运行。
- P1 的持久化主机管理、版本升级确认、模板编辑和同步冲突界面仍需实现。
