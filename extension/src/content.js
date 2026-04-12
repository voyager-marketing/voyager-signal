// Save to Voyager — content script
// Runs on all pages. Extracts readable content on demand via message.
// Uses specialized extractors for X/Twitter threads.

(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'extractContent') {
      try {
        const result = extractPage();
        sendResponse({ success: true, data: result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }

    if (message.action === 'getSelectedLinks') {
      try {
        const urls = getSelectedLinks();
        sendResponse({ success: true, urls });
      } catch (err) {
        sendResponse({ success: false, error: err.message, urls: [] });
      }
    }

    if (message.action === 'showNotification') {
      showToast(message.message, message.type);
    }

    return true;
  });

  function extractPage() {
    // Try X/Twitter thread extractor first
    const xExtractor = window.__voyagerXThreadExtractor;
    if (xExtractor && xExtractor.isXPage()) {
      const thread = xExtractor.extractThread();
      if (thread && thread.tweets.length > 0) {
        return {
          url: thread.url,
          title: `Thread by ${thread.author.displayName} (${thread.author.handle})`,
          content: xExtractor.formatAsText(thread),
          excerpt: thread.tweets.find(t => t.isMainTweet)?.text || thread.tweets[0]?.text || '',
          byline: `${thread.author.displayName} ${thread.author.handle}`,
          siteName: 'X (Twitter)',
          _thread: thread // full structured data for enrichment
        };
      }
    }

    // Fall back to Readability for general pages
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();

    if (!article) {
      return {
        url: location.href,
        title: document.title,
        content: document.body.innerText.slice(0, 5000),
        excerpt: '',
        byline: '',
        siteName: location.hostname
      };
    }

    return {
      url: location.href,
      title: article.title || document.title,
      content: article.textContent,
      excerpt: article.excerpt || '',
      byline: article.byline || '',
      siteName: article.siteName || location.hostname
    };
  }

  function getSelectedLinks() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return [];

    const urls = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      const container = range.cloneContents();
      const anchors = container.querySelectorAll('a[href]');
      anchors.forEach((a) => {
        const href = a.getAttribute('href');
        if (href) {
          // Resolve relative URLs
          try {
            const resolved = new URL(href, location.href).href;
            if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
              urls.push(resolved);
            }
          } catch (e) {
            // skip malformed URLs
          }
        }
      });
    }

    // Also check if selected nodes contain anchors that cloneContents might miss
    // (e.g., when selection starts/ends inside an anchor)
    if (urls.length === 0 && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const root = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
      if (root) {
        const allAnchors = root.querySelectorAll('a[href]');
        allAnchors.forEach((a) => {
          if (selection.containsNode(a, true)) {
            try {
              const resolved = new URL(a.href, location.href).href;
              if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
                urls.push(resolved);
              }
            } catch (e) {
              // skip
            }
          }
        });
      }
    }

    return [...new Set(urls)];
  }

  function showToast(msg, type) {
    const existing = document.getElementById('voyager-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'voyager-toast';
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      padding: '12px 20px',
      borderRadius: '8px',
      fontSize: '14px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      color: '#fff',
      background: type === 'success' ? '#065f46' : '#991b1b',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      zIndex: '999999',
      transition: 'opacity 0.3s'
    });

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
})();
