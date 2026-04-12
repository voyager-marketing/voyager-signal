#!/usr/bin/env node

// Voyager Brain MCP Server
// Gives Claude Desktop/Code direct access to the Notion knowledge brain.
//
// Tools provided:
//   search_brain     — full-text search across the Media Vault
//   get_recent       — fetch recent captures, optionally filtered
//   get_entry        — read a single Notion page with full synthesis
//   get_high_signals — fetch score 4-5 entries for a time window
//   synthesize_topic — ask Claude to synthesize across entries for a topic
//
// Env vars required:
//   NOTION_TOKEN     — Notion integration token
//   NOTION_DB_ID     — Media Vault database ID (defaults to project default)
//   CLAUDE_API_KEY   — needed for synthesize_topic tool

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID || '81eb2b5a-05f6-433e-8c89-0d7c78cb798e';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

async function notionFetch(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
      ...options.headers
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

function extractText(richTextArr) {
  if (!richTextArr) return '';
  return richTextArr.map(t => t.plain_text || t.text?.content || '').join('');
}

function formatPage(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    title: extractText(p.Name?.title),
    url: p.URL?.url || '',
    source: p.Source?.select?.name || '',
    score: p.Score?.number ?? null,
    domain: p.Domain?.select?.name || '',
    signal_type: p['Signal Type']?.select?.name || '',
    summary: extractText(p.Summary?.rich_text),
    tags: (p.Tags?.multi_select || []).map(t => t.name),
    byline: extractText(p.Byline?.rich_text),
    created: page.created_time
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'voyager-brain',
  version: '1.0.0'
});

// --- search_brain ---
server.tool(
  'search_brain',
  'Search the Voyager knowledge brain (Notion Media Vault) by keyword. Returns matching entries with scores, summaries, and tags.',
  {
    query: z.string().describe('Search query — keywords, topic, or phrase'),
    limit: z.number().optional().default(10).describe('Max results (default 10)')
  },
  async ({ query, limit }) => {
    const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          or: [
            { property: 'Name', title: { contains: query } },
            { property: 'Summary', rich_text: { contains: query } },
            { property: 'Tags', multi_select: { contains: query } }
          ]
        },
        sorts: [{ property: 'Score', direction: 'descending' }],
        page_size: limit
      })
    });

    const results = data.results.map(formatPage);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(results, null, 2)
      }]
    };
  }
);

// --- get_recent ---
server.tool(
  'get_recent',
  'Get the most recent captures from the Voyager brain. Optionally filter by source, domain, or minimum score.',
  {
    limit: z.number().optional().default(10).describe('Number of entries (default 10)'),
    source: z.string().optional().describe('Filter by source: x, linkedin, substack, web, etc.'),
    domain: z.string().optional().describe('Filter by domain: ai, growth, brand, content, etc.'),
    min_score: z.number().optional().describe('Minimum signal score (1-5)')
  },
  async ({ limit, source, domain, min_score }) => {
    const filters = [];

    if (source) {
      filters.push({ property: 'Source', select: { equals: source } });
    }
    if (domain) {
      filters.push({ property: 'Domain', select: { equals: domain } });
    }
    if (min_score) {
      filters.push({ property: 'Score', number: { greater_than_or_equal_to: min_score } });
    }

    const body = {
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: limit
    };

    if (filters.length === 1) {
      body.filter = filters[0];
    } else if (filters.length > 1) {
      body.filter = { and: filters };
    }

    const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const results = data.results.map(formatPage);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(results, null, 2)
      }]
    };
  }
);

