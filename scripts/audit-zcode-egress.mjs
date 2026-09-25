#!/usr/bin/env node
/* eslint-disable max-lines -- 审计脚本集中维护进程发现、连接采集、域名解析与分级输出，拆文件会让排障时多跳一次。 */
/**
 * ZCode 出网审计：列出本机所有 ZCode 相关进程的 TCP 连接、对端域名与风险分级。
 *
 * 为什么需要它：代码层的隐私改造（遥测开关、UI 精简）无法证明「运行时真的没有多余出网」。
 * 唯一可信的证据是进程级连接快照：跑一次本脚本，就能看到此刻 ZCode 到底连了谁。
 *
 * 用法：
 *   node scripts/audit-zcode-egress.mjs              # 人类可读报告（含反向域名解析）
 *   node scripts/audit-zcode-egress.mjs --no-resolve # 跳过 DNS 反解（离线/更快）
 *   node scripts/audit-zcode-egress.mjs --json       # 机器可读输出
 *   node scripts/audit-zcode-egress.mjs --watch 30   # 每 30 秒重复输出一次
 *
 * 退出码：0 = 采集完成（即使发现可疑连接）；1 = 环境不支持（缺 lsof/ps）。
 */
import { execFileSync } from "node:child_process";
import { reverse } from "node:dns/promises";

/**
 * 进程命令行匹配：覆盖桌面端（打包/开发）与其派生的 Host / Agent / MCP 子进程。
 * 注意：macOS 的 ps 对 app 主进程只输出可执行名（`ZCode` / `ZCode Dev`），没有路径，
 * 所以主进程、Host、Agent 必须按「进程名」匹配，不能只匹配 .app 路径 —— 漏掉这三个
 * 就等于漏掉真正在调模型 API 和 MCP 的进程，审计会给出「零出网」的假安全感。
 */
const PROCESS_PATTERNS = [
  /^ZCode( Dev)?$/, // 桌面端主进程
  /ZCode( Dev)?\.app\//i, // Electron 子进程（--type=renderer/gpu/utility）
  /\bzcode-cli\b/i, // Agent 运行时
  /\bzcode-host-local\b/i, // 每窗口一个的 Local Host
  /\bzcode-node-repl-mcp\b/i, // 内置 MCP
  /\bzcode-runtime\b/i,
  /\bzcode\.cjs\b/i,
  /@zcode\/desktop/i, // 开发态 pnpm 启动器
];

/** 期望中的出网：用户自己配置的模型服务商、官方端点（配置拉取/分享/更新）、本机回环。 */
const EXPECTED_PATTERNS = [
  { re: /(^|\.)bigmodel\.(cn|com)$/i, label: "模型服务商（BigModel）" },
  { re: /(^|\.)z\.ai$/i, label: "模型服务商 / 官方端点（z.ai）" },
  { re: /^localhost$|^127\.|^::1$|^0\.0\.0\.0$/, label: "本机回环" },
];

/**
 * 明确不该出现的连接目标。命中即说明有未被关掉的出网通道（本 fork 的遥测应已全断）。
 * 注意：这里的判定只用于「提示人工确认」，不构成自动阻断。
 */
const SUSPICIOUS_PATTERNS = [
  { re: /aliyuncs\.com|arms\.|retcode/i, label: "阿里云 ARMS / 监控（本 fork 应无连接）" },
  { re: /sentry\.io|bugsnag|crashlytics|firebase|appcenter/i, label: "第三方崩溃 / 分析服务" },
  { re: /analytics|telemetry|tracking|beacon|metrics/i, label: "分析 / 遥测类域名" },
  { re: /datadog|newrelic|elastic|grafana/i, label: "可观测性平台" },
];

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
}

function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** 通过 ps 找到所有 ZCode 相关进程；排除本脚本自身。 */
function findZcodeProcesses() {
  const output = run("ps", ["-Ao", "pid=,command="]);
  const selfPid = String(process.pid);
  const found = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex < 0) continue;
    const pid = trimmed.slice(0, spaceIndex);
    const command = trimmed.slice(spaceIndex + 1);
    if (pid === selfPid) continue;
    if (command.includes("audit-zcode-egress")) continue;
    if (!PROCESS_PATTERNS.some((pattern) => pattern.test(command))) continue;
    found.push({ pid, command: shortenCommand(command) });
  }
  return found;
}

function shortenCommand(command) {
  const marker = command.indexOf(".app/Contents/");
  if (marker > 0) {
    const tail = command.slice(marker).split(" --")[0];
    return `${command.slice(0, marker).split("/").slice(-1)[0]}${tail}`;
  }
  return command.length > 140 ? `${command.slice(0, 140)}…` : command;
}

/**
 * 采集单个进程的 TCP 连接。lsof 的 -a 用于把 pid 与 TCP 两个筛选条件做「与」而非「或」。
 *
 * 必须用 -F 机器可读模式：默认列式输出里 NAME 是 `地址:端口->地址:端口`，状态 `(ESTABLISHED)`
 * 是**下一个空白分隔字段**，按列切会把它当成 NAME，导致每条连接都被判为「无远端」而静默丢弃。
 */
