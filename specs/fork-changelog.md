# yuholy fork 变更记录（Fork Changelog）

本文档记录本私有 fork 相对上游（`zai-org/ZCode`）的全部改动：**改了什么、为什么改、功能上有什么变化、怎么恢复**。
每次改动请追加到对应日期小节，并保持「开关表」同步更新。

---

## 0. 本 fork 的定位

纯 API Key 客户端用法：**不使用官方账号体系**，模型走自配 provider（z.ai / BigModel 等）。
因此本 fork 的目标是两类：

1. **隐私**：断掉不服务于「本地编码客户端」的上报与反向控制通道；
2. **UI 精简**：隐藏因没有账号而失效或误导的入口。

改动的共同风格：**加行、不删上游代码**，统一用 `packages/shared/src/forkPolicy.ts` 的常量开关门控，
以便随时翻转回上游行为，且让上游 rebase 的冲突面尽量小。

---

## 1. 开关总表（当前全部关闭）

`packages/shared/src/forkPolicy.ts`：

| 开关                                   | 值      | 作用                                 |
| -------------------------------------- | ------- | ------------------------------------ |
| `ZCODE_FORK_ENABLE_UPDATE_CHANNELS`    | `false` | 关闭自动更新 + 远端强制升级 gate     |
| `ZCODE_FORK_ENABLE_FEEDBACK_CENTER`    | `false` | 关闭问题上报（反馈中心）全部入口     |
| `ZCODE_FORK_ENABLE_CONVERSATION_SHARE` | `false` | 关闭会话分享（发布侧）入口           |
| `ZCODE_FORK_ENABLE_MODEL_TELEMETRY`    | `false` | 关闭模型遥测（OpenTelemetry / OTLP） |

另有历史开关（不在 forkPolicy，位于原位）：

| 开关                      | 值      | 位置                                                        |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `ZCODE_TELEMETRY_ENABLED` | `false` | `packages/shared/src/env.ts`（ARMS RUM + 数仓两条上报通道） |

环境变量类开关：

| 变量                              | 作用                                             |
| --------------------------------- | ------------------------------------------------ |
| `ZCODE_EGRESS_JOURNAL_DISABLED=1` | 关闭出网流水账                                   |
| `ZCODE_EGRESS_JOURNAL_DIR`        | 指定流水账目录                                   |
| `OTEL_EXPORTER_OTLP_*`            | 即使设置，模型遥测也不再外发（被 fork 开关拦死） |

开关消费点（13 个文件）：

```
apps/zcode-cli/packages/bootstrap/src/telemetry-bootstrap.ts   模型遥测
packages/desktop/src/main/index.ts                             更新通道 / 扫盘 / 流水账安装
packages/desktop/src/main/desktopApplicationMenu.ts            原生菜单「问题上报」
packages/desktop/src/main/autoUpdater.ts                       预览更新开关 → 出网
packages/ui/src/App.tsx                                        反馈中心挂载 + openFeedback 命令
packages/ui/src/ChatErrorBanner.tsx                            错误横幅「反馈问题」
packages/ui/src/quickpick/quickPickCommands.ts                 命令面板「问题上报」
packages/ui/src/remote-connection/RemoteConnectionConnectingStep.tsx  连接失败页「去反馈」
packages/ui/src/settingsPageHelpers.tsx                        设置页两个失效的更新开关
packages/ui/src/TaskActionMenuContent.tsx                      任务菜单「反馈问题」
packages/ui/src/v4/SessionSubscriptionErrorPanel.tsx           订阅错误面板「反馈问题」
packages/ui/src/workspace-grouped-tasks/task-context-menu-content.tsx  任务右键「反馈问题」
packages/ui/src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx 顶栏「分享」
packages/ui/src/WorkspaceHelpMenuButton.tsx                    帮助菜单「问题上报 / 给产品提需求」
```

---

## 2. 2026-09-26：隐私加固第二轮（8 个提交）

### 2.1 `9b22561` chore(fork): add fork policy switches

