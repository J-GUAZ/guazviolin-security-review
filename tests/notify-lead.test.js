// Handler tests for the lead-notification endpoint. Runs with Node's built-in test runner
// (`npm test`); Supabase and Resend are replaced with a mocked fetch, so nothing hits the network.
'use strict';

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const handlerAfter = require('../fixes/01-fail-closed-lead-email/after.js');
const handlerBefore = require('../fixes/01-fail-closed-lead-email/before.js');

const SUPABASE_URL = 'https://test-project.supabase.co';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const LEAD_ID = '11111111-2222-4333-8444-555555555555';

// What an attacker POSTs: an id plus content they want delivered to the owner's inbox.
const ATTACKER_BODY = { lead: { id: LEAD_ID, name: 'ATTACKER CONTENT', message: 'Click http://evil.test' } };

function storedRow(overrides = {}) {
  return {
    id: LEAD_ID,
    created_at: new Date().toISOString(),
    lead_data: { name: 'Real Client', message: 'Wedding on June 6', ...overrides },
  };
}

function mockRequest(body, method = 'POST') {
  return { method, body };
}

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

// Routes fetch calls: Resend calls are recorded, Supabase calls get `supabaseReply(url, options)`.
function mockFetch(supabaseReply) {
  const calls = { emails: [], supabase: [] };
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url === RESEND_ENDPOINT) {
      calls.emails.push(JSON.parse(options.body));
      return Response.json({ id: 'email_test' });
    }
    if (url.startsWith(SUPABASE_URL)) {
      calls.supabase.push({ url, method: options.method || 'GET' });
      return supabaseReply(url, options);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return calls;
}

const lookupReturns = (rows) => (url, options) =>
  options.method === 'PATCH' ? new Response(null, { status: 204 }) : Response.json(rows);

beforeEach(() => {
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.RESEND_API_KEY = 'test-resend-key';
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});

afterEach(() => {
  mock.restoreAll();
});

// --- The five verification cases, run against the fixed handler ---

test('1. no service key configured -> 503 and no email', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const calls = mockFetch(lookupReturns([]));
  const res = mockResponse();

  await handlerAfter(mockRequest(ATTACKER_BODY), res);

  assert.equal(res.statusCode, 503);
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.supabase.length, 0);
});

test('2. invalid service key (database rejects it) -> 503 and no email', async () => {
  const calls = mockFetch(() => Response.json({ message: 'Invalid API key' }, { status: 401 }));
  const res = mockResponse();

  await handlerAfter(mockRequest(ATTACKER_BODY), res);

  assert.equal(res.statusCode, 503);
  assert.equal(calls.emails.length, 0);
});

test('3. lead id not in the database -> 404 and no email', async () => {
  const calls = mockFetch(lookupReturns([]));
  const res = mockResponse();

  await handlerAfter(mockRequest(ATTACKER_BODY), res);

  assert.equal(res.statusCode, 404);
  assert.equal(calls.emails.length, 0);
});

test('4. real lead -> 200, one email built from the STORED lead, lead marked notified', async () => {
  const calls = mockFetch(lookupReturns([storedRow()]));
  const res = mockResponse();

  await handlerAfter(mockRequest(ATTACKER_BODY), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.emails.length, 1);
  assert.match(calls.emails[0].html, /Real Client/);
  assert.doesNotMatch(calls.emails[0].html, /ATTACKER CONTENT/);
  assert.ok(calls.supabase.some((call) => call.method === 'PATCH'), 'expected notifiedAt to be saved');
});

test('5. lead already notified -> 200 but no second email', async () => {
  const calls = mockFetch(lookupReturns([storedRow({ notifiedAt: new Date().toISOString() })]));
  const res = mockResponse();

  await handlerAfter(mockRequest(ATTACKER_BODY), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.emails.length, 0);
  assert.ok(!calls.supabase.some((call) => call.method === 'PATCH'));
});

// --- Regression: the original handler failed open in cases 1 and 2 ---

test('regression: BEFORE fix, no service key relays attacker content into the inbox', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const calls = mockFetch(lookupReturns([]));
  const res = mockResponse();

  await handlerBefore(mockRequest(ATTACKER_BODY), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.emails.length, 1);
  assert.match(calls.emails[0].html, /ATTACKER CONTENT/);
});

test('regression: BEFORE fix, invalid service key relays attacker content into the inbox', async () => {
  const calls = mockFetch(() => Response.json({ message: 'Invalid API key' }, { status: 401 }));
  const res = mockResponse();

  await handlerBefore(mockRequest(ATTACKER_BODY), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.emails.length, 1);
  assert.match(calls.emails[0].html, /ATTACKER CONTENT/);
});
