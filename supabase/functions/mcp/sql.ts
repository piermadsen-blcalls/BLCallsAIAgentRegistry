// SQL builders for the connector's structured tools. Identifiers only ever come from the fixed
// maps below and every value is inlined as a quoted literal. The text then runs through
// mcp_run_sql (migration 066), which is read-only and limited to the mcp views whatever the text
// says, so a mistake here can make a wrong query but never a write.

export class InputError extends Error {}

const TZ = `'America/Denver'`;                          // the registry's business days (065)
const TODAY = `(now() at time zone ${TZ})::date`;
const dayStart = (dateExpr: string) => `(${dateExpr})::timestamp at time zone ${TZ}`;

export function lit(v: string): string {
  if (v.includes('\u0000')) throw new InputError('Text values cannot contain NUL characters.');
  return `'${v.replace(/'/g, "''")}'`;
}
const likeLit = (v: string) => lit('%' + v.replace(/[\\%_]/g, m => '\\' + m) + '%');

export function isDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
}
function dateLit(v: unknown, field: string): string {
  if (!isDate(v)) throw new InputError(`${field} must be a date like 2026-11-09.`);
  return `${lit(v)}::date`;
}
export function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new InputError(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return v;
}
function num(v: unknown, field: string): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InputError(`${field} must be a number.`);
  return String(v);
}
function texts(v: unknown, field: string): string[] {
  const a = Array.isArray(v) ? v : [v];
  if (!a.length || a.some(x => typeof x !== 'string' || !x.trim())) {
    throw new InputError(`${field} must be a non-empty text or a list of texts.`);
  }
  return a.map(x => (x as string).trim());
}
const inList = (col: string, vals: string[]) => vals.length === 1 ? `${col} = ${lit(vals[0])}` : `${col} in (${vals.map(lit).join(', ')})`;

// E.164 the way Canoe stores it: 10 digits -> +1XXXXXXXXXX, 11 starting with 1 -> +1...
export function e164(v: string): string {
  const d = v.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length >= 8) return '+' + d;
  throw new InputError('caller must be a phone number, e.g. +15551234567.');
}

// ── Filters (shared by search_calls, aggregate_calls, list_values and saved reports) ──
const EXACT: Record<string, string> = {
  publisher: 'publisher_name', advertiser: 'advertiser_name', campaign: 'campaign_name',
  publisher_campaign: 'api_campaign_name', vertical: 'vertical_name', agent: 'agent', outcome: 'our_outcome',
  canoe_outcome: 'canoe_outcome', result: 'result', disposition: 'disposition', state: 'state', line_type: 'line_type',
};
const CONTAINS: Record<string, string> = {
  publisher_contains: 'publisher_name', advertiser_contains: 'advertiser_name', campaign_contains: 'campaign_name',
  vertical_contains: 'vertical_name', agent_contains: 'agent',
};
const BOOLS: Record<string, string> = {
  connected: 'connected', paid: 'paid', scored: 'scored', qualified: 'qualified', flagged: 'flagged',
  suspicious: 'suspicious_call', reviewed: 'compliance_reviewed',
};
const RANGES: Record<string, [string, string]> = {
  min_connect_duration: ['connect_duration', '>='], max_connect_duration: ['connect_duration', '<='],
  min_duration: ['duration', '>='], max_duration: ['duration', '<='],
  min_publisher_score: ['publisher_score', '>='], max_publisher_score: ['publisher_score', '<='],
  min_advertiser_score: ['advertiser_score', '>='], max_advertiser_score: ['advertiser_score', '<='],
  min_payin: ['advertiser_payin', '>='], max_payin: ['advertiser_payin', '<='],
  min_payout: ['publisher_payout', '>='], max_payout: ['publisher_payout', '<='],
};
const OTHER_FILTERS = ['start_date', 'end_date', 'last_days', 'flags', 'caller', 'include_test'];
export const FILTER_KEYS = [...OTHER_FILTERS, ...Object.keys(EXACT), ...Object.keys(CONTAINS), ...Object.keys(BOOLS), ...Object.keys(RANGES)];

