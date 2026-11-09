// Digest ranking: outliers first. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBaseline, tallyAccounts, rankAccounts, buildEmail } = require('../scripts/alert.js');

const SCORED = '2026-11-05T12:00:00Z';
// n scored calls for one account/vertical, the first `flagged` of them carrying `flag`.
function calls(publisher, vertical, n, flagged = 0, flag = 'geo_mismatch') {
  return Array.from({ length: n }, (_, i) => ({
    publisher_name: publisher, advertiser_name: 'Some Buyer', vertical_name: vertical,
    flags: i < flagged ? [flag] : [], suspicious_call: false, ai_processed_at: SCORED,
  }));
}
function rank(all, pubs) {
  return rankAccounts(tallyAccounts(all.filter(c => pubs.has(c.publisher_name)), new Set(), pubs, buildBaseline(all)));
}

test('baseline counts scored calls per vertical and network, skipping unscored', () => {
  const all = [...calls('A', 'Roofing', 10, 2), { publisher_name: 'A', vertical_name: 'Roofing', flags: [], ai_processed_at: null }];
  const b = buildBaseline(all);
  assert.equal(b.network.scored, 10);
  assert.equal(b.verticals.Roofing.scored, 10);
  assert.equal(b.verticals.Roofing.counts.geo_mismatch, 2);
});

test('a flag rate far above the vertical baseline makes the account an outlier', () => {
  const all = [
    ...calls('Network', 'Roofing', 1000, 20),  // 2% baseline
    ...calls('Hot', 'Roofing', 50, 10),         // 20%
    ...calls('Normal', 'Roofing', 50, 1),       // 2%
  ];
  const ranked = rank(all, new Set(['Hot', 'Normal']));
  assert.deepEqual(ranked.map(a => [a.name, a.outlier]), [['Hot', true], ['Normal', false]]);
  const r = ranked[0].reasons[0];
  assert.equal(r.flag, 'geo_mismatch');
  assert.ok(r.z >= 3);
  assert.match(r.label, /^10 × Geo mismatch \(20% of 50 scored calls vs \d+% baseline\)$/);
  assert.equal(ranked[1].reasons[0].label, '1 × Geo mismatch');
});

test('high rate on fewer than 3 flagged calls is not an outlier', () => {
  const all = [...calls('Network', 'Roofing', 2000, 2), ...calls('Tiny', 'Roofing', 4, 2)];
  const [tiny] = rank(all, new Set(['Tiny']));
  assert.ok(tiny.reasons[0].z >= 3, 'z alone would trip it');
  assert.equal(tiny.outlier, false);
});

test('compares against the vertical, not the network, when the vertical has volume', () => {
  const all = [
    ...calls('Ins network', 'Insurance', 500, 100), // Insurance runs 20%
    ...calls('Roof network', 'Roofing', 2000, 20),  // Roofing runs 1%
    ...calls('Insurer', 'Insurance', 50, 11),        // 22%: normal for Insurance
  ];
  const [a] = rank(all, new Set(['Insurer']));
  assert.equal(a.outlier, false);
  assert.ok(Math.abs(a.reasons[0].baseRate - 111 / 550) < 1e-9);
});

test('a thin vertical falls back to the network rate', () => {
  const all = [...calls('Network', 'Roofing', 1000, 20), ...calls('Niche', 'Rare vertical', 40, 12)];
  const [a] = rank(all, new Set(['Niche']));
  assert.ok(a.reasons[0].baseRate < 0.05, 'uses ~3% network rate, not the vertical\'s own 30%');
  assert.equal(a.outlier, true);
});

test('outliers sort by worst z, then the rest by flagged calls; unflagged accounts drop out', () => {
  const all = [
    ...calls('Network', 'Roofing', 3000, 60),
    ...calls('Mild outlier', 'Roofing', 100, 9),
    ...calls('Big outlier', 'Roofing', 100, 30),
    ...calls('Many flags', 'Roofing', 400, 9),
    ...calls('Few flags', 'Roofing', 100, 2),
    ...calls('Clean', 'Roofing', 100, 0),
  ];
  const ranked = rank(all, new Set(['Mild outlier', 'Big outlier', 'Many flags', 'Few flags', 'Clean']));
  assert.deepEqual(ranked.map(a => a.name), ['Big outlier', 'Mild outlier', 'Many flags', 'Few flags']);
});

test('a flagged call missing ai_processed_at still counts', () => {
  const all = [...calls('Network', 'Roofing', 300, 3), { publisher_name: 'A', vertical_name: 'Roofing', flags: ['angry_caller'], ai_processed_at: null }];
  const [a] = rank(all, new Set(['A']));
  assert.equal(a.curr.flaggedCalls, 1);
  assert.equal(a.curr.scored, 1);
});

test('email lists outliers before the collapsed rest', () => {
  const all = [...calls('Network', 'Roofing', 1000, 20), ...calls('Hot Pub', 'Roofing', 50, 10), ...calls('Calm Pub', 'Roofing', 50, 1)];
  const ranked = rank(all, new Set(['Hot Pub', 'Calm Pub']));
  const html = buildEmail({ manager_name: 'Pat Example' }, ranked, 'Nov 2 – Nov 5', '2026-11-02', '2026-11-05T16:00:00');
  assert.match(html, /1 outlier, 2 accounts flagged/);
  const iOut = html.indexOf('Outliers (1)'), iHot = html.indexOf('Hot Pub'), iRest = html.indexOf('Other flagged accounts (1)'), iCalm = html.indexOf('Calm Pub');
  assert.ok(iOut >= 0 && iOut < iHot && iHot < iRest && iRest < iCalm, 'order: outliers, Hot Pub, rest, Calm Pub');
  assert.match(html, /vs \d+% baseline/);
});

test('email with no outliers says so and still lists every account', () => {
  const all = [...calls('Network', 'Roofing', 1000, 20), ...calls('Calm Pub', 'Roofing', 50, 1)];
  const html = buildEmail({ manager_name: 'Pat Example' }, rank(all, new Set(['Calm Pub'])), 'Nov 2 – Nov 5', '2026-11-02', '2026-11-05T16:00:00');
  assert.match(html, /Outliers \(0\)/);
  assert.match(html, /Calm Pub/);
});
