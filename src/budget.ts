import { ApiError } from "./errors.ts";

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
export const USAGE_CACHE_MS = 60_000;
// Let the minute cron refresh five seconds early so scheduler jitter does not
// accidentally turn a 60-second schedule into a 120-second cache interval.
const REFRESH_EARLY_MS = 55_000;
const LEASE_MS = 30_000;
const FAILURE_BACKOFF_MS = 15_000;
const MAX_RESPONSE_BYTES = 65_536;

export type UsageSnapshot = {
  account_id: string;
  day: string;
  neurons: number | null;
  checked_at: number;
  next_refresh_at: number;
  lease_id: string | null;
  lease_until: number;
  last_error: number;
  last_error_reason: string | null;
};

type Runtime = {
  now(): number;
  sleep(ms: number): Promise<void>;
  fetch: typeof fetch;
};
const runtime: Runtime = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  fetch: (input, init) => fetch(input, init),
};

const SELECT_SQL = "SELECT * FROM ai_daily_usage WHERE account_id = ?1 AND day = ?2";
export const CLAIM_SQL = `
  INSERT INTO ai_daily_usage (account_id, day, next_refresh_at, lease_id, lease_until)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(account_id, day) DO UPDATE SET
    next_refresh_at = excluded.next_refresh_at,
    lease_id = excluded.lease_id, lease_until = excluded.lease_until
  WHERE ai_daily_usage.next_refresh_at <= ?6 AND ai_daily_usage.lease_until <= ?6
  RETURNING *`;
export const SAVE_SQL = `
  UPDATE ai_daily_usage SET
    neurons = MAX(COALESCE(neurons, 0), ?3), checked_at = ?4,
    next_refresh_at = ?5, lease_id = NULL, lease_until = 0, last_error = 0,
    last_error_reason = NULL
  WHERE account_id = ?1 AND day = ?2 AND lease_id = ?6 AND lease_until > ?7
  RETURNING *`;
const FAIL_SQL = `
  UPDATE ai_daily_usage SET last_error = 1, next_refresh_at = ?3,
    lease_id = NULL, lease_until = 0, last_error_reason = ?5
  WHERE account_id = ?1 AND day = ?2 AND lease_id = ?4`;

type FailureReason = "unknown" | "graphql_error" | "invalid_metric" | `http_${number}`;
class BudgetUnavailable extends ApiError {
  readonly reason: FailureReason;
  constructor(reason: FailureReason = "unknown") {
    super(503, "budget_unavailable", "AI usage statistics unavailable; please retry later.");
    this.reason = reason;
  }
}
function unavailable(reason?: FailureReason): BudgetUnavailable {
  return new BudgetUnavailable(reason);
}