export type Filters = Record<string, unknown>;

export function whereClause(f: Filters = {}, defaultDays = 30): { sql: string; range: string } {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) throw new InputError('filters must be an object.');
  const unknown = Object.keys(f).filter(k => !FILTER_KEYS.includes(k));
  if (unknown.length) throw new InputError(`Unknown filter ${unknown.join(', ')}. Filters: ${FILTER_KEYS.join(', ')}.`);
  const c: string[] = [];
  let range: string;
  if (f.last_days != null) {
    if (f.start_date != null || f.end_date != null) throw new InputError('Use last_days or start_date/end_date, not both.');
    const n = int(f.last_days, 'last_days', 1, 3650);
    c.push(`created_at >= ${dayStart(`${TODAY} - ${n - 1}`)}`);
    range = `last ${n} days in Mountain Time, today included`;
  } else if (f.start_date != null || f.end_date != null) {
    if (f.start_date != null) c.push(`created_at >= ${dayStart(dateLit(f.start_date, 'start_date'))}`);
    if (f.end_date != null) c.push(`created_at < ${dayStart(`${dateLit(f.end_date, 'end_date')} + 1`)}`);
    range = `${f.start_date ?? 'first call'} to ${f.end_date ?? 'today'} (Mountain Time days, inclusive)`;
  } else if (defaultDays) {
    c.push(`created_at >= ${dayStart(`${TODAY} - ${defaultDays - 1}`)}`);
    range = `last ${defaultDays} days in Mountain Time (default; pass dates to change)`;
  } else {
    range = 'all calls';
  }
  for (const [k, col] of Object.entries(EXACT)) if (f[k] != null) c.push(inList(col, texts(f[k], k)));
  for (const [k, col] of Object.entries(CONTAINS)) {
    if (f[k] != null) c.push(`${col} ilike ${likeLit(texts(f[k], k)[0])}`);
  }
  for (const [k, col] of Object.entries(BOOLS)) {
    if (f[k] == null) continue;
    if (typeof f[k] !== 'boolean') throw new InputError(`${k} must be true or false.`);
    c.push(f[k] ? col : `not coalesce(${col}, false)`);
  }
  for (const [k, [col, op]] of Object.entries(RANGES)) if (f[k] != null) c.push(`${col} ${op} ${num(f[k], k)}`);
  if (f.flags != null) c.push(`flags ?| array[${texts(f.flags, 'flags').map(lit).join(', ')}]`);
  if (f.caller != null) c.push(`called_from = ${lit(e164(texts(f.caller, 'caller')[0]))}`);
  if (f.include_test != null && typeof f.include_test !== 'boolean') throw new InputError('include_test must be true or false.');
  if (!f.include_test) c.push('is_test is not true');
  return { sql: c.length ? c.join('\n  and ') : 'true', range };
}

