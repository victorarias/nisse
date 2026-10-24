#!/bin/sh
# Runs one task in code mode twice, once with Nisse's tool names and once with
# Codex's, recording each exchange for comparison.
set -eu
task=${1:?usage: scripts/compare-nested-tools.sh 'task' [model]}
model=${2:-gpt-6.1-sol}
root=$(cd "$(dirname "$0")/.." && pwd)
out=${NISSE_COMPARE_DIR:-$(mktemp -d)}
cargo build -q --manifest-path "$root/Cargo.toml" -p nisse
"$root/scripts/code-mode-host.sh" >/dev/null
for flavor in claude-code codex; do
  work="$out/$flavor/work"
  mkdir -p "$work" "$out/$flavor/record"
  git -C "$root" archive HEAD | tar -x -C "$work"
  echo "== $flavor"
  (cd "$work" && NISSE_NESTED_TOOLS=$flavor NISSE_RECORD="$out/$flavor/record" \
    "$root/target/debug/nisse" --provider openai --model "$model" exec "$task" \
    </dev/tty | tee "$out/$flavor/transcript.txt")
done
echo "recordings and transcripts in $out"