function readTcpConnections(pid) {
  let output;
  try {
    output = run("lsof", ["-nP", "-a", "-p", pid, "-i", "TCP", "-F", "pnT"]);
  } catch {
    // lsof 无匹配结果时退出码为 1，属正常情况。
    return [];
  }

  const connections = [];
  let name = null;
  let state = "";
  const flush = () => {
    if (!name) return;
    const [local, remote] = name.split("->");
    // 只上报「有对端」的连接：LISTEN 自身没有远端，不构成出网证据。
    if (remote) {
      const lastColon = remote.lastIndexOf(":");
      if (lastColon > 0) {
        const host = remote.slice(0, lastColon).replace(/^\[|\]$/g, "");
        connections.push({ pid, local, host, port: remote.slice(lastColon + 1), state });
      }
    }
    name = null;
    state = "";
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("n")) {
      flush();
      name = line.slice(1);
    } else if (line.startsWith("TST=")) {
      state = line.slice(4);
    }
  }
  flush();
  return connections;
}

async function resolveHostnames(hosts) {
  const result = new Map();
  await Promise.all(
    hosts.map(async (host) => {
      // 反向解析仅用于可读性，超时即放弃，不能拖慢审计本身。
      const lookup = reverse(host);
      const timeout = new Promise((resolve) => setTimeout(() => resolve([]), 1500));
      try {
        const names = await Promise.race([lookup, timeout]);
        result.set(host, Array.isArray(names) && names.length > 0 ? names[0] : null);
      } catch {
        result.set(host, null);
      }
    }),
  );
  return result;
}

function classify(name, host) {
  const haystack = name ?? host;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.re.test(haystack)) return { level: "suspicious", label: pattern.label };
  }
  for (const pattern of EXPECTED_PATTERNS) {
    if (pattern.re.test(haystack)) return { level: "expected", label: pattern.label };
  }
  return { level: "unknown", label: "未在预期清单中，请人工确认" };
}

async function collect(options) {
  const processes = findZcodeProcesses();
  const connections = processes.flatMap((proc) => readTcpConnections(proc.pid));
  const uniqueHosts = [...new Set(connections.map((conn) => conn.host).filter((host) => host))];
  const hostnames = options.resolve ? await resolveHostnames(uniqueHosts) : new Map();

  const rows = connections.map((conn) => {
    const name = hostnames.get(conn.host) ?? null;
    const verdict = classify(name, conn.host);
    return { ...conn, hostname: name, ...verdict };
  });

  return { processes, rows };
}

function printReport(processes, rows) {
  const timestamp = new Date().toISOString();
  console.log(`\n=== ZCode 出网审计 ${timestamp} ===`);
  console.log(`进程数: ${processes.length} / TCP 连接数: ${rows.length}\n`);

  if (processes.length === 0) {
    console.log("未发现运行中的 ZCode 进程（桌面端未启动？）\n");
    return;
  }

  const byPid = new Map();
  for (const row of rows) {
    const list = byPid.get(row.pid) ?? [];
    list.push(row);
    byPid.set(row.pid, list);
  }

  for (const proc of processes) {
    const own = byPid.get(proc.pid) ?? [];
    console.log(`[pid ${proc.pid}] ${proc.command}`);
    if (own.length === 0) {
      console.log("   (无出网连接)");
      continue;
    }
    for (const row of own) {
      const tag =
        row.level === "suspicious" ? "⚠ 可疑" : row.level === "expected" ? "· 预期" : "? 未知";
      const target = row.hostname
        ? `${row.host}:${row.port} (${row.hostname})`
        : `${row.host}:${row.port}`;
      console.log(`   ${tag}  ${target}  ${row.label}`);
    }
  }

  const suspicious = rows.filter((row) => row.level === "suspicious");
  const unknown = rows.filter((row) => row.level === "unknown");
  console.log("\n--- 汇总 ---");
  console.log(
    `可疑: ${suspicious.length}  未知: ${unknown.length}  预期: ${rows.length - suspicious.length - unknown.length}`,
  );
  if (suspicious.length > 0) {
    console.log("命中可疑目标（应为 0，请逐条确认）：");
    for (const row of suspicious) console.log(`  - ${row.host}:${row.port} — ${row.label}`);
  }
  if (unknown.some((row) => !row.hostname)) {
    // CDN/IP 直连普遍没有 PTR 记录，反解失败很正常；给出核查手段，避免「只有 IP」被当成「无法审计」。
    console.log(
      "提示：无 PTR 记录的 IP 属正常（CDN 常见），可用 `nslookup <ip>` 或 --json 导出后另查。",
    );
  }
  console.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    resolve: !argv.includes("--no-resolve"),
    json: argv.includes("--json"),
    watchSeconds: Number.parseInt(readFlagValue(argv, "--watch") ?? "", 10),
  };

  const once = async () => {
    const { processes, rows } = await collect(options);
    if (options.json) {
      console.log(JSON.stringify({ processes, connections: rows }, null, 2));
    } else {
      printReport(processes, rows);
    }
  };

  if (Number.isFinite(options.watchSeconds) && options.watchSeconds > 0) {
    // 观察模式：轮询快照，便于抓瞬时连接（如启动期的配置拉取）。
    for (;;) {
      await once();
      await new Promise((resolve) => setTimeout(resolve, options.watchSeconds * 1000));
    }
  }

  await once();
}

main().catch((error) => {
  console.error(
    `[audit-zcode-egress] 采集失败: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("依赖 ps/lsof（macOS 自带；Linux 需安装 lsof 或改用 ss）。");
  process.exitCode = 1;
});