// ── search_calls / get_call ──
export const CALL_COLUMNS = [
  'id', 'created_at', 'day', 'agent', 'ivr_name', 'ivr_id', 'publisher_name', 'publisher_id', 'advertiser_name',
  'advertiser_id', 'vertical_name', 'vertical_id', 'campaign_name', 'campaign_id', 'api_campaign_name',
  'api_campaign_id', 'promo_number_name', 'promo_number_id', 'lead_id', 'phone_lead_transaction_id', 'called_from',
  'called_to', 'zip', 'city', 'state', 'line_type', 'keypresses', 'result', 'connected', 'duration', 'ivr_duration',
  'connect_duration', 'advertiser_payin', 'publisher_payout', 'advertiser_bid', 'publisher_bid', 'paid', 'our_outcome',
  'scored', 'qualified', 'canoe_outcome', 'publisher_score', 'advertiser_score', 'flags', 'suspicious_call', 'flagged',
  'compliance_reviewed', 'is_test', 'disposition', 'disposition_description', 'intent', 'ai_agent_phone_number',
  'ai_model', 'ai_processed_at', 'prompt_id', 'recording_id', 'recording_type', 'recording_url', 'ascnd_recording_url',
  'our_summary', 'canoe_summary', 'transcription', 'ascnd_transcript', 'synced_at',
];
const TIME_MT = `to_char(created_at at time zone ${TZ}, 'YYYY-MM-DD HH24:MI:SS') as time_mt`;
export const TEXT_COLUMNS = ['transcription', 'ascnd_transcript', 'canoe_summary', 'our_summary'];
export const RECORDING_COLUMNS = ['recording_url', 'ascnd_recording_url'];
export const DEFAULT_SEARCH_COLUMNS = [
  'id', 'time_mt', 'agent', 'publisher_name', 'advertiser_name', 'vertical_name', 'campaign_name', 'result',
  'connect_duration', 'our_outcome', 'canoe_outcome', 'publisher_score', 'advertiser_score', 'advertiser_payin',
  'publisher_payout', 'flags', 'suspicious_call', 'state', 'called_from',
];
const SORTS: Record<string, string> = {
  newest: 'created_at desc, id desc',
  oldest: 'created_at, id',
  longest: 'connect_duration desc nulls last, created_at desc',
  highest_payin: 'advertiser_payin desc nulls last, created_at desc',
};
const colExpr = (c: string) => (c === 'time_mt' ? TIME_MT : c);

export function searchSql(a: Record<string, unknown>) {
  let cols = DEFAULT_SEARCH_COLUMNS;
  if (a.columns != null) {
    cols = texts(a.columns, 'columns');
    const bad = cols.filter(c => c !== 'time_mt' && !CALL_COLUMNS.includes(c));
    if (bad.length) throw new InputError(`Unknown column ${bad.join(', ')}. See describe_data.`);
  }
  if (a.include_text) cols = [...cols, ...TEXT_COLUMNS.filter(c => !cols.includes(c))];
  const heavy = cols.some(c => TEXT_COLUMNS.includes(c) && c !== 'our_summary');
  const maxLimit = heavy ? 20 : 200;
  const limit = a.limit == null ? Math.min(50, maxLimit) : int(a.limit, 'limit', 1, maxLimit);
  const offset = a.offset == null ? 0 : int(a.offset, 'offset', 0, 100000);
  const sort = SORTS[String(a.sort ?? 'newest')];
  if (!sort) throw new InputError(`sort must be one of ${Object.keys(SORTS).join(', ')}.`);
  const w = whereClause((a.filters ?? {}) as Filters);
  const sql = `select ${[...new Set(cols)].map(colExpr).join(', ')}\nfrom calls\nwhere ${w.sql}\norder by ${sort}\nlimit ${limit + 1} offset ${offset}`;
  return { sql, limit, offset, range: w.range };
}

export function getCallSql(a: Record<string, unknown>) {
  const id = texts(a.id, 'id')[0];
  const cols = CALL_COLUMNS.filter(c =>
    (c === 'our_summary' || !TEXT_COLUMNS.includes(c) || a.include_transcript === true) &&
    (!RECORDING_COLUMNS.includes(c) || a.include_recording === true));
  return `select ${TIME_MT}, ${cols.join(', ')}\nfrom calls\nwhere id = ${lit(id)}`;
}

