// SQL builders: filters, the three structured queries and saved-report parameters. The SQL these
// produce runs against the real 066 views in the end-to-end check (see the PR's test log).
// Run: deno test supabase/functions/mcp/test/
import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1';
import {
  aggregateSql, e164, fillArgs, fillSql, getCallSql, InputError, listValuesSql, lit, paramValues, resolveDate,
  sampleValues, searchSql, validateParams, whereClause,
} from '../sql.ts';

Deno.test('literals: quotes doubled, NUL refused', () => {
  assertEquals(lit("O'Brien"), "'O''Brien'");
  assertEquals(lit("x'); drop table calls; --"), "'x''); drop table calls; --'");
  assertThrows(() => lit('a\u0000b'), InputError);
});

Deno.test('filters: default 30 Mountain days, no test calls', () => {
  const w = whereClause({});
  assertStringIncludes(w.sql, `created_at >= ((now() at time zone 'America/Denver')::date - 29)::timestamp at time zone 'America/Denver'`);
  assertStringIncludes(w.sql, 'is_test is not true');
  assertMatch(w.range, /last 30 days/);
  assert(!whereClause({ include_test: true }).sql.includes('is_test'));
});

Deno.test('filters: dates are inclusive Mountain days', () => {
  const w = whereClause({ start_date: '2026-11-09', end_date: '2026-11-15' });
  assertStringIncludes(w.sql, `created_at >= ('2026-11-09'::date)::timestamp at time zone 'America/Denver'`);
  assertStringIncludes(w.sql, `created_at < ('2026-11-15'::date + 1)::timestamp at time zone 'America/Denver'`);
  assertThrows(() => whereClause({ start_date: '11/09/2026' }), InputError, 'date like');
  assertThrows(() => whereClause({ start_date: '2026-02-30x' }), InputError);
  assertThrows(() => whereClause({ last_days: 7, start_date: '2026-11-01' }), InputError, 'not both');
  assertStringIncludes(whereClause({ last_days: 7 }).sql, `::date - 6)::timestamp`);
});

Deno.test('filters: exact, contains, booleans, ranges, flags, caller', () => {
  const w = whereClause({
    publisher: 'Pub A', advertiser: ['Adv 1', "Adv 'Two'"], publisher_contains: '50%_off', qualified: true,
    flagged: false, min_connect_duration: 60, flags: ['geo_mismatch', 'outbound_dial'], caller: '(555) 010-6601',
  }).sql;
  assertStringIncludes(w, `publisher_name = 'Pub A'`);
  assertStringIncludes(w, `advertiser_name in ('Adv 1', 'Adv ''Two''')`);
  assertStringIncludes(w, `publisher_name ilike '%50\\%\\_off%'`);
  assertStringIncludes(w, '\n  and qualified');
  assertStringIncludes(w, 'not coalesce(flagged, false)');
  assertStringIncludes(w, 'connect_duration >= 60');
  assertStringIncludes(w, `flags ?| array['geo_mismatch', 'outbound_dial']`);
  assertStringIncludes(w, `called_from = '+15550106601'`);
});

Deno.test('filters: bad input names the problem', () => {
  assertThrows(() => whereClause({ publsher: 'x' }), InputError, 'Unknown filter publsher');
  assertThrows(() => whereClause({ connected: 'yes' }), InputError, 'true or false');
  assertThrows(() => whereClause({ min_payin: '5' }), InputError, 'number');
  assertThrows(() => whereClause({ publisher: [] }), InputError);
  assertThrows(() => e164('12'), InputError);
  assertEquals(e164('15550106601'), '+15550106601');
});

Deno.test('search: summary columns, no long text, page size and next page', () => {
  const s = searchSql({ filters: { publisher: 'Pub A' }, limit: 10, offset: 20 });
  assertStringIncludes(s.sql, `to_char(created_at at time zone 'America/Denver', 'YYYY-MM-DD HH24:MI:SS') as time_mt`);
  assert(!/transcription|canoe_summary|ascnd_transcript/.test(s.sql), 'no transcripts by default');
  assertStringIncludes(s.sql, 'order by created_at desc, id desc\nlimit 11 offset 20');
  assertEquals([s.limit, s.offset], [10, 20]);
  const t = searchSql({ include_text: true });
  assertStringIncludes(t.sql, 'transcription');
  assertEquals(t.limit, 20, 'text caps the page at 20');
  assertThrows(() => searchSql({ include_text: true, limit: 50 }), InputError, '1 to 20');
  assertThrows(() => searchSql({ columns: ['id', 'password'] }), InputError, 'Unknown column password');
  assertThrows(() => searchSql({ sort: 'random' }), InputError);
  assertThrows(() => searchSql({ limit: 500 }), InputError);
});

Deno.test('get_call: transcripts and recordings only on request', () => {
  const plain = getCallSql({ id: 'c1' });
  assert(!/transcription|ascnd_transcript|canoe_summary|recording_url/.test(plain));
  assertStringIncludes(plain, 'our_summary');
  assertStringIncludes(plain, "where id = 'c1'");
  const full = getCallSql({ id: 'c1', include_transcript: true, include_recording: true });
  for (const c of ['transcription', 'ascnd_transcript', 'canoe_summary', 'recording_url', 'ascnd_recording_url']) assertStringIncludes(full, c);
});

