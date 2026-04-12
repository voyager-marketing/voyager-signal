#!/usr/bin/env node

// ============================================================================
// Voyager Brain MCP — Claude Desktop Setup
// ============================================================================
//
// Usage:
//   cd mcp && npm run setup
//   — or —
//   node mcp/setup.js
//
// What it does:
//   1. Detects your Claude Desktop config file (macOS / Windows / Linux)
//   2. Reads the existing config (or starts fresh if none exists)
//   3. Adds the "voyager-brain" MCP server entry with the correct absolute
//      path to server.js and the required env vars
//   4. Prompts for NOTION_TOKEN and CLAUDE_API_KEY if not already in your
//      environment
//   5. Writes the merged config back — existing servers are preserved
//
// Env vars (set these to skip prompts):
//   NOTION_TOKEN    — Notion integration token
//   CLAUDE_API_KEY  — Anthropic API key (needed for synthesize_topic tool)
//
// ============================================================================

import { createInterface } from 'readline';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_JS = resolve(__dirname, 'server.js');
const NOTION_DB_ID = '81eb2b5a-05f6-433e-8c89-0d7c78cb798e';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfigPath() {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    case 'linux':
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
    default:
      throw new Error(`Unsupported platform: ${platform()}. Please configure Claude Desktop manually.`);
  }
}

function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function readJsonFile(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n  Voyager Brain MCP — Claude Desktop Setup\n');

  // 1. Resolve config path
  const configPath = getConfigPath();
  console.log(`  Config path: ${configPath}`);

  // 2. Read existing config or start fresh
  let config = await readJsonFile(configPath);
  if (config) {
    console.log('  Found existing config — will merge.\n');
  } else {
    console.log('  No existing config — will create a new one.\n');
    config = {};
  }

  // 3. Prompt for env vars if not set
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let notionToken = process.env.NOTION_TOKEN || '';
  let claudeApiKey = process.env.CLAUDE_API_KEY || '';

  // Check if values already exist in the current config entry
  const existing = config.mcpServers?.['voyager-brain']?.env || {};

  if (!notionToken && existing.NOTION_TOKEN && existing.NOTION_TOKEN !== '<prompt-or-env>') {
    notionToken = existing.NOTION_TOKEN;
    console.log('  NOTION_TOKEN: using value from existing config');
  }
  if (!claudeApiKey && existing.CLAUDE_API_KEY && existing.CLAUDE_API_KEY !== '<prompt-or-env>') {
    claudeApiKey = existing.CLAUDE_API_KEY;
    console.log('  CLAUDE_API_KEY: using value from existing config');
  }

  if (!notionToken) {
    notionToken = await prompt(rl, '  Enter your NOTION_TOKEN: ');
    if (!notionToken) {
      console.error('\n  Error: NOTION_TOKEN is required. Aborting.\n');
      rl.close();
      process.exit(1);
    }
  } else if (!existing.NOTION_TOKEN) {
    console.log('  NOTION_TOKEN: found in environment');
  }

  if (!claudeApiKey) {
    claudeApiKey = await prompt(rl, '  Enter your CLAUDE_API_KEY (or press Enter to skip): ');
    if (!claudeApiKey) {
      console.log('  Skipping CLAUDE_API_KEY — synthesize_topic tool will be unavailable.');
    }
  } else if (!existing.CLAUDE_API_KEY) {
    console.log('  CLAUDE_API_KEY: found in environment');
  }

  rl.close();

  // 4. Build the server entry
  const env = {
    NOTION_TOKEN: notionToken,
    NOTION_DB_ID: NOTION_DB_ID
  };
  if (claudeApiKey) {
    env.CLAUDE_API_KEY = claudeApiKey;
  }

  const serverEntry = {
    command: 'node',
    args: [SERVER_JS],
    env
  };

  // 5. Merge into config
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  config.mcpServers['voyager-brain'] = serverEntry;

  // 6. Write config
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
    console.log(`\n  Created directory: ${configDir}`);
  }

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(`\n  Wrote config to: ${configPath}`);
  console.log('  Server path:    ' + SERVER_JS);
  console.log('\n  Restart Claude Desktop to pick up the new server.\n');
}

main().catch((err) => {
  console.error(`\n  Setup failed: ${err.message}\n`);
  process.exit(1);
});
