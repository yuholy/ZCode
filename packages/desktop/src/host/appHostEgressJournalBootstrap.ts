import { installNetworkEgressInstrumentation } from "@zcode/shared/network-egress-instrumentation";

// 出网流水账（local Host 进程）。Host 承载 bots（飞书/Telegram/微信）、反馈上传、会话分享、
// MCP 配置等真实出网调用，必须在其它模块之前安装，故作为本入口的第一个 import。
// 只写本机 JSONL、永不上传；记录范围与安全约束见 specs/egress-journal.md。
installNetworkEgressInstrumentation({ role: "host" });
