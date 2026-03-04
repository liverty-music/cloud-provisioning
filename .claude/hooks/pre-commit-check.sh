#!/usr/bin/env bash
# PreToolUse hook: runs `make check` before git commit.
# Exit 2 = block the tool call (stderr shown to Claude as reason).

COMMAND=$(jq -r '.tool_input.command' < /dev/stdin)

# Only act on git commit calls
if ! echo "$COMMAND" | grep -q 'git commit'; then
  exit 0
fi

make check
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Blocked: 'make check' failed (exit $EXIT_CODE). Fix errors before committing." >&2
  exit 2
fi

exit 0
