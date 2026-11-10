> **范围变化（0.4.0）**：本文档里「远端运行包升级」和「远端 Host 重启」的部分已随 controller 一并移除。
> 本机 Web profile 的插件/配置对齐仍然有效；远端侧改由「同步并更新」按 Host 卡片执行。

# Web Host 升级与 desktop 对齐设计

日期：2026-11-09。状态：已批准，实施中。

## 目标

新页签页为每个运行中的 Web Host 显示 DSH 版本；有可做的事时显示一个按钮，点击后：

- 本机 Web Host：升级本机 `dsh`，升级该 profile 的全部插件，并把 desktop 的插件与配置对齐到 `web` profile。
- 远端 Web Host：换成更新的运行包、重启 Host，并升级该 profile 的全部插件。

不做：现场构建运行包；升级 Desktop 应用本身；反向同步；HOME 级数据迁移；差异预览。

## 现状与约束

- `desktop` profile 由 Electron app host 加载，DSH 0.2.2-rc.1，18 个依赖、33 个 bundle、33KB patch。
- `web` profile 由 `dsh web` 加载，11 个依赖、23 个 bundle、31KB patch。HOME 级数据（credentials、storages、表情图库）本来共享。
- 2026-11-04 的手工迁移记录见 `desktop-web-migration/desktop-to-web-migration.md`，本设计把它变成可重复的操作。
- PATH 上的 `dsh` 是 npm 全局包（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`），目录属主可写；`/usr/local/bin/dsh` 是 Desktop app 自带的 CLI，不能由插件升级。
- 远端 DSH 来自插件自带的运行包，运行包目录在 `controller/artifacts`（打包后在 `packages/manager/artifacts`）。远端版本只能用已有运行包升级。
- Web Host 用 pnpm 11 的 store（app 自带 11.28.5）；用 pnpm 10 装会报 `ERR_PNPM_UNEXPECTED_STORE`。profile 侧的统一入口是 `~/.dsh/bin/pnpm11`。
- Shell 现在写死 `expectedVersion: '0.2.1-rc.5'`，本机 CLI 是 0.2.2-rc.1，launcher 打开任何非当前 profile 都会报 `VERSION_MISMATCH`。本轮删掉这条等值检查，只记录探测到的版本。

## 按钮与信息

按钮挂在“运行中的 Web Host”行上，一行最多一个。

- 本机行：当前 Shell 所在的 Web Host（标“当前”，不可停止）、由 Shell 启动的其它本机 Web Host，以及还没运行的本机 Web profile（标“未运行”）。显示 `DSH <当前版本>`；有更新或存在 desktop 差异时出现按钮。
  未运行的 Web profile 行只提供升级按钮，没有新建视图和停止。这样 `web` 比 desktop 少插件时，不必先启动旧插件集合就能看到待同步状态。
- 远端行：每台 SSH 机器上的每个 Host 实例一行。显示 `DSH <当前版本>`；运行包版本更高、或插件落后 npm latest 时出现按钮。
- 没有可做的事、或版本探测失败时，不显示按钮，只显示版本。
- “有 desktop 差异”指对齐计算出的依赖、bundle 或配置条目与 web 现值不同。依赖版本查 npm latest，结果随版本检查一起缓存 10 分钟，不按行重复请求。
- 点击后不弹预览。按钮立即进入执行态，行内显示当前步骤；完成后显示结果摘要或安全错误码。

按钮文案：本机 `web` 行“同步并升级”，其它本机行与远端行“升级”。

版本显示与按钮状态放在行内，不新增面板、不改本机 profile 选择区。

## 版本检测

### 当前版本

- 本机：启动 Host 时运行 `dsh --version` 并记录到运行时记录。未运行的 profile 行共用一次 CLI 探测结果。取不到版本时显示“未知”；只有 desktop 差异时按钮仍可出现。
- 当前 Host：读 `@deepseek-ai/dsh-web-app` bundle 的版本，取不到时显示“未知”。
- 远端：读 Host 实例的 `dshVersion`（manager 已有该字段）。

### 最新版本

- 本机：`https://registry.npmjs.org/@deepseek-ai%2Fdsh` 的 `dist-tags.latest`。请求超时 8 秒，结果缓存 10 分钟；失败不显示按钮。
- 远端：本地运行包目录里该远端 target（platform/arch/libc）的最新 `dshVersion`。没有更高版本时不显示按钮。
- 解析到的 `dsh` 若指向 Desktop app 自带 CLI（`/usr/local/bin/dsh` 或 `/Applications/DeepSeek Harness.app` 下），不给 DSH 升级按钮；版本随 app 更新。插件与配置对齐照常可用。

