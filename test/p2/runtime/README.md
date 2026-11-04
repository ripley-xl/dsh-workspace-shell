# P2 runtime verification

远端运行时的安装逻辑单元测试在 `test/p0/runtime/npm-install.test.js`，manager 侧的 bootstrap 流程在 `test/p1/service/npm-bootstrap.test.js`。

真实主机的端到端验证：连接一台装有 Node.js 22+ 和 npm 的远端主机，打开一个远程页签，确认 DSH 在远端安装、Web 启动并加载认证页面。
