// node --test   worker.js against a fake Anthropic / Ahrefs (global fetch).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { extractJson, normalizeUrl } from './worker.js';

let realFetch, calls, reply;
beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  reply = { status: 200, body: { content: [{ type: 'text', text: '```json\n{"overallScore": 72}\n```' }], usage: { input_tokens: 1 }, stop_reason: 'end_turn' } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('ahrefs')) return Response.json({ domain_rating: 41, ahrefs_rank: 12345 });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const ENV = { ANTHROPIC_API_KEY: 'sk-ant-test', ASSETS: { fetch: async () => new Response('page') } };
const analyze = (env, body) => worker.fetch(new Request('https://p/api/analyze', { method: 'POST', body: JSON.stringify(body) }), env);

test('normalizeUrl and extractJson behave like main.py', () => {
  assert.equal(normalizeUrl(' example.com '), 'https://example.com');
  assert.equal(normalizeUrl('http://x.io'), 'http://x.io');
  assert.throws(() => normalizeUrl('  '), /URL is required/);
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json'), /No JSON object/);
});

test('analyze sends the system prompt + web_search tool and tags the result as an AI estimate', async () => {
  const res = await analyze(ENV, { url: 'example.com' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.overallScore, 72);
  assert.deepEqual(body.dataSource, { authority: 'ai_estimate', onPage: 'live_fetch' });
  assert.deepEqual(body._meta, { targetUrl: 'https://example.com', model: 'claude-haiku-4-5-20251001' });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.tools[0].type, 'web_search_20250305');
  assert.match(sent.system, /GEO \(Generative Engine Optimization\)/);
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-test');
});

test('with AHREFS_API_KEY the verified domain rating is attached', async () => {
  const body = await (await analyze({ ...ENV, AHREFS_API_KEY: 'ah' }, { url: 'https://example.com/page' })).json();
  assert.equal(body.dataSource.authority, 'ahrefs');
  assert.deepEqual(body.verifiedStats, { domainRating: 41, ahrefsRank: 12345 });
  assert.match(calls[1].url, /target=example\.com$/);
});

test('errors: missing key 500, upstream error 502, truncated JSON 502, bad body 422', async () => {
  const noKey = await analyze({ ASSETS: ENV.ASSETS }, { url: 'x.com' });
  assert.equal(noKey.status, 500);
  assert.match((await noKey.json()).detail, /ANTHROPIC_API_KEY is not configured/);
  reply = { status: 529, body: { error: 'overloaded' } };
  assert.equal((await analyze(ENV, { url: 'x.com' })).status, 502);
  reply = { status: 200, body: { content: [{ type: 'text', text: '{"overallScore": ' }], stop_reason: 'max_tokens' } };
  assert.match((await (await analyze(ENV, { url: 'x.com' })).json()).detail, /cut off/);
  assert.equal((await analyze(ENV, { url: '' })).status, 422);
});

test('health reports whether the key is set; other paths serve the frontend', async () => {
  assert.deepEqual(await (await worker.fetch(new Request('https://p/api/health'), ENV)).json(), { status: 'ok', key_configured: true });
  assert.equal(await (await worker.fetch(new Request('https://p/'), ENV)).text(), 'page');
});
