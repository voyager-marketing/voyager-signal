// Save to Voyager — background service worker (MV3)
// Smart ingestion: Extract → Claude synthesis → Notion brain → Slack alert
// Builds a living knowledge base from anything on the web.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESTRICTED_URL_PATTERNS = [
  /^chrome:\/\//,
  /^chrome-extension:\/\//,
  /^about:/,
  /^edge:\/\//,
  /^file:\/\//
];

const BADGE_SUCCESS = { text: '\u2713', color: '#22c55e', duration: 2000 };
const BADGE_ERROR   = { text: '!',  color: '#ef4444', duration: 3000 };
const BADGE_WORKING = { text: '…',  color: '#3b82f6', duration: 30000 };

const SAVE_HISTORY_KEY = 'saveHistory';
const SAVE_HISTORY_MAX = 50;

const AUTO_CAPTURE_DEFAULTS = {
  autoCapture: false,
  autoCapturePatterns: [
    'x.com/*/status',
    'substack.com/p/',
    'linkedin.com/pulse/'
  ]
};

const AUTO_CAPTURE_DEBOUNCE_MS = 2000;
const BULK_CAPTURE_DELAY_MS = 2000;

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

const SYNTHESIS_PROMPT = `You are Voyager Signal — the ingestion layer of a marketing agency's knowledge brain (like Karpathy's Autoresearch, but for marketing strategy).

Your job: deeply analyze this content and extract everything worth remembering. This entry goes into a Notion knowledge base that the team queries to make decisions, build strategies, and spot opportunities.

Respond with JSON only:
{
  "score": <1-5>,
  "summary": "<2-3 sentence synthesis — not a description, but the INSIGHT. What does this mean?>",
  "key_takeaways": ["<actionable learning 1>", "<actionable learning 2>", "<...up to 5>"],
  "action_items": ["<specific thing the agency should do based on this>"],
  "key_quotes": ["<verbatim quote worth saving, if any>"],
  "tags": ["<tag1>", "<tag2>", "<...up to 5>"],
  "domain": "<which knowledge area: ai|growth|brand|content|social|seo|paid|strategy|product|culture|tech|design>",
  "signal_type": "<trend|competitor|tactic|insight|framework|case-study|data|opinion|tool|announcement>",
  "novelty": "<what's new or contrarian here vs. conventional wisdom, in one sentence>",
  "connections": "<what existing marketing concepts, frameworks, or trends does this connect to>"
}

Scoring guide:
- 5 = Urgent — immediately actionable for a client or strategy, share now
- 4 = High value — important trend, framework, or competitive insight
- 3 = Useful context — worth filing, will be valuable in synthesis later
- 2 = Low — tangentially related, thin on insight
- 1 = Noise — not relevant to marketing/strategy`;

// ---------------------------------------------------------------------------
// Installation — context menu registration
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Voyager] Extension installed.');

  chrome.contextMenus.create({
    id: 'save-to-voyager',
    title: 'Save to Voyager',
    contexts: ['page', 'selection', 'link']
  });

  chrome.contextMenus.create({
    id: 'save-all-links-to-voyager',
    title: 'Save all links to Voyager',
    contexts: ['selection']
  });

  // Initialize auto-capture defaults if not set
  chrome.storage.sync.get(['autoCapture', 'autoCapturePatterns'], (result) => {
    if (result.autoCapture === undefined) {
      chrome.storage.sync.set(AUTO_CAPTURE_DEFAULTS);
    }
  });
});

// ---------------------------------------------------------------------------
// Context menu click handler
// ---------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-to-voyager') {
    await captureFromTab(tab);
    return;
  }

  if (info.menuItemId === 'save-all-links-to-voyager') {
    await bulkCaptureSelectedLinks(tab);
    return;
  }
});

// ---------------------------------------------------------------------------
// Keyboard command handler
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-current-page') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  await captureFromTab(tab);
});

// ---------------------------------------------------------------------------
// Message listener (popup & content scripts)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'capture') {
    handleCapture(message.data)
      .then(result => {
        showBadge(BADGE_SUCCESS);
        addToHistory(message.data, result);
        sendResponse({ success: true, result });
      })
      .catch(err => {
        showBadge(BADGE_ERROR);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'getSettings') {
    chrome.storage.sync.get(
      ['claudeApiKey', 'notionToken', 'notionDbId', 'slackWebhookUrl'],
      (settings) => sendResponse(settings)
    );
    return true;
  }
});

