import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ACCOUNT_ID } from './helpers.mjs';

test('actual workerd Request and D1 APIs accept the analytics refresh path', async () => {
  const script = `import {readDailyUsage} from './src/budget.ts';
    export default { async fetch(request, env) {
      try {
        const usage = await readDailyUsage(env, {
          now: () => Date.now(),
          sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
          fetch: async (url, init) => {
            // Real workerd validates RequestInit here; Node alone accepts modes
            // that workerd rejects. No network call or real credential is used.
            const outgoing = new Request(url, init);
            if (outgoing.redirect !== 'manual') throw new Error('Unsafe redirect mode');
            return Response.json({data:{viewer:{accounts:[{daily:[{sum:{neurons:600.347740650177}}]}]}}});
          },
        });
        return Response.json({neurons:usage.neurons, last_error:usage.last_error});
      } catch (error) { return Response.json({error:error.code}, {status:error.status ?? 500}); }
    }};
  `;
  const bundle = await build({
    stdin: {contents:script, resolveDir:new URL('../', import.meta.url).pathname, loader:'ts'},
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script:bundle.outputFiles[0].text, compatibilityDate: '2026-11-12',
    d1Databases: { BUDGET_DB: 'runtime-test-database' },
    bindings: { CF_ACCOUNT_ID: ACCOUNT_ID, DAILY_NEURON_BUDGET: '9500', CF_ANALYTICS_TOKEN: 'test-token-not-a-real-secret' },
  }));
  try {
    const db = await mf.getD1Database('BUDGET_DB');
    for (const file of ['0001_budget.sql', '0002_actual_usage.sql', '0003_usage_diagnostics.sql']) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
        .replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
      await db.exec(sql);
    }
    const response = await mf.dispatchFetch('http://localhost/');
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result, {neurons:600.347740650177, last_error:0});
    const row = await db.prepare('SELECT neurons, last_error_reason FROM ai_daily_usage').first();
    assert.equal(row.neurons, 600.347740650177);
    assert.equal(row.last_error_reason, null);
  } finally { await mf.dispose(); }
});