### 检查时机

版本与差异检查由 Host 侧缓存并异步刷新，`catalog` 与 `status` 只读缓存。缓存为空时返回 `checking`，同时触发一次刷新；客户端轮询，结果到达后按钮出现。

### 比较

按 semver 规则比较，含 prerelease：`0.2.2-rc.1 < 0.2.2`，`0.2.2-rc.1 < 0.2.2-rc.2`。构建标签忽略。

## 本机升级流程

目标 profile 是行对应的 profile（`web` 或其它 Web profile）。

1. 读 profile 目录，校验它是 Web profile、目录真实且在 `~/.dsh/profiles` 下。
2. 解析最新 `@deepseek-ai/dsh`；比当前版本高才算 DSH 升级。
3. 计算插件目标集合：
   - 目标 profile 是 `web` 且 desktop profile 可读：执行下面的对齐规则。
   - 其它情况：只把现有 registry 依赖升到 latest，官方包跟新 DSH 版本。
4. 备份 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 到 `<profile>/.host-upgrades/<时间戳>/`，权限 0600，写入失败即中止。
5. 若 DSH 有新版本：`npm install -g @deepseek-ai/dsh@<版本>`。用 PATH 上解析到的 `npm`；解析失败或退出码非 0 即失败。
6. 停止该 profile 的运行中 Host（当前 Host 与未运行的 profile 除外，见下）。先停再写：运行中的 Host 会热加载 patch 文件，边写边重载会读到还没装好的插件。
7. 写 `package.json`：依赖集合与 `dsh.profile.bundles`；保持 pnpm-workspace 和其它字段不变。
8. 写 `cordis.patch.yml`：按对齐规则更新条目，保留文件头注释与未涉及条目。
9. 在 profile 目录运行 pnpm 11 install，不带 `--frozen-lockfile`。pnpm 依次取目标 profile patch 里的 `plugin-manager.pnpmCommand`、`~/.dsh/bin/pnpm11`、app 自带的 `pnpm/bin/pnpm.mjs`；都取不到即失败。
   pnpm 11 在安装完成但存在未批准的构建脚本时会以退出码 1 结束（`ERR_PNPM_IGNORED_BUILDS`）。这种情况不算安装失败：升级自己批准这些构建。做法是把 pnpm 报出的身份写进 profile `pnpm-workspace.yaml` 的 `allowBuilds` 映射（`name: true`），然后重跑一次 install，最多 3 轮：registry 依赖用包名（`@jackwener/opencli`），`file:`、`link:`、`git` 依赖用完整 spec（`dsh-workspace-guest@file:../x.tgz`）——pnpm 只按完整 spec 匹配这类依赖，裸名批不下来。已有条目一律不动，显式 `false` 视为用户明确拒绝，不覆盖。`allowBuilds` 是内联映射（`{}`、`[]`、带注释）时不改写文件，避免重复 key。安装集是升级计划算出来的，构建脚本属于其中的依赖，因此不需要再人工点头。
   只有两种情况仍会把包名带进 `upgrade.ignoredBuilds`、由界面提示“N 个依赖的构建脚本待批准”：profile 显式拒绝该包；或三轮之内 pnpm 仍报同一批包。
10. 运行 `dsh --profile <p> --dump-config` 校验组合树，退出码非 0 视为失败。
11. 不自动重启。行消失，提示“已升级，重新打开页签”。

当前 Host 跳过第 6 步，完成后提示“重启 Host 生效”。

### 对齐规则

排除的插件：`dsh-workspace-shell`、`dsh-pet`、`@local/dsh-preset-whale-maid`、`@xmanrui/dsh-im`。`@local/dsh-ssh-remote` 由 shell 的依赖带入，随 shell 一起排除。

依赖：

- 以 web 现有依赖为底，一律保留（`dsh-recall-plugin`、两个 `@deepseek-ai/dsh-subagent-*` 等 web 独有项不删）。
- desktop 有、web 没有、且不在排除名单的依赖，加入。
- 两边都有时：
  - registry 来源 → `name@<最新可安装版本>`。
  - `github:`、`git+`、`file:`、`link:` 来源 → 保留 desktop 的原始 spec，不做版本解析。
