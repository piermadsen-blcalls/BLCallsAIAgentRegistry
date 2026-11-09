import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let payload: Record<string, any>;
  try {
    payload = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const customData = payload.customData;
  if (!customData) {
    return new Response('Missing customData', { status: 400 });
  }

  // Phone comes from top-level in E.164 format
  const phone = (payload.phone || '').trim();
  if (!phone) {
    return new Response('Missing phone', { status: 400 });
  }

  // Parse call_timestamp — Pacific time (America/Vancouver)
  // Format from payload: "2026-06-03 15:10:54"
  const rawTimestamp = (customData.call_timestamp || '').trim();
  if (!rawTimestamp) {
    return new Response('Missing call_timestamp', { status: 400 });
  }

  // Determine Pacific offset for the given date (PDT = UTC-7, PST = UTC-8)
  // by checking what UTC time corresponds to noon on that date in Vancouver
  const [datePart, timePart] = rawTimestamp.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);

  // Test if this date is in PDT (second Sunday in March through first Sunday in November)
  // Simple approach: try both offsets and pick the one that matches Vancouver's actual offset
  const testDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const vancouverHour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Vancouver',
    hour: 'numeric',
    hour12: false
  }).format(testDate);
  const isPDT = parseInt(vancouverHour) === 5; // noon UTC = 5am PDT or 4am PST
  const offsetMinutes = isPDT ? -7 * 60 : -8 * 60;

  const localMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60 * 1000;
  const callTimestamp = new Date(localMs).toISOString();

  // Transcript from top-level — nullable
  const rawTranscript = (payload['Voice AI Transcript'] || '').trim();
  const transcript = rawTranscript.length > 0 ? rawTranscript : null;

  const record = {
    contact_id:              (customData.contact_id || '').trim() || null,
    phone,
    call_timestamp:          callTimestamp,
    disposition:             (customData.disposition || '').trim() || null,
    disposition_description: (customData.disposition_description || '').trim() || null,
    recording_url:           (customData.recording_url || '').trim() || null,
    transcript,
    intent: (customData.intent || '').trim() || null,
      ai_agent_phone_number: (customData.ai_agent_phone_number ||
  '').trim() || null,
  };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { error } = await supabase
    .from('hl_call_data')
    .insert(record);

  if (error) {
    console.error('Supabase insert error:', error);
    return new Response(`Insert failed: ${error.message}`, { status: 500 });
  }

  return new Response('OK', { status: 200 });
});
