/**
 * @file 出网拦截：给 `globalThis.fetch` 与 `node:http/https.request/get` 挂上观测钩子，
 * 把每次出网的「谁、往哪、多大、结果如何」交给 egressJournal 落盘。
 *
 * 设计约束（改动前先读 specs/egress-journal.md）：
 * 1. **只看不改**：原函数一律原样转发、原样返回；记录逻辑全都包在 try/catch 内，失败绝不影响请求。
 * 2. 拿不到可安全描述的 URL 时**跳过记录**，而不是退化成记录 URL 原文。
 * 3. 不消费任何 body（流式 body 不测量大小），避免改变语义。
 *
 * Node-only：浏览器侧不得导入本文件。
 */
import http from "node:http";
import https from "node:https";
import {
  createEgressJournal,
  redactEgressTarget,
  type EgressJournal,
  type EgressProcessRole,
  type EgressRecordInput,
  type EgressTransport,
} from "./egressJournal.js";

/** 归一化后的出网目标（已抹掉 query value 与 userinfo）。 */
interface EgressTarget {
  host: string;
  path: string;
  queryKeys?: string[];
  loopback: boolean;
}

interface DescribedRequest {
  target: EgressTarget;
  method: string;
  bodyBytes?: number;
}

type FetchLike = (input: unknown, init?: unknown) => Promise<{ status?: number }>;

const globalScope = globalThis as unknown as { fetch?: unknown };

let installed = false;

/**
 * 安装出网观测钩子。幂等：同一进程内重复调用返回 false。
 * 返回值只表示「本次是否完成安装」，不代表记录是否成功（记录始终 fail-open）。
 */