// ---------------------------------------------------------------------------
// Auto-capture — listen for matching page loads
// ---------------------------------------------------------------------------

const _autoCaptureTimers = {};

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || isRestrictedUrl(tab.url)) return;

  chrome.storage.sync.get(['autoCapture', 'autoCapturePatterns'], (settings) => {
    if (!settings.autoCapture) return;

    const patterns = settings.autoCapturePatterns || AUTO_CAPTURE_DEFAULTS.autoCapturePatterns;
    const matches = patterns.some((pattern) => tab.url.includes(pattern));
    if (!matches) return;

    // Debounce: clear any pending capture for this tab
    if (_autoCaptureTimers[tabId]) {
      clearTimeout(_autoCaptureTimers[tabId]);
    }

    _autoCaptureTimers[tabId] = setTimeout(async () => {
      delete _autoCaptureTimers[tabId];
      console.log('[Voyager] Auto-capture triggered for:', tab.url);
      await captureFromTab(tab);
    }, AUTO_CAPTURE_DEBOUNCE_MS);
  });
});

// ---------------------------------------------------------------------------
// Bulk import — capture all links from a text selection
// ---------------------------------------------------------------------------

let _bulkQueue = [];
let _bulkRunning = false;

async function bulkCaptureSelectedLinks(tab) {
  if (!tab?.id) return;

  try {
    await ensureContentScript(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'getSelectedLinks'
    });

    if (!response || !response.success || !response.urls || response.urls.length === 0) {
      showBadge(BADGE_ERROR, tab.id);
      console.warn('[Voyager] No links found in selection.');
      return;
    }

    // Filter out restricted URLs and deduplicate
    const urls = [...new Set(response.urls)].filter((url) => !isRestrictedUrl(url));

    if (urls.length === 0) {
      showBadge(BADGE_ERROR, tab.id);
      return;
    }

    console.log(`[Voyager] Bulk import: queuing ${urls.length} links.`);

    // Add URLs to the queue
    _bulkQueue.push(...urls);
    updateBulkBadge();

    if (!_bulkRunning) {
      processBulkQueue();
    }
  } catch (err) {
    console.error('[Voyager] Bulk capture failed:', err);
    showBadge(BADGE_ERROR, tab.id);
  }
}

async function processBulkQueue() {
  _bulkRunning = true;

  while (_bulkQueue.length > 0) {
    const url = _bulkQueue.shift();
    updateBulkBadge();

    try {
      // Open the URL in a new tab, wait for it, capture, then close
      const newTab = await chrome.tabs.create({ url, active: false });

      // Wait for the tab to finish loading
      await new Promise((resolve) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === newTab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      await captureFromTab(newTab);
      await chrome.tabs.remove(newTab.id);
    } catch (err) {
      console.error('[Voyager] Bulk capture error for', url, ':', err);
    }

    // Delay between captures
    if (_bulkQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, BULK_CAPTURE_DELAY_MS));
    }
  }

  _bulkRunning = false;
  // Clear badge when done
  chrome.action.setBadgeText({ text: '' });
}

