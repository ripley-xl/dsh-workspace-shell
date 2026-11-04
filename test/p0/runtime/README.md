# P0 runtime tests

- `controller.test.js`：协议、摘要、归档路径、manifest 和安装锁单元测试。
- `supervisor.test.js`：使用临时假 Host 验证 detached Supervisor、租约、脱敏日志、patch 参数、Host 内 `spawn pnpm`、优雅停止，以及默认 `unknown` 活动状态阻止空闲退出、注入 `inactive` 后允许空闲退出。
- `npm-install.test.js`：远端 npm 安装路径，覆盖缺 Node、Node 过旧、缺 npm 和正常安装写 manifest/receipt。

真实主机的端到端验证见仓库根 README 的“远端运行时”一节。
