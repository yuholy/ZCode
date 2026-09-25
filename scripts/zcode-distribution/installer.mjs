const packageDirName = "zcode";

export function installScriptSource(baseUrl) {
  return `#!/usr/bin/env sh
set -eu

BASE_URL="\${ZCODE_DIST_BASE_URL:-${baseUrl}}"
INSTALL_DIR="\${ZCODE_DIST_HOME:-$HOME/.zcode/runtime}"
BIN_DIR="\${ZCODE_DIST_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "zcode install requires $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl
need_cmd tar

LATEST_JSON="$(curl -fsSL "\${BASE_URL%/}/latest.json")"
VERSION="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).version))")"
TARBALL="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).tarball))")"
SHA256="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).sha256??''))")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$TARBALL"
curl -fL "\${BASE_URL%/}/releases/$VERSION/$TARBALL" -o "$ARCHIVE"

# 校验归档完整性。注意：sha256 与归档同源，只能拦“归档被换但元数据没跟着换”以及传输损坏；
# 真正的防篡改需要对 sha256 本身做签名并固化公钥（见 specs/fork-changelog.md 的 P0-2）。
if [ "\${ZCODE_DIST_SKIP_SHA256:-}" = "1" ]; then
  echo "Warning: ZCODE_DIST_SKIP_SHA256=1 — skipping archive integrity check." >&2
else
  if [ -z "$SHA256" ]; then
    echo "latest.json has no sha256 field; refusing to install." >&2
    echo "Set ZCODE_DIST_SKIP_SHA256=1 to install anyway." >&2
    exit 1
  fi
  ACTUAL_SHA256="$(node -e 'const c=require("node:crypto"),f=require("node:fs");const h=c.createHash("sha256");f.createReadStream(process.argv[1]).on("data",d=>h.update(d)).on("end",()=>process.stdout.write(h.digest("hex")))' "$ARCHIVE")"
  if [ "$ACTUAL_SHA256" != "$SHA256" ]; then
    echo "sha256 mismatch: archive may have been tampered with" >&2
    echo "  expected $SHA256" >&2
    echo "  actual   $ACTUAL_SHA256" >&2
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"
TARGET="$INSTALL_DIR/releases/$VERSION"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
tar -xzf "$ARCHIVE" -C "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new/${packageDirName}" "$TARGET"
rm -rf "$TARGET.new"
ln -sfn "$TARGET" "$INSTALL_DIR/current"

cat > "$BIN_DIR/zcode" <<SH
#!/usr/bin/env sh
exec node "$INSTALL_DIR/current/bin/zcode.mjs" "\\$@"
SH
chmod +x "$BIN_DIR/zcode"

echo "ZCode $VERSION installed."
echo "Run: zcode (TUI) or zcode --web (Web)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH." ;;
esac
`;
}
