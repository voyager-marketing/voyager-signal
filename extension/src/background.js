// Save to Voyager — background service worker (MV3)
// Pipeline: Extract → Claude scoring → Notion write → Slack alert (score 5)
// No n8n — all API calls happen directly in the extension.

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
const BADGE_SCORING = { text: '…',  color: '#3b82f6', duration: 30000 };

const SAVE_HISTORY_KEY = 'saveHistory';
const SAVE_HISTORY_MAX = 50;

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

const SCORING_PROMPT = `You are Voyager Signal, an AI content analyst for Voyager Marketing.

Score the following article on a 1-5 scale for marketing signal value:
- 5 = Urgent insight — immediately actionable for a client or strategy
- 4 = High value — relevant trend, competitor move, or tactical insight
- 3 = Moderate — useful context, worth filing
- 2 = Low — tangentially related
- 1 = Noise — not relevant

Respond with JSON only:
{
  "score": <1-5>,
  "summary": "<2-3 sentence summary>",
  "tags": ["<tag1>", "<tag2>"],
  "signal_type": "<trend|competitor|tactic|insight|news|opinion>",
  "relevance_reason": "<why this matters to a marketing agency>"
}`;

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
});

// ---------------------------------------------------------------------------
// Context menu click handler
// ---------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-to-voyager') return;
  await captureFromTab(tab);
});

// ---------------------------------------------------------------------------
// Keyboard command handler
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-current-page') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    console.warn('[Voyager] No active tab found for command.');
    return;
  }

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
// Tab capture — shared by context menu & keyboard command
// ---------------------------------------------------------------------------

async function captureFromTab(tab) {
  if (!tab?.id) {
    console.warn('[Voyager] captureFromTab called without a valid tab.');
    return;
  }

  if (isRestrictedUrl(tab.url)) {
    console.warn('[Voyager] Cannot capture restricted URL:', tab.url);
    showBadge(BADGE_ERROR, tab.id);
    return;
  }

  try {
    showBadge(BADGE_SCORING, tab.id);
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
// Core pipeline: Claude scoring → Notion write → Slack alert
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

  // Step 1: Score with Claude
  const enrichment = await scoreWithClaude(settings.claudeApiKey, data, source);

  // Step 2: Write to Notion
  const notionDbId = settings.notionDbId || '81eb2b5a-05f6-433e-8c89-0d7c78cb798e';
  const notionPage = await writeToNotion(settings.notionToken, notionDbId, data, enrichment, source);

  // Step 3: Slack alert if score >= 5
  if (enrichment.score >= 5 && settings.slackWebhookUrl) {
    await sendSlackAlert(settings.slackWebhookUrl, data, enrichment);
  }

  return {
    status: 'saved',
    url: data.url,
    score: enrichment.score,
    summary: enrichment.summary,
    signal_type: enrichment.signal_type,
    tags: enrichment.tags,
    notionPageId: notionPage?.id || null
  };
}

// ---------------------------------------------------------------------------
// Claude API — content scoring
// ---------------------------------------------------------------------------

async function scoreWithClaude(apiKey, data, source) {
  const contentSnippet = (data.content || '').slice(0, 3000);

  const userMessage = `Article:
Title: ${data.title}
Source: ${source}
URL: ${data.url}
Byline: ${data.byline || 'Unknown'}

Content (first 3000 chars):
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
      max_tokens: 500,
      messages: [
        { role: 'user', content: SCORING_PROMPT + '\n\n' + userMessage }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text || '';

  // Parse JSON from response (handle markdown code blocks)
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('[Voyager] Could not parse Claude response:', e);
  }

  // Fallback if parsing fails
  return {
    score: 3,
    summary: 'Could not parse enrichment — saved with default score.',
    tags: ['needs-review'],
    signal_type: 'unknown',
    relevance_reason: 'Auto-saved, enrichment parsing failed.'
  };
}

// ---------------------------------------------------------------------------
// Notion API — write to Media Vault
// ---------------------------------------------------------------------------

async function writeToNotion(notionToken, databaseId, data, enrichment, source) {
  const properties = {
    // Title property (Name / Title)
    'Name': {
      title: [{ text: { content: (data.title || 'Untitled').slice(0, 200) } }]
    },
    'URL': {
      url: data.url || null
    },
    'Source': {
      select: { name: source }
    },
    'Score': {
      number: enrichment.score
    },
    'Summary': {
      rich_text: [{ text: { content: (enrichment.summary || '').slice(0, 2000) } }]
    },
    'Signal Type': {
      select: { name: enrichment.signal_type || 'unknown' }
    },
    'Byline': {
      rich_text: [{ text: { content: (data.byline || '').slice(0, 200) } }]
    }
  };

  // Tags as multi-select (only if we have tags)
  if (enrichment.tags && enrichment.tags.length > 0) {
    properties['Tags'] = {
      multi_select: enrichment.tags.map(tag => ({ name: tag }))
    };
  }

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[Voyager] Notion write failed:', errText);
    // Don't throw — we still saved the enrichment, Notion is secondary
    return null;
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Slack — alert on score 5 signals
// ---------------------------------------------------------------------------

async function sendSlackAlert(webhookUrl, data, enrichment) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*Signal Score 5* — ${data.title}\n${enrichment.summary}\n<${data.url}|Open article> · Signal: ${enrichment.signal_type}`
      })
    });
  } catch (err) {
    // Slack is best-effort, don't fail the whole capture
    console.warn('[Voyager] Slack alert failed:', err);
  }
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
