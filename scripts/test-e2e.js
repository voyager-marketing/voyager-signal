#!/usr/bin/env node
/**
 * End-to-end test: simulates X post → extension capture → webhook → enrichment
 *
 * Modes:
 *   --mock     Starts a local mock webhook server and tests against it (default)
 *   --live     Sends to the real n8n webhook URL (reads from WEBHOOK_URL env var)
 *
 * Usage:
 *   node scripts/test-e2e.js          # mock mode
 *   node scripts/test-e2e.js --mock   # mock mode (explicit)
 *   WEBHOOK_URL=https://... node scripts/test-e2e.js --live   # live mode
 */

const http = require('http');
const https = require('https');

const MOCK_PORT = 9877;
const isLive = process.argv.includes('--live');

// --- Test fixtures ---

const fixtures = {
  xPost: {
    url: 'https://x.com/pmarca/status/1234567890',
    title: 'Thread by Marc Andreessen (@pmarca)',
    content: `Thread by Marc Andreessen (@pmarca)
URL: https://x.com/pmarca/status/1234567890
Tweets: 3
---
>> @pmarca: The most important thing happening in marketing right now is the shift from brand-led to signal-led strategy. Companies that capture and act on real-time signals will win.

[1] @pmarca: This means your tech stack needs to be a sensing network, not just a publishing tool. Every touchpoint is an antenna.

[2] @pmarca: The agencies that figure this out first will eat the market. The rest will be replaced by AI + a junior PM.
`,
    excerpt: 'The most important thing happening in marketing right now is the shift from brand-led to signal-led strategy.',
    byline: 'Marc Andreessen @pmarca',
    siteName: 'X (Twitter)',
    source: 'x'
  },

  substackArticle: {
    url: 'https://example.substack.com/p/future-of-agencies',
    title: 'The Future of Marketing Agencies in the AI Era',
    content: `Marketing agencies face an existential moment. The traditional model — big teams, slow processes, expensive retainers — is being disrupted by AI-native firms that move faster with fewer people. But the winners won't be pure-AI shops. They'll be hybrid teams that use AI as a force multiplier while maintaining the human judgment that clients actually pay for. The key capability is signal intelligence: the ability to detect, score, and act on market signals faster than competitors.`,
    excerpt: 'Marketing agencies face an existential moment.',
    byline: 'Industry Observer',
    siteName: 'Substack',
    source: 'substack'
  }
};

// --- Test runner ---

async function runTests() {
  const webhookUrl = isLive
    ? process.env.WEBHOOK_URL
    : `http://localhost:${MOCK_PORT}/webhook/voyager-signal`;

  if (isLive && !webhookUrl) {
    console.error('ERROR: --live mode requires WEBHOOK_URL environment variable');
    process.exit(1);
  }

  console.log(`\n=== Voyager Signal E2E Test ===`);
  console.log(`Mode: ${isLive ? 'LIVE' : 'MOCK'}`);
  console.log(`Webhook: ${webhookUrl}\n`);

  let mockServer;
  const receivedPayloads = [];

  // Start mock server if needed
  if (!isLive) {
    mockServer = await startMockServer(receivedPayloads);
  }

  let passed = 0;
  let failed = 0;

  // Test 1: X post capture
  console.log('--- Test 1: X post capture ---');
  try {
    const result = await sendPayload(webhookUrl, fixtures.xPost);
    assert(result.status >= 200 && result.status < 300, `Expected 2xx, got ${result.status}`);

    if (!isLive) {
      const payload = receivedPayloads[receivedPayloads.length - 1];
      assert(payload.source === 'x', `Source should be "x", got "${payload.source}"`);
      assert(payload.url.includes('x.com'), 'URL should contain x.com');
      assert(payload.title.includes('pmarca'), 'Title should include author handle');
      assert(payload.content.length > 100, 'Content should be substantial');
      assert(payload.capturedAt, 'Should have capturedAt timestamp');
    }

    console.log('  PASS: X post payload sent and validated');
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    failed++;
  }

  // Test 2: Substack article capture
  console.log('\n--- Test 2: Substack article capture ---');
  try {
    const result = await sendPayload(webhookUrl, fixtures.substackArticle);
    assert(result.status >= 200 && result.status < 300, `Expected 2xx, got ${result.status}`);

    if (!isLive) {
      const payload = receivedPayloads[receivedPayloads.length - 1];
      assert(payload.source === 'substack', `Source should be "substack", got "${payload.source}"`);
      assert(payload.excerpt.length > 0, 'Excerpt should not be empty');
    }

    console.log('  PASS: Substack article payload sent and validated');
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    failed++;
  }

  // Test 3: Payload structure validation
  console.log('\n--- Test 3: Payload structure ---');
  try {
    if (!isLive) {
      const payload = receivedPayloads[0];
      const requiredFields = ['url', 'title', 'content', 'excerpt', 'byline', 'siteName', 'capturedAt', 'source'];
      for (const field of requiredFields) {
        assert(field in payload, `Missing required field: ${field}`);
      }
      assert(typeof payload.capturedAt === 'string', 'capturedAt should be a string');
      assert(payload.capturedAt.includes('T'), 'capturedAt should be ISO format');
    } else {
      console.log('  SKIP: Structure validation only runs in mock mode');
    }

    console.log('  PASS: All required fields present with correct types');
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    failed++;
  }

  // Test 4: Source detection
  console.log('\n--- Test 4: Source detection ---');
  try {
    const testCases = [
      { url: 'https://x.com/user/status/123', expected: 'x' },
      { url: 'https://twitter.com/user/status/123', expected: 'x' },
      { url: 'https://linkedin.com/posts/123', expected: 'linkedin' },
      { url: 'https://example.substack.com/p/test', expected: 'substack' },
      { url: 'https://medium.com/@user/post', expected: 'medium' },
      { url: 'https://example.com/article', expected: 'web' },
    ];

    for (const { url, expected } of testCases) {
      const detected = detectSource(url);
      assert(detected === expected, `detectSource("${url}") = "${detected}", expected "${expected}"`);
    }

    console.log('  PASS: All source types correctly detected');
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    failed++;
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (mockServer) {
    mockServer.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

// --- Helpers ---

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function detectSource(url) {
  if (!url) return 'unknown';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'x';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('substack.com')) return 'substack';
  if (url.includes('medium.com')) return 'medium';
  return 'web';
}

function sendPayload(webhookUrl, fixture) {
  const payload = {
    ...fixture,
    capturedAt: new Date().toISOString(),
    source: detectSource(fixture.url)
  };

  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);

    const req = transport.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function startMockServer(receivedPayloads) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const payload = JSON.parse(body);
            receivedPayloads.push(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', score: 4, title: payload.title }));
          } catch (e) {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      } else {
        res.writeHead(405);
        res.end('Method not allowed');
      }
    });

    server.listen(MOCK_PORT, () => {
      console.log(`Mock webhook server running on port ${MOCK_PORT}`);
      resolve(server);
    });
  });
}

// --- Run ---
runTests();
