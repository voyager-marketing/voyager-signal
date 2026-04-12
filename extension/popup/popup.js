// Save to Voyager — popup controller
// Direct pipeline: Claude scoring → Notion write → Slack alert

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('page-title');
const urlEl = document.getElementById('page-url');
const sourceEl = document.getElementById('page-source');
const wordCountEl = document.getElementById('word-count');
const saveBtn = document.getElementById('save-btn');
const enrichmentEl = document.getElementById('enrichment-result');
const claudeKeyInput = document.getElementById('claude-key');
const notionTokenInput = document.getElementById('notion-token');
const notionDbIdInput = document.getElementById('notion-db-id');
const slackWebhookInput = document.getElementById('slack-webhook');
const saveSettingsBtn = document.getElementById('save-settings');
const historyList = document.getElementById('history-list');
const historyCount = document.getElementById('history-count');
const versionEl = document.getElementById('version');
const contentPreviewEl = document.getElementById('content-preview');
const tagInput = document.getElementById('tag-input');
const recentTagsEl = document.getElementById('recent-tags');
const sparklineSvg = document.getElementById('score-sparkline');

let extractedData = null;

// --- Init ---
versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
loadSettings();
checkOnboarding();
extractCurrentPage();
loadHistory();
loadRecentTags();

// --- Onboarding check ---
function checkOnboarding() {
  chrome.storage.sync.get(['claudeApiKey', 'notionToken'], (s) => {
    if (!s.claudeApiKey || !s.notionToken) {
      showStatus('Set up your API keys in Settings below to get started.', 'loading');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Configure Settings First';
      document.getElementById('settings-panel').open = true;
    }
  });
}

// --- Extract content from active tab ---
function extractCurrentPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return showStatus('No active tab found.', 'error');

    if (isRestrictedUrl(tab.url)) {
      titleEl.textContent = 'Cannot capture this page';
      urlEl.textContent = tab.url;
      sourceEl.textContent = 'restricted';
      showStatus('Browser internal pages cannot be captured.', 'error');
      return;
    }

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
        wordCountEl.textContent = '';
        saveBtn.disabled = false;
        return;
      }

      if (response && response.success) {
        extractedData = response.data;
        titleEl.textContent = extractedData.title;
        const words = (extractedData.content || '').split(/\s+/).filter(Boolean).length;
        wordCountEl.textContent = words > 0 ? words.toLocaleString() + ' words' : '';
        showContentPreview(extractedData.content || extractedData.excerpt || '');
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
  saveBtn.textContent = 'Synthesizing…';
  showStatus('Claude is analyzing and synthesizing…', 'loading');
  enrichmentEl.className = 'enrichment hidden';

  const userTags = parseTagInput();
  if (userTags.length > 0) {
    saveRecentTags(userTags);
  }
  const captureData = Object.assign({}, extractedData, { userTags: userTags });

  chrome.runtime.sendMessage({ action: 'capture', data: captureData }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Voyager';
      return;
    }

    if (response && response.success) {
      const r = response.result;
      if (r.status === 'duplicate') {
        showStatus('Already in the brain — skipped duplicate.', 'error');
        saveBtn.textContent = 'Already Saved';
      } else {
        showStatus('Saved to Voyager!', 'success');
        saveBtn.textContent = 'Saved!';
        showEnrichment(r);
        loadHistory();
      }
    } else {
      showStatus('Error: ' + (response?.error || 'Unknown error'), 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Voyager';
    }
  });
});

// --- Show synthesis result ---
function showEnrichment(result) {
  if (!result || !result.score) return;

  const tagsHtml = (result.tags || [])
    .map(t => '<span class="tag">' + escapeHtml(t) + '</span>')
    .join('');

  const takeawaysHtml = (result.key_takeaways || [])
    .map(t => '<li>' + escapeHtml(t) + '</li>')
    .join('');

  const actionsHtml = (result.action_items || [])
    .map(a => '<li>' + escapeHtml(a) + '</li>')
    .join('');

  let html =
    '<div class="enrichment-header">' +
      '<span class="score-badge score-' + result.score + '">Score: ' + result.score + '</span>' +
      '<span class="domain-badge">' + escapeHtml(result.domain || '') + '</span>' +
      '<span class="signal-type">' + escapeHtml(result.signal_type || '') + '</span>' +
    '</div>' +
    '<p class="enrichment-summary">' + escapeHtml(result.summary || '') + '</p>';

  if (takeawaysHtml) {
    html += '<p class="enrichment-label">Key Takeaways</p><ul class="enrichment-list">' + takeawaysHtml + '</ul>';
  }

  if (actionsHtml) {
    html += '<p class="enrichment-label">Actions</p><ul class="enrichment-list action-list">' + actionsHtml + '</ul>';
  }

  if (result.novelty) {
    html += '<p class="enrichment-label">What\'s New</p><p class="enrichment-novelty">' + escapeHtml(result.novelty) + '</p>';
  }

  if (tagsHtml) {
    html += '<div class="enrichment-tags">' + tagsHtml + '</div>';
  }

  enrichmentEl.innerHTML = html;
  enrichmentEl.className = 'enrichment';
}

