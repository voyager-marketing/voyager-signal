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
    const url = location.href;
    const hostname = location.hostname;

    // Source-specific extractors for sites where Readability struggles
    if (hostname.includes('x.com') || hostname.includes('twitter.com')) {
      return extractXThread(url);
    }
    if (hostname.includes('linkedin.com')) {
      return extractLinkedIn(url);
    }

    // Default: Mozilla Readability
    return extractWithReadability(url);
  }

  // --- Readability (default) ---
  function extractWithReadability(url) {
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();

    if (!article) {
      return fallbackExtract(url);
    }

    return {
      url,
      title: article.title || document.title,
      content: article.textContent,
      excerpt: article.excerpt || '',
      byline: article.byline || '',
      siteName: article.siteName || location.hostname
    };
  }

  // --- X / Twitter thread extractor ---
  function extractXThread(url) {
    // Gather all tweet text on the page (thread view)
    const tweetEls = document.querySelectorAll(
      '[data-testid="tweetText"], article [lang]'
    );
    const tweets = [];
    const seen = new Set();
    tweetEls.forEach(el => {
      const text = el.innerText.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        tweets.push(text);
      }
    });

    // Get author from the main tweet
    const authorEl = document.querySelector(
      '[data-testid="User-Name"] span, [data-testid="UserName"] span'
    );
    const byline = authorEl ? authorEl.innerText : '';

    const content = tweets.length > 0
      ? tweets.join('\n\n---\n\n')
      : document.body.innerText.slice(0, 8000);

    return {
      url,
      title: document.title,
      content,
      excerpt: tweets[0] || '',
      byline,
      siteName: 'X (Twitter)'
    };
  }

  // --- LinkedIn post/article extractor ---
  function extractLinkedIn(url) {
    // LinkedIn article
    if (url.includes('/pulse/') || url.includes('/article/')) {
      return extractWithReadability(url);
    }

    // LinkedIn post/feed item
    const postEl = document.querySelector(
      '.feed-shared-update-v2__description, .update-components-text, ' +
      '.attributed-text-segment-list__container'
    );
    const content = postEl
      ? postEl.innerText.trim()
      : document.body.innerText.slice(0, 5000);

    const authorEl = document.querySelector(
      '.update-components-actor__name span, .feed-shared-actor__name span'
    );
    const byline = authorEl ? authorEl.innerText.trim() : '';

    return {
      url,
      title: document.title,
      content,
      excerpt: content.slice(0, 200),
      byline,
      siteName: 'LinkedIn'
    };
  }

  // --- Fallback for when Readability can't parse ---
  function fallbackExtract(url) {
    // Try meta tags first
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');

    return {
      url,
      title: ogTitle?.content || document.title,
      content: document.body.innerText.slice(0, 8000),
      excerpt: ogDesc?.content || '',
      byline: '',
      siteName: location.hostname
    };
  }
})();