function config(env: Env): number {
  const limit = Number(env.DAILY_NEURON_BUDGET);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 9500 ||
      !/^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID) || !env.CF_ANALYTICS_TOKEN?.trim()) {
    throw unavailable();
  }
  return limit;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNeurons(value: unknown): number {
  // GraphQL can return HTTP 200 with errors or missing account access. Never turn
  // those failures into zero usage. Only a valid, empty dataset means no usage.
  if (!record(value) || (value.errors != null &&
      (!Array.isArray(value.errors) || value.errors.length > 0)) || !record(value.data) ||
      !record(value.data.viewer) || !Array.isArray(value.data.viewer.accounts) ||
      value.data.viewer.accounts.length !== 1) throw unavailable();
  const account: unknown = value.data.viewer.accounts[0];
  if (!record(account) || !Array.isArray(account.daily) || account.daily.length > 1) throw unavailable();
  if (account.daily.length === 0) return 0;
  const row: unknown = account.daily[0];
  if (!record(row) || !record(row.sum) || typeof row.sum.neurons !== "number" ||
      !Number.isFinite(row.sum.neurons) || row.sum.neurons < 0) throw unavailable();
  return row.sum.neurons;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw unavailable(response.ok ? "unknown" : `http_${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

async function queryNeurons(env: Env, day: string, rt: Runtime): Promise<number> {
  // No Workers binding exposes account analytics. This management API call is
  // limited to the exact dashboard query, with a server-side read-only secret.
  // Account ID is validated above; day is generated from UTC, never user input.
  const query = `{viewer{accounts(filter:{accountTag:"${env.CF_ACCOUNT_ID}"}){
    daily:aiInferenceAdaptiveGroups(limit:1,filter:{date_geq:"${day}",date_leq:"${day}"}){
      sum{neurons:totalNeurons}
    }
  }}}`;
  const response = await rt.fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
    // workerd does not implement redirect: "error". Reject 3xx in readJson
    // instead, so credentials are never forwarded to a redirected host.
    redirect: "manual",
  });
  if (!response.ok) {
    console.error(JSON.stringify({ event: "budget.api_failed", reason: "http_error", status: response.status }));
  }
  const payload = await readJson(response);
  try { return parseNeurons(payload); }
  catch {
    // Log categories only: upstream error text may echo request credentials.
    const reason = record(payload) && Array.isArray(payload.errors) && payload.errors.length > 0
      ? "graphql_error" : "invalid_metric";
    console.error(JSON.stringify({ event: "budget.api_failed", reason }));
    throw unavailable(reason);
  }
}

function validSnapshot(row: UsageSnapshot | null, now: number): row is UsageSnapshot & { neurons: number } {
  return row !== null && typeof row.neurons === "number" && Number.isFinite(row.neurons) && row.neurons >= 0 &&
    row.checked_at > 0 && row.checked_at <= now;
}

export async function readDailyUsage(env: Env, rt: Runtime = runtime, refreshEarly = false): Promise<UsageSnapshot & { neurons: number }> {
  const limit = config(env);
  try {
    // A D1 lease coalesces refreshes across every Worker isolate and colo. Polling
    // uses primary reads so another refresher's result cannot be hidden by lag.
    for (let attempt = 0; attempt < 9; attempt++) {
      const now = rt.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const read = () => env.BUDGET_DB.withSession("first-primary").prepare(SELECT_SQL)
        .bind(env.CF_ACCOUNT_ID, day).first<UsageSnapshot>();
      const row = await read();
      // Once this day's reported usage reaches the cap, keep the gate closed
      // until the UTC date changes, even if analytics later fluctuates or fails.
      if (validSnapshot(row, now) && (row.neurons >= limit ||
          (row.last_error === 0 && now - row.checked_at < (refreshEarly ? REFRESH_EARLY_MS : USAGE_CACHE_MS)))) {
        if (day === new Date(rt.now()).toISOString().slice(0, 10)) return row;
        continue;
      }
      if (row?.last_error && row.next_refresh_at > now) throw unavailable();
      const leaseId = crypto.randomUUID();
      const claimed = await env.BUDGET_DB.prepare(CLAIM_SQL)
        .bind(env.CF_ACCOUNT_ID, day, now + USAGE_CACHE_MS, leaseId, now + LEASE_MS, now)
        .first<UsageSnapshot>();
      if (claimed) {
        let saved: UsageSnapshot | null;
        let stage = "query";
        try {
          const neurons = await queryNeurons(env, day, rt);
          stage = "save";
          saved = await env.BUDGET_DB.prepare(SAVE_SQL)
            .bind(env.CF_ACCOUNT_ID, day, neurons, now, now + REFRESH_EARLY_MS, leaseId, rt.now())
            .first<UsageSnapshot>();
          if (!validSnapshot(saved, rt.now())) throw unavailable();
        } catch (error) {
          const reason = error instanceof BudgetUnavailable ? error.reason :
            error instanceof Error && ["TypeError", "SyntaxError", "TimeoutError", "AbortError", "RangeError"].includes(error.name)
              ? error.name : "exception";
          console.error(JSON.stringify({ event: "budget.refresh_failed", stage, reason }));
          await env.BUDGET_DB.prepare(FAIL_SQL)
            .bind(env.CF_ACCOUNT_ID, day, rt.now() + FAILURE_BACKOFF_MS, leaseId, `${stage}:${reason}`).run();
          throw unavailable();
        }
        console.log(JSON.stringify({ event: "budget.synced", day, neurons: saved.neurons, limit }));
        if (day === new Date(rt.now()).toISOString().slice(0, 10)) return saved;
        continue; // A query spanning 00:00 UTC must not authorize the new day.
      }
      // Another request or the cron job owns the refresh. Do not serve an
      // expired low snapshot; wait briefly, then fail closed if still unknown.
      await rt.sleep(Math.min(100 * 2 ** attempt, 1600));
    }
  } catch { throw unavailable(); }
  throw unavailable();
}

export async function assertDailyBudget(env: Env, rt: Runtime = runtime): Promise<void> {
  const limit = config(env);
  const usage = await readDailyUsage(env, rt);
  if (usage.neurons >= limit) {
    throw new ApiError(456, "quota_exceeded", "Account daily AI usage limit reached. Resets at 00:00 UTC (08:00 Beijing).");
  }
}
