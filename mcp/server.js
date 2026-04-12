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

// --- weekly_digest ---
server.tool(
  'weekly_digest',
  'Generate a weekly digest of all captures grouped by domain, sorted by score. Includes themes, top signals, and recommended actions. Perfect for team sync or strategy review.',
  {
    days: z.number().optional().default(7).describe('Lookback window in days (default 7)')
  },
  async ({ days }) => {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { timestamp: 'created_time', created_time: { on_or_after: since } },
        sorts: [{ property: 'Score', direction: 'descending' }],
        page_size: 100
      })
    });

    const entries = data.results.map(formatPage);
    if (entries.length === 0) {
      return { content: [{ type: 'text', text: `No entries in the last ${days} days.` }] };
    }

    // Group by domain
    const byDomain = {};
    let totalScore = 0;
    entries.forEach(e => {
      const d = e.domain || 'uncategorized';
      if (!byDomain[d]) byDomain[d] = [];
      byDomain[d].push(e);
      totalScore += (e.score || 0);
    });

    const topSignals = entries.filter(e => e.score >= 5).slice(0, 5);
    const avgScore = (totalScore / entries.length).toFixed(1);

    // Build digest markdown
    let md = `# Voyager Brain — ${days}-Day Digest\n\n`;
    md += `**${entries.length} captures** | Avg score: ${avgScore} | Top signals: ${topSignals.length}\n\n`;

    if (topSignals.length > 0) {
      md += `## Top Signals (Score 5)\n\n`;
      topSignals.forEach(e => {
        md += `- **${e.title}** (${e.source}) — ${e.summary}\n`;
      });
      md += '\n';
    }

    md += `## By Domain\n\n`;
    Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length).forEach(([domain, items]) => {
      md += `### ${domain} (${items.length})\n`;
      items.slice(0, 5).forEach(e => {
        md += `- [${e.score}] ${e.title} — ${e.summary.slice(0, 100)}\n`;
      });
      if (items.length > 5) md += `- _...and ${items.length - 5} more_\n`;
      md += '\n';
    });

    // Use Claude for themes if available
    if (CLAUDE_API_KEY) {
      const summaries = entries.slice(0, 30).map(e =>
        `[${e.score}] (${e.domain}) ${e.title}: ${e.summary}`
      ).join('\n');

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{ role: 'user', content: `Here are ${entries.length} entries captured over the last ${days} days:\n\n${summaries}\n\nIn 3-5 bullet points, identify the key themes across these entries. Then suggest 2-3 specific actions the marketing team should take based on these signals. Be direct and strategic.` }]
        })
      });

      if (res.ok) {
        const result = await res.json();
        md += `## AI Analysis\n\n${result.content?.[0]?.text || ''}\n`;
      }
    }

    return { content: [{ type: 'text', text: md }] };
  }
);

// --- find_related ---
server.tool(
  'find_related',
  'Given a Notion page ID, find other entries in the brain that are related by tags, domain, or topic. Returns ranked matches.',
  {
    page_id: z.string().describe('Notion page ID to find related entries for'),
    limit: z.number().optional().default(5).describe('Max related entries (default 5)')
  },
  async ({ page_id, limit }) => {
    const page = await notionFetch(`/pages/${page_id}`);
    const entry = formatPage(page);

    // Build search filters from the entry's tags and domain
    const orFilters = [];
    if (entry.domain) {
      orFilters.push({ property: 'Domain', select: { equals: entry.domain } });
    }
    entry.tags.forEach(tag => {
      orFilters.push({ property: 'Tags', multi_select: { contains: tag } });
    });
    // Also search by title keywords
    const keywords = entry.title.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
    keywords.forEach(kw => {
      orFilters.push({ property: 'Name', title: { contains: kw } });
    });

    if (orFilters.length === 0) {
      return { content: [{ type: 'text', text: 'Not enough metadata to find related entries.' }] };
    }

    const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { or: orFilters },
        sorts: [{ property: 'Score', direction: 'descending' }],
        page_size: limit + 1
      })
    });

    // Filter out the source page itself
    const related = data.results
      .map(formatPage)
      .filter(e => e.id !== page_id)
      .slice(0, limit);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ source: entry, related }, null, 2)
      }]
    };
  }
);

// --- knowledge_gaps ---
server.tool(
  'knowledge_gaps',
  'Analyze the brain\'s coverage over the last N days and identify gaps — thin domains, missing signal types, and suggested research topics.',
  {
    days: z.number().optional().default(30).describe('Lookback window (default 30)')
  },
  async ({ days }) => {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { timestamp: 'created_time', created_time: { on_or_after: since } },
        page_size: 100
      })
    });

    const entries = data.results.map(formatPage);

    // Count by domain and signal type
    const domainCounts = {};
    const typeCounts = {};
    const tagCounts = {};
    entries.forEach(e => {
      domainCounts[e.domain || 'unknown'] = (domainCounts[e.domain || 'unknown'] || 0) + 1;
      typeCounts[e.signal_type || 'unknown'] = (typeCounts[e.signal_type || 'unknown'] || 0) + 1;
      e.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
    });

    const coverage = {
      total: entries.length,
      period_days: days,
      domains: domainCounts,
      signal_types: typeCounts,
      top_tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)
    };

    // Use Claude to analyze gaps
    if (CLAUDE_API_KEY && entries.length > 0) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{ role: 'user', content: `Analyze this knowledge base coverage for a marketing agency:\n\n${JSON.stringify(coverage, null, 2)}\n\nAll possible domains: ai, growth, brand, content, social, seo, paid, strategy, product, culture, tech, design.\nAll possible signal types: trend, competitor, tactic, insight, framework, case-study, data, opinion, tool, announcement.\n\nIdentify:\n1. Which domains have thin or zero coverage (knowledge gaps)\n2. Which signal types are over/under-represented\n3. 5 specific topics the team should research next to fill gaps\n4. Any blind spots in the current collection strategy\n\nBe specific and actionable.` }]
        })
      });

      if (res.ok) {
        const result = await res.json();
        coverage.analysis = result.content?.[0]?.text || '';
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(coverage, null, 2) }] };
  }
);

// --- get_actions ---
server.tool(
  'get_actions',
  'Scan recent brain entries and collect all action items from high-signal captures. Returns a consolidated action list grouped by domain.',
  {
    days: z.number().optional().default(14).describe('Lookback window (default 14)'),
    min_score: z.number().optional().default(3).describe('Minimum score (default 3)')
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

    const entries = data.results.map(formatPage);

    // For each entry, fetch the page blocks to find to-do items
    const actions = [];
    for (const entry of entries.slice(0, 20)) {
      try {
        const blocks = await notionFetch(`/blocks/${entry.id}/children?page_size=100`);
        const todos = blocks.results
          .filter(b => b.type === 'to_do')
          .map(b => ({
            action: extractText(b.to_do?.rich_text),
            done: b.to_do?.checked || false,
            from: entry.title,
            domain: entry.domain,
            score: entry.score,
            url: entry.url
          }));
        actions.push(...todos);
      } catch {
        // Skip entries we can't read
      }
    }

    // Group by domain
    const byDomain = {};
    actions.forEach(a => {
      const d = a.domain || 'general';
      if (!byDomain[d]) byDomain[d] = [];
      byDomain[d].push(a);
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total_actions: actions.length,
          pending: actions.filter(a => !a.done).length,
          completed: actions.filter(a => a.done).length,
          by_domain: byDomain
        }, null, 2)
      }]
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
