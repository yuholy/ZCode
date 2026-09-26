/**
 * fork 策略开关（yuholy 私有 fork）。
 *
 * 背景：上游打包版在 production flavor 下启用两条「远端可反向控制本机」的通道：
 * 1. 自动更新：更新源只分发官方 ZCode 安装包，一旦安装会把本 fork 的补丁构建
 *    （遥测关闭、UI 精简、fork 标识）整体覆盖成官方二进制。
 * 2. 远端强制升级 gate：启动时请求远端配置，可判定本机版本过低并阻塞启动、要求升级。
 *
 * 两条通道都不服务于「本地编码客户端」场景，且都会削弱本 fork 的隐私加固，故在此集中关闭。
 * 如需临时恢复上游行为，把此值改为 true；改回前请自行评估官方二进制覆盖风险。
 */
export const ZCODE_FORK_ENABLE_UPDATE_CHANNELS: boolean = false;

/**
 * fork 策略开关（yuholy 私有 fork）：问题上报（反馈中心）。
 *
 * 上游的反馈中心会把工单文本、截图与日志归档上传到官方端点
 * （`packages/services/src/feedback/feedbackHttpClient.ts` 的 `/feedback/ticket` 与
 * `/feedback/attachment/upload-credential`）。入口散布在帮助菜单、命令面板、任务右键菜单、
 * 错误横幅与原生应用菜单等 11 处，任何一处误点都会上传日志与截图；私有 fork 不需要这条
 * 通道，故整体关闭。
 *
 * 关闭后：反馈中心不挂载（提交链路只在 FeedbackCenter 内部驱动，不挂载即无法上传），
 * 各处入口不再渲染，主进程 openFeedback 命令也不再触发远端帮助配置拉取与 IPC 回发。
 * 如需临时恢复上游行为，把此值改为 true。
 */
export const ZCODE_FORK_ENABLE_FEEDBACK_CENTER: boolean = false;

/**
 * fork 策略开关（yuholy 私有 fork）：会话分享（发布侧）。
 *
 * 上游「分享」会把当前会话的对话记录与选中文件内容打包上传到官方站点
 * （`packages/services/src/conversation-share/conversationShareService.ts` 的 publish，
 * 分享页写死 `https://zcode.z.ai/cn/share`）。这是把代码内容整份送出本机的通道，
 * 且需要账号体系支撑，本 fork 不使用，故关闭顶栏入口。
 *
 * 关闭后：顶栏不再渲染分享按钮（原本还要求登录态，这里改成与登录态无关的确定性关闭）。
 * 发布链路只由 `ConversationShareMenu` 激活选择态驱动（`setScope` 全仓唯一调用者），
 * 入口不渲染即无法进入选择态，也就无法上传。
 *
 * 注意「导入分享」不在此开关范围内：它是浏览器分享页 Deep Link 唤起的下载/导入流程，
 * 不向本机外发送任何内容。
 */
export const ZCODE_FORK_ENABLE_CONVERSATION_SHARE: boolean = false;

/**
 * fork 策略开关（yuholy 私有 fork）：模型遥测（OpenTelemetry / OTLP）。
 *
 * 这条通道与 ARMS / 数仓不是同一个开关：无论 ARMS 关没关，只要进程环境里出现
 * `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`，CLI 就会初始化
 * OTLP exporter，把 agent 的模型调用 trace/metrics 发出去（含脱敏后的 provider 端点身份与 deviceMid）。
 * 见 `apps/zcode-cli/packages/telemetry/src/bootstrap.ts`。
 *
 * 关闭后：CLI 不再准备遥测 Owner，`createModelTelemetry` 拿不到 owner 就返回 no-op（enabled:false），
 * 因此即使用户自己配了 OTLP 端点（如本地 Jaeger/Tempo），也不再外发模型遥测。
 * 只影响可观测性，不改变任何对话行为；如需临时恢复，把此值改为 true。
 */
export const ZCODE_FORK_ENABLE_MODEL_TELEMETRY: boolean = false;

/**
 * fork 策略开关（yuholy 私有 fork）：「远端服务器下载」资源安装模式。
 *
 * 该模式与「本地下载后上传」的差别不只是带宽：它读 **CDN 的 manifest**（`deploy.ts` 的
 * `getManifestRefForComponents` / `createRemoteAssetInstaller`），而远端 agent 本体就属于该类
 * 组件（manifest 里的 `glm`，就是 `zcode.cjs`）。选它意味着远端从官方 CDN 拉 **官方构建的 agent**
 * —— 本 fork 的隐私加固（遥测关闭、模型遥测关闭、无反馈/分享入口、不扫盘）在远端全部失效。
 *
 * 关闭后：UI 不再展示该选项，持久化/历史快照里残留的 `remote-download` 也会在部署前被归一化为
 * 「本地下载后上传」；远端仍拿到本机构建的 agent。schema 仍接受该字面量（旧设置向下兼容）。
 * 如需临时恢复，把此值改为 true。
 */
export const ZCODE_FORK_ENABLE_REMOTE_ASSET_DOWNLOAD: boolean = false;
