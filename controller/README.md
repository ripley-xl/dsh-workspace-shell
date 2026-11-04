# SSH Remote Controller

本目录包含 P0 远端运行包构建脚本、Remote Controller 和 Instance Supervisor。

## 构建运行包

构建机需要 Node 22+、npm、可访问 Node.js 和 npm 官方仓库的网络，以及 POSIX `tar`/`gzip`。目标机只需要受支持的 Linux 或 macOS 及 `tar`/`gzip`，不需要预装 Node、pnpm 或编译工具。

```sh
node scripts/build-runtime.mjs --platform linux --arch all --libc glibc
node scripts/build-runtime.mjs --platform darwin --arch all
```

默认在 `controller/artifacts` 生成：

- `dsh-ssh-remote-0.2.1-rc.5-linux-x64-glibc.tar.gz`
- `dsh-ssh-remote-0.2.1-rc.5-linux-arm64-glibc.tar.gz`
- `dsh-ssh-remote-0.2.1-rc.5-darwin-x64-none.tar.gz`
- `dsh-ssh-remote-0.2.1-rc.5-darwin-arm64-none.tar.gz`
- 对应的 `.sha256` 和 `.json` 元数据

运行包固定使用 Node `v24.22.1`、`@deepseek-ai/dsh` `0.2.1-rc.5` 和 pnpm `10.32.1`。Node 下载必须匹配脚本内的 SHA256。npm 使用 `runtime/package-lock.json` 和 `npm ci --os=<platform> --cpu=<arch>`，Linux 另传 `--libc=<libc>`，安装脚本在构建机上也不执行。构建脚本检查 Web 前端资产、平台原生绑定、`node-pty` 预编译文件和 pnpm 实际 CLI，并把 `packages/status` 复制到 `runtime/plugins/status`。`bin/pnpm` 使用包内 Node；Supervisor 把运行包 `bin` 放在 Host PATH 首位。

归档中的目录、文件顺序、uid/gid、mtime 和 gzip 头已固定。相同源码和 lockfile 的重复构建应产生相同 SHA256。

`--arch x64 --libc musl` 使用 Node 官方 musl 运行时可单独构建。Node 官方未提供本版本的 arm64 musl 包，因此脚本会明确拒绝该组合。

## Controller 协议

```sh
bin/dsh-ssh-remote-controller <command> --request-id <id> [options]
```

支持 `probe/profiles/install/list/start/attach/heartbeat/release/status/stop/logs/uninstall`。stdout 始终只有一条 JSON，包含 `protocolVersion`、`controllerVersion`、`requestId`、`ok` 和结果或错误。诊断写 stderr。

默认状态目录为 `~/.dsh/ssh-remote`，可用 `--root` 或 `DSH_SSH_REMOTE_HOME` 覆盖。实例记录和租约文件权限为 `0600`，目录权限为 `0700`。

安装示例：

```sh
bin/dsh-ssh-remote-controller install \
  --package dsh-ssh-remote-0.2.1-rc.5-linux-x64-glibc.tar.gz \
  --sha256 <归档摘要> \
  --expected-version 0.2.1-rc.5
```

启动和接入示例：

```sh
bin/dsh-ssh-remote-controller start --version 0.2.1-rc.5
bin/dsh-ssh-remote-controller attach --instance-id <uuid> \
  --expected-version 0.2.1-rc.5 --expected-build-id <build-id>
```

`start` 可选 `--patch /absolute/path.yml` 与 `--profile <profileId>`。Supervisor 以 `dsh --profile <profileId> --patch <path> --host 127.0.0.1 --port 0 --no-open --trusted-host localhost` 启动 Web：launcher 参数在 app 参数之前，profile 缺省为 `web`。只有 `attach` 返回 `authenticatedUrl` 和 `clientLeaseId`。`list/status/logs` 会脱敏，普通日志不保存完整认证 URL。

实例记录保存 `profileId`。旧记录没有该字段时按 `web` 读取，`list/status/attach` 的 sanitize 输出始终带 `profileId`。`start/list/attach/status` 接受 `--profile`，缺省为 `web`；`list` 只返回该 profile 的实例，`attach/status` 在 profile 不匹配时返回 `REMOTE_PROFILE_MISMATCH`，不会把其它 profile 的实例接入当前视图。

`profiles` 接受 `--dsh-home /absolute/path`（缺省取 `DSH_HOME`，否则 `~/.dsh`），只读取 `<DSH_HOME>/profiles/<id>/package.json`，返回真实声明 `@deepseek-ai/dsh-web-app` 的 profile id，形状为 `{"profiles":["web"]}`。扫描有固定上限：条目 256 个、manifest 1 MiB；符号链接目录、符号链接 manifest、非普通文件、超限或不可解析的 manifest 一律跳过。不读取凭据、Session 或 profile 其它文件。`desktop` 由 Electron 独占，`dsh --profile desktop` 会被 CLI 拒绝，因此不列入结果。

`runSupervisor(options, { activityProvider })` 接受活动查询提供方。提供方返回 `active`、`inactive` 或 `unknown`；默认返回 `unknown`，因此真实 Host 在接入 Agent、终端和后台任务查询前不会自动空闲退出。只有租约为空且提供方明确返回 `inactive` 时才启动空闲计时，停止前会持锁复查两项条件。

## 测试

```sh
node --test ../test/p0/runtime/controller.test.js ../test/p0/runtime/supervisor.test.js ../test/p0/runtime/profiles.test.js
node ../test/p0/runtime/lima-smoke.mjs
node ../test/p2/runtime/macos-smoke.mjs
```

Lima 脚本只使用名为 `dsh-ssh-remote-p0` 的隔离 VM，不读取用户 SSH 配置，也不连接其他主机。
