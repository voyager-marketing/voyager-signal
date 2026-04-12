// Save to Voyager — content script
// Runs on all pages. Extracts readable content on demand via message.

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
    return true;
  });

  function extractPage() {
    // Clone the document so Readability doesn't mutate the live DOM
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
})();