// ── aggregate_calls ──
export const GROUPS: Record<string, string> = {
  day: 'day',
  week: `date_trunc('week', day)::date`,
  month: `date_trunc('month', day)::date`,
  hour: `extract(hour from created_at at time zone ${TZ})::int`,
  weekday: `extract(isodow from created_at at time zone ${TZ})::int`,
  publisher: 'publisher_name', advertiser: 'advertiser_name', campaign: 'campaign_name',
  publisher_campaign: 'api_campaign_name', vertical: 'vertical_name', agent: 'agent', outcome: 'our_outcome',
  canoe_outcome: 'canoe_outcome', result: 'result', disposition: 'disposition', state: 'state', line_type: 'line_type',
  flag: 'fl.flag',
};
const TIME_GROUPS = ['day', 'week', 'month', 'hour', 'weekday'];
const pct = (n: string, d: string) => `round(100.0 * ${n} / nullif(${d}, 0), 1)`;
const CONNECTED = 'count(*) filter (where connected)';
const PAID = 'count(*) filter (where paid)';
const SCORED = 'count(*) filter (where scored)';
export const METRICS: Record<string, string> = {
  calls: 'count(*)',
  connected: CONNECTED,
  connect_rate: pct(CONNECTED, 'count(*)'),
  paid_calls: PAID,
  paid_rate: pct(PAID, 'count(*)'),
  unique_callers: 'count(distinct called_from)',
  scored: SCORED,
  qualified: 'count(*) filter (where qualified)',
  qualified_rate: pct('count(*) filter (where qualified)', SCORED),
  flagged: 'count(*) filter (where flagged)',
  flag_rate: pct('count(*) filter (where flagged and scored)', SCORED),
  avg_duration: 'round(avg(duration), 1)',
  avg_ivr_duration: 'round(avg(ivr_duration), 1)',
  avg_connect_duration: 'round(avg(connect_duration) filter (where connected), 1)',
  total_connect_minutes: 'round(sum(connect_duration) / 60.0, 1)',
  avg_publisher_score: 'round(avg(publisher_score), 2)',
  avg_advertiser_score: 'round(avg(advertiser_score), 2)',
  payin: 'round(coalesce(sum(advertiser_payin), 0), 2)',
  payout: 'round(coalesce(sum(publisher_payout), 0), 2)',
  margin: 'round(coalesce(sum(advertiser_payin), 0) - coalesce(sum(publisher_payout), 0), 2)',
  payin_per_call: 'round(coalesce(sum(advertiser_payin), 0) / nullif(count(*), 0), 2)',
  payin_per_paid_call: `round(coalesce(sum(advertiser_payin), 0) / nullif(${PAID}, 0), 2)`,
  payout_per_call: 'round(coalesce(sum(publisher_payout), 0) / nullif(count(*), 0), 2)',
};
export const DEFAULT_METRICS = ['calls', 'connected', 'connect_rate', 'paid_calls', 'payin', 'payout'];

export function aggregateSql(a: Record<string, unknown>) {
  const groups = a.group_by == null ? [] : texts(a.group_by, 'group_by');
  if (groups.length > 3) throw new InputError('group_by takes at most 3 fields.');
  const badG = groups.filter(g => !GROUPS[g]);
  if (badG.length) throw new InputError(`Unknown group_by ${badG.join(', ')}. Options: ${Object.keys(GROUPS).join(', ')}.`);
  const metrics = a.metrics == null ? DEFAULT_METRICS : texts(a.metrics, 'metrics');
  const badM = metrics.filter(m => !METRICS[m]);
  if (badM.length) throw new InputError(`Unknown metric ${badM.join(', ')}. Options: ${Object.keys(METRICS).join(', ')}.`);
  const limit = a.limit == null ? 100 : int(a.limit, 'limit', 1, 1000);
  const w = whereClause((a.filters ?? {}) as Filters);
  const q = (s: string) => `"${s}"`;
  let order: string;
  if (a.sort != null) {
    const key = String(a.sort);
    if (!groups.includes(key) && !metrics.includes(key)) throw new InputError('sort must be one of the group_by fields or metrics.');
    order = `${q(key)} ${a.sort_dir === 'asc' ? 'asc' : 'desc'} nulls last`;
  } else if (groups.length && groups.every(g => TIME_GROUPS.includes(g))) {
    order = groups.map(q).join(', ');
  } else {
    order = `${q(metrics[0])} desc nulls last`;
  }
  const select = [...groups.map(g => `${GROUPS[g]} as ${q(g)}`), ...metrics.map(m => `${METRICS[m]} as ${q(m)}`)];
  const from = groups.includes('flag') ? `calls\ncross join lateral jsonb_array_elements_text(coalesce(flags, '[]'::jsonb)) as fl(flag)` : 'calls';
  const sql = `select ${select.join(',\n  ')}\nfrom ${from}\nwhere ${w.sql}` +
    (groups.length ? `\ngroup by ${groups.map((_, i) => i + 1).join(', ')}` : '') +
    `\norder by ${order}\nlimit ${limit + 1}`;
  return { sql, limit, range: w.range };
}