export function installNetworkEgressInstrumentation(options: {
  role: EgressProcessRole;
  dir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (installed) {
    return false;
  }
  installed = true;
  const journal = createEgressJournal({
    role: options.role,
    ...(options.dir ? { dir: options.dir } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  installFetchHook(journal);
  installNodeHook(journal, http as unknown as Record<string, unknown>, "http");
  installNodeHook(journal, https as unknown as Record<string, unknown>, "https");
  return true;
}

function classifyError(error: unknown): string {
  const code =
    typeof (error as { code?: unknown } | null)?.code === "string"
      ? String((error as { code?: string }).code).toLowerCase()
      : "";
  const haystack =
    `${code} ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`.toLowerCase();
  if (
    haystack.includes("timeout") ||
    haystack.includes("timed out") ||
    haystack.includes("etimedout")
  ) {
    return "timeout";
  }
  if (haystack.includes("enotfound") || haystack.includes("eai_again")) {
    return "dns_failure";
  }
  if (haystack.includes("econnreset")) {
    return "connection_reset";
  }
  if (haystack.includes("econnrefused")) {
    return "connection_refused";
  }
  if (haystack.includes("cert") || haystack.includes("tls") || haystack.includes("ssl")) {
    return "tls_error";
  }
  if (haystack.includes("abort")) {
    return "aborted";
  }
  return code || "other";
}

/** 只在能零成本测量时返回字节数；流式 body / FormData 一律返回 undefined。 */
function measureBodyBytes(body: unknown): number | undefined {
  if (typeof body === "string") {
    return Buffer.byteLength(body);
  }
  if (body instanceof URLSearchParams) {
    return Buffer.byteLength(body.toString());
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.size;
  }
  return undefined;
}

function readContentLength(headers: unknown): number | undefined {
  const get = (headers as { get?: unknown } | null)?.get;
  if (typeof get !== "function") {
    return undefined;
  }
  const raw = (get as (name: string) => unknown).call(headers, "content-length");
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function describeFetchRequest(input: unknown, init: unknown): DescribedRequest | null {
  const initRecord = (typeof init === "object" && init !== null ? init : {}) as {
    method?: unknown;
    body?: unknown;
  };
  const initMethod =
    typeof initRecord.method === "string" ? initRecord.method.toUpperCase() : undefined;
  const bodyBytes = measureBodyBytes(initRecord.body);

  if (typeof input === "string") {
    const target = redactEgressTarget(input);
    return target
      ? { target, method: initMethod ?? "GET", ...(bodyBytes !== undefined ? { bodyBytes } : {}) }
      : null;
  }
  if (input instanceof URL) {
    const target = redactEgressTarget(input.toString());
    return target
      ? { target, method: initMethod ?? "GET", ...(bodyBytes !== undefined ? { bodyBytes } : {}) }
      : null;
  }
  const requestLike = input as { url?: unknown; method?: unknown; headers?: unknown } | null;
  if (requestLike && typeof requestLike.url === "string") {
    const target = redactEgressTarget(requestLike.url);
    if (!target) {
      return null;
    }
    const requestMethod =
      typeof requestLike.method === "string" ? requestLike.method.toUpperCase() : "GET";
    const bytes = bodyBytes ?? readContentLength(requestLike.headers);
    return {
      target,
      method: initMethod ?? requestMethod,
      ...(bytes !== undefined ? { bodyBytes: bytes } : {}),
    };
  }
  return null;
}

function installFetchHook(journal: EgressJournal): void {
  const original = globalScope.fetch;
  if (typeof original !== "function") {
    return;
  }
  const originalFetch = original as FetchLike;

  const egressFetch = function (
    this: unknown,
    input: unknown,
    init?: unknown,
  ): Promise<{ status?: number }> {
    const described = describeFetchRequest(input, init);
    if (!described) {
      return originalFetch.call(this, input, init);
    }
    const base: Omit<EgressRecordInput, "durationMs"> = {
      transport: "fetch" satisfies EgressTransport,
      method: described.method,
      ...described.target,
      ...(described.bodyBytes !== undefined ? { requestBytes: described.bodyBytes } : {}),
    };
    const startedAt = Date.now();
    let pending: Promise<{ status?: number }>;
    try {
      pending = originalFetch.call(this, input, init);
    } catch (error) {
      journal({ ...base, durationMs: Date.now() - startedAt, errorKind: classifyError(error) });
      throw error;
    }
    return pending.then(
      (response) => {
        journal({
          ...base,
          ...(typeof response?.status === "number" ? { status: response.status } : {}),
          durationMs: Date.now() - startedAt,
        });
        return response;
      },
      (error: unknown) => {
        journal({ ...base, durationMs: Date.now() - startedAt, errorKind: classifyError(error) });
        throw error;
      },
    );
  };

  try {
    Object.defineProperty(egressFetch, "name", { value: "fetch" });
  } catch {
    // 名称不可写不影响功能
  }
  globalScope.fetch = egressFetch;
}

/** 从 `http.request(url[, options][, cb])` 或 `http.request(options[, cb])` 归一化出目标。 */
function describeNodeRequest(
  args: readonly unknown[],
  isGetCall: boolean,
): DescribedRequest | null {
  const [first, second] = args;
  let href: string | null = null;
  let options: Record<string, unknown> | null = null;

  if (typeof first === "string" || first instanceof URL) {
    href = first instanceof URL ? first.toString() : first;
    if (typeof second === "object" && second !== null) {
      options = second as Record<string, unknown>;
    }
  } else if (typeof first === "object" && first !== null) {
    options = first as Record<string, unknown>;
    href = buildHrefFromOptions(options);
  }
  if (!href) {
    return null;
  }
  const target = redactEgressTarget(href);
  if (!target) {
    return null;
  }
  const rawMethod =
    typeof options?.method === "string" ? options.method : isGetCall ? "GET" : "GET";
  return { target, method: rawMethod.toUpperCase() };
}

function buildHrefFromOptions(options: Record<string, unknown>): string | null {
  const protocol = typeof options.protocol === "string" ? options.protocol : undefined;
  const hostname = typeof options.hostname === "string" ? options.hostname : undefined;
  const host = typeof options.host === "string" ? options.host : undefined;
  const authority = hostname ?? host;
  if (!protocol && !authority) {
    return null;
  }
  const port =
    options.port === undefined || options.port === null
      ? ""
      : String(options.port as string | number);
  const path = typeof options.path === "string" && options.path.length > 0 ? options.path : "/";
  const withPort =
    authority === undefined
      ? ""
      : authority.includes(":") || port === ""
        ? authority
        : `${authority}:${port}`;
  return `${protocol ?? "http:"}//${withPort}${path}`;
}

function installNodeHook(
  journal: EgressJournal,
  moduleRecord: Record<string, unknown>,
  transport: EgressTransport,
): void {
  // get 在 Node 内部调用的是模块作用域内的 request，不会走被替换的导出属性，
  // 因此两个入口都要单独包装；否则 http.get 会整片漏记。
  for (const methodName of ["request", "get"]) {
    const original = moduleRecord[methodName];
    if (typeof original !== "function") {
      continue;
    }
    const originalFn = original as (...args: unknown[]) => unknown;
    moduleRecord[methodName] = function (this: unknown, ...args: unknown[]): unknown {
      // 先原样转发，保证请求语义与返回值完全不变。
      const request = originalFn.apply(this, args);
      try {
        observeNodeRequest(
          journal,
          transport,
          request,
          describeNodeRequest(args, methodName === "get"),
        );
      } catch {
        // fail-open：观测失败不得影响请求
      }
      return request;
    };
  }
}

function observeNodeRequest(
  journal: EgressJournal,
  transport: EgressTransport,
  request: unknown,
  described: DescribedRequest | null,
): void {
  if (!described || typeof request !== "object" || request === null) {
    return;
  }
  const once = (request as { once?: unknown }).once;
  if (typeof once !== "function") {
    return;
  }
  const register = once as (event: string, listener: (...listenerArgs: unknown[]) => void) => void;
  const startedAt = Date.now();
  const base: Omit<EgressRecordInput, "durationMs"> = {
    transport,
    method: described.method,
    ...described.target,
    ...(described.bodyBytes !== undefined ? { requestBytes: described.bodyBytes } : {}),
  };
  let settled = false;
  const emit = (extra: Partial<EgressRecordInput>): void => {
    if (settled) {
      return;
    }
    settled = true;
    journal({ ...base, ...extra, durationMs: Date.now() - startedAt });
  };

  register.call(request, "response", (response: unknown) => {
    const status = (response as { statusCode?: unknown } | null)?.statusCode;
    emit(typeof status === "number" ? { status } : {});
  });
  register.call(request, "error", (error: unknown) => emit({ errorKind: classifyError(error) }));
  // close 在正常收流后也会触发；此时 settled 已为 true，只有提前中断才会落到这里。
  register.call(request, "close", () => emit({ errorKind: "aborted" }));
}