- 官方包（`@deepseek-ai/` 前缀）在 DSH 升级时置为新 DSH 版本；npm 上该版本不存在时保留原版本并记录一条跳过原因。
- 排除名单里的依赖不加入，也不升级。

bundle 列表：

- 保留 web 现有顺序，把缺失的 desktop bundle 追加到末尾，排除项跳过。
- 不重排 web 已有的 bundle。

配置条目：

- 逐条读 desktop 的 patch 条目。
- 只处理同时满足三条的条目：id 出现在 web 当前组合树里；条目名不属于排除插件；不在下面的保留名单里。
- 命中时只覆盖 `config` 段；web 条目里的其它字段（如 `disabled`）保持原样；web 没有该条目则整条追加。
- desktop 只有 `disabled` 没有 `config` 的条目（`experimental-inspector`、各模型条目）不复制，插件启停状态不算配置。
- 其余条目原样保留，位置不动。
- 保留名单：`llm-deepseek-account`（desktop 的模型表比 web 默认少）、`plugin-manager`（`pnpmCommand` 是本机路径）。
- 组合树判定用改动前的 `dsh --profile web --dump-config` 顶层 id 集合。desktop 独有的 `bili-native`、`image-gen`、`claude-*` 等条目因此自然跳过。

不迁移：`.dsh-market/state.json`、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`、HOME 级数据。

## 远端升级流程

1. 读该 Host 实例的 `dshVersion` 与 target。
2. 在运行包目录选出 target 相同、`dshVersion` 最高的运行包。
3. 高于实例版本时，以“最高版本”为偏好重开控制器会话并安装运行包，停掉本 manager 持有的旧 Host，再起新实例（复用 `performConnect` 的 `upgrading` 分支）。同一 SSH 连接下其它 profile 的 Host 不受影响。
4. 升级插件：列出远端 bundle，只处理非官方、且 spec 是 registry 来源的条目；在本地解析 latest。
   - 目标版本比已装的新时才处理。
   - DSH 拒绝用不同版本覆盖已装插件，所以先 `plugins/remove` 再 `plugins/install name@version`。
   - 新版本安装失败（含构建脚本待批准）时，回装旧版本，避免 profile 少一个插件。
   - 构建脚本待批准不是普通失败：结果项带 `PLUGIN_BUILD_APPROVAL_REQUIRED` 和 `pendingBuilds`，Host 行带 `buildApprovals`，客户端在行内列出待批准包名并给出“批准并重试”入口。
   - 批准走 `POST /api/ssh-remote/upgrade/approve`：按插件把 `approvedBuilds` 传给远端安装，避免把不再待批准的包名传给它导致 `stale-approval`。
5. 任一插件返回 `restart-required` 时重启该 Host 一次。
6. 单个插件失败不回滚已成功的，失败项进入结果摘要。

运行包已是最新但远端插件落后时，仍然允许升级：只跑第 4 步，不动运行包与实例。两种情况都没有可做的事时才返回不需要升级。
Host 行在“有新运行包”或“插件落后”时显示按钮；`pluginsUpgradable` 由远端 `plugins/list` 与 npm latest 比对得出，缓存 60 秒。官方 bundle 随运行包更新，不在逐项升级范围内。关联视图不自动重开，提示重新打开。

## 失败处理

- 本机写文件前必须有备份；第 7 至 10 步任一失败，按相反顺序还原四个文件（含第 9 步可能新建的 `pnpm-workspace.yaml`，原本不存在就删掉），并用备份的 lockfile 运行一次 `pnpm11 install --frozen-lockfile` 恢复 `node_modules`。还原失败单独报错。
- `ERR_PNPM_IGNORED_BUILDS` 是唯一不触发还原的安装退出码：依赖已经装好，只是构建脚本还没批准，升级随后写入 `allowBuilds` 并重试。其余非 0 退出码照常还原；重试仍然失败时按普通失败还原。
- 第 5 步（全局 npm 升级）失败不回滚文件，直接中止；第 6 步停止 Host 失败也不动文件。
- 远端运行包安装失败保持原实例不动；插件升级失败只影响该项。
- 同一 Host 同时只允许一个升级操作；重复点击返回 `UPGRADE_BUSY`。

错误码：`UPGRADE_BUSY`、`UPGRADE_UNSUPPORTED_PROFILE`、`UPGRADE_PROFILE_UNAVAILABLE`、`UPGRADE_REGISTRY_UNAVAILABLE`、`UPGRADE_NPM_FAILED`、`UPGRADE_INSTALL_FAILED`、`UPGRADE_VALIDATION_FAILED`、`UPGRADE_BACKUP_FAILED`、`UPGRADE_RESTORE_FAILED`、`UPGRADE_RUNTIME_UNAVAILABLE`、`UPGRADE_PLUGIN_FAILED`。

## 安全

- 只接受 `~/.dsh/profiles/<id>` 下的真实目录，拒绝符号链接逃逸。
- 依赖 spec 只接受 registry 名称、`github:`、`git+`、`file:`、`link:`；含 URL 凭据、密码或可疑 query 的 spec 跳过并记录。
- 备份文件权限 0600，目录 0700；不写凭据、不复制凭据。
- 结果与错误只带安全字段，不带命令输出正文、路径以外的本机信息。
- npm 与 pnpm 调用使用固定 argv，不经过 shell。

## 接口与文件

Shell（`packages/shell`）：

- `src/host/profile-inventory.js`：读 profile 的 `package.json`、bundle 列表、patch 条目、组合树 id。
- `src/host/desktop-align.js`：纯函数，输入 desktop 与 web 的清单，输出依赖、bundle、patch 条目改动。
- `src/host/patch-text.js`：patch 文件的条目级文本读写，替换或追加 `config` 段，保留文件头注释与未涉及条目。
- `src/host/profile-upgrade.js`：备份、写文件、调用 npm/pnpm、校验、还原。
- `src/host/routes.js`：`POST /api/workspace-shell/hosts/upgrade`。
- `src/host/local-runtimes.js`：记录启动时的 CLI 版本；删除版本等值检查。
- `src/launcher.js`：Host 行显示版本与按钮。

Manager（`packages/manager`）：

- `shared/registry.js`：npm latest 查询与 semver 比较，两个包共用。
- `src/host/runtime-catalog.js`：新增“按 target 取最高版本”。
- `src/host/service.js`：`upgradeHost({ hostId, profileId })`。
- `src/host/index.js`：`POST /api/ssh-remote/upgrade`。
- `src/client/ssh-launcher.js`：Host 行显示版本与按钮。

`catalog` 与 `status` 响应增加：运行时/连接的 `dshVersion`、`latestDshVersion`、`alignPending`（仅本机 `web` 行）、`upgrade: { phase, step, error }`。客户端轮询刷新，不新增事件通道。

### 请求与响应

本机：

```
POST /api/workspace-shell/hosts/upgrade
{ runtimeId?: string, ownerId: string }        // 省略 runtimeId 表示当前 Host
→ { ok: true, result: { started: true, upgrade: { phase: 'running', step: 'backup' } } }
```

远端：

```
POST /api/ssh-remote/upgrade
{ hostId: string, profileId?: string }
→ { ok: true, result: { started: true, upgrade: { phase: 'running', step: 'runtime' } } }
```

两者都立即返回，进度由 `catalog` / `status` 轮询读取。`upgrade.phase` 取值 `running`、`done`、`failed`；`done` 或 `failed` 在一次轮询后被消费，下次刷新清空并反映新版本。`upgrade.ignoredBuilds` 只在升级自己批不下来（profile 显式拒绝或重试后仍被拦）时出现。

`upgrade.step` 取值为 `backup`、`dsh`、`stop`、`write`、`install`、`validate`（本机）与 `runtime`、`plugins`（远端）。客户端按固定文案映射，不直接显示字段值。

## 测试

- 纯函数：semver 比较（含 prerelease）、依赖与 bundle 合并、排除名单、patch 条目筛选、保留名单。
- YAML 往返：文件头注释保留、未涉及条目的 id/config 不变、新增条目落在末尾。
- 执行器：临时 profile 目录 + 假 npm/pnpm 执行器；成功路径、pnpm 失败还原、`ERR_PNPM_IGNORED_BUILDS` 不还原、校验失败还原、备份失败中止、重复执行。
- 远端：运行包选择取最高版本；实例已是最新时返回“无需升级”；插件升级跳过官方与非 registry 条目；`restart-required` 只重启一次。
- 客户端：有更新才显示按钮、执行中禁用、错误码显示、无版本时不显示按钮。
- 回归：`node scripts/test.mjs` 全量。

## 实施顺序

1. 共用版本与 registry 模块 + 测试。
2. profile 清单读取、对齐纯函数、YAML 写入 + 测试。
3. 本机执行器、路由、版本放宽 + 测试。
4. launcher Host 行版本与按钮。
5. 远端运行包选择、升级路由、客户端行。
6. README 与全量回归。
