// Save to Voyager — background service worker (MV3)

// --- Context menu ---
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Voyager] Extension installed.');

  chrome.contextMenus.create({
    id: 'save-selection',
    title: 'Save selection to Voyager',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'save-page',
    title: 'Save page to Voyager',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-selection') {
    const data = {
      url: tab.url,
      title: tab.title,
      content: info.selectionText,
      excerpt: info.selectionText.slice(0, 200),
      byline: '',
      siteName: new URL(tab.url).hostname
    };
    handleCapture(data, tab)
      .then(() => notifyTab(tab.id, 'Selection saved to Voyager!', 'success'))
      .catch(err => notifyTab(tab.id, err.message, 'error'));
  }

  if (info.menuItemId === 'save-page') {
    chrome.tabs.sendMessage(tab.id, { action: 'extractContent' }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        const fallback = {
          url: tab.url,
          title: tab.title,
          content: '',
          excerpt: '',
          byline: '',
          siteName: new URL(tab.url).hostname
        };
        handleCapture(fallback, tab)
          .then(() => notifyTab(tab.id, 'Page saved to Voyager!', 'success'))
          .catch(err => notifyTab(tab.id, err.message, 'error'));
        return;
      }

      handleCapture(response.data, tab)
        .then(() => notifyTab(tab.id, 'Page saved to Voyager!', 'success'))
        .catch(err => notifyTab(tab.id, err.message, 'error'));
    });
  }
});

// --- Message listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'capture') {
    handleCapture(message.data, sender.tab)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getSettings') {
    chrome.storage.sync.get(['webhookUrl', 'notionToken', 'claudeApiKey'], (settings) => {
      sendResponse(settings);
    });
    return true;
  }
});

// --- Core capture logic ---
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

  return { status: 'sent', url: data.url };
}

function detectSource(url) {
  if (!url) return 'unknown';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'x';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('substack.com')) return 'substack';
  if (url.includes('medium.com')) return 'medium';
  return 'web';
}

function notifyTab(tabId, message, type) {
  chrome.tabs.sendMessage(tabId, { action: 'showNotification', message, type }).catch(() => {});
}
