import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";
import { ZCODE_ARMS_RUM_ENDPOINT, ZCODE_TELEMETRY_ENABLED } from "@zcode/shared";

// 须在 appARMSBootstrap 之前完成：先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// remoteCrashReporterEnabled=true 表示 ARMS 已接管远端 crash 上报，不再启动仅本地的 crashReporter。
//
// fork 策略：这个值原为硬编码 true，其前提是「ARMS 一定初始化」。本 fork 关掉了遥测总开关
// （ZCODE_TELEMETRY_ENABLED=false，且未配置 ARMS 端点），ARMS 从不初始化，继续传 true 会留出
// 「既无远端上报、也无本地 crashReporter」的空档：崩溃连本地 dump 都不落盘。
// 故改为按 ARMS 是否真的会初始化来推导，判据与 appARMSBootstrap 里 armsInitPromise 完全一致。
// 遥测关闭时走 desktopCrashCapture 的本地分支，其 submitURL 是保留域 (zcode.invalid)
// 且 uploadToServer:false，不产生任何上传。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(
  logger,
  ZCODE_TELEMETRY_ENABLED && Boolean(ZCODE_ARMS_RUM_ENDPOINT),
);
