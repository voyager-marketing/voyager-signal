// Save to Voyager — popup controller

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('page-title');
const urlEl = document.getElementById('page-url');
const sourceEl = document.getElementById('page-source');
const wordCountEl = document.getElementById('word-count');
const saveBtn = document.getElementById('save-btn');
const webhookInput = document.getElementById('webhook-url');
const saveSettingsBtn = document.getElementById('save-settings');
const historyList = document.getElementById('history-list');
const historyCount = document.getElementById('history-count');
const versionEl = document.getElementById('version');

let extractedData = null;

// --- Init ---
versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
loadSettings();
extractCurrentPage();
loadHistory();

// --- Extract content from active tab ---
function extractCurrentPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return showStatus('No active tab found.', 'error');

    // Check for restricted URLs
    if (isRestrictedUrl(tab.url)) {
      titleEl.textContent = 'Cannot capture this page';
      urlEl.textContent = tab.url;
      sourceEl.textContent = 'restricted';
      showStatus('Browser internal pages cannot be captured.', 'error');
      return;
    }

    urlEl.textContent = tab.url;
    const source = detectSource(tab.url);
    sourceEl.textContent = source;

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
        wordCountEl.textContent = '';
        saveBtn.disabled = false;
        return;
      }

      if (response && response.success) {
        extractedData = response.data;
        titleEl.textContent = extractedData.title;
        const words = (extractedData.content || '').split(/\s+/).filter(Boolean).length;
        wordCountEl.textContent = words > 0 ? words.toLocaleString() + ' words' : '';
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
        wordCountEl.textContent = '';
        saveBtn.disabled = false;
      }
    });
  });
}

// --- Save button ---
saveBtn.addEventListener('click', () => {
  if (!extractedData) return;

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  showStatus('Sending to Voyager…', 'loading');

  chrome.runtime.sendMessage({ action: 'capture', data: extractedData }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Voyager';
      return;
    }

    if (response && response.success) {
      showStatus('Saved to Voyager!', 'success');
      saveBtn.textContent = 'Saved!';
      loadHistory();
    } else {
      showStatus('Error: ' + (response?.error || 'Unknown error'), 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Voyager';
    }
  });
});

// --- Settings ---
function loadSettings() {
  chrome.storage.sync.get(['webhookUrl'], (s) => {
    if (s.webhookUrl) webhookInput.value = s.webhookUrl;
  });
}

saveSettingsBtn.addEventListener('click', () => {
  const url = webhookInput.value.trim();
  if (url && !url.startsWith('https://')) {
    showStatus('Webhook URL must use HTTPS.', 'error');
    return;
  }
  chrome.storage.sync.set({ webhookUrl: url }, () => {
    showStatus('Settings saved.', 'success');
    setTimeout(() => hideStatus(), 2000);
  });
});

// --- History ---
function loadHistory() {
  chrome.storage.local.get(['saveHistory'], (result) => {
    const history = result.saveHistory || [];
    historyCount.textContent = history.length;

    if (history.length === 0) {
      historyList.innerHTML = '<p class="empty-state">No saves yet.</p>';
      return;
    }

    historyList.innerHTML = history.slice(0, 10).map((item) => {
      const time = new Date(item.savedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
      const scoreHtml = item.score
        ? '<span class="score-badge score-' + item.score + '">' + item.score + '</span>'
        : '';
      return '<div class="history-item">' +
        '<a href="' + escapeHtml(item.url) + '" target="_blank" class="history-title">' +
          escapeHtml(item.title || 'Untitled') +
        '</a>' +
        '<div class="history-meta">' +
          '<span class="badge">' + escapeHtml(item.source || 'web') + '</span>' +
          scoreHtml +
          '<span class="history-time">' + time + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  });
}

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
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('reddit.com')) return 'reddit';
  if (url.includes('github.com')) return 'github';
  return 'web';
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|about|edge|brave|file):\/\//.test(url);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
