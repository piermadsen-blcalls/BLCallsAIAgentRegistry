// Scores-tab tiering. index.html has no build step, so the tier code is lifted out of
// the page and evaluated on its own. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Source of a top-level `function name(` or `const name =` declaration, by brace matching.
function lift(decl) {
  const start = html.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in index.html`);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}
const ctx = {};
vm.runInNewContext(
  [lift('const SCORES_TIERS ='), lift('function scoresRates('), lift('function scoresTierOf(')].join(';\n')
    + ';\nthis.SCORES_TIERS = SCORES_TIERS; this.scoresRates = scoresRates; this.scoresTierOf = scoresTierOf;',
  ctx);
const { SCORES_TIERS, scoresRates, scoresTierOf } = ctx;

const WEIGHTS = { sale: 10, quoted_undecided: 2, caller_hangup: 0, misrouted: -3, soliciting: -5 };
const weightOf = o => WEIGHTS[o] ?? 0;

test('rates: defect = weight < 0, conversion-adjacent = weight 2+', () => {
  const r = scoresRates({ sale: 1, quoted_undecided: 1, caller_hangup: 6, misrouted: 1, soliciting: 1 }, weightOf);
  assert.equal(r.defect, 0.2);
  assert.equal(r.conv, 0.2);
  assert.equal(JSON.stringify(scoresRates({}, weightOf)), JSON.stringify({ defect: null, conv: null }));
});

test('tiers are ordered and each bar is no looser than the next tier down', () => {
  for (const entity of ['publisher', 'advertiser']) {
    const t = SCORES_TIERS[entity];
    assert.equal(t.map(x => x.tier).join(','), '1,2,3');
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i - 1].minAvg > t[i].minAvg && t[i - 1].maxDefect < t[i].maxDefect && t[i - 1].minConv > t[i].minConv, entity);
    }
  }
});

test('publisher bars: re-tuned values (2026-11-09 live quartiles)', () => {
  assert.equal(scoresTierOf(0.9, 0.07, 0.15, 'publisher'), 1, 'exactly on the Tier 1 bars');
  assert.equal(scoresTierOf(4.2, 0.05, 0.30, 'publisher'), 1, 'the old Tier 1 bar still lands in Tier 1');
  assert.equal(scoresTierOf(0.89, 0.05, 0.30, 'publisher'), 2, 'just under the Tier 1 average');
  assert.equal(scoresTierOf(2.0, 0.08, 0.30, 'publisher'), 2, 'defect over 7% drops a strong pairing to Tier 2');
  assert.equal(scoresTierOf(0.0, 0.15, 0.05, 'publisher'), 3);
  assert.equal(scoresTierOf(-0.5, 0.10, 0.10, 'publisher'), 4, 'below every average bar');
  assert.equal(scoresTierOf(1.0, 0.25, 0.20, 'publisher'), 4, 'defect over 20% fails every tier');
});

test('advertiser bars use their own (looser defect) thresholds', () => {
  assert.equal(scoresTierOf(0.6, 0.18, 0.16, 'advertiser'), 1);
  assert.equal(scoresTierOf(0.6, 0.18, 0.16, 'publisher'), 3, 'same numbers only reach Tier 3 under the publisher defect bars');
  assert.equal(scoresTierOf(-0.9, 0.30, 0.10, 'advertiser'), 4);
});

test('no score means no tier', () => {
  assert.equal(scoresTierOf(null, null, null, 'publisher'), null);
});