// ── list_values ──
export const VALUE_FIELDS: Record<string, string> = Object.fromEntries(
  Object.entries(GROUPS).filter(([k]) => !TIME_GROUPS.includes(k)));

export function listValuesSql(a: Record<string, unknown>) {
  const field = String(a.field ?? '');
  const col = VALUE_FIELDS[field];
  if (!col) throw new InputError(`field must be one of ${Object.keys(VALUE_FIELDS).join(', ')}.`);
  const limit = a.limit == null ? 50 : int(a.limit, 'limit', 1, 500);
  const w = whereClause((a.filters ?? {}) as Filters, 90);
  const extra = a.contains != null ? `\n  and ${col} ilike ${likeLit(texts(a.contains, 'contains')[0])}` : '';
  const from = field === 'flag' ? `calls\ncross join lateral jsonb_array_elements_text(coalesce(flags, '[]'::jsonb)) as fl(flag)` : 'calls';
  const sql = `select ${col} as value, count(*) as calls\nfrom ${from}\nwhere ${w.sql}\n  and ${col} is not null and ${col} <> ''${extra}\ngroup by 1\norder by 2 desc, 1\nlimit ${limit + 1}`;
  return { sql, limit, range: w.range };
}

// ── Saved-report parameters ──
export const PARAM_TYPES = ['text', 'text_list', 'date', 'integer', 'number', 'boolean'] as const;
export interface Param { name: string; type: typeof PARAM_TYPES[number]; description?: string; default?: unknown; required?: boolean }

export function validateParams(v: unknown): Param[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new InputError('parameters must be a list.');
  const seen = new Set<string>();
  return v.map((p, i) => {
    if (typeof p !== 'object' || p === null) throw new InputError(`parameters[${i}] must be an object.`);
    const { name, type, description, required } = p as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new InputError(`Parameter name "${name}" must be lower_snake_case.`);
    if (seen.has(name)) throw new InputError(`Parameter ${name} is listed twice.`);
    seen.add(name);
    if (!PARAM_TYPES.includes(type as Param['type'])) throw new InputError(`Parameter ${name}: type must be one of ${PARAM_TYPES.join(', ')}.`);
    const out: Param = { name, type: type as Param['type'] };
    if (description != null) out.description = String(description).slice(0, 500);
    if ('default' in (p as object)) out.default = (p as Record<string, unknown>).default;
    if (required != null) out.required = required === true;
    return out;
  });
}

// Mountain Time "today" and the relative dates a date parameter accepts.
export function mountainToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const RELATIVE_DATES = ['today', 'yesterday', 'today-N', 'start_of_week', 'start_of_last_week', 'end_of_last_week',
                               'start_of_month', 'start_of_last_month', 'end_of_last_month'];
export function resolveDate(v: string, today = mountainToday()): string {
  if (isDate(v)) return v;
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;   // Monday = 0
  const monthStart = today.slice(0, 8) + '01';
  const lastMonthStart = addDays(monthStart, -1).slice(0, 8) + '01';
  const m = /^today-(\d{1,4})$/.exec(v);
  if (m) return addDays(today, -Number(m[1]));
  switch (v) {
    case 'today': return today;
    case 'yesterday': return addDays(today, -1);
    case 'start_of_week': return addDays(today, -dow);
    case 'start_of_last_week': return addDays(today, -dow - 7);
    case 'end_of_last_week': return addDays(today, -dow - 1);
    case 'start_of_month': return monthStart;
    case 'start_of_last_month': return lastMonthStart;
    case 'end_of_last_month': return addDays(monthStart, -1);
  }
  throw new InputError(`"${v}" is not a date. Use 2026-11-09 or one of ${RELATIVE_DATES.join(', ')}.`);
}