Deno.test('aggregate: registry definitions, grouping, ordering', () => {
  const s = aggregateSql({ filters: { last_days: 7 }, group_by: ['publisher'], metrics: ['calls', 'connect_rate', 'qualified_rate', 'margin'] });
  assertStringIncludes(s.sql, 'publisher_name as "publisher"');
  assertStringIncludes(s.sql, 'round(100.0 * count(*) filter (where connected) / nullif(count(*), 0), 1) as "connect_rate"');
  assertStringIncludes(s.sql, 'round(100.0 * count(*) filter (where qualified) / nullif(count(*) filter (where scored), 0), 1) as "qualified_rate"');
  assertStringIncludes(s.sql, 'group by 1\norder by "calls" desc nulls last\nlimit 101');
  const t = aggregateSql({ group_by: ['day'] });
  assertStringIncludes(t.sql, 'order by "day"');
  const total = aggregateSql({});
  assert(!total.sql.includes('group by'), 'no group = one total row');
  assertStringIncludes(aggregateSql({ group_by: ['flag'] }).sql, 'jsonb_array_elements_text');
  assertStringIncludes(aggregateSql({ group_by: ['agent'], sort: 'agent', sort_dir: 'asc' }).sql, 'order by "agent" asc');
  assertThrows(() => aggregateSql({ group_by: ['a', 'b', 'c', 'd'] }), InputError, 'at most 3');
  assertThrows(() => aggregateSql({ group_by: ['color'] }), InputError, 'Unknown group_by');
  assertThrows(() => aggregateSql({ metrics: ['profit'] }), InputError, 'Unknown metric');
  assertThrows(() => aggregateSql({ metrics: ['calls'], sort: 'payin' }), InputError);
});

Deno.test('list_values: 90-day default, partial match', () => {
  const s = listValuesSql({ field: 'publisher', contains: 'acme' });
  assertStringIncludes(s.sql, '::date - 89)::timestamp');
  assertStringIncludes(s.sql, `publisher_name ilike '%acme%'`);
  assertThrows(() => listValuesSql({ field: 'day' }), InputError);
});

Deno.test('report parameters: validation, defaults, required, types', () => {
  const params = validateParams([
    { name: 'start', type: 'date', default: 'start_of_last_week' },
    { name: 'pubs', type: 'text_list' },
    { name: 'min_calls', type: 'integer', default: 10, required: true },
  ]);
  assertThrows(() => validateParams([{ name: 'Bad Name', type: 'text' }]), InputError, 'lower_snake_case');
  assertThrows(() => validateParams([{ name: 'x', type: 'json' }]), InputError, 'type must be');
  assertThrows(() => validateParams([{ name: 'x', type: 'text' }, { name: 'x', type: 'text' }]), InputError, 'twice');
  const v = paramValues(params, { pubs: ['A', 'B'] }, '2026-11-17');
  assertEquals(v, { start: '2026-11-09', pubs: ['A', 'B'], min_calls: 10 });
  assertThrows(() => paramValues(params, { nope: 1 }), InputError, 'Unknown parameter nope');
  assertThrows(() => paramValues(params, { min_calls: 'ten' }), InputError, 'integer');
  assertThrows(() => paramValues([{ name: 'd', type: 'date', required: true }], {}), InputError, 'required');
  assertEquals(Object.keys(sampleValues(params, '2026-11-17')).sort(), ['min_calls', 'pubs', 'start']);
});

Deno.test('relative dates are Mountain Time calendar days (weeks start Monday)', () => {
  const t = '2026-11-17';   // a Tuesday
  assertEquals(resolveDate('today', t), t);
  assertEquals(resolveDate('yesterday', t), '2026-11-16');
  assertEquals(resolveDate('today-7', t), '2026-11-10');
  assertEquals(resolveDate('start_of_week', t), '2026-11-16');
  assertEquals(resolveDate('start_of_last_week', t), '2026-11-09');
  assertEquals(resolveDate('end_of_last_week', t), '2026-11-15');
  assertEquals(resolveDate('start_of_month', t), '2026-11-01');
  assertEquals(resolveDate('start_of_last_month', t), '2026-10-01');
  assertEquals(resolveDate('end_of_last_month', t), '2026-10-31');
  assertEquals(resolveDate('start_of_last_month', '2026-01-05'), '2025-12-01');
  assertEquals(resolveDate('start_of_week', '2026-11-16'), '2026-11-16', 'Monday is its own week start');
  assertThrows(() => resolveDate('next tuesday', t), InputError);
});

Deno.test('fillSql: typed literals, unset optional = null, unknown placeholder refused', () => {
  const params = validateParams([{ name: 'start', type: 'date' }, { name: 'pubs', type: 'text_list' }, { name: 'min', type: 'number' }, { name: 'who', type: 'text' }]);
  const sql = fillSql("select * from calls where day >= {{start}} and publisher_name = any({{ pubs }}) and x > {{min}} and y = {{who}}",
    params, { start: '2026-11-09', pubs: ["A'1", 'B'], who: "O'Brien" });
  assertEquals(sql, "select * from calls where day >= '2026-11-09'::date and publisher_name = any(array['A''1', 'B']::text[]) and x > null and y = 'O''Brien'");
  assertThrows(() => fillSql('select {{other}}', params, {}), InputError, 'no parameter "other"');
});

Deno.test('fillArgs: whole placeholders take typed values, lists flatten, unset ones drop out', () => {
  const params = validateParams([{ name: 'start', type: 'date' }, { name: 'pubs', type: 'text_list' }, { name: 'end', type: 'date' }]);
  const out = fillArgs({ filters: { start_date: '{{start}}', end_date: '{{end}}', publisher: ['{{pubs}}'] }, group_by: ['day'] },
    params, { start: '2026-11-09', pubs: ['A', 'B'] });
  assertEquals(out, { filters: { start_date: '2026-11-09', publisher: ['A', 'B'] }, group_by: ['day'] });
  assertThrows(() => fillArgs({ x: '{{nope}}' }, params, {}), InputError);
});
