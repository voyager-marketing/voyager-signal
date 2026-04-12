// Save to Voyager — popup controller

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('page-title');
const urlEl = document.getElementById('page-url');
const sourceEl = document.getElementById('page-source');
const saveBtn = document.getElementById('save-btn');
const webhookInput = document.getElementById('webhook-url');
const notionInput = document.getElementById('notion-token');
const claudeInput = document.getElementById('claude-key');
const saveSettingsBtn = document.getElementById('save-settings');

let extractedData = null;

// --- Init ---
loadSettings();
extractCurrentPage();

// --- Extract content from active tab ---
function extractCurrentPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return showStatus('No active tab found.', 'error');

    urlEl.textContent = tab.url;
    sourceEl.textContent = detectSource(tab.url);

    chrome.tabs.sendMessage(tab.id, { action: 'extractContent' }, (response) => {
      if (chrome.runtime.lastError) {
        titleEl.textContent = tab.title || 'Unknown page';
        extractedData = {
          url: tab.url,
          title: tab.title,
          content: '',
          excerpt: '',
          byline: '',
          siteName: new URL(tab.url).hostname
        };
        saveBtn.disabled = false;
        return;
      }

      if (response && response.success) {
        extractedData = response.data;
        titleEl.textContent = extractedData.title;
        saveBtn.disabled = false;
      } else {
        titleEl.textContent = tab.title || 'Could not extract';
        extractedData = {
          url: tab.url,
          title: tab.title,
          content: '',
          excerpt: '',
          byline: '',
          siteName: new URL(tab.url).hostname
        };
        saveBtn.disabled = false;
      }
    });
  });
}

// --- Save button ---
saveBtn.addEventListener('click', () => {
  if (!extractedData) return;

  saveBtn.disabled = true;
  showStatus('Saving…', 'loading');

  chrome.runtime.sendMessage({ action: 'capture', data: extractedData }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
      saveBtn.disabled = false;
      return;
    }

    if (response && response.success) {
      showStatus('Saved to Voyager!', 'success');
    } else {
      showStatus('Error: ' + (response?.error || 'Unknown error'), 'error');
      saveBtn.disabled = false;
    }
  });
});

// --- Settings ---
function loadSettings() {
  chrome.storage.sync.get(['webhookUrl', 'notionToken', 'claudeApiKey'], (s) => {
    if (s.webhookUrl) webhookInput.value = s.webhookUrl;
    if (s.notionToken) notionInput.value = s.notionToken;
    if (s.claudeApiKey) claudeInput.value = s.claudeApiKey;
  });
}

saveSettingsBtn.addEventListener('click', () => {
  chrome.storage.sync.set({
    webhookUrl: webhookInput.value.trim(),
    notionToken: notionInput.value.trim(),
    claudeApiKey: claudeInput.value.trim()
  }, () => {
    showStatus('Settings saved.', 'success');
    setTimeout(() => hideStatus(), 2000);
  });
});

// --- Helpers ---
function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function hideStatus() {
  statusEl.className = 'status';
}

function detectSource(url) {
  if (!url) return 'unknown';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'x';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('substack.com')) return 'substack';
  if (url.includes('medium.com')) return 'medium';
  return 'web';
}
