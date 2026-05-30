#!/bin/bash
# gws-keepalive.sh — daily liveness check for the Google Workspace (gws) OAuth token.
#
# Wired in as the pre_check of scheduled task d3ea7c15. The whole point: the
# "your auth is stale" alert must NOT depend on an LLM agent producing output.
# An earlier version asked the scheduled agent to compose+send the warning, and
# when the SDK returned empty text (see memory: sdk-empty-result-text) the alert
# silently vanished. Here the alert is sent deterministically with curl via
# notify.sh, so detection == delivery.
#
# Contract with the scheduler (src/scheduler.ts): a pre_check that exits 0 with
# EMPTY stdout makes the scheduler skip the LLM step entirely. This script never
# writes to stdout, so the LLM agent is always skipped — healthy or not. Zero
# tokens spent; the alert (when needed) goes out from here.
#
# Exit is always 0 on purpose: a non-zero exit would also skip the agent, but 0
# keeps the scheduler's run-status clean ("success") whether or not we alerted.

set -uo pipefail

# The vault agent runs as a systemd user service with a minimal PATH that omits
# user-installed bins (~/.npm-global/bin, where `gws` lives). Prepend them so
# `gws` resolves the same way it does in an interactive shell.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAUTH_FILE="/home/chaka/gws-auth-command.md"

# Cheapest authenticated call. Capture output so it never reaches our stdout.
gws tasks tasklists list --format json >/dev/null 2>&1
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  # Healthy. No stdout -> agent skipped, no alert. Done.
  exit 0
fi

# Failed (exit 2 = auth error; anything non-zero we treat as "needs attention").
# Send the alert straight to Telegram. Plain text, no HTML-special chars.
MSG="⚠️ gws auth is stale (check exited ${STATUS}). Your morning briefing's Google Tasks section and any other gws-backed features will be blank until you re-auth. Run the command saved in ${REAUTH_FILE} (open it in VS Code and paste it into a terminal). This is an interactive browser login — only you can complete it."

# notify.sh self-sources .env for the bot token + chat id and writes nothing to
# stdout, so our own stdout stays empty (agent stays skipped). Swallow its stderr.
"$SCRIPT_DIR/notify.sh" "$MSG" >/dev/null 2>&1 || true

exit 0
