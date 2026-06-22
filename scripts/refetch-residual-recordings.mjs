// =====================================================================
// One-off recovery: pull call recordings that are still sitting on Twilio
// into our private Supabase bucket, mirroring the /recording-status intake.
//
// Why this exists: call recording (Record=true + RecordingStatusCallback to
// /recording-status) was enabled on the kick-call WF before the Railway code
// that handles the callback went live (~2026-06-05 .. merge). Those callbacks
// 404'd, so the recordings stayed on Twilio instead of being copied + deleted.
// Successful intake deletes the Twilio copy, so anything STILL on Twilio is, by
// definition, a residual that was never saved. This script intakes them.
//
// It replicates index.js /recording-status exactly:
//   session(call_sid) -> tenant_id; download {sid}.mp3; upload to
//   call-recordings/{tenant_id}/{call_sid}.mp3; upsert call_recordings
//   (onConflict call_sid) with the tenant retention window; then delete the
//   Twilio copy. Idempotent — safe to re-run; already-saved calls are gone
//   from Twilio so they won't reappear.
//
// Usage (run where the Railway env vars are available, e.g. Railway shell or a
// local .env with the production keys):
//   DRY_RUN=1 node scripts/refetch-residual-recordings.mjs   # list only
//   node scripts/refetch-residual-recordings.mjs             # actually intake
//
// Env:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY (required)
//   START_DATE / END_DATE  optional Twilio DateCreated bounds (YYYY-MM-DD)
//   DRY_RUN=1              list residuals, mutate nothing
//   LIMIT=N               stop after N processed (debug)
// =====================================================================

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

dotenv.config();

const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    START_DATE,
    END_DATE,
} = process.env;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;

for (const [k, v] of Object.entries({ TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
    if (!v) { console.error(`Missing required env: ${k}`); process.exit(1); }
}

// Mirror index.js
const RECORDING_BUCKET = 'call-recordings';
const DEFAULT_RECORDING_RETENTION_DAYS = 30;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const twAuth = 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
const TW_BASE = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}`;

// Walk the paginated Twilio recordings list, optionally bounded by DateCreated.
async function* listTwilioRecordings() {
    const params = new URLSearchParams({ PageSize: '1000' });
    if (START_DATE) params.set('DateCreated>', START_DATE);
    if (END_DATE) params.set('DateCreated<', END_DATE);
    let url = `${TW_BASE}/Recordings.json?${params.toString()}`;
    while (url) {
        const res = await fetch(url, { headers: { Authorization: twAuth } });
        if (!res.ok) throw new Error(`Twilio list failed: ${res.status} ${await res.text()}`);
        const body = await res.json();
        for (const rec of body.recordings || []) yield rec;
        // next_page_uri is an absolute path like /2010-04-01/Accounts/AC.../Recordings.json?Page=1&...
        url = body.next_page_uri ? `https://api.twilio.com${body.next_page_uri}` : '';
    }
}

async function intake(rec) {
    const CallSid = rec.call_sid;
    const RecordingSid = rec.sid;
    if (rec.status && rec.status !== 'completed') {
        return { skip: `status=${rec.status}` };
    }

    // session(call_sid) -> tenant_id (most recent), same as the handler.
    const { data: session } = await supabase
        .from('call_sessions')
        .select('id, tenant_id')
        .eq('call_sid', CallSid)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (!session?.tenant_id) return { skip: 'no session/tenant (left on Twilio)' };

    if (DRY_RUN) return { dry: true, tenant_id: session.tenant_id };

    // Dual-channel MP3 from Twilio.
    const dl = await fetch(`${TW_BASE}/Recordings/${RecordingSid}.mp3`, { headers: { Authorization: twAuth } });
    if (!dl.ok) throw new Error(`download failed: ${dl.status}`);
    const mp3 = Buffer.from(await dl.arrayBuffer());
    if (mp3.length === 0) throw new Error('download was empty');

    const storagePath = `${session.tenant_id}/${CallSid}.mp3`;
    const { error: upErr } = await supabase.storage
        .from(RECORDING_BUCKET)
        .upload(storagePath, mp3, { contentType: 'audio/mpeg', upsert: true });
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);

    const { data: tenant } = await supabase
        .from('tenants')
        .select('recording_retention_days')
        .eq('id', session.tenant_id)
        .single();
    const days = tenant?.recording_retention_days ?? DEFAULT_RECORDING_RETENTION_DAYS;
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

    const { error: insErr } = await supabase.from('call_recordings').upsert({
        tenant_id: session.tenant_id,
        session_id: session.id,
        call_sid: CallSid,
        recording_sid: RecordingSid,
        storage_path: storagePath,
        duration_seconds: rec.duration ? parseInt(rec.duration, 10) : null,
        expires_at: expiresAt,
    }, { onConflict: 'call_sid' });
    if (insErr) throw new Error(`call_recordings upsert failed: ${insErr.message}`);

    // Only after our copy is safe do we delete Twilio's.
    const delRes = await fetch(`${TW_BASE}/Recordings/${RecordingSid}.json`, {
        method: 'DELETE',
        headers: { Authorization: twAuth },
    });
    if (!delRes.ok && delRes.status !== 404) {
        console.error(`  ⚠ Twilio delete failed: ${delRes.status} (copy saved at ${storagePath})`);
    }
    return { saved: storagePath, bytes: mp3.length, expiresAt };
}

const counts = { total: 0, saved: 0, skipped: 0, failed: 0, dry: 0 };
console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Scanning Twilio recordings${START_DATE ? ` from ${START_DATE}` : ''}${END_DATE ? ` to ${END_DATE}` : ''} ...`);

for await (const rec of listTwilioRecordings()) {
    if (counts.total >= LIMIT) break;
    counts.total++;
    try {
        const r = await intake(rec);
        if (r.skip) { counts.skipped++; console.log(`- skip ${rec.sid} (call=${rec.call_sid}): ${r.skip}`); }
        else if (r.dry) { counts.dry++; console.log(`~ would intake ${rec.sid} (call=${rec.call_sid}) -> tenant ${r.tenant_id}, ${rec.duration}s`); }
        else { counts.saved++; console.log(`✓ saved ${r.saved} (${r.bytes} bytes, expires ${r.expiresAt})`); }
    } catch (err) {
        counts.failed++;
        console.error(`✗ ${rec.sid} (call=${rec.call_sid}): ${err.message}`);
    }
}

console.log('\n=== summary ===');
console.log(counts);
if (DRY_RUN) console.log('DRY RUN — nothing was changed. Re-run without DRY_RUN=1 to intake.');
process.exit(counts.failed > 0 ? 1 : 0);