function updateBulkBadge() {
  const remaining = _bulkQueue.length;
  if (remaining > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
    chrome.action.setBadgeText({ text: String(remaining) });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ---------------------------------------------------------------------------
// Tab capture — shared by context menu & keyboard command
// ---------------------------------------------------------------------------

async function captureFromTab(tab) {
  if (!tab?.id) return;

  if (isRestrictedUrl(tab.url)) {
    showBadge(BADGE_ERROR, tab.id);
    return;
  }

  try {
    showBadge(BADGE_WORKING, tab.id);
    await ensureContentScript(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extractContent'
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Content script returned no data.');
    }

    const result = await handleCapture(response.data);
    showBadge(BADGE_SUCCESS, tab.id);
    await addToHistory(response.data, result);
  } catch (err) {
    console.error('[Voyager] Capture failed:', err);
    showBadge(BADGE_ERROR, tab.id);
  }
}

// ---------------------------------------------------------------------------
// Core pipeline: Claude synthesis → Notion brain → Slack alert
// ---------------------------------------------------------------------------

async function handleCapture(data) {
  const settings = await chrome.storage.sync.get([
    'claudeApiKey', 'notionToken', 'notionDbId', 'slackWebhookUrl'
  ]);

  if (!settings.claudeApiKey) {
    throw new Error('No Claude API key configured. Open extension settings.');
  }
  if (!settings.notionToken) {
    throw new Error('No Notion token configured. Open extension settings.');
  }

  const source = detectSource(data.url);
  const notionDbId = settings.notionDbId || '81eb2b5a-05f6-433e-8c89-0d7c78cb798e';

  // Step 0: Check for duplicates — skip if URL already in brain
  const existing = await checkDuplicate(settings.notionToken, notionDbId, data.url);
  if (existing) {
    return {
      status: 'duplicate',
      url: data.url,
      score: existing.score,
      summary: 'Already in the brain — skipped.',
      notionPageId: existing.id
    };
  }

  // Step 1: Deep synthesis with Claude
  const synthesis = await synthesizeWithClaude(settings.claudeApiKey, data, source);

  // Step 2: Write rich knowledge entry to Notion
  const notionPage = await writeToNotion(
    settings.notionToken, notionDbId, data, synthesis, source
  );

  // Step 3: Slack alert if score >= 5
  if (synthesis.score >= 5 && settings.slackWebhookUrl) {
    await sendSlackAlert(settings.slackWebhookUrl, data, synthesis);
  }

  return {
    status: 'saved',
    url: data.url,
    score: synthesis.score,
    summary: synthesis.summary,
    key_takeaways: synthesis.key_takeaways,
    action_items: synthesis.action_items,
    domain: synthesis.domain,
    signal_type: synthesis.signal_type,
    novelty: synthesis.novelty,
    tags: synthesis.tags,
    notionPageId: notionPage?.id || null
  };
}

// ---------------------------------------------------------------------------
// Claude API — deep content synthesis
// ---------------------------------------------------------------------------

async function synthesizeWithClaude(apiKey, data, source) {
  const contentSnippet = (data.content || '').slice(0, 5000);

  const userMessage = `Article:
Title: ${data.title}
Source: ${source}
URL: ${data.url}
Byline: ${data.byline || 'Unknown'}

Content:
${contentSnippet}`;

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: SYNTHESIS_PROMPT + '\n\n' + userMessage }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text || '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('[Voyager] Could not parse Claude response:', e);
  }

  return {
    score: 3,
    summary: 'Could not parse synthesis — saved with default score.',
    key_takeaways: [],
    action_items: [],
    key_quotes: [],
    tags: ['needs-review'],
    domain: 'unknown',
    signal_type: 'unknown',
    novelty: '',
    connections: ''
  };
}

// ---------------------------------------------------------------------------
// Notion API — write rich knowledge entry
// ---------------------------------------------------------------------------

async function writeToNotion(notionToken, databaseId, data, synthesis, source) {
  // Database row properties
  const properties = {
    'Name': {
      title: [{ text: { content: (data.title || 'Untitled').slice(0, 200) } }]
    },
    'URL': { url: data.url || null },
    'Source': { select: { name: source } },
    'Score': { number: synthesis.score },
    'Domain': { select: { name: synthesis.domain || 'unknown' } },
    'Signal Type': { select: { name: synthesis.signal_type || 'unknown' } },
    'Summary': {
      rich_text: [{ text: { content: (synthesis.summary || '').slice(0, 2000) } }]
    },
    'Byline': {
      rich_text: [{ text: { content: (data.byline || '').slice(0, 200) } }]
    },
    'Word Count': {
      number: wordCount(data.content)
    },
    'Reading Time': {
      rich_text: [{ text: { content: readingTime(data.content) } }]
    }
  };

  if (synthesis.tags && synthesis.tags.length > 0) {
    properties['Tags'] = {
      multi_select: synthesis.tags.map(tag => ({ name: tag }))
    };
  }

  // Page body — the rich knowledge card
  const children = buildNotionBody(data, synthesis);

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[Voyager] Notion write failed:', errText);
    return null;
  }

  return response.json();
}

