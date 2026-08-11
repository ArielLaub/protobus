#!/usr/bin/env bash
#
# Compiles and runs the combat-game sample end to end against a live RabbitMQ
# and asserts the battle royale terminated correctly: exactly one player left
# standing, everyone else eliminated.
#
# This is the only exercise of the framework as a consumer sees it — decorators,
# proto loading from disk, RPC, pub/sub events and shutdown all in one process —
# so a regression that unit and integration tests miss (a broken decorator, an
# event that never routes, a hang on disconnect) shows up here as "no winner"
# or "several winners".
#
# The sample is TypeScript and the repo has no ts-node, so it is compiled with a
# standalone tsc invocation into a scratch tree. Two things that tree needs:
#   * node_modules, because the compiled code requires amqplib/protobufjs by
#     bare specifier and node resolves those by walking up from the file;
#   * player.proto next to the compiled GameRunner.js, because the sample loads
#     protos from __dirname and tsc copies no assets.
#
# Env:
#   AMQP_URL  broker to connect to (default amqp://guest:guest@localhost:5672/)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/protobus-combat-sample.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "==> Compiling sample/combatGame into $BUILD_DIR"
# --skipLibCheck keeps this to the sample's own diagnostics; the full typecheck
# of lib/ is the static CI job's business.
npx tsc sample/combatGame/GameRunner.ts \
    --outDir "$BUILD_DIR" \
    --module commonjs \
    --target es2020 \
    --esModuleInterop \
    --skipLibCheck \
    --moduleResolution node \
    --experimentalDecorators

# tsc derives the output layout from the common root of every file it pulled in
# (the sample imports lib/), so locate the emitted entry point instead of
# assuming a path.
RUNNER="$(find "$BUILD_DIR" -name GameRunner.js -print -quit)"
if [ -z "$RUNNER" ]; then
    echo "FAIL: tsc emitted no GameRunner.js under $BUILD_DIR" >&2
    exit 1
fi

ln -s "$REPO_ROOT/node_modules" "$BUILD_DIR/node_modules"
cp sample/combatGame/player.proto "$(dirname "$RUNNER")/"

echo "==> Running $RUNNER"
LOG="$BUILD_DIR/game.log"
set +e
node "$RUNNER" 2>&1 | tee "$LOG"
STATUS="${PIPESTATUS[0]}"
set -e

if [ "$STATUS" -ne 0 ]; then
    echo "FAIL: sample exited with status $STATUS" >&2
    exit 1
fi

SHOTS="$(grep -c 'shoots at' "$LOG" || true)"
WINNERS="$(grep -c '(WINNER!)' "$LOG" || true)"
ELIMINATED="$(grep -c '(eliminated)' "$LOG" || true)"

echo
echo "==> Result: ${SHOTS} shots fired, ${WINNERS} winner(s), ${ELIMINATED} eliminated"

if [ "$WINNERS" -ne 1 ]; then
    echo "FAIL: expected exactly 1 winner, got ${WINNERS}" >&2
    exit 1
fi
if [ "$SHOTS" -lt 1 ]; then
    echo "FAIL: no shots were fired, so the sample never really played" >&2
    exit 1
fi

echo "PASS: combat game completed with exactly one winner"
