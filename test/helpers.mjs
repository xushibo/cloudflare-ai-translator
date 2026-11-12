import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MODEL } from '../src/index.ts';

export const ACCOUNT_ID = '11111111111111111111111111111111';
export function fixture({ limited = false, dbError = false, result, usage = 600.347740650177,
  now = Date.now(), fresh = true } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0001_budget.sql', '0002_actual_usage.sql', '0003_usage_diagnostics.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  if (fresh) db.prepare(`INSERT INTO ai_daily_usage
    (account_id, day, neurons, checked_at, next_refresh_at) VALUES (?, ?, ?, ?, ?)`)
    .run(ACCOUNT_ID, new Date(now).toISOString().slice(0, 10), usage, now, now + 55000);
  const calls = [];
  const database = {
    withSession: constraint => { assert.equal(constraint, 'first-primary'); return database; },
    prepare: sql => {
      const statement = values => ({
        bind: (...bound) => statement(bound),
        first: async () => {
          if (dbError) throw new Error('database down');
          return db.prepare(sql).get(...values) ?? null;
        },
        run: async () => {
          if (dbError) throw new Error('database down');
          return { success: true, meta: db.prepare(sql).run(...values), results: [] };
        },
      });
      return statement([]);
    },
  };
  const env = {
    DAILY_NEURON_BUDGET: '9500', CF_ACCOUNT_ID: ACCOUNT_ID, CF_ANALYTICS_TOKEN: 'test-token-not-a-real-secret', API_BASE_PATH: '',
    IP_RATE_LIMITER: { limit: async () => ({ success: !limited }) }, BUDGET_DB: database,
    AI: { run: async (model, input) => {
      assert.equal(model, MODEL);
      calls.push(input);
      return result ?? { response: { detected_source_lang: 'en', text: `译文:${JSON.parse(input.messages[1].content).text}` } };
    } },
  };
  return { db, env, calls };
}

export const graphResult = neurons => ({ data: { viewer: { accounts: [{ daily: [{ sum: { neurons } }] }] } }, errors: null });
