import { installNetworkEgressInstrumentation } from "@zcode/shared/network-egress-instrumentation";

// 出网流水账（main 进程）。必须在任何业务请求之前安装，因此与其它早期 bootstrap 一起
// 在 index.ts 顶部被导入（顺序在 desktopEarlyDataBaseDirBootstrap 之后，以便拿到真实数据目录）。
// 只写本机 JSONL、永不上传；记录范围与安全约束见 specs/egress-journal.md。
installNetworkEgressInstrumentation({ role: "main" });
