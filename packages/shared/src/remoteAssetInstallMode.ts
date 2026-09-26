import { ZCODE_FORK_ENABLE_REMOTE_ASSET_DOWNLOAD } from "./forkPolicy.js";

export const REMOTE_ASSET_INSTALL_MODES = ["local-download-upload", "remote-download"] as const;

export type RemoteAssetInstallMode = (typeof REMOTE_ASSET_INSTALL_MODES)[number];

export const DEFAULT_REMOTE_ASSET_INSTALL_MODE: RemoteAssetInstallMode = "local-download-upload";

export function normalizeRemoteAssetInstallMode(
  mode?: RemoteAssetInstallMode | null,
): RemoteAssetInstallMode {
  return mode === "remote-download" ? mode : DEFAULT_REMOTE_ASSET_INSTALL_MODE;
}

/**
 * 可选的安装模式（供 UI 渲染）。fork 关闭「远端服务器下载」后只剩本地下载后上传。
 */
export function resolveEnabledRemoteAssetInstallModes(): RemoteAssetInstallMode[] {
  return ZCODE_FORK_ENABLE_REMOTE_ASSET_DOWNLOAD
    ? [...REMOTE_ASSET_INSTALL_MODES]
    : [DEFAULT_REMOTE_ASSET_INSTALL_MODE];
}

/**
 * 部署前把安装模式夹紧到实际允许的范围。
 * 这是唯一的执行点——UI 隐藏选项不构成约束，历史快照/持久化设置里仍可能带 remote-download。
 */
export function resolveEffectiveRemoteAssetInstallMode(
  mode?: RemoteAssetInstallMode | null,
): RemoteAssetInstallMode {
  if (!ZCODE_FORK_ENABLE_REMOTE_ASSET_DOWNLOAD) {
    return DEFAULT_REMOTE_ASSET_INSTALL_MODE;
  }
  return normalizeRemoteAssetInstallMode(mode);
}