新增 `packages/shared/src/forkPolicy.ts`（58 行）+ `shared/index.ts` 导出。
把散落的 fork 判断集中为命名常量，避免各处硬编码 `false` 触发 lint 常量条件告警，也便于日后翻转。
**功能影响**：无（纯新增模块）。

### 2.2 `eadb33b` feat(shared): add local egress journal and network instrumentation

新增本机出网流水账，共 618 行 / 4 个文件：

| 文件                                                            | 作用                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/shared/src/egressJournal.ts`（194 行）                | 记录类型 + 归约脱敏（`redactEgressTarget`）+ append-only JSONL sink      |
| `packages/shared/src/networkEgressInstrumentation.ts`（342 行） | 包 `globalThis.fetch` + `node:http/https.request` **与 `.get`**          |
| `packages/shared/package.json`                                  | 新增 `./egress-journal`、`./network-egress-instrumentation` 两个 subpath |
| `specs/egress-journal.md`                                       | 规格：归属、记录内容、硬性约束、失败语义、验收场景                       |

**功能**：每次出网追加一行 JSONL 到
`${ZCODE_EGRESS_JOURNAL_DIR}` ?? `${ZCODE_HOME}` ?? `~/.zcode` + `/egress/egress-YYYY-MM-DD.jsonl`。

**安全前提（硬性约束）**：只记「谁、往哪、多大、结果如何」——
不记请求体/响应体/header/**query 的 value**，不记最终 URL 原文，不记本机路径；
本模块**不得**被任何上报通道引用。全链路 fail-open（连续失败 3 次自禁用）。

**踩坑记录**：Node 里 `http.get` 调的是模块作用域内的 `request`，不会走被替换的导出属性 ——
只包 `request` 会让 `http.get` 整片漏记，必须两个入口都包装。

### 2.3 `2c42222` feat(desktop): wire egress journal and harden fork runtime

| 改动               | 内容                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 流水账接线         | 新增 `main/appEgressJournalBootstrap.ts`、`host/appHostEgressJournalBootstrap.ts`（模块级副作用安装），入口各加一行 import |
| 自动更新关闭       | `initAutoUpdater({ enabled: production && ZCODE_FORK_ENABLE_UPDATE_CHANNELS })`                                            |
| 强制升级 gate 关闭 | `maybeBlockStartupForForceUpdate` 前置条件加 flag；并补一条 fork 跳过日志分支                                              |
| **扫盘调度器关闭** | `registerDesktopZCodeDataSizeTelemetry(...)` 移入 `if (ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT)`                |

**为什么要关扫盘**：该调度器每天在系统空闲时遍历 `~/.zcode`（上限 20 万文件 / 30 秒），
唯一去向是 `armsRum.sendCustom`。遥测关闭后数据无处可发，扫描却仍在跑 —— 纯扫盘、零收益。
实测证据（关闭前）：

```
[2026-09-25 22:18:07] [zcode-data-size] reported status=complete bytes=1650355975
[2026-09-23 16:58:08] [zcode-data-size] reported status=complete bytes=610851497
[2026-09-22 13:58:16] [zcode-data-size] reported status=complete bytes=38825195
```

> 实现注记：第一版把守卫写在 `desktopZCodeDataSizeTelemetry.ts` 函数入口（diff 更小），
> 但 `oxlint` 的 `max-lines` 是 **error（上限 400，跳过空行与注释）**，该文件 399 行 + 4 行即爆。
> 改放到已 `/* eslint-disable max-lines */` 的 `index.ts`。**动接近 400 行的文件前先数行数。**

### 2.4 `d2e0aaa` fix(desktop): keep crash capture consistent with telemetry state

两个修复：

1. **`appCrashCaptureBootstrap.ts`**：`initializeCrashCapture(logger, true)` 的 `true` 是上游硬编码的
   「ARMS 已接管远端 crash 上报」。我们关掉 ARMS 后它没跟着变，导致 Electron 内置 crashReporter
   **也不启动** —— 出现「既无远端上报，也无本地 crashReporter」的空档，崩溃连本地 dump 都不落盘。
   改为 `ZCODE_TELEMETRY_ENABLED && Boolean(ZCODE_ARMS_RUM_ENDPOINT)`，判据与 `armsInitPromise` 一致。
   遥测关闭时走本地分支，其 `submitURL` 是保留域 `zcode.invalid` 且 `uploadToServer: false`，**不产生上传**。
2. **`autoUpdater.ts`**：`refreshAutoUpdaterReleaseChannel` 加 `autoUpdaterDisabledForProductFlavor` 短路。
   否则切换「接收预览更新」会调 `checkForUpdates()`，而此时不会执行 `setFeedURL`，
   electron-updater 会**回退到打包内置的 `app-update.yml`（官方 feed）** → 开关即出网。

**运行期验证**（dev main pid 75238）：

```
[crash-capture] configured remoteCrashReporterEnabled=false
[crash-capture] local crashReporter started without remote upload
```

并实测**新增出现** crashpad handler 进程（修复前精确复查为 0 —— 注意 `ps | grep` 会自匹配 shell 命令行造成假阳性）。

### 2.5 `11b078f` feat(ui): remove account-era entries for pure API-key usage

三件事，共 12 个文件：

1. **隐藏两个已失效的更新开关**（`settingsPageHelpers.tsx`，+8 行）
   `接受提前收到预览版更新`、`自动下载并安装更新` 在更新通道关闭后不再产生任何行为，显示即误导。
   _实现手法_：不用「包裹」（要把 34 行整体缩进、diff ~70 行），而是在「Chrome 硬件加速」行之后
   **先闭合原片段、再另起一个受控片段**，内部 34 行原封不动 → +8 行 / 0 行删改。

2. **移除反馈中心**（11 处入口 + 中心挂载，`packages/ui/src` + 原生菜单）
   - 反馈中心**不挂载**（`App.tsx`）：提交链路只由 `FeedbackCenter` 内部驱动，不挂载即物理上无法上传；
   - `handleOpenFeedback` 置空：这条路径会**先拉一次远端帮助配置再回发 IPC**，即使中心不挂载也会出网；
   - 入口：帮助菜单（2 项）、命令面板、任务右键菜单、任务「更多」菜单、远程连接失败页、
     会话订阅错误面板、聊天错误横幅、**原生应用菜单**（Windows/Linux Help）。
   - 全链路核对：8 个 store 调用点全部落在门控分支内；`OpenTicketsPanel` 全仓无发送方。

3. **会话分享改为确定性关闭**（`WorkspaceHeaderActionSection.tsx`）
   原条件 `activeTaskId && user && isDesktop !== false` 本来就被登录态隐藏（纯 API Key 下 `user` 为 null），
   加 flag 后变成**与登录态无关**的确定性关闭：以后真登录了、或远端/手机会话把 `user` 填上，也不会冒出来。
   全仓 `<ConversationShareMenu>` 只有一个渲染点，且激活分享选择态的 `setScope` 只有它一个调用者。

**实测**：帮助菜单项变为 `产品文档 / 用户社群 / 资源管理器 / 关于 ZCode`（两个反馈项消失，正向对照完好）；
命令面板搜不到「问题上报」。**排查注记**：第一次实测仍看到「问题上报」，不是失败而是运行中的 renderer
尚未重新执行该模块 —— 强制 reload 后才反映真实结果；这类判断必须以重载后的 DOM 为准。

### 2.6 `3772f2e` + `5e611e0` CLI：模型遥测关闭（保留）+ 流水账接线（后撤销）

**保留**：`ZCODE_FORK_ENABLE_MODEL_TELEMETRY=false`，消费者是 CLI 侧唯一的「准备遥测 Owner」入口
`apps/zcode-cli/packages/bootstrap/src/telemetry-bootstrap.ts`：

```ts
if (!ZCODE_FORK_ENABLE_MODEL_TELEMETRY) {
  return env; // 不准备 Owner
}
```

- `createModelTelemetry` 取 `options.owner ?? preparedOwner`，拿不到 owner 就返回 no-op（`enabled:false`），
  因此不准备 Owner ⇒ OTLP exporter 根本不会创建；
- `prepareModelTelemetry` 是 `preparedOwner` 的唯一写入者，且只被上述文件调用；
- 桌面侧（`packages/desktop`、`packages/services`）grep `prepareModelTelemetry|createModelTelemetry|
ZCODE_MODEL_TELEMETRY_ENABLED` 全空 → 这条通道只在 CLI 进程存在。

**为何要单独关**：模型遥测（OpenTelemetry / OTLP）与 ARMS / 数仓**不是同一个开关**。
只要环境里出现 `OTEL_EXPORTER_OTLP_ENDPOINT`（例如自建 Jaeger/Tempo），
CLI 就会初始化 exporter，把 agent 的模型调用 trace/metrics 发出去（含脱敏后的 provider 端点身份与 deviceMid）。
上游还刻意让 **OTLP 端点复用 ARMS 接入点**（`bootstrap.ts` 注释），属于「一条通道、两套消费者」。

**撤销**：`5e611e0` 移除 CLI 进程的出网流水账接线（bootstrap 文件、`main.ts` import、
以及 `build.mjs` 里为它登记的 esbuild alias 条目）。
**理由**：模型对话是用户自配 provider 的既定、已知出网通道，把每次模型请求也记进来只会淹没信号 ——
流水账的价值在于暴露**预期之外**的通道。决定与盲区已写入 `specs/egress-journal.md`。

> 集成注记：`apps/zcode-cli/packages/cli/scripts/build.mjs` 有一张**必须同步维护的 esbuild alias 表**。
> 注释明确写明：所有 shared subpath 必须在通用入口前精确声明，否则会被拼成
> `src/index.ts/<subpath>`，**导致 Desktop agent / SEA 打包失败**。新增 shared subpath 时别漏。

### 2.7 `ce109df` chore: add egress and upstream-network audit scripts

两个只读审计脚本（`package.json` 注册 `audit:egress` / `audit:upstream-network`）：

1. **`scripts/audit-zcode-egress.mjs`**（269 行）—— 进程级出网快照。
   按 `ps` 找 ZCode 相关进程（覆盖 `ZCode`/`ZCode Dev` 主进程、`zcode-cli`、`zcode-host-local`、
   `zcode-node-repl-mcp`），用 `lsof -F pnT` 采 TCP 连接，反解域名并三级分级（可疑 / 预期 / 未知）。
   支持 `--no-resolve` / `--json` / `--watch N`。
   **修过的两个自身 bug**：① 进程匹配漏了主进程与 agent（macOS `ps` 只给可执行名、无路径），
   漏掉它们等于漏掉真正在调模型和 MCP 的进程；② 列式切词把 `(ESTABLISHED)` 当成了 NAME，
   导致每条连接被静默丢弃 → 改用 `-F` 机器可读模式。
2. **`scripts/audit-upstream-network-diff.mjs`**（213 行）—— 上游同步后的新增出网点审计。
   只解析 `git diff -U0` 的新增行，匹配 fetch/http/WebSocket/beacon/DNS 与 URL 字面量，末段按域名聚合。
   默认范围 `origin/main@{1}..origin/main`。实测：自身提交 0 命中；上游 v3.14.3 同步（30341 新增行）32 命中。

**已知局限**：只能抓直接 `fetch(` / URL 字面量，抓不到走共享 client 的间接出网与
依赖内部拼的地址（实例：飞书长连接的地址由 `@larksuiteoapi/node-sdk` 的 `EventDispatcher` 在依赖内拼）。
所以它与进程级 `audit:egress` 必须配着用。

---

## 3. 2026-09-24 ~ 09-25：隐私加固第一轮（4 个提交，本次会话之前）

| 提交      | 内容                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `862926c` | `ZCODE_TELEMETRY_ENABLED` 写死 `false`（切断 ARMS RUM + 数仓两条上报通道）                                       |
| `05b58cc` | 隐藏账号类入口：「升级」入口仅在存在套餐时显示；隐藏「连接使用」；徽标回退 `ZCode`                               |
| `a29a818` | fork 标识三层落地：`build-metadata.mjs` 的 `forkId: "yuholy"` + About 显示 `Fork: yuholy` + tag `yuholy-v3.14.3` |

---

## 4. 上游同步历史

| 提交                  | 说明                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `872ad96`             | 上游开源起点                                                                |
| `328c1a0` / `29628c9` | 同步 v3.14.3（rebase 保留本地补丁；`env.ts` 的 false 在上游合并结果中保留） |
| `303db3b` / `2290e43` | 两次 `Merge branch 'zai-org:main'`                                          |

---

## 5. 验证基线（改完必跑）

| 命令                                                          | 期望                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                              | 退出 0（**注意：不覆盖 `apps/zcode-cli`**）                                                                                                |
| `pnpm lint`                                                   | `oxlint`：**70 warnings / 0 errors**（70 是既有基线，不应增加）                                                                            |
| `oxfmt --check <files>`                                       | 全部 pass（`.md` 也在 oxfmt 管辖内）                                                                                                       |
| `pnpm architecture:check --changed`                           | `architecture: OK / violations: 0`                                                                                                         |
| `cd apps/zcode-cli && pnpm --filter @zcode/cli run typecheck` | 存在**预先存在**的失败：`Cannot find module '@zcode/tui'`（其 `dist` 未构建）及连锁 implicit-any；判断标准是「报错文件与本次改动有无交集」 |

运行期取证方式：`~/.zcode/v2/logs/<date>.log` 按 **pid** 区分实例（dev 与打包版共用同一日志文件，
不按 pid 区分就会误判）；`ps`/`grep` 做进程取证时必须 `grep -v grep`，否则会匹配到 shell 自身命令行造成假阳性。

---

## 6. 已知边界与未做项

### 6.1 出网流水账的覆盖边界

- **记**：main + host 进程的 `fetch` / `http(s)` —— 配置拉取、更新 CDN、内置配置、bots（飞书/Telegram/微信）、
  反馈上传、会话分享、MCP 配置、浏览器数据导入。
- **不记**：模型对话；agent 进程的 WebFetch / MCP HTTP / 插件下载；渲染进程；`net.connect` 直连。
- 实测：`~/.zcode/egress/egress-2026-09-26.jsonl`，6 条（`zcode.z.ai/api/v1/client/configs` ×4、
  `cdn-zcode.z.ai/zcode/config/zcode-builtin-23.json` ×2），query value 已抹掉。
- **易踩**：文件名用**本地日期**、记录内 `ts` 用 **ISO UTC**，按 UTC 挑文件会错一天。

### 6.2 未做（有意保留）

| 项                                                                                                  | 状态                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 凭据 KDF / sessions 明文 / 插件沙箱 / marketplace 签名 / server 鉴权 / 自签 CA / deviceMid 配置拉取 | 按第一批方案排序（P0-4 → P0-2 → P2-2 → P2-3 → P0-1）延后，全文见 `zcode-privacy-toolkit/modification-plan.md` |
| 模型对话出网                                                                                        | 产品核心机制，代码层不可关闭；只做了「加记录」（流水账不覆盖）与「关模型遥测（OTLP）」                        |
| 插件市场安装第三方代码 / MCP server 的 Node 权限                                                    | 属用户自划可信边界                                                                                            |
| Claude Code 会话导入 / 外部 Agent 配置导入                                                          | 手动触发（首启引导走到迁移步骤会**自动扫** `~/.claude/projects`，纯本地、不外发），暂不隐藏                   |
| Chrome Cookie / localStorage 导入                                                                   | 手动触发（`BrowserSettingsSection` 按钮），导入到本机 Electron 分区，不外发                                   |

### 6.3 部署与打包提醒

- 本 fork 的补丁只对**新构建**生效；`/Applications/ZCode.app` 与 `packages/desktop/dist/{mac-arm64,win-unpacked}`
  内嵌的是旧 `app.asar`，需重新打包才会带上。
- 远端 SSH 部署：agent 本体来自安装包内嵌 `bundled-agents/`（fork 构建），Node/node-pty/tools 从官方 CDN 拉（通用二进制）。
- 开发/打包环境已知坑：必须 `export TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"`，
  否则 agent Unix socket 路径超长 → `listen EINVAL` 崩溃循环。