// Build Notion page body blocks
function buildNotionBody(data, synthesis) {
  const blocks = [];

  // Synthesis summary
  blocks.push(heading('Synthesis'));
  blocks.push(paragraph(synthesis.summary || ''));

  // Key takeaways
  if (synthesis.key_takeaways?.length > 0) {
    blocks.push(heading('Key Takeaways'));
    synthesis.key_takeaways.forEach(t => blocks.push(bullet(t)));
  }

  // Action items
  if (synthesis.action_items?.length > 0) {
    blocks.push(heading('Action Items'));
    synthesis.action_items.forEach(a => blocks.push(todo(a)));
  }

  // What's novel
  if (synthesis.novelty) {
    blocks.push(heading('What\'s New / Contrarian'));
    blocks.push(paragraph(synthesis.novelty));
  }

  // Connections
  if (synthesis.connections) {
    blocks.push(heading('Connections'));
    blocks.push(paragraph(synthesis.connections));
  }

  // Key quotes
  if (synthesis.key_quotes?.length > 0) {
    blocks.push(heading('Key Quotes'));
    synthesis.key_quotes.forEach(q => blocks.push(quote(q)));
  }

  // Full article text in a toggle (collapsible)
  if (data.content && data.content.length > 100) {
    blocks.push(divider());
    const chunks = chunkText(data.content, 1900);
    blocks.push({
      object: 'block', type: 'toggle',
      toggle: {
        rich_text: [{ type: 'text', text: { content: `Full Article (${wordCount(data.content)} words, ${readingTime(data.content)})` } }],
        children: chunks.map(chunk => paragraph(chunk))
      }
    });
  }

  // Source metadata
  blocks.push(divider());
  blocks.push(paragraph(
    `Source: ${data.url}\nByline: ${data.byline || 'Unknown'}\n` +
    `Captured: ${new Date().toISOString()}`
  ));

  return blocks;
}

// Notion block helpers
function heading(text) {
  return {
    object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] }
  };
}
function paragraph(text) {
  return {
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] }
  };
}
function bullet(text) {
  return {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] }
  };
}
function todo(text) {
  return {
    object: 'block', type: 'to_do',
    to_do: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }], checked: false }
  };
}
function quote(text) {
  return {
    object: 'block', type: 'quote',
    quote: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] }
  };
}
function divider() {
  return { object: 'block', type: 'divider', divider: {} };
}

// ---------------------------------------------------------------------------
// Slack — alert on score 5 signals
// ---------------------------------------------------------------------------

async function sendSlackAlert(webhookUrl, data, synthesis) {
  try {
    const takeaways = (synthesis.key_takeaways || []).slice(0, 3)
      .map(t => `  • ${t}`).join('\n');

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*Signal Score 5* — ${data.title}\n${synthesis.summary}\n${takeaways ? '\n' + takeaways + '\n' : ''}\n<${data.url}|Open article> · ${synthesis.domain} · ${synthesis.signal_type}`
      })
    });
  } catch (err) {
    console.warn('[Voyager] Slack alert failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Duplicate detection — check if URL already exists in Notion
// ---------------------------------------------------------------------------

async function checkDuplicate(notionToken, databaseId, url) {
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        filter: { property: 'URL', url: { equals: url } },
        page_size: 1
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.results && data.results.length > 0) {
      const page = data.results[0];
      return {
        id: page.id,
        score: page.properties?.Score?.number ?? null
      };
    }
  } catch (err) {
    console.warn('[Voyager] Duplicate check failed, proceeding:', err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PATTERNS.some(pattern => pattern.test(url));
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/readability.js', 'src/content.js']
    });
  } catch {
    // Already injected or not scriptable
  }
}

function showBadge({ text, color, duration }, tabId) {
  const tabArgs = tabId ? { tabId } : {};
  chrome.action.setBadgeBackgroundColor({ color, ...tabArgs });
  chrome.action.setBadgeText({ text, ...tabArgs });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', ...tabArgs });
  }, duration);
}

function wordCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function readingTime(text) {
  const words = wordCount(text);
  const mins = Math.max(1, Math.round(words / 230));
  return `${mins} min read`;
}

function chunkText(text, maxLen) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks.slice(0, 50); // Notion limit: 100 children max
}

function detectSource(url) {
  if (!url) return 'unknown';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'x';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('substack.com')) return 'substack';
  if (url.includes('medium.com')) return 'medium';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('reddit.com')) return 'reddit';
  return 'web';
}

// ---------------------------------------------------------------------------
// Save history (chrome.storage.local)
// ---------------------------------------------------------------------------

async function addToHistory(data, result) {
  try {
    const store = await chrome.storage.local.get([SAVE_HISTORY_KEY]);
    const history = store[SAVE_HISTORY_KEY] || [];

    const record = {
      url: data.url,
      title: data.title,
      source: detectSource(data.url),
      score: result?.score ?? null,
      summary: result?.summary ?? '',
      domain: result?.domain ?? '',
      savedAt: new Date().toISOString()
    };

    history.unshift(record);
    if (history.length > SAVE_HISTORY_MAX) {
      history.length = SAVE_HISTORY_MAX;
    }

    await chrome.storage.local.set({ [SAVE_HISTORY_KEY]: history });
  } catch (err) {
    console.error('[Voyager] Failed to update save history:', err);
  }
}
