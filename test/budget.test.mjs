import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import worker from '../src/index.ts';
import { readDailyUsage, assertDailyBudget, parseNeurons, GRAPHQL_URL, CLAIM_SQL, SAVE_SQL } from '../src/budget.ts';
import { ACCOUNT_ID, fixture, graphResult } from './helpers.mjs';

const START = Date.parse('2026-08-28T03:00:00Z');
function harness({ now = START, answer = 600.347740650177 } = {}) {
  let clock = now;
  const requests = [];
  const rt = {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return typeof answer === 'function' ? answer(url, init) : Response.json(graphResult(answer));
    },
  };
  return { rt, requests, advance: ms => { clock += ms; }, set: n => { clock = n; } };
}
const unavailable = error => error.status === 503 && error.code === 'budget_unavailable';
const quota = error => error.status === 456 && error.code === 'quota_exceeded';

test('GraphQL parser accepts the dashboard metric and a genuinely empty dataset', () => {
  assert.equal(parseNeurons(graphResult(600.347740650177)), 600.347740650177);
  assert.equal(parseNeurons(graphResult(0)), 0);
  assert.equal(parseNeurons({ data: { viewer: { accounts: [{ daily: [] }] } } }), 0);
});

test('GraphQL errors, missing access and malformed values never become zero', () => {
  for (const payload of [null, {}, { errors: [{ message: 'denied' }] },
    { ...graphResult(1), errors: [{ message: 'partial failure' }] },
    { data: { viewer: { accounts: [] } } },
    { data: { viewer: { accounts: [{}] } } },
    { data: { viewer: { accounts: [{ daily: null }] } } },
    { data: { viewer: { accounts: [{ daily: [] }, { daily: [] }] } } },
    ...[-1, NaN, Infinity, null, '0'].map(graphResult),
  ]) assert.throws(() => parseNeurons(payload), unavailable);
});

