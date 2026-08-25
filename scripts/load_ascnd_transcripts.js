/**
 * load_ascnd_transcripts.js  (one-off)
 * Bulk-loads a trimmed transcript CSV into the ascnd_transcript_import staging
 * table, which the backfill SQL then joins into hl_call_data / canoe_calls.
 *
 * Prereqs:
 *   1) Create the staging table first (see 036 backfill SQL / the create block).
 *   2) scripts/.env must have SUPABASE_URL + SUPABASE_SERVICE_KEY.
 *
 * Usage:
 *   node scripts/load_ascnd_transcripts.js [path-to-csv]
 *   (defaults to ~/Downloads/ascnd_transcripts_for_import.csv)
 *
 * CSV columns (header row required): contact_id,tag,voice_ai_transcript
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// Local dev: load scripts/.env if present (gitignored), same as sync.js.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY (put them in scripts/.env).');
  process.exit(1);
}

const CSV_PATH = process.argv[2] || path.join(os.homedir(), 'Downloads', 'ascnd_transcripts_for_import.csv');
const CHUNK = 500;

function parseCSV(t) {
  t = t.replace(/^﻿/, '');
  const rows = []; let f = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { f.push(cur); cur = ''; }
           else if (c === '\n') { f.push(cur); rows.push(f); f = []; cur = ''; }
           else if (c === '\r') { } else cur += c; }
  }
  if (cur.length || f.length) { f.push(cur); rows.push(f); }
  return rows;
}

function postChunk(records) {
  const body = JSON.stringify(records);
  const u = new URL(`${SUPABASE_URL}/rest/v1/ascnd_transcript_import`);
  return new Promise((resolve, reject) => {
    const req = https.request(u, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300)
        ? resolve() : reject(new Error(`${res.statusCode}: ${d.slice(0, 300)}`)));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  if (!fs.existsSync(CSV_PATH)) { console.error('CSV not found:', CSV_PATH); process.exit(1); }
  const rows = parseCSV(fs.readFileSync(CSV_PATH, 'utf8'));
  const H = rows[0].map(h => h.trim());
  const iCid = H.indexOf('contact_id'), iTag = H.indexOf('tag'), iVAT = H.indexOf('voice_ai_transcript');
  if (iCid < 0 || iVAT < 0) { console.error('CSV must have contact_id,tag,voice_ai_transcript headers'); process.exit(1); }

  const recs = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row || row.length < H.length) continue;
    const cid = (row[iCid] || '').trim(), vat = (row[iVAT] || '').trim();
    if (!cid || !vat) continue;
    recs.push({ contact_id: cid, tag: (row[iTag] || '').trim() || null, voice_ai_transcript: vat });
  }
  console.log(`Parsed ${recs.length} transcript rows from ${CSV_PATH}`);

  let done = 0;
  for (let i = 0; i < recs.length; i += CHUNK) {
    await postChunk(recs.slice(i, i + CHUNK));
    done += Math.min(CHUNK, recs.length - i);
    process.stdout.write(`\rInserted ${done}/${recs.length}`);
  }
  console.log(`\nDone. Loaded ${done} rows into ascnd_transcript_import.`);
})().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
