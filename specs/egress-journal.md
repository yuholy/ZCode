# 本机出网流水账（Egress Journal）

## 目的

让「哪些数据离开了这台机器」变成可事后审计的本地事实，而不是靠读代码推断。

动机来自一次隐私加固：把遥测总开关关掉之后，仍然无法回答「刚才那次对话把什么发给了 z.ai」。
本 spec 定义一条**只写本机、永不上传**的出网记录通道。

## 归属与边界

| 项         | 决定                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| 状态所有者 | 每个进程各自的 sink（`packages/shared/src/egressJournal.ts` 的 `createEgressJournal`），文件是唯一共享事实   |
| 写入位置   | `${ZCODE_EGRESS_JOURNAL_DIR}` ?? `${ZCODE_HOME}` ?? `${HOME}/.zcode`，再拼 `/egress/egress-YYYY-MM-DD.jsonl` |
| 格式       | append-only JSONL，一行一条记录（单次 `write` + `O_APPEND`，多进程可安全并发追加）                           |
| 出网方向   | **不适用**：本通道自身只做 `fs` 写，不产生任何网络请求                                                       |
| 覆盖范围   | 进程内 `globalThis.fetch` + `node:http.request/get` + `node:https.request/get`（含第三方库发起的请求）       |
| 不覆盖     | 渲染进程（其流量多为本地 dev server 与 IPC）；原生 socket 直连（`net.connect`）；非 Node 进程                |

## 记录内容（这是本通道的安全前提）

**只记录「谁、往哪、多大、结果如何」，不记录载荷。**

```ts
{
  ts, seq, pid, role: "main" | "host" | "agent",
  transport: "fetch" | "http" | "https",
  method, host: "api.example.com:443",     // 含端口；URL 里的 userinfo 天然不在 host 内
  path: "/v1/chat/completions",            // 仅 pathname
  queryKeys: ["app_version", "platform"],  // 只留 key，value 一律丢弃
  requestBytes?, status?, durationMs?, errorKind?, loopback?
}
```

### 硬性约束（违反即视为缺陷）

1. **绝不记录请求体、响应体、header、query 的 value。** query value 是凭据最常见的位置。
2. **绝不记录最终 URL 原文**（含 query 与 userinfo）。
3. 不记录任何本机绝对路径、workspace 路径、session id。
4. 本文件**不得**被任何上报通道读取（ARMS / 数仓 / 反馈 / 分享都不许引用本模块）。

## 失败语义

- 全链路 **fail-open**：记录失败绝不影响业务请求。所有写入包在 `try/catch` 内。
- 连续写入失败 3 次后**自禁用**（避免 IO 故障时变成刷盘风暴），并静默降级。
- 单日文件超过 64 MB 后停止写入当天剩余记录（不轮转、不删旧文件）。

## 保留与清理

- 每天轮转一个文件；保留 14 天，超出后由写进程清理（每进程每天最多清理一次）。
- 关闭开关：`ZCODE_EGRESS_JOURNAL_DISABLED=1`。

## 幂等与安装点

`installNetworkEgressInstrumentation()` 幂等（重复调用返回 `false`），在三个进程启动早期各安装一次：

| 进程         | 安装点                                                                          | 覆盖内容                                                 |
| ------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Desktop main | `packages/desktop/src/main/index.ts`（`desktopEarlyDataBaseDirBootstrap` 之后） | 配置拉取、更新 CDN、远端资源、浏览器数据导入             |
| Local Host   | `packages/desktop/src/host/index.ts`                                            | bots（飞书/Telegram/微信）、反馈上传、会话分享、MCP 配置 |
| Agent CLI    | `apps/zcode-cli/packages/bootstrap/src/index.ts`                                | **模型对话**、WebFetch、MCP、插件市场下载                |

## 验收场景

1. 启动 Desktop（dev 或打包版）后，`~/.zcode/egress/egress-<today>.jsonl` 存在且包含启动期请求（如插件市场 / 配置拉取）。
2. 发起一次模型对话后，journal 出现 `host` 为模型服务商、`path` 为接口路径的记录，且**不含** prompt 内容。
3. 带 query 的请求（如 `/api/v1/client/configs?app_version=…&platform=…`）只留 `queryKeys`，无 value。
4. 断开网络 / 目录不可写时，业务请求仍成功，journal 静默降级。
5. `ZCODE_EGRESS_JOURNAL_DISABLED=1` 时不产生文件。

## 迁移边界

纯新增通道，不改动任何既有协议、服务接口或状态所有者；关闭开关即可完全恢复到引入前的行为。

## 文件名与时间戳（易踩）

- 文件名用**本机本地日期**（`egress-YYYY-MM-DD.jsonl`），符合“今天”的直觉。
- 记录内 `ts` 用 **ISO UTC**，例如本地 `2026-09-26 00:43` 写作 `2026-09-25T16:43:31.010Z`。
- 因此挑文件时必须按本地日期计算；按 UTC 会错一天（本地 00:00–08:00 区间最容易踩）。
