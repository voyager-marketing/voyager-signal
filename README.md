# 📡 Voyager Signal

AI-powered content intake system — a Chrome extension that captures web content from authenticated sessions, scores it with Claude, and writes enriched entries to a Notion knowledge brain.

## What it does

Voyager Signal solves the auth wall problem. X threads, Substack paid posts, LinkedIn articles, newsletters, and paywalled content that no server-side scraper can reach — the extension runs inside your authenticated browser session and captures what you're already reading.

**Pipeline:**
```
Browser → content.js (platform-aware extraction)
  → background.js (service worker)
    → Claude API (score 1-5 + deep synthesis)
    → Notion API (Media Vault with full page body)
    → Slack webhook (score-5 alerts)
```

**MCP Brain server** gives Claude Desktop/Code direct access to query, update, and export the knowledge base.

## Features

### Chrome Extension (`extension/`)
- **Multi-source extraction** — specialized parsers for X/Twitter threads, YouTube, Reddit, Substack, Medium, Gmail newsletters, generic webmail, plus 13 structured fallback selectors
- **Claude synthesis** — scores content 1-5, extracts key takeaways, action items, quotes, novelty detection, and cross-concept connections
- **Notion Media Vault** — writes enriched entries with full page body (synthesis, bullets, to-dos, blockquotes, metadata)
- **Auto-capture mode** — pattern-matching on URLs (e.g. `x.com/*/status`, `substack.com/p/`), toggleable with 2s debounce
- **Context menu** — right-click "Save to Voyager" + bulk link import
- **Keyboard shortcut** — `Alt+Shift+S`
- **Reliability** — retry with exponential backoff, offline queue, URL-based duplicate detection
- **Popup UI** — tag input with recent chips, content preview, score sparkline

### MCP Brain Server (`mcp/`)
7 tools for Claude Desktop/Code:
| Tool | Description |
|------|-------------|
| `search_brain` | Full-text search across the Media Vault |
| `get_recent` | Fetch recent captures, optionally filtered |
| `get_entry` | Read a single page with full synthesis |
| `get_high_signals` | Score 4-5 entries for a time window |
| `synthesize_topic` | Claude synthesizes across entries for a topic |
| `update_entry` | Patch score, tags, domain, or signal_type |
| `export_brain` | Export as markdown or CSV |

## Setup

### 1. Install the extension
```bash
# Clone the repo
git clone https://github.com/voyager-marketing/voyager-signal.git
```
1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select the `extension/` folder

### 2. Configure API keys
Open the extension popup → ⚙️ Settings:
- **Claude API Key** — for scoring and synthesis
- **Notion Token** + **Database ID** — Media Vault
- **Slack Webhook URL** — optional, for score-5 alerts

### 3. Register MCP server
```bash
cd mcp && npm install && node setup.js
```
Auto-registers `voyager-brain-mcp` in your Claude Desktop config (macOS, Windows, Linux).

### 4. Test
1. Navigate to any X post, Substack article, or LinkedIn post
2. Click the extension icon
3. Set a score → Save
4. Check Notion Media Vault for the enriched entry

## Tech stack

- **Extension:** Chrome MV3, Vanilla JS (no build step), Readability.js (Mozilla)
- **AI:** Claude API (claude-sonnet-4-6) for scoring and synthesis
- **Storage:** Notion API (Media Vault database)
- **Notifications:** Slack webhooks
- **MCP:** `@modelcontextprotocol/sdk` over STDIO transport

## Project structure

```
voyager-signal/
├── extension/
│   ├── manifest.json          # MV3 manifest
│   ├── popup/                 # Popup UI (HTML/CSS/JS)
│   ├── src/
│   │   ├── background.js      # Service worker — Claude + Notion + Slack pipeline
│   │   ├── content.js         # Platform-aware content extraction
│   │   └── readability.js     # Mozilla Readability.js
│   └── icons/                 # V lettermark (16/48/128px)
├── mcp/
│   ├── server.js              # Voyager Brain MCP server (7 tools)
│   └── setup.js               # Claude Desktop auto-registration
├── scripts/
│   ├── validate.js            # Manifest + JS lint
│   ├── test-e2e.js            # End-to-end capture tests
│   └── package.js             # Extension packaging
└── CLAUDE.md                  # Agent instructions
```

## Part of Voyager

Voyager Signal is one component of the [Voyager Marketing](https://voyagermark.com) platform — alongside [Orbit](https://github.com/voyager-marketing/voyager-orbit) (WordPress plugin), [Blocks](https://github.com/voyager-marketing/voyager-blocks) (Gutenberg blocks), [Core](https://github.com/voyager-marketing/voyager-core) (infrastructure), and [Portal](https://github.com/voyager-marketing/voyager-report) (Next.js client portal).
