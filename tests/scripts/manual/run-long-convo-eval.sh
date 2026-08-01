#!/usr/bin/env bash
# Wrapper: launch the eval script with bun, redirect output to file.
set -e
cd "$(dirname "$0")/../../.."
exec bun run tests/scripts/manual/long-convo-eval.ts
