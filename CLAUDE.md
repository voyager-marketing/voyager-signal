# CLAUDE.md — voyager-signal

> Mission file for Claude Code and Managed Agents.
> Read this at the start of every session before taking any action.

## Project identity

- **Repo:** voyager-marketing/voyager-signal
- **Type:** tooling (browser extension + enrichment pipeline)
- **Status:** Active — Phase 1 in progress
- **Notion page:** https://www.notion.so/ (update after creation)
- **Production:** Chrome Web Store (unpublished, internal use)

## What this project is

voyager-signal is Voyager Marketing's AI-powered intake and signal intelligence system.
It is a "tentacle" — a sensing and capture layer that feeds the Voyager brain.

Three components work together:
1. **`extension/`** — Chrome/Edge MV3 browser extension ("Save to Voyager")
2. **`enrichment/`** — n8n workflow JSON (Claude scoring + Notion writing + signal routing)
3. **`scripts/`** — dev utilities, packaging, and deploy helpers

The extension captures authenticated content (X threads, Substack, LinkedIn, newsletters,
paywalled articles) that server-side scrapers cannot reach. It uses Readability.js against
the live authenticated DOM — no credentials required on the server side.

## Voyager context

- **Team:** Ben (lead), Alex (delivery) — see voyager-team-context skill
- **Stack relationship:** Extension → n8n webhook → Notion Media Vault → Claude enrichment → Signal routing → Slack/Tasks
- **Notion database:** Media Vault (collection://81eb2b5a-05f6-433e-8c89-0d7c78cb798e)
- **Signal routing target:** Slack DM for score 5, weekly digest for score 4

## Tech stack

- **Extension:** Chrome MV3, Vanilla JS (no build step — keep it simple), Readability.js (Mozilla), Manifest V3
- **Enrichment:** n8n (self-hosted at voyagermarketing.app.n8n.cloud), Claude API (claude-sonnet-4-6)
- **Storage:** Notion API (Media Vault database)
- **Notifications:** Slack webhooks
- **Dev tools:** Node.js for packaging script only

## Scope — what you may touch

The agent loop ONLY modifies files in these paths:
- `extension/` — all extension JS, HTML, CSS, manifest
- `enrichment/` — n8n workflow JSON exports
- `scripts/` — build and packaging scripts
- `docs/` — architecture and API documentation

**Never touch:** `.claude/`, `CLAUDE.md`, `icons/` (production assets), Chrome Web Store config

## Fitness metric

**Primary signal:** Extension loads in Chrome without errors + popup renders + captures content from a test URL

After every experiment:
1. Run: `node scripts/validate.js` (lints manifest, checks required fields, validates JS syntax)
2. If clean → `git commit -m "exp: {hypothesis} | result: {delta}"`
3. If errors → `git checkout -- .`
4. Log to Notion experiment log
5. Propose next hypothesis → repeat

## Agent budget

- **Session limit:** 30 experiments or 90 minutes, whichever comes first
- **Model:** claude-sonnet-4-6 for main agent, haiku for parallel workers
- **Isolation:** worktree for all file-modifying subagents

## Sub-orchestration

### Notion
- **Task queue:** (add URL after Notion page created)
- **Experiment log:** (add URL after Notion page created)
- **Project page:** (add URL after Notion page created)

### Slack
- Post session summary when Stop hook fires
- Channel: #dev or DM to Ben
- Format: "✅ {n} experiments | {delta} on fitness | PR #{n} ready"

### n8n
- `agent-ready` label on GitHub → dispatch new session
- Slack ✅ reaction → auto-merge

## Tool permissions

```json
{
  "allow": ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch"],
  "deny": ["github_force_push", "github_delete_repo"]
}
```

## Commit convention

Conventional Commits. Scopes: `ext` (extension), `enrichment` (n8n), `scripts`, `docs`
Experiment commits: `exp(ext): {hypothesis} | {result}`

## Key contacts

- Ben: ben@voyagermark.com — final approval on all PRs
- Alex: alex@voyagermark.com — delivery/UX feedback
