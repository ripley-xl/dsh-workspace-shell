# 同级环境页签：布局边界核对

> 2026-11-03 更新：独立工作区根框架已安装并通过当前 macOS 截图和用户常用点击初验；未修改 DSH 源码。原有 Slot 声明和服务保留。多环境页签尚未接入；本文旧方案与当前进度冲突时，以[第一阶段记录](</Users/okarinhuang/dsh-workspace/dsh-workspace-shell/docs/frame-redraw.md>)为准。

状态：2026-11-03 用户明确限定只做插件，禁止修改 DSH 源码。此前的布局源码扩展提议已撤回，包括在工作区复制修改宿主源码或通过替换宿主包实施的做法；刚才的授权选项不再有效。未修改 DSH 源码或已安装应用包。界面目标不变，纯插件方案尚未完成验证，本文件不表示当前 Desktop 已支持或通过验收。

## 必须保持的体验

```text
┌ 本地 │ alpha │ beta │ ＋ │ 主机管理 ┐
├───────────────────────────────────┤
│ 当前环境的完整 DSH                 │
│ 自己的侧栏、会话、文件、终端、插件 │
└───────────────────────────────────┘
```

本地是永久存在的同级页面，不是退出远端模式的按钮。切到本地后，共用页签栏不消失；切到远端后，也没有本地侧栏、管理卡片或第二层工作区包在外面。

## ds-bot 证明了什么

已阅读已安装 ds-bot 的界面切换实现，而非只看 Slot 名称：

- `groupsFor` 和 `surfaceGroups` 管理 shell、conversation 两组注册，按模式安装或撤销。
- shell 组替换侧栏、品牌、设置入口，安装全窗浮层；conversation 组替换页头、消息和输入区。
- 切回 Agent 模式后撤销这些注册和样式，恢复原有界面贡献。

这证明插件能切换一整套 DSH 界面。它不是“只能在中央面板里显示”。可参考的重点是成组注册／撤销、独立窗口状态、入口与资源生命周期分离。

但这段实现没有在原始 AppFrame 外分配一行永久页签栏，也没有把两个完整 AppFrame 放进同级页面。它的一些几何计算还查询宿主类名片段；这些私有选择器不会复制进 SSH Remote。

源码位置：[界面组切换](</Users/okarinhuang/.dsh/profiles/desktop/node_modules/ds-bot/client.js#L11360-L11420>)、[整组 Slot 注册](</Users/okarinhuang/.dsh/profiles/desktop/node_modules/ds-bot/client.js#L21366-L21442>)、[切换时协调和卸载](</Users/okarinhuang/.dsh/profiles/desktop/node_modules/ds-bot/client.js#L21492-L21535>)。

## 当前已检查的布局能力

| 入口 | 实际边界 | 对同级页签的限制 |
| --- | --- | --- |
| `main` | 侧栏选中的中央面板 | 不包含本地侧栏、右栏和整窗浮层，选中项切换会卸载组件 |
| `shell.overlay` | 整窗覆盖层 | 可以覆盖整窗，但不会为下方原始界面分配顶部空间 |
| `shell.bottom` | 列布局下方的全宽行 | 分配的是底部空间，不是所需的顶部页签行 |
| `shell.leading` | macOS 侧栏完全收起时的左上角窗口控制位 | 有现有占用且条件挂载，不能当作永久全宽页签栏 |
| `layout` | 面板导航及侧栏／右栏动作 | 当前没有整窗顶部留位或环境内容区展示控制 |

原生窗口留白也不是一块空闲的通用页签区域。macOS 侧栏顶部包含收起按钮，会话页顶部包含拖动区和会话控制；普通 Web 也没有同样的原生窗口区域。直接把页签压上去，会遮住本地操作。

证据：[布局渲染](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js#L309-L358>)、[公开 Slot 声明](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js#L623-L653>)、[窗口留白契约](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/README.md#L36-L43>)。

静态源码之外，已再次只读查询运行时 `layout` Service 和 `shell.overlay` Slot：前者仍提供面板导航及侧栏／右栏动作，后者仍是跨列浮层，未提供顶部留位或原始本地内容区的展示控制。这与上述源码边界一致，不是 Desktop 视觉验收。

结论限定为：在不私改宿主 DOM／CSS、不替换根节点、不另建本地 Guest 的约束下，当前检查到的扩展入口没有提供所需的顶部行和同级内容边界。

## 已撤回的布局源码扩展提议（不执行）

用户已禁止修改 DSH 源码。以下保留此前提议的能力清单，仅供理解界面要求，不是待授权或待实施任务，也不是已存在、可以直接调用的 Service 或 Slot：

1. 布局拥有者分配一行始终挂载的全宽页签区域，实际占用高度，不覆盖本地内容。
2. 页签下方提供独立内容边界。原始本地 AppFrame 保持同一 React 子树，不因环境选择而重建、移动 DOM 或重置导航。
3. 远端 Guest 由插件拥有，在这个内容边界里与本地页面并列。普通切换只改变可见性和输入资格。
4. 本地浮层、底栏、右栏全屏内容必须仍属于本地页面，不能盖到其他环境或公共页签栏上。
5. macOS 交通灯、Windows 窗口按钮及拖动区由外壳协调；不能通过猜测宿主 CSS 类名处理。
6. 插件释放贡献后，原始本地页面继续可用；远端 Host 不随本地 UI 卸载而停止。

此源码扩展提议不再执行。后续只能使用插件公开扩展，不复制修改宿主源码、不替换宿主包，也不把缺失接口写成虚构的公开调用。

## 已可独立推进的代码

- [远端插件界面](<../packages/status/client.js>)已重写为双页签、搜索和紧凑列表。嵌入模式只保留会话级布尔标记，隐藏会在 Guest 内导航到本地的按钮。
- [现有管理 Client](<../packages/manager/client.js>)已修复 Guest 重试、新地址、关闭重开后的旧回调、成功同步备份信息丢失，并附加嵌入标记。这些修复不等于完成新的整窗布局。
- [窗口级环境状态](<../packages/manager/src/client/environment-state.js>)已由插件上下文持有并接入主机选择和备份通知。页签、私有地址和连接世代接口已有状态测试，尚未接到实际 Guest 生命周期或同级布局。
- [浏览器连接回归](<../test/p2/ui/browser-connect-review.test.mjs>)验证跳转前可复制备份指令、取消和旧回调保护，以及页面卸载后不再跳转。导航和原生组件仍是受控测试边界。
- [React 生命周期测试](<../test/p2/ui/workspace-lifecycle.test.mjs>)运行真实 effects 和协调过程，但 Guest 桥及页面容器仍是测试边界，不证明实际绘制。

## 不会用作替代的方案

- 放大管理页里的 webview。
- 切到本地时撤掉页签栏，回到另一套无页签的界面。
- 用浮动页签遮住原始本地顶部按钮。
- 新建一个本地 Guest，替换原本的 Desktop 界面、导航状态和能力。
- 使用宿主私有 CSS 选择器、搬动其他插件的 DOM 或替换应用根节点。

## 最终验收

必须在实际 Desktop 验证：本地／两个远端共用同一条页签栏；原本的本地会话、滚动和输入不丢失；远端侧栏、文件、终端及插件页完整；打开主机管理不销毁 Guest；缩放没有双层边框、溢出或遮挡；失败和重试不自动跳到本地；关闭页签只释放本地资源；退出本地应用后远端 Host 可复用。

单元测试、Slot 注册成功、插件安装成功或独立预览页面，都不能替代这项验收。
