> **已过时（0.4.0）**：内置运行包、Remote Controller、Supervisor 和远端状态插件已被移除。
> 远端宿主现在由远端机器自己的 `dsh` 启动，靠 Guest 的 Host 卡片被本机发现和接管；
> 本文档保留为历史设计记录，当前实现见 [Web Host 自重启与来宾上报](host-restart-design.md) 与 README。

# 远端插件同步与「同步并升级」

## 目标

本机与远端 Web profile 的插件清单、DSH 版本不一致时，管理页自动给出可执行的入口：行内出现「同步并升级」，用户点击后把远端补齐到与本机一致。

不做：自动执行（不点不动远端）、把本机路径形式的插件推到远端、改本机 profile、给远端降级。

## 差异来源

### 插件清单

- 本机：Desktop profile 的 `pluginManager.listBundles()`。
- 远端：远端 Host 的 `/api/ssh-remote/plugins/list`。

只有「可移植」的本机插件参与比较：

1. `installed === true`；
2. 不是官方 bundle（`official === true`）；
3. 不是 Desktop 独占插件（`dsh-workspace-shell`、`dsh-pet`、`@local/dsh-preset-whale-maid`、`@xmanrui/dsh-im`、`@local/dsh-ssh-remote`，与 shell 的 `EXCLUDED_PACKAGES` 同一份名单，测试断言两处一致）；
4. 能解析出 registry spec（`name@version`）或公开源 spec（`github:`、`git+https:`、`https://github.com/`）。

`link:`、`file:`、本地 tar、绝对路径的安装只在当前机器成立，不参与差异，也不发送到远端。

### DSH 版本

远端实例的 `dshVersion` 对插件内置运行包的最新 `dshVersion`。本机 Desktop 的 DSH 版本只决定运行包偏好，不作为差异：本机 App 升级不会改变远端运行包，拿它比会出现点了按钮也消不掉的差异。

### 官方 bundle

不参与插件差异。官方可选 bundle 走既有的启停同步（快照 + `plugins/official`）。

## 判定

| 情况 | 结论 |
| --- | --- |
| 本机有、远端没有或未安装 | 安装项，spec 用本机可移植 spec |
| 两边都有，本机版本更新 | 升级项，先删旧再装新 |
| 两边都有，`github:` 等源安装的 spec 不同（同一版本也可能是不同 commit） | 升级项，先删旧再按本机 spec 重装 |
| 两边都有，源安装的 spec 相同 | 跳过 |
| 两边都有，远端版本更新 | 跳过，不降级 |
| 版本相同 | 跳过 |
| 官方 bundle、Desktop 独占、本机路径安装 | 跳过 |

## 检测与按钮

- 行内按钮条件：`有更新运行包 || 插件差异非空`。
- 差异结果缓存 60 秒；打开列表、手动刷新、重新连接都触发重算。
- 按钮文案「同步并升级」；检测只读，不改任何远端状态。

## 执行流程

1. 读远端插件清单与当前实例；读不到即中止，不动任何东西。
2. 运行包有更新时先换运行包、起新实例；否则复用当前实例。
3. 把远端已有插件升到 npm 最新（既有逻辑）。
4. 重新读一次远端清单，重新计算「缺失 / 本地更新」集合（版本号或源安装 spec 任一不同即算差异）：
   - 缺失项直接装本机 spec；
   - 落后项先删旧版本再装；
   - 启用阶段失败重试一次（换包后的第一次 enable 可能解析到已删除的旧路径，包其实已装好）；
   - 仍然失败：落后项把旧版本装回（源安装按原来的完整 spec 装回，包括 commit 钉），记单项失败，继续后续项。
5. 任一插件要求重启时合并成一次重启；重启后补传本机插件快照，让远端插件页的「本机插件」列表恢复。
6. 重新 attach，返回逐项结果，刷新列表。

## 配置同步

插件装好后，只给这次升级**动过的插件**推配置，其他插件的本地配置一概不发：

- **配置条目**：从本机配置编辑器读条目（条目名属于被同步的插件），去掉密钥类字段和本机路径后发给远端 `POST /api/ssh-remote/plugins/config`。远端先备份 profile，再按条目 id（没有 id 用 plugin 名）匹配并写回。
  - 远端已有该条目：直接改它的 config。
  - 远端没有、但该插件已在远端安装：向 profile 的 `cordis.patch.yml` 追加一条 `- id / name / config`，config 用 flow 映射写（JSON 即合法 YAML）；同一 id 或同一插件名已有条目时不追加，避免把 bundle 自带的行复制成两个实例。追加后需要一次 Host 重启才生效，升级流程会在配置同步完成后合并重启一次。
  - 插件没装在远端、或 profile 目录不可用：记 `entry-missing`，不写文件。
- **设置命名空间**：从本机 settings 描述里筛出属于这些插件的命名空间，走既有的 `settings/update`。
- 远端已有、但本机配置里没出现的字段保持远端原值：同步只覆盖发过去的键。
- 配置同步整体失败（接口异常）时升级标 failed，错误码 `UPGRADE_CONFIG_FAILED`；插件本身已经装好，逐项结果里保留安装成功。

## 失败处理

- 单项失败不影响其他项；有失败项时整体标 failed，成功的保留在结果里。
- registry 不可用：该项记 `UPGRADE_REGISTRY_UNAVAILABLE`，其余继续。
- 构建脚本待批准：`PLUGIN_BUILD_APPROVAL_REQUIRED` 带 `pendingBuilds`，行内出现「批准并重试」。
- 同一个 Host 同时只允许一个升级操作，重复点击返回 `UPGRADE_BUSY`。
- 升级期间本机清单变化：以执行时重新读取的清单为准，不使用缓存的差异结果。

## 错误码

沿用既有升级错误码：`UPGRADE_BUSY`、`UPGRADE_RUNTIME_UNAVAILABLE`、`UPGRADE_REGISTRY_UNAVAILABLE`、`UPGRADE_INSTALL_FAILED`、`UPGRADE_PLUGIN_FAILED`、`UPGRADE_BACKUP_FAILED`、`UPGRADE_RESTORE_FAILED`、`UPGRADE_VALIDATION_FAILED`、`PLUGIN_BUILD_APPROVAL_REQUIRED`。

## 测试

单元（`test/p1/service/plugin-alignment.test.js`）：

- 缺失 registry 插件生成安装项；`link:`/`file:`/tar 不生成；
- 本机更新生成升级项；远端更新不降级；版本相同跳过；
- 官方 bundle、Desktop 独占插件跳过；
- Desktop 独占名单与 shell 的 `EXCLUDED_PACKAGES` 完全一致。

服务级（`test/p1/service/host-upgrade.test.js`）：

- 本机有、远端没有的插件让 `pluginsUpgradable` 为真；
- 点升级后确实安装该插件，`link:` 插件不外发；
- 需要构建批准时记 `PLUGIN_BUILD_APPROVAL_REQUIRED`，批准后重试带上 `approvedBuilds`；
- 升级触发的重启会补传本机插件快照。

UI（`test/p2/ui/shell-ssh-launcher.test.mjs`）：

- 按钮文案「同步并升级」；无差异时不出现。

真机验证：远端卸载一个插件 → 列表出现按钮 → 点击后装回、结果逐项显示。
