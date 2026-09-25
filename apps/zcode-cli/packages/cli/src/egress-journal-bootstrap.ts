import { installNetworkEgressInstrumentation } from "@zcode/shared/network-egress-instrumentation";

// 出网流水账（agent CLI 进程）。CLI 是模型对话、WebFetch、MCP、插件下载的真正发起点，
// 必须在任何业务请求之前安装，故作为 main.ts 的第一个 import（TUI 与 app-server 两种模式同源）。
// 只写本机 JSONL、永不上传；记录范围与安全约束见 specs/egress-journal.md。
installNetworkEgressInstrumentation({ role: "agent" });
