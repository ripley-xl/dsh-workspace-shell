# 工作区框架：第一阶段

## 范围和状态

用户已批准先实现完整页面框架重绘，再做同级多环境页签。允许插件依赖宿主私有 DOM/CSS 和既有运行时能力，但不允许修改 DSH 源码、安装文件或用宿主分叉绕过限制。旧方案中的 public-only 限制、先做页签顺序和等待实施批准的描述，不再适用。

独立插件 @local/dsh-workspace-shell 0.1.0 已在 desktop profile 安装并启用。用户确认已保存输入，并授权本次使用 npm 官方源；修正软件源参数后，安装工具返回 applied。2026-11-03 用户提供当前 macOS 窗口截图，并反馈简单点击各处均正常，第一阶段桌面初验通过。

## 实现

插件临时替换原 root Entry 的 component 引用，而不注销原 Entry。原 children、store、inject、locale、Slot 声明和第三方注册身份保持不变。只通过既有根版本通知触发重新渲染，不创建第二个 React 根，也不替换 html/body。

新框架拥有全窗口网格：公共顶部行、侧栏/主区/右栏内容行、独占实际高度的底部行。sidebar、main、rightbar、shell.bottom、shell.overlay、shell.leading 继续由原绑定的 renderSlot 渲染。没有伪造 Local 首页，没有把 Local 改为 Guest；当前 SSH 管理页和其旧嵌套 Guest 逻辑尚未改动。

保留原布局服务、快捷键、主题服务、Store 和原生标记。Sidebar 和右栏宽度继续写入原 Store；指针捕获、最终位移提交、取消、卸载清理均有测试。常规导航和尺寸变化不重新挂载右栏、底部、浮层。

适配仅声明支持 DSH 0.2.1-rc.5。先验证原 Entry 契约，再从当前框架或已加载样式表确认类名。遇到根竞争或不支持的结构时不抢占。恢复采用 compare-and-swap；被其他插件保留的旧包装器会转发给原组件。渲染异常由自己的 React 边界回退，不能复活已被宿主判错退出的 root。

## 已知边界

第一次启用、还原或重新安装会重挂载界面。Store 不变不等于所有 React 局部状态都能保留：未保存表单、滚动位置、终端交互和旧管理页中的 Guest，需要在实际切换时检查。切换前必须先保存输入。本插件不会发送停止远端 Host/Agent 的操作。

Slot 扩展性不代表与所有私有 DOM 改写插件绝对兼容；其他全页面替换、浮动侧栏和特殊 CSS 插件仍需逐个实测。当前 macOS 的主要区域和常用点击已由用户协助初验；全屏、极窄窗口、快捷键全覆盖、长时间终端和 Windows 标题栏仍未专项验证。

浏览器工具目前缺少 bsk 可执行文件；没有通过其他浏览器控制渠道绕过它。渲染尺寸诊断只能辅助确认挂载，不能代替截图和交互验收。

## 构建与验证

在项目根目录运行：

~~~sh
node scripts/build-shell-client.mjs
node scripts/build-shell-client.mjs --check
node --test test/p2/ui/shell-adapter.test.mjs test/p2/ui/shell-geometry.test.mjs test/p2/ui/shell-frame.test.mjs
node scripts/test.mjs
~~~

根项目的 build:client/check:client 同时覆盖管理器和新框架。注册语义测试使用固定版本的已发布 @deepseek-ai/dsh-client-ui-slots 开发依赖，不依赖临时下载文件。其内容已与先前下载的同版本参考模块逐字核对一致。

全量回归共 424 项：419 通过、5 跳过、0 失败，包含 54 项新框架测试，覆盖真实 SlotCore、几何/指针控制、真实 React 挂载与回退。已安装、已核对 Client 注册、已检查用户截图并取得常用点击正常的反馈。多环境页签、Guest 常驻控制及远端界面切换尚未完成。框架与 SSH 已是独立包，但通用扩展接口和 SSH 对框架的显式依赖仍待设计；当前框架仍有 SSH 管理入口的临时耦合。
