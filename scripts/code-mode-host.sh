#!/bin/sh
# Installs Codex's codex-code-mode-host, which OpenAI's code-mode models run their scripts in,
# from the pinned Codex release into DIR (default: $NISSE_HOME/bin, or ~/.nisse/bin), checked
# against the release's SHA-256. Prints the installed path.

set -eu

RELEASE="rust-v0.164.0"
DIR="${1:-${NISSE_HOME:-$HOME/.nisse}/bin}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TARGET=x86_64-unknown-linux-musl
    SHA256=3ec55053109608d5038f7e50750f7d25f768dfd740fef071aa710e2559b63aac ;;
  Linux-aarch64 | Linux-arm64) TARGET=aarch64-unknown-linux-musl
    SHA256=5918add6c7e9cf1e14a9af1b4c0f4bf1d24a43903faac26df5dc4c019ea91bd5 ;;
  Darwin-arm64) TARGET=aarch64-apple-darwin
    SHA256=dd99e9092270691a67bdde7be04ac283dea9da8e86cbde356c2cc851a79205fa ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin
    SHA256=cfb2a9988d7ea448511166a35789af07a0065d1117db54350b17d46cf03d0294 ;;
  *) echo "no Codex release for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$DIR/codex-code-mode-host" ] && [ "$(cat "$DIR/codex-code-mode-host.release" 2>/dev/null)" = "$RELEASE" ]; then
  echo "$DIR/codex-code-mode-host"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="codex-package-$TARGET.tar.gz"
curl -fsSL --retry 3 -o "$WORK/$ARCHIVE" \
  "https://github.com/openai/codex/releases/download/$RELEASE/$ARCHIVE"
if command -v sha256sum >/dev/null; then
  ACTUAL="$(sha256sum "$WORK/$ARCHIVE" | cut -d' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "$WORK/$ARCHIVE" | cut -d' ' -f1)"
fi
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "$ARCHIVE has SHA-256 $ACTUAL, expected $SHA256" >&2
  exit 1
fi
tar -xzf "$WORK/$ARCHIVE" -C "$WORK" bin/codex-code-mode-host
mkdir -p "$DIR"
mv "$WORK/bin/codex-code-mode-host" "$DIR/codex-code-mode-host.$$"
mv "$DIR/codex-code-mode-host.$$" "$DIR/codex-code-mode-host"
echo "$RELEASE" > "$DIR/codex-code-mode-host.release"
echo "$DIR/codex-code-mode-host"