// Typed values for a run: given values, then defaults; required ones must be present.
export function paramValues(params: Param[], given: Record<string, unknown> = {}, today?: string): Record<string, unknown> {
  const unknown = Object.keys(given).filter(k => !params.some(p => p.name === k));
  if (unknown.length) throw new InputError(`Unknown parameter ${unknown.join(', ')}. This report takes: ${params.map(p => p.name).join(', ') || 'none'}.`);
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const v = p.name in given ? given[p.name] : p.default;
    if (v == null) {
      if (p.required) throw new InputError(`Parameter ${p.name} (${p.type}) is required.`);
      continue;
    }
    const bad = () => new InputError(`Parameter ${p.name} must be ${p.type === 'text_list' ? 'a list of texts' : 'a ' + p.type}.`);
    switch (p.type) {
      case 'text': if (typeof v !== 'string') throw bad(); out[p.name] = v; break;
      case 'text_list': out[p.name] = texts(v, p.name); break;
      case 'date': if (typeof v !== 'string') throw bad(); out[p.name] = resolveDate(v, today); break;
      case 'integer': if (typeof v !== 'number' || !Number.isInteger(v)) throw bad(); out[p.name] = v; break;
      case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(); out[p.name] = v; break;
      case 'boolean': if (typeof v !== 'boolean') throw bad(); out[p.name] = v; break;
    }
  }
  return out;
}

// A stand-in value per type, to check a report's query plans before it is saved.
export function sampleValues(params: Param[], today?: string): Record<string, unknown> {
  const sample: Record<string, unknown> = { text: 'x', text_list: ['x'], date: 'today', integer: 1, number: 1, boolean: true };
  return paramValues(params, Object.fromEntries(params.map(p => [p.name, p.default ?? sample[p.type]])), today);
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

function sqlValue(p: Param, v: unknown): string {
  switch (p.type) {
    case 'text': return lit(v as string);
    case 'text_list': return `array[${(v as string[]).map(lit).join(', ')}]::text[]`;
    case 'date': return `${lit(v as string)}::date`;
    case 'boolean': return v ? 'true' : 'false';
    default: return String(v);
  }
}

// {{name}} in a SQL report -> a typed literal. An unset optional parameter becomes null.
export function fillSql(sql: string, params: Param[], values: Record<string, unknown>): string {
  return sql.replace(PLACEHOLDER, (_, name: string) => {
    const p = params.find(x => x.name === name);
    if (!p) throw new InputError(`The query uses {{${name}}} but the report has no parameter "${name}".`);
    return name in values ? sqlValue(p, values[name]) : 'null';
  });
}

// {{name}} in a search/aggregate report's arguments: a string that is just the placeholder takes
// the typed value; a placeholder inside longer text is spliced in as text.
export function fillArgs(v: unknown, params: Param[], values: Record<string, unknown>): unknown {
  if (typeof v === 'string') {
    const whole = /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/.exec(v);
    const check = (name: string) => {
      if (!params.some(p => p.name === name)) throw new InputError(`The report uses {{${name}}} but has no parameter "${name}".`);
    };
    if (whole) { check(whole[1]); return values[whole[1]]; }
    return v.replace(PLACEHOLDER, (_, name: string) => { check(name); return values[name] == null ? '' : String(values[name]); });
  }
  if (Array.isArray(v)) return v.map(x => fillArgs(x, params, values)).flat().filter(x => x !== undefined);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillArgs(x, params, values)]).filter(([, x]) => x !== undefined));
  }
  return v;
}