test('queries only the official account-wide UTC-day metric and stores fractional neurons', async () => {
  const f = fixture({ fresh: false });
  const h = harness();
  const row = await readDailyUsage(f.env, h.rt);
  assert.equal(row.neurons, 600.347740650177);
  assert.equal(row.day, '2026-08-28');
  assert.equal(h.requests.length, 1);
  const { url, init } = h.requests[0];
  assert.equal(url, GRAPHQL_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, `Bearer ${f.env.CF_ANALYTICS_TOKEN}`);
  assert.ok(init.signal instanceof AbortSignal);
  const { query } = JSON.parse(init.body);
  assert.match(query, new RegExp(ACCOUNT_ID));
  assert.match(query, /date_geq:"2026-08-28",date_leq:"2026-08-28"/);
  assert.doesNotMatch(query, /modelId|requestSource|text|prompt/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM daily_budget').get().n, 0);
  assert.equal(row.lease_id, null);
});

test('cached usage is reused for 60 seconds and old reservation exhaustion is ignored', async () => {
  const f = fixture({ fresh: false });
  f.db.prepare('INSERT INTO daily_budget VALUES (?, 7500)').run('2026-08-28');
  const h = harness();
  await assertDailyBudget(f.env, h.rt);
  h.advance(59_999);
  await assertDailyBudget(f.env, h.rt);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  await assertDailyBudget(f.env, h.rt);
  assert.equal(h.requests.length, 2);
  assert.equal(f.db.prepare('SELECT reserved_units FROM daily_budget').get().reserved_units, 7500);
});

test('9499.999 is allowed and 9500 or greater blocks without estimated reservations', async () => {
  for (const neurons of [0, 9499.999, 9500, 10_001]) {
    const f = fixture({ fresh: false });
    const h = harness({ answer: neurons });
    if (neurons < 9500) await assertDailyBudget(f.env, h.rt);
    else await assert.rejects(assertDailyBudget(f.env, h.rt), quota);
    assert.equal(h.requests.length, 1);
    assert.equal(f.calls.length, 0);
  }
});

test('a reached cap stays closed until the UTC date changes even when the snapshot is old', async () => {
  const f = fixture({ now: START, usage: 9500 });
  const h = harness({ now: START + 120_000, answer: 0 });
  await assert.rejects(assertDailyBudget(f.env, h.rt), quota);
  assert.equal(h.requests.length, 0);
});

test('invalid configuration fails closed before contacting Cloudflare', async () => {
  for (const changes of [{ DAILY_NEURON_BUDGET: '9501' }, { DAILY_NEURON_BUDGET: '0' },
    { DAILY_NEURON_BUDGET: 'NaN' }, { CF_ACCOUNT_ID: 'bad-id' }, { CF_ANALYTICS_TOKEN: '' }]) {
    const f = fixture({ now: START });
    Object.assign(f.env, changes);
    const h = harness();
    await assert.rejects(assertDailyBudget(f.env, h.rt), unavailable);
    assert.equal(h.requests.length, 0);
  }
});

test('HTTP and GraphQL failures preserve the old value but refuse stale authorization', async () => {
  for (const answer of [
    () => new Response(null, { status: 302, headers: { Location: 'https://example.invalid/' } }),
    () => new Response('denied', { status: 401 }),
    () => new Response('denied', { status: 403 }),
    () => new Response('rate limited', { status: 429 }),
    () => new Response('unavailable', { status: 500 }),
    () => Response.json({ errors: [{ message: 'denied' }] }),
    () => new Response('{'),
    () => { throw new Error('network failure'); },
    () => { throw new DOMException('timeout', 'TimeoutError'); },
  ]) {
    const f = fixture({ now: START - 60_000, usage: 600 });
    const h = harness({ answer });
    await assert.rejects(readDailyUsage(f.env, h.rt), unavailable);
    const row = f.db.prepare('SELECT * FROM ai_daily_usage').get();
    assert.equal(row.neurons, 600);
    assert.equal(row.last_error, 1);
    assert.equal(row.lease_id, null);
    assert.match(row.last_error_reason, /^query:(http_\d{3}|graphql_error|SyntaxError|exception|TimeoutError)$/);
    await assert.rejects(readDailyUsage(f.env, h.rt), unavailable);
    assert.equal(h.requests.length, 1, 'failure backoff prevents repeated API calls');
  }
});

test('a failed refresh recovers after the bounded backoff', async () => {
  const f = fixture({ fresh: false });
  let fail = true;
  const h = harness({ answer: () => fail ? new Response('no', { status: 500 }) : Response.json(graphResult(610)) });
  await assert.rejects(readDailyUsage(f.env, h.rt), unavailable);
  h.advance(15_001);
  fail = false;
  const row = await readDailyUsage(f.env, h.rt);
  assert.equal(row.neurons, 610);
  assert.equal(row.last_error, 0);
  assert.equal(row.last_error_reason, null);
  assert.equal(h.requests.length, 2);
});

test('oversized analytics responses are rejected with and without content-length', async () => {
  for (const headers of [{ 'Content-Length': '70000' }, {}]) {
    const f = fixture({ fresh: false });
    const h = harness({ answer: () => new Response('x'.repeat(70000), { headers }) });
    await assert.rejects(readDailyUsage(f.env, h.rt), unavailable);
  }
});

test('parallel cold requests share one API refresh through the D1 lease', async () => {
  const f = fixture({ fresh: false });
  let calls = 0;
  const rt = { now: Date.now, sleep: () => delay(5), fetch: async () => {
    calls++;
    await delay(15);
    return Response.json(graphResult(600.347740650177));
  } };
  const results = await Promise.all(Array.from({ length: 30 }, () => readDailyUsage(f.env, rt)));
  assert.equal(calls, 1);
  assert.ok(results.every(row => row.neurons === 600.347740650177));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ai_daily_usage').get().n, 1);
});

test('leases are atomic and a replaced lease cannot overwrite the new owner', () => {
  const f = fixture({ fresh: false });
  const claim = f.db.prepare(CLAIM_SQL);
  const first = claim.get(ACCOUNT_ID, '2026-08-28', START + 60000, 'old-owner', START + 30000, START);
  assert.equal(first.lease_id, 'old-owner');
  assert.equal(claim.get(ACCOUNT_ID, '2026-08-28', START + 60000, 'racer', START + 30000, START), undefined);
  const second = claim.get(ACCOUNT_ID, '2026-08-28', START + 120000, 'new-owner', START + 90000, START + 60000);
  assert.equal(second.lease_id, 'new-owner');
  const save = f.db.prepare(SAVE_SQL);
  assert.equal(save.get(ACCOUNT_ID, '2026-08-28', 9000, START, START + 55000, 'old-owner', START + 60001), undefined);
  assert.equal(save.get(ACCOUNT_ID, '2026-08-28', 600, START + 60000, START + 115000, 'new-owner', START + 60001).neurons, 600);
});

test('an abandoned refresh lease can be replaced after its deadline', async () => {
  const f = fixture({ fresh: false });
  f.db.prepare(CLAIM_SQL).get(ACCOUNT_ID, '2026-08-28', START - 1, 'abandoned', START - 1, START - 60000);
  const h = harness();
  assert.equal((await readDailyUsage(f.env, h.rt)).neurons, 600.347740650177);
  assert.equal(h.requests.length, 1);
});

test('a hung refresh fails closed after bounded polling without another API call', async () => {
  const f = fixture({ fresh: false });
  f.db.prepare(CLAIM_SQL).get(ACCOUNT_ID, '2026-08-28', START + 60000, 'busy', START + 30000, START);
  const h = harness();
  await assert.rejects(readDailyUsage(f.env, h.rt), unavailable);
  assert.equal(h.requests.length, 0);
  assert.ok(h.rt.now() - START < 15000);
});

test('reported daily usage remains monotonic when analytics later reports a lower value', async () => {
  const f = fixture({ now: START - 60000, usage: 610 });
  const h = harness({ answer: 600 });
  assert.equal((await readDailyUsage(f.env, h.rt)).neurons, 610);
});

test('UTC midnight starts a new account-day without deleting prior data', async () => {
  const midnight = Date.parse('2026-08-29T00:00:00Z');
  const f = fixture({ now: midnight - 1000, usage: 9501 });
  const h = harness({ now: midnight, answer: 0 });
  await assertDailyBudget(f.env, h.rt);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ai_daily_usage').get().n, 2);
  assert.equal(f.db.prepare("SELECT neurons FROM ai_daily_usage WHERE day='2026-08-28'").get().neurons, 9501);
  assert.match(JSON.parse(h.requests[0].init.body).query, /date_geq:"2026-08-29"/);
});

test('a refresh spanning midnight queries the new day before authorizing inference', async () => {
  const f = fixture({ fresh: false });
  const midnight = Date.parse('2026-08-29T00:00:00Z');
  let calls = 0;
  const h = harness({ now: midnight - 10, answer: () => {
    calls++;
    if (calls === 1) { h.advance(20); return Response.json(graphResult(9500)); }
    return Response.json(graphResult(5));
  } });
  await assertDailyBudget(f.env, h.rt);
  assert.equal(calls, 2);
  assert.match(JSON.parse(h.requests[1].init.body).query, /date_geq:"2026-08-29"/);
});

test('the minute cron may refresh five seconds early while normal reads still use the cache', async () => {
  const f = fixture({ now: START, usage: 600 });
  const h = harness({ now: START + 55000, answer: 620 });
  assert.equal((await readDailyUsage(f.env, h.rt)).neurons, 600);
  assert.equal(h.requests.length, 0);
  assert.equal((await readDailyUsage(f.env, h.rt, true)).neurons, 620);
  assert.equal(h.requests.length, 1);
});

test('scheduled handler reports synchronization failures without exposing the secret', async () => {
  const f = fixture({ dbError: true });
  await assert.rejects(worker.scheduled({}, f.env), /AI usage synchronization failed/);
});
