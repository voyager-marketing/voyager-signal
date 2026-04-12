// Save to Voyager — background service worker (MV3)
// Handles: context menu capture, keyboard shortcut, popup messages,
//          badge feedback, save history, and webhook forwarding.

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

const SAVE_HISTORY_KEY = 'saveHistory';
const SAVE_HISTORY_MAX = 50;

// ---------------------------------------------------------------------------
// Installation — context menu registration
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Voyager] Extension installed.');

  // Register right-click context menu on all pages
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

  // Get the currently active tab in the focused window
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
    handleCapture(message.data, sender.tab)
      .then(result => {
        showBadge(BADGE_SUCCESS, sender.tab?.id);
        addToHistory(message.data, result);
        sendResponse({ success: true, result });
      })
      .catch(err => {
        showBadge(BADGE_ERROR, sender.tab?.id);
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep channel open for async response
  }

  if (message.action === 'getSettings') {
    chrome.storage.sync.get(['webhookUrl', 'notionToken', 'claudeApiKey'], (settings) => {
      sendResponse(settings);
    });
    return true;
  }
});

// ---------------------------------------------------------------------------
// Tab capture — shared by context menu & keyboard command
// ---------------------------------------------------------------------------

/**
 * Validate tab URL, inject content script if needed, extract page content,
 * and forward to handleCapture. Shows badge feedback on success/failure.
 */
async function captureFromTab(tab) {
  if (!tab?.id) {
    console.warn('[Voyager] captureFromTab called without a valid tab.');
    return;
  }

  // Block restricted URLs where content scripts cannot run
  if (isRestrictedUrl(tab.url)) {
    console.warn('[Voyager] Cannot capture restricted URL:', tab.url);
    showBadge(BADGE_ERROR, tab.id);
    return;
  }

  try {
    // Attempt to inject the content script in case it has not loaded yet
    // (e.g. the tab was open before the extension was installed).
    await ensureContentScript(tab.id);

    // Ask the content script to extract the page
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extractContent'
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Content script returned no data.');
    }

    const result = await handleCapture(response.data, tab);
    showBadge(BADGE_SUCCESS, tab.id);
    await addToHistory(response.data, result);
  } catch (err) {
    console.error('[Voyager] Capture failed:', err);
    showBadge(BADGE_ERROR, tab.id);
  }
}

// ---------------------------------------------------------------------------
// Restricted-URL check
// ---------------------------------------------------------------------------

/**
 * Returns true if the URL matches a browser-internal scheme where content
 * scripts are not allowed to execute.
 */
function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PATTERNS.some(pattern => pattern.test(url));
}

// ---------------------------------------------------------------------------
// Content-script injection helper
// ---------------------------------------------------------------------------

/**
 * Programmatically inject the content scripts if they are not already present.
 * Silently catches errors (e.g. if the scripts are already injected).
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/readability.js', 'src/content.js']
    });
  } catch {
    // Already injected or tab is not scriptable — safe to ignore
  }
}

// ---------------------------------------------------------------------------
// Badge feedback
// ---------------------------------------------------------------------------

/**
 * Show a coloured badge on the extension icon and auto-clear it after
 * the specified duration.
 *
 * @param {{ text: string, color: string, duration: number }} badge
 * @param {number} [tabId] - scope badge to a specific tab (optional)
 */
function showBadge({ text, color, duration }, tabId) {
  const tabArgs = tabId ? { tabId } : {};

  chrome.action.setBadgeBackgroundColor({ color, ...tabArgs });
  chrome.action.setBadgeText({ text, ...tabArgs });

  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', ...tabArgs });
  }, duration);
}

// ---------------------------------------------------------------------------
// Webhook capture handler
// ---------------------------------------------------------------------------

/**
 * Build the payload and POST it to the configured webhook URL.
 * Returns parsed JSON from the webhook response when available,
 * falling back to a simple status object.
 */
async function handleCapture(data, tab) {
  const settings = await chrome.storage.sync.get(['webhookUrl']);
  const webhookUrl = settings.webhookUrl;

  if (!webhookUrl) {
    throw new Error('No webhook URL configured. Open extension settings.');
  }

  const payload = {
    url: data.url,
    title: data.title,
    content: data.content,
    excerpt: data.excerpt,
    byline: data.byline,
    siteName: data.siteName,
    capturedAt: new Date().toISOString(),
    source: detectSource(data.url)
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}`);
  }

  // Try to parse JSON from the webhook response (e.g. enrichment score)
  let responseData = null;
  try {
    const text = await response.text();
    if (text) {
      responseData = JSON.parse(text);
    }
  } catch {
    // Response is not JSON — that is fine, we still count it as success
  }

  return {
    status: 'sent',
    url: data.url,
    ...(responseData ? { webhookResponse: responseData } : {})
  };
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

/**
 * Infer a human-readable source label from the page URL.
 */
function detectSource(url) {
  if (!url) return 'unknown';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'x';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('substack.com')) return 'substack';
  if (url.includes('medium.com')) return 'medium';
  return 'web';
}

// ---------------------------------------------------------------------------
// Save history (chrome.storage.local)
// ---------------------------------------------------------------------------

/**
 * Append a capture record to local save history, keeping only the most
 * recent SAVE_HISTORY_MAX entries.
 *
 * @param {object} data    - The extracted page data (url, title, etc.)
 * @param {object} result  - The handleCapture return value (may include webhookResponse)
 */
async function addToHistory(data, result) {
  try {
    const store = await chrome.storage.local.get([SAVE_HISTORY_KEY]);
    const history = store[SAVE_HISTORY_KEY] || [];

    // Extract score from webhook response if available
    const score = result?.webhookResponse?.score ?? null;

    const record = {
      url: data.url,
      title: data.title,
      source: detectSource(data.url),
      score,
      savedAt: new Date().toISOString()
    };

    // Prepend newest entry, then trim to the max length
    history.unshift(record);
    if (history.length > SAVE_HISTORY_MAX) {
      history.length = SAVE_HISTORY_MAX;
    }

    await chrome.storage.local.set({ [SAVE_HISTORY_KEY]: history });
  } catch (err) {
    console.error('[Voyager] Failed to update save history:', err);
  }
}
