/**
 * @file 本机出网流水账（append-only JSONL，只写本机、永不上传）。
 *
 * 目的：把「哪些数据离开了这台机器」变成可事后审计的本地事实，而不是靠读代码推断。
 * 安全前提（硬性约束，改动前先读 specs/egress-journal.md）：
 * 只记录「谁、往哪、多大、结果如何」，**绝不记录请求体/响应体/header/query 的 value**，
 * 也绝不记录最终 URL 原文（query 里最常出现凭据）。本模块不得被任何上报通道引用。
 *
 * Node-only：浏览器侧（renderer/web）不得导入本文件。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EgressProcessRole = "main" | "host" | "agent" | "server" | "unknown";

export type EgressTransport = "fetch" | "http" | "https";

export interface EgressRecord {
  /** ISO 时间戳 */
  ts: string;
  /** 进程内自增序号，用于判断是否有记录丢失 */
  seq: number;
  pid: number;
  role: EgressProcessRole;
  transport: EgressTransport;
  method: string;
  /** 只含 host[:port]；URL 的 userinfo 不会进入该字段 */
  host: string;
  /** 只含 pathname */
  path: string;
  /** query 的 key 列表（value 一律丢弃） */
  queryKeys?: string[];
  /** 已知时才有值；流式 body 无法在不消费的情况下测量 */
  requestBytes?: number;
  status?: number;
  durationMs?: number;
  errorKind?: string;
  /** 目标是回环/私网地址。注意 127.0.0.1:<proxyPort> 表示走了本机代理，属真实出网路径 */
  loopback?: boolean;
}

export type EgressRecordInput = Omit<EgressRecord, "ts" | "seq" | "pid" | "role">;

export type EgressJournal = (input: EgressRecordInput) => void;

const RETENTION_DAYS = 14;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FAILURE_LIMIT = 3;
const FILE_NAME_RE = /^egress-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const PRIVATE_HOST_RE =
  /^(localhost|127\.|::1|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/i;

/** 出网记录的最终目录：显式环境变量 > ZCODE_HOME > ~/.zcode，再拼 /egress。 */
export function resolveEgressJournalDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ZCODE_EGRESS_JOURNAL_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const home = env.ZCODE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".zcode");
  return join(home, "egress");
}

/**
 * 把任意 URL 归约成可安全落盘的形态：只留 host、pathname 与 query 的 key。
 * 解析失败返回 null（调用方应跳过记录，而不是退化成记录原文）。
 */
export function redactEgressTarget(rawUrl: string): {
  host: string;
  path: string;
  queryKeys?: string[];
  loopback: boolean;
} | null {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const queryKeys = [...new Set(url.searchParams.keys())].sort();
    return {
      host: url.host,
      path: url.pathname || "/",
      ...(queryKeys.length > 0 ? { queryKeys } : {}),
      loopback: PRIVATE_HOST_RE.test(hostname),
    };
  } catch {
    return null;
  }
}

function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function readFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** 清理超过保留期的旧文件；每进程每天最多执行一次（由 ensureReady 的日切换驱动）。 */
function pruneOldFiles(dir: string, today: string): void {
  try {
    const cutoff = Date.parse(`${today}T00:00:00.000Z`) - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      const match = FILE_NAME_RE.exec(name);
      if (!match) {
        continue;
      }
      const stamp = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isFinite(stamp) && stamp < cutoff) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // 清理失败不影响写入
  }
}

/**
 * 创建本进程的 journal sink。返回的函数**永不抛错**：
 * 记录失败最多到 FAILURE_LIMIT 次即自禁用，避免磁盘故障时变成刷盘风暴。
 */
export function createEgressJournal(options: {
  role: EgressProcessRole;
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): EgressJournal {
  const env = options.env ?? process.env;
  if (env.ZCODE_EGRESS_JOURNAL_DISABLED === "1") {
    return () => {};
  }
  const now = options.now ?? (() => new Date());
  const dir = options.dir?.trim() || resolveEgressJournalDir(env);

  let day = "";
  let filePath = "";
  let fileBytes = 0;
  let seq = 0;
  let failures = 0;
  let disabled = false;
  let prepared = false;

  const ensureReady = (): boolean => {
    const today = formatDay(now());
    if (prepared && today === day) {
      return true;
    }
    day = today;
    filePath = join(dir, `egress-${today}.jsonl`);
    // 标记 prepared：即使 mkdir 失败也不对同一逻辑反复重试（写失败由 failures 计数兜底）。
    prepared = true;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return false;
    }
    fileBytes = readFileSize(filePath);
    pruneOldFiles(dir, today);
    return true;
  };

  return (input: EgressRecordInput): void => {
    if (disabled) {
      return;
    }
    try {
      if (!ensureReady() || fileBytes >= MAX_FILE_BYTES) {
        return;
      }
      seq += 1;
      const record: EgressRecord = {
        ts: now().toISOString(),
        seq,
        pid: process.pid,
        role: options.role,
        ...input,
      };
      const line = `${JSON.stringify(record)}\n`;
      // 单次 write + O_APPEND：多进程追加同一文件时按行不交错。
      appendFileSync(filePath, line, { encoding: "utf8", flag: "a" });
      fileBytes += Buffer.byteLength(line);
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= FAILURE_LIMIT) {
        disabled = true;
      }
    }
  };
}
