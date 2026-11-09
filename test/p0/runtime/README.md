# P0 runtime tests

- `controller.test.js`：协议、摘要、归档路径、manifest 和安装锁单元测试。
- `supervisor.test.js`：使用临时假 Host 验证 detached Supervisor、租约、脱敏日志、patch 参数、Host 内 `spawn pnpm`、优雅停止，以及默认 `unknown` 活动状态阻止空闲退出、注入 `inactive` 后允许空闲退出。
- `lima-smoke.mjs`：在固定隔离 VM `dsh-ssh-remote-p0` 中安装真实 Linux x64 包，验证 pnpm 包装和 `dsh plugin --profile web --version`，启动 DSH Web，读取认证页面并验证停止和卸载。
- `verify-http.mjs`：由 Lima 脚本调用，从私有实例记录读取认证 URL，只输出 HTTP 状态和页面检查结果。

运行真实 VM 测试前先生成 x64 运行包：

```sh
node ../../../controller/scripts/build-runtime.mjs --arch x64
node lima-smoke.mjs
```

测试不会读取 `~/.ssh/config`，也不接受改用其他主机的参数。
