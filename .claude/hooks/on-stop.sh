#!/bin/bash
# .claude/hooks/on-stop.sh
# Fires when a Claude Code session ends.
# Writes session notes to Notion project page + posts to #dev-agents in Slack.
# Requires: NOTION_TOKEN, SLACK_BOT_TOKEN env vars (or MCP credentials)

set -euo pipefail

PROJECT_NOTION_URL="${CLAUDE_PROJECT_NOTION_URL:-}"
SLACK_CHANNEL="C0AFC9W3UGH"   # #dev-agents
REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo 'unknown')")
BRANCH=$(git branch --show-current 2>/dev/null || echo 'unknown')
DATE=$(date +%Y-%m-%d)

# ── Read session summary if written by agent ──────────────────────────────────
SUMMARY_FILE=".claude/session-summary.md"
if [[ -f "$SUMMARY_FILE" ]]; then
  SUMMARY=$(cat "$SUMMARY_FILE")
else
  SUMMARY="Session complete. No summary file found at .claude/session-summary.md"
fi

# ── Count open PRs created this session ──────────────────────────────────────
PR_COUNT=$(git log --oneline "HEAD~10..HEAD" 2>/dev/null | wc -l | tr -d ' ')

# ── Post to #dev-agents via Slack MCP (Claude writes this) ───────────────────
# The agent itself should post using the Slack MCP at session end.
# This script provides the structured data for that post.
cat > .claude/session-log.json << JSONEOF
{
  "repo": "$REPO",
  "branch": "$BRANCH",
  "date": "$DATE",
  "summary": $(echo "$SUMMARY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))"),
  "commits": $PR_COUNT,
  "notion_project": "$PROJECT_NOTION_URL",
  "slack_channel": "$SLACK_CHANNEL"
}
JSONEOF

echo "Session log written to .claude/session-log.json"
echo "Agent should now:"
echo "  1. Post to #dev-agents using Slack MCP"
echo "  2. Write discoveries to Notion project page using Notion MCP"
echo "  3. Open PR via GitHub MCP if changes were made"
exit 0
