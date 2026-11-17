// The connector's tools: what Claude sees (TOOLS) and what each call does (callTool). Every read
// is one mcp_run_sql call (066); saved reports use the 067 functions. All of it runs as the user.
import { Db, DbError } from './db.ts';
import {
  aggregateSql, DEFAULT_METRICS, FILTER_KEYS, fillArgs, fillSql, getCallSql, GROUPS, InputError, int, listValuesSql,
  METRICS, Param, PARAM_TYPES, paramValues, RELATIVE_DATES, sampleValues, searchSql, validateParams, VALUE_FIELDS,
} from './sql.ts';

type Args = Record<string, unknown>;
export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean; [k: string]: unknown }

// ── Schemas ──
const textOrList = (description: string) => ({
  description, anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
});
const FILTERS = {
  type: 'object',
  additionalProperties: false,
  description: 'Which calls. Dates are Mountain Time days (inclusive). With no dates: the last 30 days (list_values: 90). Test calls are excluded unless include_test.',
  properties: {
    start_date: { type: 'string', description: 'First day, YYYY-MM-DD (Mountain Time).' },
    end_date: { type: 'string', description: 'Last day, YYYY-MM-DD (Mountain Time), included.' },
    last_days: { type: 'integer', description: 'The last N days including today (instead of start/end).' },
    publisher: textOrList('Exact publisher name(s). Get names from list_values.'),
    publisher_contains: { type: 'string', description: 'Publisher name contains (case-insensitive).' },
    advertiser: textOrList('Exact advertiser name(s).'),
    advertiser_contains: { type: 'string', description: 'Advertiser name contains (case-insensitive).' },
    campaign: textOrList('Exact advertiser (buyer) campaign name(s).'),
    campaign_contains: { type: 'string', description: 'Buyer campaign name contains.' },
    publisher_campaign: textOrList('Exact publisher campaign name(s).'),
    vertical: textOrList('Exact vertical name(s).'),
    vertical_contains: { type: 'string', description: 'Vertical name contains.' },
    agent: textOrList('Exact AI agent (IVR) name(s), renamed IVRs resolved.'),
    agent_contains: { type: 'string', description: 'AI agent (IVR) name contains.' },
    outcome: textOrList('Registry AI outcome(s), e.g. appointment, sale, quoted_interested (see describe_data).'),
    canoe_outcome: textOrList('Canoe AI outcome(s).'),
    result: textOrList('Canoe routing result(s): connected, abandoned, nobids, dropped, duplicate.'),
    disposition: textOrList('ASCND disposition(s): Connected, Completed, Rejected.'),
    state: textOrList('Caller state(s), two letters.'),
    line_type: textOrList('mobile, landline or voip.'),
    flags: { type: 'array', items: { type: 'string' }, description: 'Calls with any of these compliance flags.' },
    flagged: { type: 'boolean', description: 'Any flag or suspicious (true) / none (false).' },
    suspicious: { type: 'boolean' },
    connected: { type: 'boolean', description: 'connect_duration > 0 or result connected.' },
    paid: { type: 'boolean', description: 'advertiser_payin > 0.' },
    scored: { type: 'boolean', description: 'Has a registry AI outcome.' },
    qualified: { type: 'boolean', description: 'Outcome appointment, sale or quoted_interested.' },
    reviewed: { type: 'boolean', description: 'Flags marked reviewed in the registry.' },
    min_connect_duration: { type: 'number', description: 'Seconds.' }, max_connect_duration: { type: 'number' },
    min_duration: { type: 'number', description: 'Recording seconds.' }, max_duration: { type: 'number' },
    min_publisher_score: { type: 'number' }, max_publisher_score: { type: 'number' },
    min_advertiser_score: { type: 'number' }, max_advertiser_score: { type: 'number' },
    min_payin: { type: 'number', description: 'USD.' }, max_payin: { type: 'number' },
    min_payout: { type: 'number', description: 'USD.' }, max_payout: { type: 'number' },
    caller: { type: 'string', description: 'Caller phone number (any format).' },
    include_test: { type: 'boolean', description: 'Include test calls (default false).' },
  },
};
const REPORT_REF = { type: 'string', description: 'Report name (case-insensitive) or id.' };
const READ = { readOnlyHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'describe_data',
    title: 'Describe the call data',
    description: 'What the call data contains: every view and column you can query with its meaning, the outcome list with scores, the registry\'s metric definitions and the date range of the data. Call it first when unsure which column answers a question.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'search_calls',
    title: 'Search calls',
    description: 'List individual calls that match filters, newest first. Up to 200 rows per page (20 when transcripts are included); page with offset. Long text (transcripts, summaries) is left out unless include_text or columns asks for it. For counts, rates or money, use aggregate_calls instead. Phone numbers are personal data: only show them when the user needs them.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filters: FILTERS,
        columns: { type: 'array', items: { type: 'string' }, description: 'Columns to return (see describe_data; time_mt = Mountain Time). Default: a summary set.' },
        include_text: { type: 'boolean', description: 'Add transcripts and summaries (max 20 rows).' },
        sort: { type: 'string', enum: ['newest', 'oldest', 'longest', 'highest_payin'] },
        limit: { type: 'integer', description: 'Rows per page, default 50.' },
        offset: { type: 'integer', description: 'Skip this many rows (use next_offset from the last page).' },
      },
    },
    annotations: READ,
  },
  {
    name: 'get_call',
    title: 'Get one call',
    description: 'One call by id with every field. include_transcript adds the Canoe and ASCND transcripts and the Canoe summary; include_recording adds the recording links. Transcripts and recordings are personal data: fetch them only when the user asks.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Call id.' },
        include_transcript: { type: 'boolean' },
        include_recording: { type: 'boolean' },
      },
    },
    annotations: READ,
  },
  {
    name: 'aggregate_calls',
    title: 'Aggregate calls',
    description: 'Counts, rates, durations, scores and money for calls that match filters, grouped by up to 3 fields (or one total row). Uses the registry\'s definitions: connected = connect_duration > 0 or result connected; paid = advertiser_payin > 0; qualified = appointment, sale or quoted_interested; qualified_rate and flag_rate are % of AI-scored calls; every *_rate is a percentage; payin = revenue, payout = publisher cost, margin = payin - payout. week starts Monday; weekday 1 = Monday. Grouping by flag counts a call once per flag.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filters: FILTERS,
        group_by: { type: 'array', items: { type: 'string', enum: Object.keys(GROUPS) }, description: 'Up to 3. Empty = totals.' },
        metrics: { type: 'array', items: { type: 'string', enum: Object.keys(METRICS) }, description: `Default: ${DEFAULT_METRICS.join(', ')}.` },
        sort: { type: 'string', description: 'A group_by field or metric. Default: time order for time groups, else the first metric, high to low.' },
        sort_dir: { type: 'string', enum: ['desc', 'asc'] },
        limit: { type: 'integer', description: 'Groups returned, default 100, max 1000.' },
      },
    },
    annotations: READ,
  },
  {
    name: 'list_values',
    title: 'List field values',
    description: 'The values of a field with their call counts, most calls first (default: last 90 days), e.g. to get exact publisher, advertiser, campaign or agent names before filtering. contains does a case-insensitive partial match.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['field'],
      properties: {
        field: { type: 'string', enum: Object.keys(VALUE_FIELDS) },
        contains: { type: 'string' },
        filters: FILTERS,
        limit: { type: 'integer', description: 'Default 50, max 500.' },
      },
    },
    annotations: READ,
  },
  {
    name: 'run_sql',
    title: 'Run a read-only SQL query',
    description: 'Run one PostgreSQL SELECT (or WITH ... SELECT) on the views calls, agents, agent_aliases, outcome_weights and account_assignments, for anything the other tools cannot answer. It is read-only, limited to those views, has an 8-second time limit and returns up to max_rows rows (default 200, max 1000); system functions (pg_*, set_config, ...) are blocked. Tips: filter calls on created_at for date ranges (indexed), e.g. created_at >= \'2026-11-01\'::timestamp at time zone \'America/Denver\'; group on day for Mountain Time days; add "not is_test"; use the connected/paid/scored/qualified/flagged columns so numbers match the registry. explain=true returns the plan without running the query.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string' },
        max_rows: { type: 'integer' },
        explain: { type: 'boolean' },
      },
    },
    annotations: READ,
  },
  {
    name: 'list_reports',
    title: 'List my saved reports',
    description: 'The signed-in user\'s saved reports with their parameters.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'run_report',
    title: 'Run a saved report',
    description: 'Run one of the user\'s saved reports, with parameter values (others use their defaults).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['report'],
      properties: {
        report: REPORT_REF,
        params: { type: 'object', description: 'Parameter values by name.' },
        limit: { type: 'integer', description: 'Override the row limit.' },
      },
    },
    annotations: READ,
  },
  {
    name: 'create_report',
    title: 'Save a report',
    description: `Save a named report the user can re-run later, here or from the registry's Claude tab. kind sql: a query for run_sql, with {{param}} placeholders. kind search or aggregate: the arguments of search_calls or aggregate_calls, where any string may be a {{param}} placeholder. Parameters are typed (${PARAM_TYPES.join(', ')}) with optional defaults; a date also accepts ${RELATIVE_DATES.join(', ')} (Mountain Time), so "last week" reports need no input. The report is checked before it is saved.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'kind'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        kind: { type: 'string', enum: ['sql', 'search', 'aggregate'] },
        sql: { type: 'string', description: 'For kind sql.' },
        arguments: { type: 'object', description: 'For kind search/aggregate: the tool arguments (filters, group_by, metrics, ...).' },
        parameters: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string', description: 'lower_snake_case' },
              type: { type: 'string', enum: [...PARAM_TYPES] },
              description: { type: 'string' },
              default: {},
              required: { type: 'boolean' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_report',
    title: 'Change a saved report',
    description: 'Change a saved report\'s name, description, query/arguments or parameters. Only the fields given change.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['report'],
      properties: {
        report: REPORT_REF,
        name: { type: 'string' },
        description: { type: 'string', description: 'Empty text clears it.' },
        sql: { type: 'string' },
        arguments: { type: 'object' },
        parameters: { type: 'array', items: { type: 'object' } },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_report',
    title: 'Delete a saved report',
    description: 'Delete one of the user\'s saved reports. Confirm with the user first.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['report'], properties: { report: REPORT_REF } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

export const INSTRUCTIONS = 'Call data for Buyerlink Calls\' AI phone agents (the AI Agent Registry): every inbound call routed through Canoe since 2026-05-31 with publisher, advertiser, campaign, vertical, AI agent, routing result, durations, revenue (advertiser payin) and cost (publisher payout), plus the registry\'s AI outcome, scores and compliance flags. Use aggregate_calls for counts, rates and money, search_calls and get_call for individual calls, list_values for exact names, and run_sql for anything else; describe_data explains every column. Days are Mountain Time. Phone numbers, ZIPs, transcripts and recording links are personal data: include them only when the user needs them. Users can save any query as a report (create_report) and re-run it later.';

const DEFINITIONS = {
  days: 'Business days are Mountain Time (America/Denver), as on the registry pages.',
  connected: 'connect_duration > 0 or result contains "connected"; connect rate = connected / calls.',
  paid: 'advertiser_payin > 0 (a billable call).',
  scored: 'our_outcome is set (the registry AI scored the call); outcome shares are % of scored calls.',
  qualified: 'our_outcome is appointment, sale or quoted_interested; qualified rate = qualified / scored.',
  flags: 'High severity: outbound_dial, facebook_marketplace, coached_call, suspicious_call; medium: duplicate_caller, wrong_business, angry_caller; info: geo_mismatch, quoted_abandoned. flag_rate = flagged scored calls / scored calls.',
  money: 'payin (advertiser_payin) = revenue, payout (publisher_payout) = publisher cost, margin = payin - payout. USD.',
  test_calls: 'The registry excludes is_test calls; the structured tools do too unless include_test.',
  personal_data: 'called_from, zip, transcripts and recording links are personal data.',
};

// ── Running queries ──
interface SqlResult { rows?: Record<string, unknown>[]; row_count?: number; truncated?: boolean; plan?: unknown; error?: string; sqlstate?: string }

class QueryError extends Error {
  constructor(message: string, readonly sqlstate?: string) { super(message); }
}
const HINTS: Record<string, string> = {
  '42501': 'Only the views calls, agents, agent_aliases, outcome_weights and account_assignments can be queried.',
  '42P01': 'Unknown table. Query the views calls, agents, agent_aliases, outcome_weights or account_assignments.',
  '42703': 'Unknown column: describe_data lists them.',
  '57014': 'The query took longer than 8 seconds. Narrow the date range (filter on created_at) or filter on publisher_name, advertiser_name, vertical_name, our_outcome or agent.',
  '25006': 'The connector is read-only.',
};

const withHint = (message: string, code?: string) =>
  code && HINTS[code] ? `${message.replace(/[.\s]*$/, '.')} ${HINTS[code]}` : message;

async function runSql(db: Db, query: string, maxRows: number, tool: string, explain = false): Promise<SqlResult> {
  const r = await db.rpc<SqlResult>('mcp_run_sql', { query, max_rows: maxRows, explain_only: explain, tool });
  if (r?.error) throw new QueryError(r.error, r.sqlstate);
  return r;
}

const MAX_TEXT = 4000;
function trimRows(rows: Record<string, unknown>[], maxText = MAX_TEXT) {
  let cut = false;
  const out = rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    if (typeof v === 'string' && v.length > maxText) { cut = true; return [k, v.slice(0, maxText) + ` …[${v.length - maxText} more characters]`]; }
    return [k, v];
  })));
  return { rows: out, cut };
}

// Rows plus paging facts, kept under ~150k characters (dropping rows from the end if needed).
function rowsPayload(r: SqlResult, extra: Record<string, unknown>, maxText = MAX_TEXT) {
  const { rows, cut } = trimRows(r.rows ?? [], maxText);
  const payload: Record<string, unknown> = { ...extra, row_count: rows.length, truncated: !!r.truncated, rows };
  if (cut) payload.note = `Long text was cut at ${maxText} characters.`;
  while (JSON.stringify(payload).length > 150000 && rows.length > 1) {
    rows.splice(Math.ceil(rows.length / 2));
    payload.row_count = rows.length;
    payload.truncated = true;
    payload.note = 'Result too large: rows were dropped. Ask for fewer rows or columns.';
  }
  return payload;
}

async function runSearch(db: Db, a: Args, tool: string) {
  const s = searchSql(a);
  const r = await runSql(db, s.sql, s.limit, tool);
  const more = !!r.truncated;
  return rowsPayload(r, { range: s.range, ...(more ? { next_offset: s.offset + s.limit } : {}), sql: s.sql });
}
async function runAggregate(db: Db, a: Args, tool: string) {
  const s = aggregateSql(a);
  return rowsPayload(await runSql(db, s.sql, s.limit, tool), { range: s.range, sql: s.sql });
}

// ── Saved reports ──
interface Report {
  id: string; name: string; description: string | null; kind: 'sql' | 'search' | 'aggregate';
  definition: Args; parameters: Param[]; created_at: string; updated_at: string;
}
const reportSummary = (r: Report) => ({
  id: r.id, name: r.name, description: r.description, kind: r.kind, parameters: r.parameters,
  definition: r.definition, updated_at: r.updated_at,
});

async function findReport(db: Db, ref: unknown): Promise<Report> {
  if (typeof ref !== 'string' || !ref.trim()) throw new InputError('report must be a report name or id.');
  const all = await db.rpc<Report[]>('mcp_reports_list');
  const key = ref.trim().toLowerCase();
  const hit = all.find(r => r.id === ref.trim()) ?? all.find(r => r.name.trim().toLowerCase() === key);
  if (!hit) throw new InputError(`No saved report "${ref}". Your reports: ${all.map(r => r.name).join(', ') || 'none yet'}.`);
  return hit;
}

function reportDefinition(kind: unknown, a: Args): Args {
  if (kind === 'sql') {
    if (typeof a.sql !== 'string' || !a.sql.trim()) throw new InputError('A sql report needs sql.');
    return { sql: a.sql.trim() };
  }
  if (kind === 'search' || kind === 'aggregate') {
    if (a.arguments != null && (typeof a.arguments !== 'object' || Array.isArray(a.arguments))) throw new InputError('arguments must be an object.');
    return (a.arguments ?? {}) as Args;
  }
  throw new InputError('kind must be sql, search or aggregate.');
}

// The query a report runs with these values (limit overrides the stored row limit).
function reportQuery(kind: string, def: Args, params: Param[], values: Record<string, unknown>, limit?: number) {
  if (kind === 'sql') return { sql: fillSql(String(def.sql ?? ''), params, values), limit: limit ?? 200 };
  const args = fillArgs(def, params, values) as Args;
  if (limit != null) args.limit = limit;
  const s = kind === 'search' ? searchSql(args) : aggregateSql(args);
  return { sql: s.sql, limit: s.limit };
}

// Build it with stand-in values and let the database plan it, so a broken report is never saved.
async function checkReport(db: Db, kind: string, def: Args, params: Param[]) {
  const q = reportQuery(kind, def, params, sampleValues(params));
  await runSql(db, q.sql, 1, 'check_report', true);
}

// ── Dispatch ──
export async function callTool(db: Db, name: string, a: Args): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return fail(`Unknown tool ${name}.`);
  try {
    return ok(await handler(db, a ?? {}));
  } catch (e) {
    if (e instanceof InputError) return fail(e.message);
    if (e instanceof QueryError) return fail(`Query failed: ${withHint(e.message, e.sqlstate)}`);
    if (e instanceof DbError) {
      if (e.status === 401 || (e.code === '42501' && /session|sign in/i.test(e.message))) {
        return fail(`${e.message} (reconnect the connector from the registry's Claude tab)`);
      }
      return fail(withHint(e.message, e.code));
    }
    console.error('mcp tool error', name, e);
    return fail('Something went wrong running this tool.');
  }
}
const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const TOOL_HANDLERS: Record<string, (db: Db, a: Args) => Promise<unknown>> = {
  async describe_data(db) {
    const d = await db.rpc<Record<string, unknown>>('mcp_describe');
    return { ...d, definitions: DEFINITIONS, filters: FILTER_KEYS, group_by: Object.keys(GROUPS), metrics: Object.keys(METRICS) };
  },
  search_calls: (db, a) => runSearch(db, a, 'search_calls'),
  async get_call(db, a) {
    const r = await runSql(db, getCallSql(a), 1, 'get_call');
    if (!r.rows?.length) throw new InputError(`No call with id "${a.id}".`);
    return trimRows(r.rows, 50000).rows[0];
  },
  aggregate_calls: (db, a) => runAggregate(db, a, 'aggregate_calls'),
  async list_values(db, a) {
    const s = listValuesSql(a);
    return rowsPayload(await runSql(db, s.sql, s.limit, 'list_values'), { range: s.range });
  },
  async run_sql(db, a) {
    if (typeof a.query !== 'string') throw new InputError('query must be text.');
    const maxRows = a.max_rows == null ? 200 : int(a.max_rows, 'max_rows', 1, 1000);
    const r = await runSql(db, a.query, maxRows, 'run_sql', a.explain === true);
    return a.explain === true ? { plan: r.plan } : rowsPayload(r, {});
  },
  async list_reports(db) {
    return (await db.rpc<Report[]>('mcp_reports_list')).map(reportSummary);
  },
  async run_report(db, a) {
    const rep = await findReport(db, a.report);
    if (a.params != null && (typeof a.params !== 'object' || Array.isArray(a.params))) throw new InputError('params must be an object.');
    const values = paramValues(rep.parameters, (a.params ?? {}) as Args);
    const limit = a.limit == null ? undefined : int(a.limit, 'limit', 1, 1000);
    const q = reportQuery(rep.kind, rep.definition, rep.parameters, values, limit);
    const r = await runSql(db, q.sql, q.limit, 'run_report');
    return rowsPayload(r, { report: rep.name, params: values, sql: q.sql });
  },
  async create_report(db, a) {
    if (typeof a.name !== 'string' || !a.name.trim()) throw new InputError('name is required.');
    const params = validateParams(a.parameters);
    const def = reportDefinition(a.kind, a);
    await checkReport(db, a.kind as string, def, params);
    const saved = await db.rpc<Report>('mcp_report_save', {
      p_id: null, p_name: a.name, p_description: a.description ?? null, p_kind: a.kind, p_definition: def, p_parameters: params,
    });
    return { saved: reportSummary(saved) };
  },
  async update_report(db, a) {
    const rep = await findReport(db, a.report);
    const params = a.parameters == null ? rep.parameters : validateParams(a.parameters);
    const changesQuery = a.sql != null || a.arguments != null || a.parameters != null;
    const def = a.sql != null || a.arguments != null ? reportDefinition(rep.kind, a) : rep.definition;
    if (changesQuery) await checkReport(db, rep.kind, def, params);
    const saved = await db.rpc<Report>('mcp_report_save', {
      p_id: rep.id, p_name: a.name ?? null, p_description: a.description ?? null, p_kind: null,
      p_definition: changesQuery ? def : null, p_parameters: a.parameters == null ? null : params,
    });
    return { saved: reportSummary(saved) };
  },
  async delete_report(db, a) {
    const rep = await findReport(db, a.report);
    await db.rpc<boolean>('mcp_report_delete', { p_id: rep.id });
    return { deleted: rep.name };
  },
};
