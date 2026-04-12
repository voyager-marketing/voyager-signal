// Save to Voyager — background service worker (MV3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Voyager] Extension installed.');
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'capture') {
    handleCapture(message.data, sender.tab)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.action === 'getSettings') {
    chrome.storage.sync.get(['webhookUrl', 'notionToken', 'claudeApiKey'], (settings) => {
      sendResponse(settings);
    });
    return true;
  }
});

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
