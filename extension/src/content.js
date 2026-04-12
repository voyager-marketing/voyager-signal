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
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      return extractYouTube(url);
    }
    if (hostname.includes('reddit.com')) {
      return extractReddit(url);
    }
    if (hostname.includes('substack.com') || document.querySelector('meta[content*="Substack"]')) {
      return extractSubstack(url);
    }
    if (hostname.includes('medium.com') || document.querySelector('meta[name="twitter:app:id:iphone"][content="828256236"]')) {
      return extractMedium(url);
    }
    if (hostname.includes('mail.google.com')) {
      return extractGmailNewsletter(url);
    }
    if (hostname.includes('outlook.live.com') || hostname.includes('outlook.office.com')) {
      return extractEmailNewsletter(url);
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

  // --- YouTube video extractor ---
  function extractYouTube(url) {
    // Video title — try structured element first, then fall back to selectors
    const titleEl = document.querySelector(
      'ytd-watch-metadata h1 yt-formatted-string, ' +
      'h1.ytd-watch-metadata yt-formatted-string, ' +
      'h1.title yt-formatted-string, ' +
      '#title h1 yt-formatted-string, ' +
      'h1.ytd-video-primary-info-renderer'
    );
    const title = titleEl ? titleEl.innerText.trim() : document.title;

    // Channel name
    const channelEl = document.querySelector(
      'ytd-channel-name yt-formatted-string a, ' +
      '#channel-name a, ' +
      '#owner-name a, ' +
      'ytd-video-owner-renderer #channel-name yt-formatted-string'
    );
    const byline = channelEl ? channelEl.innerText.trim() : '';

    // Description text
    const descEl = document.querySelector(
      '#description-text, ' +
      'ytd-text-inline-expander #plain-snippet-text, ' +
      'ytd-text-inline-expander .content, ' +
      '#description .content, ' +
      'ytd-expander[collapsed] #content'
    );
    const description = descEl ? descEl.innerText.trim() : '';

    // Attempt to grab transcript if the transcript panel is open
    const transcriptSegments = document.querySelectorAll(
      'ytd-transcript-segment-renderer, ' +
      'ytd-transcript-segment-list-renderer .segment, ' +
      '[target-id="engagement-panel-searchable-transcript"] .segment-text, ' +
      'yt-formatted-string.segment-text'
    );
    let transcript = '';
    if (transcriptSegments.length > 0) {
      const lines = [];
      transcriptSegments.forEach(seg => {
        const timestampEl = seg.querySelector('.segment-timestamp, [class*="timestamp"]');
        const textEl = seg.querySelector('.segment-text, yt-formatted-string') || seg;
        const timestamp = timestampEl ? timestampEl.innerText.trim() : '';
        const text = textEl.innerText.trim();
        if (text) {
          lines.push(timestamp ? '[' + timestamp + '] ' + text : text);
        }
      });
      transcript = lines.join('\n');
    }

    // Build content: description + transcript (if available)
    const parts = [];
    if (description) {
      parts.push('DESCRIPTION:\n' + description);
    }
    if (transcript) {
      parts.push('TRANSCRIPT:\n' + transcript);
    }
    const content = parts.length > 0
      ? parts.join('\n\n---\n\n')
      : document.body.innerText.slice(0, 8000);

    return {
      url,
      title,
      content,
      excerpt: description.slice(0, 300),
      byline,
      siteName: 'YouTube'
    };
  }

  // --- Reddit post + comments extractor ---
  function extractReddit(url) {
    // Try new Reddit (shreddit custom elements) first, then old Reddit selectors
    const result = extractRedditNew(url) || extractRedditOld(url);
    if (result) return result;

    // Final fallback — Readability or basic extraction
    return extractWithReadability(url);
  }

  function extractRedditNew(url) {
    // New Reddit uses shreddit- custom elements
    const postEl = document.querySelector('shreddit-post');
    if (!postEl) return null;

    const title = postEl.getAttribute('post-title') ||
      (document.querySelector('h1') ? document.querySelector('h1').innerText.trim() : '') ||
      document.title;

    const subreddit = postEl.getAttribute('subreddit-prefixed-name') ||
      (function() {
        var el = document.querySelector('a[href*="/r/"][data-click-id="subreddit"]');
        return el ? el.innerText.trim() : '';
      })();

    const author = postEl.getAttribute('author') ||
      (function() {
        var el = document.querySelector('a[href*="/user/"][data-click-id="user"]');
        return el ? el.innerText.trim() : '';
      })();

    // Post body text
    const bodyEl = postEl.querySelector('[slot="text-body"]') ||
      document.querySelector('[slot="text-body"]') ||
      document.querySelector('[data-click-id="text"] .md');
    const body = bodyEl ? bodyEl.innerText.trim() : '';

    // Collect top comments (up to 10)
    const commentEls = document.querySelectorAll('shreddit-comment');
    const comments = [];
    for (let i = 0; i < Math.min(commentEls.length, 10); i++) {
      const c = commentEls[i];
      const commentAuthor = c.getAttribute('author') || 'unknown';
      const commentBody = c.querySelector('[slot="comment"]') ||
        c.querySelector('.md') ||
        c.querySelector('[id*="comment-content"]');
      const commentText = commentBody ? commentBody.innerText.trim() : '';
      if (commentText) {
        comments.push('u/' + commentAuthor + ':\n' + commentText);
      }
    }

    const parts = [];
    if (body) parts.push(body);
    if (comments.length > 0) {
      parts.push('TOP COMMENTS:\n\n' + comments.join('\n\n---\n\n'));
    }

    return {
      url,
      title: subreddit ? '[' + subreddit + '] ' + title : title,
      content: parts.join('\n\n---\n\n') || document.body.innerText.slice(0, 8000),
      excerpt: body.slice(0, 300),
      byline: author ? 'u/' + author : '',
      siteName: 'Reddit'
    };
  }

  function extractRedditOld(url) {
    // Old Reddit / redesign selectors
    const titleEl = document.querySelector(
      'a.title.may-blank, ' +         // old.reddit
      'h1._eYtD2XCVieq6emjKBH3m, ' + // redesign
      '._1qeIAgB0cPwnLhDF9XSiJM h1, ' +
      '[data-test-id="post-content"] h1'
    );
    if (!titleEl) return null;

    const title = titleEl.innerText.trim();

    const subredditEl = document.querySelector(
      '.subreddit, a.subreddit, ' +
      'a[data-click-id="subreddit"]'
    );
    const subreddit = subredditEl ? subredditEl.innerText.trim() : '';

    const authorEl = document.querySelector(
      'a.author, ' +
      'a[data-click-id="user"]'
    );
    const author = authorEl ? authorEl.innerText.trim() : '';

    // Post body
    const bodyEl = document.querySelector(
      '.usertext-body .md, ' +
      '._1qeIAgB0cPwnLhDF9XSiJM .md, ' +
      '[data-test-id="post-content"] .md, ' +
      '[data-click-id="text"]'
    );
    const body = bodyEl ? bodyEl.innerText.trim() : '';

    // Comments — old Reddit
    const commentEls = document.querySelectorAll(
      '.comment .usertext-body .md, ' +
      '._1qeIAgB0cPwnLhDF9XSiJM .Comment'
    );
    const comments = [];
    for (let i = 0; i < Math.min(commentEls.length, 10); i++) {
      const text = commentEls[i].innerText.trim();
      if (text) comments.push(text);
    }

    const parts = [];
    if (body) parts.push(body);
    if (comments.length > 0) {
      parts.push('TOP COMMENTS:\n\n' + comments.join('\n\n---\n\n'));
    }

    return {
      url,
      title: subreddit ? '[' + subreddit + '] ' + title : title,
      content: parts.join('\n\n---\n\n') || document.body.innerText.slice(0, 8000),
      excerpt: body.slice(0, 300),
      byline: author,
      siteName: 'Reddit'
    };
  }

  // --- Substack extractor (enhanced Readability) ---
  function extractSubstack(url) {
    // Try Readability first for the main article body
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();

    // Grab Substack-specific metadata not always caught by Readability
    const subtitleEl = document.querySelector(
      '.subtitle, [data-testid="subtitle"], ' +
      'h3.subtitle, .post-subtitle, ' +
      '.single-post-summary'
    );
    const subtitle = subtitleEl ? subtitleEl.innerText.trim() : '';

    const pubNameEl = document.querySelector(
      '.publication-name, [data-testid="publication-name"], ' +
      'a.navbar-title, .navbar-title-link, ' +
      '.pencraft.pc-display-flex .pub-name'
    );
    const publicationName = pubNameEl ? pubNameEl.innerText.trim() : '';

    // If Readability got content, enhance it
    if (article && article.textContent) {
      const enhancedContent = subtitle
        ? subtitle + '\n\n' + article.textContent
        : article.textContent;

      return {
        url,
        title: article.title || document.title,
        content: enhancedContent,
        excerpt: subtitle || article.excerpt || '',
        byline: article.byline || '',
        siteName: publicationName || article.siteName || 'Substack'
      };
    }

    // Fallback: manual extraction for Substack
    const bodyEl = document.querySelector(
      '.body.markup, .post-content, ' +
      '[data-testid="post-body"], .available-content'
    );
    const content = bodyEl
      ? bodyEl.innerText.trim()
      : document.body.innerText.slice(0, 10000);

    const authorEl = document.querySelector(
      '.author-name, [data-testid="author-name"], ' +
      '.post-meta-item a'
    );
    const byline = authorEl ? authorEl.innerText.trim() : '';

    return {
      url,
      title: document.title,
      content: subtitle ? subtitle + '\n\n' + content : content,
      excerpt: subtitle || content.slice(0, 300),
      byline,
      siteName: publicationName || 'Substack'
    };
  }

  // --- Medium extractor (enhanced Readability) ---
  function extractMedium(url) {
    // Try Readability first
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();

    // Medium-specific extras
    const clapEl = document.querySelector(
      '[data-testid="clapCount"], ' +
      'button[data-action="show-recommends"] span, ' +
      '.js-multirecommendCountButton, ' +
      '.pw-multi-vote-count'
    );
    const clapCount = clapEl ? clapEl.innerText.trim() : '';

    const readingTimeEl = document.querySelector(
      '[data-testid="storyReadTime"], ' +
      '.pw-reading-time, ' +
      'span[class*="readingTime"], ' +
      '.reading-time'
    );
    const readingTime = readingTimeEl ? readingTimeEl.innerText.trim() : '';

    // Publication name on Medium
    const pubEl = document.querySelector(
      '[data-testid="publicationName"], ' +
      '.metabar-publication a, ' +
      'a[data-action="show-publication-home-page"]'
    );
    const publicationName = pubEl ? pubEl.innerText.trim() : '';

    if (article && article.textContent) {
      // Prepend metadata to content
      const meta = [];
      if (readingTime) meta.push('Reading time: ' + readingTime);
      if (clapCount) meta.push('Claps: ' + clapCount);

      const metaPrefix = meta.length > 0 ? meta.join(' | ') + '\n\n' : '';

      return {
        url,
        title: article.title || document.title,
        content: metaPrefix + article.textContent,
        excerpt: article.excerpt || '',
        byline: article.byline || '',
        siteName: publicationName || article.siteName || 'Medium'
      };
    }

    // Fallback for Medium articles
    const bodyEl = document.querySelector(
      'article, .postArticle-content, ' +
      '[data-testid="post-body"]'
    );
    const content = bodyEl
      ? bodyEl.innerText.trim()
      : document.body.innerText.slice(0, 10000);

    return {
      url,
      title: document.title,
      content,
      excerpt: content.slice(0, 300),
      byline: '',
      siteName: publicationName || 'Medium'
    };
  }

  // --- Gmail newsletter extractor ---
  function extractGmailNewsletter(url) {
    // Gmail message body container
    const emailBody = document.querySelector(
      '.a3s.aiL, ' +                   // Gmail standard message body
      '.ii.gt div, ' +                 // Alternative Gmail body
      '[data-message-id] .a3s'         // Scoped to a message
    );

    if (emailBody) {
      const content = emailBody.innerText.trim();

      // Try to get the email subject line
      const subjectEl = document.querySelector(
        'h2[data-thread-perm-id], ' +
        '.ha h2, ' +
        '.hP'
      );
      const subject = subjectEl ? subjectEl.innerText.trim() : document.title;

      // Sender
      const senderEl = document.querySelector(
        '.go .gD, ' +
        '[email], ' +
        '.qu .gD'
      );
      const sender = senderEl
        ? (senderEl.getAttribute('name') || senderEl.innerText.trim())
        : '';

      return {
        url,
        title: subject,
        content,
        excerpt: content.slice(0, 300),
        byline: sender,
        siteName: 'Email Newsletter (Gmail)'
      };
    }

    // Couldn't find Gmail body, fall through to generic
    return extractEmailNewsletter(url);
  }

  // --- Generic email/newsletter extractor ---
  function extractEmailNewsletter(url) {
    // Try common email client body selectors
    const selectors = [
      '.a3s.aiL',                       // Gmail
      '[role="main"] .ReadMsgBody',     // Outlook web
      '.ReadMsgBody',                   // Outlook
      '.rps_ad5e',                      // Outlook web alt
      '[aria-label="Message body"]',    // Generic webmail
      '[role="main"]',                  // General main content
      'iframe[id*="message"]'           // Some webmail uses iframes
    ];

    for (let i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.innerText && el.innerText.trim().length > 100) {
        return {
          url,
          title: document.title,
          content: el.innerText.trim(),
          excerpt: el.innerText.trim().slice(0, 300),
          byline: '',
          siteName: 'Email Newsletter'
        };
      }
    }

    // Could not isolate newsletter content — fall back to Readability
    return extractWithReadability(url);
  }

  // --- Fallback for when Readability can't parse ---
  function fallbackExtract(url) {
    // Try meta tags first
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');

    // Try structured content containers before raw body text
    const contentSelectors = [
      'article',
      '[role="article"]',
      '.post-content',
      '.entry-content',
      '.article-body',
      '.article-content',
      '.post-body',
      '.story-body',
      '.c-entry-content',
      'main article',
      'main .content',
      '#article-body',
      '.node-body',
      '.field-name-body'
    ];

    let content = '';
    for (let i = 0; i < contentSelectors.length; i++) {
      var el = document.querySelector(contentSelectors[i]);
      if (el && el.innerText && el.innerText.trim().length > 200) {
        content = el.innerText.trim();
        break;
      }
    }

    // If no structured container found, use body text
    if (!content) {
      content = document.body.innerText.slice(0, 8000);
    }

    return {
      url,
      title: ogTitle?.content || document.title,
      content,
      excerpt: ogDesc?.content || content.slice(0, 300),
      byline: '',
      siteName: location.hostname
    };
  }
})();