// --- Settings ---
function loadSettings() {
  chrome.storage.sync.get(
    ['claudeApiKey', 'notionToken', 'notionDbId', 'slackWebhookUrl'],
    (s) => {
      if (s.claudeApiKey) claudeKeyInput.value = s.claudeApiKey;
      if (s.notionToken) notionTokenInput.value = s.notionToken;
      if (s.notionDbId) notionDbIdInput.value = s.notionDbId;
      if (s.slackWebhookUrl) slackWebhookInput.value = s.slackWebhookUrl;
    }
  );
}

saveSettingsBtn.addEventListener('click', () => {
  const claudeKey = claudeKeyInput.value.trim();
  const notionToken = notionTokenInput.value.trim();

  if (!claudeKey) {
    showStatus('Claude API key is required.', 'error');
    return;
  }
  if (!notionToken) {
    showStatus('Notion token is required.', 'error');
    return;
  }

  saveSettingsBtn.disabled = true;
  saveSettingsBtn.textContent = 'Validating…';
  showStatus('Testing API connections…', 'loading');

  // Quick validation: test Claude API key
  validateClaudeKey(claudeKey).then(valid => {
    if (!valid) {
      showStatus('Invalid Claude API key — check and retry.', 'error');
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = 'Save Settings';
      return;
    }

    chrome.storage.sync.set({
      claudeApiKey: claudeKey,
      notionToken: notionToken,
      notionDbId: notionDbIdInput.value.trim(),
      slackWebhookUrl: slackWebhookInput.value.trim()
    }, () => {
      showStatus('Settings saved — you\'re ready to go!', 'success');
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = 'Save Settings';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Voyager';
      setTimeout(() => hideStatus(), 3000);
    });
  });
});

async function validateClaudeKey(key) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- History ---
function loadHistory() {
  chrome.storage.local.get(['saveHistory'], (result) => {
    const history = result.saveHistory || [];
    historyCount.textContent = history.length;
    renderSparkline(history);

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
        (item.summary ? '<p class="history-summary">' + escapeHtml(item.summary) + '</p>' : '') +
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

// --- Content preview ---
function showContentPreview(text) {
  if (!text || text.trim().length === 0) return;
  const clean = text.replace(/\s+/g, ' ').trim();
  const truncated = clean.length > 200 ? clean.substring(0, 200) + '\u2026' : clean;
  contentPreviewEl.textContent = truncated;
  contentPreviewEl.classList.add('visible');
}

// --- Tag management ---
function parseTagInput() {
  return tagInput.value
    .split(',')
    .map(function(t) { return t.trim().toLowerCase(); })
    .filter(function(t) { return t.length > 0; });
}

function loadRecentTags() {
  chrome.storage.local.get(['recentTags'], function(result) {
    var tags = result.recentTags || [];
    renderRecentTags(tags);
  });
}

function saveRecentTags(newTags) {
  chrome.storage.local.get(['recentTags'], function(result) {
    var existing = result.recentTags || [];
    // Prepend new tags, deduplicate, cap at 20
    var merged = newTags.concat(existing);
    var seen = {};
    var unique = [];
    for (var i = 0; i < merged.length; i++) {
      if (!seen[merged[i]]) {
        seen[merged[i]] = true;
        unique.push(merged[i]);
      }
    }
    var capped = unique.slice(0, 20);
    chrome.storage.local.set({ recentTags: capped }, function() {
      renderRecentTags(capped);
    });
  });
}

function renderRecentTags(tags) {
  recentTagsEl.innerHTML = '';
  tags.forEach(function(tag) {
    var chip = document.createElement('span');
    chip.className = 'recent-tag-chip';
    chip.textContent = tag;
    chip.addEventListener('click', function() {
      var current = parseTagInput();
      if (current.indexOf(tag) === -1) {
        current.push(tag);
        tagInput.value = current.join(', ');
      }
    });
    recentTagsEl.appendChild(chip);
  });
}

// --- Score sparkline ---
function renderSparkline(history) {
  var scores = history
    .slice(0, 20)
    .reverse()
    .map(function(item) { return item.score; })
    .filter(function(s) { return s >= 1 && s <= 5; });

  if (scores.length < 2) {
    sparklineSvg.style.display = 'none';
    return;
  }

  sparklineSvg.style.display = '';
  var width = 120;
  var height = 24;
  var padding = 2;
  var step = (width - padding * 2) / (scores.length - 1);

  var points = scores.map(function(score, i) {
    var x = padding + i * step;
    // Score 5 = top (padding), score 1 = bottom (height - padding)
    var y = height - padding - ((score - 1) / 4) * (height - padding * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });

  var lastX = padding + (scores.length - 1) * step;
  var lastY = height - padding - ((scores[scores.length - 1] - 1) / 4) * (height - padding * 2);

  sparklineSvg.innerHTML =
    '<polyline points="' + points.join(' ') + '"></polyline>' +
    '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="2"></circle>';
}
