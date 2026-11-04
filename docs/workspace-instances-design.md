# 工作区 Host 与视图实例设计

Desktop 不多开；Web 支持多视图；TUI 支持多实例，按各自工作目录启动。插件不修改 DSH，也不迁移已有共享数据。

## 身份与生命周期

Profile 表示插件与默认配置，不作为视图唯一键。Web Host 用 profile 区分；TUI runtime 和每个视图都使用独立 ID。调用方可用通用 provider 的显式 key 去重，高层“新开 Web/TUI”每次生成新 key。

Desktop 始终只有不可关闭的 Local；对当前 profile 的 Web 请求返回 Local，不创建副本。Web 允许同一 owner 复用本插件已持有的同 profile Host，并建立多个独立 Guest；不向其它 owner 返回认证 URL。关闭 Web 视图只释放自己的 Guest，Host 保留到显式停止；显式停止 Web Host 成功后，关闭该窗口中使用此 Host 的全部 Web 视图。

TUI 不按 profile 或 cwd 去重。每次打开新建 runtimeId 与 PTY；同 profile 可在不同或相同 cwd 并存。TUI/TUI 不互斥，Web/TUI 互斥；当前 Desktop profile 仍禁止再起 Host。关闭、取消和页面清理按显式 runtimeId 操作，不按 profile 批量终止。正常退出码 0 经输出 ACK 后关闭对应 runtime；异常保留诊断。手动关闭 TUI 页签直接停止该实例。

## 共享与确认

同 profile 的默认设置和插件会共享；默认 DSH_HOME 下的数据也可能共享。实例拥有独立进程不等于账号、历史或文件系统安全隔离。GUI 新建 Web/TUI 不显示额外勾选确认，直接打开即可；Host 内部校验和 Agent 工具确认不变。显式停止 Host、恢复原布局等会中断任务的操作保留确认。

## 适配

包识别及启动参数放在小型 adapter 表中，终端 renderer 与传输不按品牌分叉。当前目标为 dsh-tui 0.18.0 与 Pi TUI 0.5.5。

新建表单默认取触发时活动页签的目录：Desktop/Web 当前会话 cwd，无会话时取选中的 workspace；TUI 取该实例记录的启动 cwd。结果允许手改，异步读取须校验视图/弹窗世代且不覆盖已编辑输入。无法读取时才提示手填，不使用 profile 存储目录或静默猜测。

Web Guest 的有效目录由插件自带的窄 companion 提供。Host 仅在启动自有 Web 进程时通过命令行 `--patch` 加载 companion，不修改目标 profile 或 HOME patch。companion 只读取唯一 mainView 会话的 `projectionValues.workingDirectory`，暴露 `string|null` 的一次性读取函数；父 Desktop 用固定脚本读取该标量，校验 ready、origin、lease、webview 世代和超时。没有可靠值时保持手填。

Web 共用未完成的启动时，每个视图有独立等待者。一个等待者取消不影响其它等待者；最后一个等待者在尚未 ready 时取消才终止启动。Host ready 后关闭视图保留 Host；stopping 的 Host 不复用旧地址。

Web 启动失败且进程句柄已创建时，record 在清理期间保持 stopping。进程 done 与退出检查都结束后才允许后续启动；退出检查失败而 done 尚未到达时仍保留 profile，避免两个 Host 同时占用同一 profile。
