// X/Twitter Thread Extractor
// Captures ordered tweet elements from X.com thread pages.
// Handles: single tweets, threads, and quote tweets.

(() => {
  const XThreadExtractor = {
    /**
     * Check if current page is an X/Twitter status page
     */
    isXPage() {
      const url = location.href;
      return (url.includes('x.com/') || url.includes('twitter.com/')) &&
             url.includes('/status/');
    },

    /**
     * Extract all tweets from the current thread view.
     * Returns an ordered array of tweet objects.
     */
    extractThread() {
      if (!this.isXPage()) return null;

      const tweets = [];
      // X renders tweets in article[data-testid="tweet"] elements
      const tweetElements = document.querySelectorAll('article[data-testid="tweet"]');

      tweetElements.forEach((el, index) => {
        const tweet = this.parseTweetElement(el, index);
        if (tweet) tweets.push(tweet);
      });

      // Identify the main tweet (the one matching the URL status ID)
      const statusId = this.getStatusIdFromUrl();
      const mainIndex = tweets.findIndex(t => t.isMainTweet);

      return {
        url: location.href,
        statusId,
        author: this.getThreadAuthor(tweets),
        tweetCount: tweets.length,
        mainTweetIndex: mainIndex >= 0 ? mainIndex : 0,
        tweets,
        capturedAt: new Date().toISOString()
      };
    },

    /**
     * Parse a single tweet article element into structured data.
     */
    parseTweetElement(el, index) {
      try {
        // Author info
        const authorEl = el.querySelector('[data-testid="User-Name"]');
        const displayName = authorEl?.querySelector('span')?.textContent?.trim() || '';
        const handleEl = authorEl?.querySelectorAll('span');
        let handle = '';
        if (handleEl) {
          for (const span of handleEl) {
            if (span.textContent.startsWith('@')) {
              handle = span.textContent.trim();
              break;
            }
          }
        }

        // Tweet text
        const textEl = el.querySelector('[data-testid="tweetText"]');
        const text = textEl?.textContent?.trim() || '';

        // Timestamp
        const timeEl = el.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || '';
        const timeText = timeEl?.textContent?.trim() || '';

        // Media (images, videos)
        const media = this.extractMedia(el);

        // Engagement metrics
        const metrics = this.extractMetrics(el);

        // Quote tweet
        const quoteTweet = this.extractQuoteTweet(el);

        // Links
        const links = [];
        const linkEls = textEl?.querySelectorAll('a[href]') || [];
        linkEls.forEach(a => {
          const href = a.getAttribute('href');
          if (href && !href.startsWith('/') && !href.includes('x.com/hashtag')) {
            links.push({ text: a.textContent, url: href });
          }
        });

        // Hashtags
        const hashtags = [];
        const hashEls = textEl?.querySelectorAll('a[href*="/hashtag/"]') || [];
        hashEls.forEach(a => hashtags.push(a.textContent.trim()));

        // Is this the "main" tweet? (the focused/expanded one)
        // The main tweet is typically inside an element with a larger font or
        // is the one that matches the URL's status ID
        const isMainTweet = this.isMainTweetElement(el);

        return {
          index,
          author: { displayName, handle },
          text,
          timestamp,
          timeText,
          media,
          metrics,
          quoteTweet,
          links,
          hashtags,
          isMainTweet
        };
      } catch (err) {
        console.warn('[Voyager] Failed to parse tweet element:', err);
        return null;
      }
    },

    /**
     * Determine if a tweet element is the "main" focused tweet.
     * On X, the main tweet has a larger font and different layout.
     */
    isMainTweetElement(el) {
      // The main tweet's text is rendered at a larger font size
      const textEl = el.querySelector('[data-testid="tweetText"]');
      if (textEl) {
        const fontSize = window.getComputedStyle(textEl).fontSize;
        if (parseInt(fontSize) > 16) return true;
      }
      // Also check if the tweet contains the "replying to" context above it
      // Main tweets don't typically have a connecting line above
      return false;
    },

    /**
     * Extract media attachments from a tweet element.
     */
    extractMedia(el) {
      const media = [];

      // Images
      const imgEls = el.querySelectorAll('[data-testid="tweetPhoto"] img');
      imgEls.forEach(img => {
        const src = img.getAttribute('src');
        if (src && !src.includes('profile_images')) {
          media.push({ type: 'image', url: src, alt: img.getAttribute('alt') || '' });
        }
      });

      // Video (detect presence — actual video URL requires player interaction)
      const videoEl = el.querySelector('[data-testid="videoPlayer"]');
      if (videoEl) {
        media.push({ type: 'video', url: null, note: 'Video detected but URL requires player' });
      }

      // GIF
      const gifEl = el.querySelector('[data-testid="gifPlayer"]');
      if (gifEl) {
        const gifImg = gifEl.querySelector('img');
        media.push({ type: 'gif', url: gifImg?.getAttribute('src') || null });
      }

      return media;
    },

    /**
     * Extract engagement metrics (likes, retweets, replies, views).
     */
    extractMetrics(el) {
      const metrics = {};

      const groups = el.querySelectorAll('[role="group"] button');
      groups.forEach(btn => {
        const label = btn.getAttribute('aria-label') || '';
        const lower = label.toLowerCase();

        if (lower.includes('repl')) {
          metrics.replies = this.parseMetricNumber(label);
        } else if (lower.includes('repost') || lower.includes('retweet')) {
          metrics.reposts = this.parseMetricNumber(label);
        } else if (lower.includes('like')) {
          metrics.likes = this.parseMetricNumber(label);
        } else if (lower.includes('view')) {
          metrics.views = this.parseMetricNumber(label);
        } else if (lower.includes('bookmark')) {
          metrics.bookmarks = this.parseMetricNumber(label);
        }
      });

      return metrics;
    },

    /**
     * Parse a number from an aria-label like "123 Likes" or "1.2K replies"
     */
    parseMetricNumber(label) {
      const match = label.match(/([\d,.]+[KkMm]?)/);
      if (!match) return 0;
      let num = match[1].replace(/,/g, '');
      if (num.match(/[Kk]$/)) return Math.round(parseFloat(num) * 1000);
      if (num.match(/[Mm]$/)) return Math.round(parseFloat(num) * 1000000);
      return parseInt(num) || 0;
    },

    /**
     * Extract quote tweet if present.
     */
    extractQuoteTweet(el) {
      const quoteEl = el.querySelector('[data-testid="quoteTweet"]');
      if (!quoteEl) return null;

      const textEl = quoteEl.querySelector('[data-testid="tweetText"]');
      const authorEl = quoteEl.querySelector('[data-testid="User-Name"]');

      return {
        text: textEl?.textContent?.trim() || '',
        author: authorEl?.querySelector('span')?.textContent?.trim() || ''
      };
    },

    /**
     * Get the status ID from the current URL.
     */
    getStatusIdFromUrl() {
      const match = location.href.match(/\/status\/(\d+)/);
      return match ? match[1] : null;
    },

    /**
     * Get the primary thread author from the extracted tweets.
     */
    getThreadAuthor(tweets) {
      if (tweets.length === 0) return { displayName: '', handle: '' };
      // The main tweet's author, or fall back to first tweet
      const main = tweets.find(t => t.isMainTweet) || tweets[0];
      return main.author;
    },

    /**
     * Format the thread as readable text for enrichment.
     */
    formatAsText(threadData) {
      if (!threadData) return '';

      const lines = [];
      lines.push(`Thread by ${threadData.author.displayName} (${threadData.author.handle})`);
      lines.push(`URL: ${threadData.url}`);
      lines.push(`Tweets: ${threadData.tweetCount}`);
      lines.push('---');

      threadData.tweets.forEach((tweet, i) => {
        const prefix = tweet.isMainTweet ? '>> ' : `[${i + 1}] `;
        lines.push(`${prefix}${tweet.author.handle}: ${tweet.text}`);
        if (tweet.media.length > 0) {
          lines.push(`   [${tweet.media.map(m => m.type).join(', ')}]`);
        }
        if (tweet.quoteTweet) {
          lines.push(`   > QT @${tweet.quoteTweet.author}: ${tweet.quoteTweet.text}`);
        }
        if (tweet.timeText) {
          lines.push(`   ${tweet.timeText}`);
        }
        lines.push('');
      });

      return lines.join('\n');
    }
  };

  // Expose to content.js
  window.__voyagerXThreadExtractor = XThreadExtractor;
})();
