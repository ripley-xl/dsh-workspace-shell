# P2 macOS runtime verification

`macos-smoke.mjs` 只在本机 macOS arm64 上运行。它使用 `test/p2/runtime` 下的独立临时 root、DSH_HOME 和 HOME，完成真实运行包安装、pnpm 检查、Web 启动/attach、认证页面、租约、未知活动状态保护和停止/卸载。

```sh
node ../../../controller/scripts/build-runtime.mjs --platform darwin --arch all
node macos-smoke.mjs
```

脚本不读取或修改用户现有 DSH profile，不连接 SSH 主机，也不启动 sshd。darwin-x64 包只在本机构建并检查产物架构；真实 x64 生命周期需要 Intel Mac 或可信的隔离 x64 环境。
