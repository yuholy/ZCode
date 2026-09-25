#!/usr/bin/env node
/* eslint-disable max-lines -- 审计脚本的三段（取范围、解 hunk、跑规则）耦合紧密，拆开反而更难核对。 */
/**
 * 上游变更的「新增出网调用」审计。
 *
 * 为什么需要它：同步上游时，真正危险的不是功能改动，而是悄悄新增的上报/上传调用点。
 * 本脚本只盯 git diff 的**新增行**，把 fetch/http/WebSocket/域名常量等出网点全部列出来，
 * 与人审相比不会漏掉藏在 1000 行改动里的那一个 beacon。
 *
 * 用法：
 *   node scripts/audit-upstream-network-diff.mjs                     # 默认审计最近一次 origin/main 更新
 *   node scripts/audit-upstream-network-diff.mjs v3.14.0 origin/main # 指定范围
 *   node scripts/audit-upstream-network-diff.mjs --range a..b        # 等价写法
 *   node scripts/audit-upstream-network-diff.mjs --json              # 机器可读输出
 *
 * 退出码：0 = 审计完成；1 = 范围解析失败（ref 不存在等）。
 */
import { execFileSync } from "node:child_process";

/** 网络调用点规则；label 用于人工判断优先级。 */
const CALL_PATTERNS = [
  { re: /\bfetch\s*\(/, label: "fetch()" },
  { re: /\bhttps?\.(request|get)\s*\(/, label: "Node http(s) 请求" },
  { re: /\bnet\.fetch\s*\(/, label: "Electron net.fetch" },
  { re: /\bnet\.connect\s*\(|\btls\.connect\s*\(/, label: "原生 TCP/TLS 连接" },
  { re: /\baxios\b|\bgot\s*\(|\bundici\b|\bky\s*\(|\bsuperagent\b/, label: "HTTP 客户端库" },
  {
    re: /new\s+WebSocket\s*\(|new\s+EventSource\s*\(|XMLHttpRequest/,
    label: "长连接 / 浏览器出网",
  },
  { re: /navigator\.sendBeacon|new\s+Image\s*\(\s*\)/, label: "隐性上报（beacon / 像素）" },
  { re: /\bdgram\.createSocket\s*\(|\bdns\.(resolve|lookup)\w*\s*\(/, label: "DNS / UDP" },
];

/** 新增行里出现的远端地址：通常就是新上报点或新依赖端点。 */
const URL_RE = /https?:\/\/[^\s"'`)\\]+,?/g;

/** 常见且无争议的地址，用于给「域名清单」降噪。 */
const IGNORED_URL_PATTERNS = [
  /^https?:\/\/(www\.)?w3\.org/i,
  /^https?:\/\/json-schema\.org/i,
  /^https?:\/\/(localhost|127\.0\.0\.1)/i,
  /^https?:\/\/example\.(com|org)/i,
  /^https?:\/\/(www\.)?github\.com\/(zai-org|yuholy)\//i,
];

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** 解析审计范围：显式参数 > --range > 最近一次 origin/main 更新（reflog）> 最近一次 HEAD 移动。 */
function resolveRange(argv) {
  const rangeFlagIndex = argv.indexOf("--range");
  if (rangeFlagIndex >= 0) {
    const value = argv[rangeFlagIndex + 1] ?? "";
    const [base, head] = value.split("..");
    if (!base || !head) throw new Error(`--range 需要 base..head 形式，收到: ${value}`);
    return { base, head, source: "--range 参数" };
  }

  const positional = argv.filter((arg) => !arg.startsWith("--"));
  if (positional.length >= 2) {
    return { base: positional[0], head: positional[1], source: "命令行参数" };
  }
  if (positional.length === 1) {
    return { base: positional[0], head: "HEAD", source: "命令行参数（base..HEAD）" };
  }

  if (refExists("origin/main@{1}")) {
    return { base: "origin/main@{1}", head: "origin/main", source: "origin/main 最近一次更新" };
  }
  if (refExists("HEAD@{1}")) {
    return { base: "HEAD@{1}", head: "HEAD", source: "HEAD 最近一次移动" };
  }
  throw new Error("无法推断审计范围，请显式传入 <base> <head>");
}

/**
 * 解析 git diff -U0 的新增行。
 * 用 -U0 的原因：diff 里只剩增删行，新增行的行号可由 hunk 头直接推导，无需跟踪上下文。
 */
function parseAddedLines(diffText) {
  const added = [];
  let file = null;
  let nextLine = 0;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      nextLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ file, line: nextLine, text: line.slice(1) });
      nextLine += 1;
      continue;
    }
    // -U0 下不存在上下文行；删除行不推进新文件行号。
  }
  return added;
}

function auditFileContent(file, text, lineNumber) {
  const findings = [];
  for (const pattern of CALL_PATTERNS) {
    if (pattern.re.test(text)) {
      findings.push({
        kind: "call",
        label: pattern.label,
        file,
        line: lineNumber,
        text: text.trim(),
      });
    }
  }
  const urls = text.match(URL_RE) ?? [];
  for (const url of urls) {
    const cleaned = url.replace(/[",;]+$/, "");
    if (IGNORED_URL_PATTERNS.some((ignored) => ignored.test(cleaned))) continue;
    findings.push({ kind: "url", label: "远端地址", file, line: lineNumber, text: cleaned });
  }
  return findings;
}

function summarizeDomains(findings) {
  const domains = new Map();
  for (const finding of findings) {
    if (finding.kind !== "url") continue;
    try {
      const host = new URL(finding.text).host;
      domains.set(host, (domains.get(host) ?? 0) + 1);
    } catch {
      // 拼接出来的地址（如 `${base}/path`）解析失败时跳过，不作为域名条目。
    }
  }
  return [...domains.entries()].sort((left, right) => right[1] - left[1]);
}

function printReport(range, findings) {
  console.log(`\n=== 上游新增出网调用审计 ===`);
  console.log(`范围: ${range.base}..${range.head}（${range.source}）`);
  console.log(`新增行命中: ${findings.length}\n`);

  if (findings.length === 0) {
    console.log("未发现新增的网络调用或远端地址。\n");
    return;
  }

  const byFile = new Map();
  for (const finding of findings) {
    const list = byFile.get(finding.file) ?? [];
    list.push(finding);
    byFile.set(finding.file, list);
  }

  for (const [file, list] of byFile) {
    console.log(`${file}`);
    for (const finding of list) {
      const text = finding.text.length > 110 ? `${finding.text.slice(0, 110)}…` : finding.text;
      console.log(`   L${finding.line}  [${finding.label}]  ${text}`);
    }
    console.log("");
  }

  const domains = summarizeDomains(findings);
  if (domains.length > 0) {
    console.log("--- 涉及的远端域名（按出现次数）---");
    for (const [host, count] of domains) console.log(`   ${count}×  ${host}`);
    console.log("");
  }

  console.log("下一步：逐条确认是否为本 fork 可接受的出网；新增上报/上传点应关闭或加入白名单。\n");
}

function main() {
  const argv = process.argv.slice(2);
  const range = resolveRange(argv);
  if (!refExists(range.base)) throw new Error(`base ref 不存在: ${range.base}`);
  if (!refExists(range.head)) throw new Error(`head ref 不存在: ${range.head}`);

  const diffText = git(["diff", "-U0", `${range.base}..${range.head}`]);
  const added = parseAddedLines(diffText);
  const findings = added.flatMap((entry) => auditFileContent(entry.file, entry.text, entry.line));

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ range, addedLineCount: added.length, findings }, null, 2));
    return;
  }
  printReport(range, findings);
}

try {
  main();
} catch (error) {
  console.error(
    `[audit-upstream-network-diff] 审计失败: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
