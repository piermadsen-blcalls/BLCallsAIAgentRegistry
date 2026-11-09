// Regression test: GHL sends call_timestamp as US-Pacific wall time with no offset.
// Since tzdata 2026 makes America/Vancouver permanent UTC-7, using it converted
// post-DST (PST, UTC-8) calls an hour early, so no ASCND call paired (2026-11-03).
// Run: deno test --allow-env --import-map=supabase/functions/hl-call-webhook/test/import_map.json supabase/functions/hl-call-webhook/test/
import { assertEquals } from 'jsr:@std/assert@1';
import { inserted } from './supabase_stub.ts';

// Pin tzdata 2026e behaviour regardless of the runtime's bundled tzdata: from
// Nov 2026 America/Vancouver stays on UTC-7 (same as fixed-offset America/Phoenix).
const RealDTF = Intl.DateTimeFormat;
Intl.DateTimeFormat = function (locales?: string | string[], opts?: Intl.DateTimeFormatOptions) {
  return new RealDTF(locales, opts?.timeZone === 'America/Vancouver' ? { ...opts, timeZone: 'America/Phoenix' } : opts);
} as unknown as typeof Intl.DateTimeFormat;

let handler: (req: Request) => Promise<Response>;
Deno.serve = ((h: typeof handler) => { handler = h; }) as unknown as typeof Deno.serve;
await import('../index.ts');

async function storedTimestamp(callTimestamp: string): Promise<string> {
  const res = await handler(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ phone: '+15550000000', customData: { call_timestamp: callTimestamp } }),
  }));
  assertEquals(res.status, 200);
  return inserted.at(-1)!.call_timestamp as string;
}

Deno.test('summer call (PDT, UTC-7)', async () => {
  assertEquals(await storedTimestamp('2026-07-15 09:00:00'), '2026-07-15T16:00:00.000Z');
});

Deno.test('winter call after the 2026-11-01 fall-back (PST, UTC-8)', async () => {
  assertEquals(await storedTimestamp('2026-11-05 09:00:00'), '2026-11-05T17:00:00.000Z');
});

Deno.test('day after the 2027-03-14 spring-forward (PDT again)', async () => {
  assertEquals(await storedTimestamp('2027-03-15 09:00:00'), '2027-03-15T16:00:00.000Z');
});
