#!/bin/sh
# Live launcher for the `omakase` CLI: runs the TypeScript source directly via
# tsx, so edits to any @omakase/* package take effect immediately — no build.
#
# Install once (puts `omakase` on your PATH, tracking this repo):
#   ln -sf "$(pwd)/scripts/omakase.sh" ~/.local/bin/omakase   # run from repo root
# Then from anywhere:
#   omakase agents
#   cd ~/some-project && omakase run "summarize this project" --agent codex
#
# Uninstall: rm ~/.local/bin/omakase
#
# The CLI uses the *current working directory* as the project, so cd into the
# project you want it to operate on. After a dependency change, run `pnpm
# install` in this repo; pure code changes need nothing.
set -e

# Resolve this script's real path (it's usually invoked via a symlink on PATH)
# to locate the repo, so no absolute paths are baked in.
SELF="$0"
while [ -h "$SELF" ]; do
  link="$(readlink "$SELF")"
  case "$link" in
    /*) SELF="$link" ;;
    *) SELF="$(dirname "$SELF")/$link" ;;
  esac
done
REPO="$(cd "$(dirname "$SELF")/.." && pwd)"

TSX="$REPO/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "omakase: tsx not found at $TSX — run 'pnpm install' in $REPO" >&2
  exit 1
fi

exec node --conditions=development --import tsx "$REPO/packages/cli/src/dev.ts" "$@"