// --- get_entry ---
server.tool(
  'get_entry',
  'Read a single knowledge entry from the Voyager brain by Notion page ID. Returns full page content including synthesis, takeaways, and action items.',
  {
    page_id: z.string().describe('Notion page ID')
  },
  async ({ page_id }) => {
    const [page, blocks] = await Promise.all([
      notionFetch(`/pages/${page_id}`),
      notionFetch(`/blocks/${page_id}/children?page_size=100`)
    ]);

    const entry = formatPage(page);

    // Extract block content
    const body = blocks.results.map(block => {
      const type = block.type;
      if (type === 'heading_2') return `## ${extractText(block.heading_2?.rich_text)}`;
      if (type === 'paragraph') return extractText(block.paragraph?.rich_text);
      if (type === 'bulleted_list_item') return `  • ${extractText(block.bulleted_list_item?.rich_text)}`;
      if (type === 'to_do') {
        const checked = block.to_do?.checked ? '[x]' : '[ ]';
        return `  ${checked} ${extractText(block.to_do?.rich_text)}`;
      }
      if (type === 'quote') return `> ${extractText(block.quote?.rich_text)}`;
      if (type === 'divider') return '---';
      return '';
    }).filter(Boolean).join('\n');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...entry, body }, null, 2)
      }]
    };
  }
);

// --- get_high_signals ---
server.tool(
  'get_high_signals',
  'Get high-signal entries (score 4-5) from the last N days. Perfect for weekly digests and strategy reviews.',
  {
    days: z.number().optional().default(7).describe('Lookback window in days (default 7)'),
    min_score: z.number().optional().default(4).describe('Minimum score (default 4)')
  },
  async ({ days, min_score }) => {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Score', number: { greater_than_or_equal_to: min_score } },
            { timestamp: 'created_time', created_time: { on_or_after: since } }
          ]
        },
        sorts: [{ property: 'Score', direction: 'descending' }],
        page_size: 50
      })
    });

    const results = data.results.map(formatPage);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(results, null, 2)
      }]
    };
  }
);

// --- synthesize_topic ---
server.tool(
  'synthesize_topic',
  'Search the brain for a topic, then use Claude to synthesize insights across all matching entries. Returns a research-style synthesis with patterns, contradictions, and recommended actions.',
  {
    topic: z.string().describe('Topic or question to synthesize across the knowledge base'),
    limit: z.number().optional().default(20).describe('Max entries to include in synthesis')
  },
  async ({ topic, limit }) => {
    if (!CLAUDE_API_KEY) {
      return {
        content: [{ type: 'text', text: 'Error: CLAUDE_API_KEY not set. Cannot run synthesis.' }]
      };
    }

    // Fetch relevant entries
    const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          or: [
            { property: 'Name', title: { contains: topic } },
            { property: 'Summary', rich_text: { contains: topic } },
            { property: 'Tags', multi_select: { contains: topic } }
          ]
        },
        sorts: [{ property: 'Score', direction: 'descending' }],
        page_size: limit
      })
    });

    const entries = data.results.map(formatPage);

    if (entries.length === 0) {
      return {
        content: [{ type: 'text', text: `No entries found for topic: "${topic}"` }]
      };
    }

    const entrySummaries = entries.map((e, i) =>
      `[${i + 1}] "${e.title}" (score ${e.score}, ${e.domain}, ${e.source})\n   ${e.summary}\n   Tags: ${e.tags.join(', ')}`
    ).join('\n\n');

    const prompt = `You are synthesizing the Voyager Marketing knowledge brain on the topic: "${topic}"

Here are ${entries.length} entries from the brain:

${entrySummaries}

Write a synthesis that:
1. Identifies the key patterns and themes across these entries
2. Notes any contradictions or tensions between sources
3. Highlights the most actionable insights for a marketing agency
4. Suggests specific next steps or experiments to run
5. Calls out any knowledge gaps — what's missing from our understanding?

Write in a direct, strategic tone. This is for practitioners, not academics.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return { content: [{ type: 'text', text: `Claude API error: ${err}` }] };
    }

    const result = await claudeRes.json();
    const synthesis = result.content?.[0]?.text || 'No synthesis generated.';

    return {
      content: [{
        type: 'text',
        text: `# Synthesis: ${topic}\n\n_Based on ${entries.length} entries from the Voyager brain_\n\n${synthesis}`
      }]
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
