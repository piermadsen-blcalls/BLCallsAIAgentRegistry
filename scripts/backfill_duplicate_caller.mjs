// One-time backfill: strip `duplicate_caller` from calls that no longer
// qualify under the tightened find_duplicate_callers rule (017).
// Only touches the duplicate_caller entry in flags; never other flags.
// DRY_RUN=true (default) reports without writing. DRY_RUN=false executes.
import fs from 'fs';
const envTxt = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
const env = Object.fromEntries(envTxt.split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const H = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const B = env.SUPABASE_URL + '/rest/v1/';
const DRY = (process.env.DRY_RUN ?? 'true') !== 'false';
const f = async (p, opt) => { const r = await fetch(B + p, { headers: H, ...opt }); if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + await r.text()); const txt = await r.text(); return txt ? JSON.parse(txt) : null; };

// 1. All calls currently carrying duplicate_caller — keyset-paginate the PK
//    (the jsonb-contains filter has no index and times out on a full scan).
const flagged = [];
let last = '', page, scanned = 0;
do {
  const q = `canoe_calls?select=id,flags&order=id.asc&limit=1000${last ? `&id=gt.${encodeURIComponent(last)}` : ''}`;
  page = await f(q);
  scanned += page.length;
  for (const c of page) if ((c.flags || []).includes('duplicate_caller')) flagged.push(c);
  if (page.length) last = page[page.length - 1].id;
} while (page.length === 1000);
console.log(`Scanned ${scanned} calls. Currently flagged duplicate_caller: ${flagged.length}`);
if (!flagged.length) { console.log('Nothing to backfill.'); process.exit(0); }

// 2. Which of them still qualify under the new rule
const ids = flagged.map(c => c.id);
const stillDup = new Set();
for (let i = 0; i < ids.length; i += 200) {
  const res = await f('rpc/find_duplicate_callers', { method: 'POST', body: JSON.stringify({ call_ids: ids.slice(i, i + 200) }) });
  (res || []).forEach(r => stillDup.add(r.id));
}
console.log(`Still qualify under new rule: ${stillDup.size}`);

// 3. The rest lose the flag
const toClear = flagged.filter(c => !stillDup.has(c.id));
console.log(`Will strip duplicate_caller from: ${toClear.length} calls`);
console.log(DRY ? '\n[DRY RUN] no writes performed. Re-run with DRY_RUN=false to apply.' : '\nApplying…');

if (DRY) process.exit(0);

let done = 0;
for (const c of toClear) {
  const newFlags = (c.flags || []).filter(x => x !== 'duplicate_caller');
  await f(`canoe_calls?id=eq.${encodeURIComponent(c.id)}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ flags: newFlags }) });
  done++;
  if (done % 25 === 0) console.log(`  ${done}/${toClear.length}`);
}
console.log(`Done. Cleared duplicate_caller from ${done} calls.`);
