// Generate a tenant's clip audio with OpenAI TTS and upload it to storage.
// Reads each clip's text from the DB (audio_clips), synthesizes with the
// playbook's voice, and uploads MP3 to <audio_base_path>/<filename> in the
// call-audio bucket. This is the self-serve onboarding path: define the
// playbook text, run this, and the agent has a voice — no recording needed.
//
// Run:
//   OPENAI_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   TENANT_SLUG=demo node scripts/generate-clips-tts.mjs
//   # FORCE=1 overwrites clips that already exist
//   # TTS_MODEL=gpt-4o-mini-tts (default) | tts-1-hd
import { createClient } from '@supabase/supabase-js';

const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, TENANT_SLUG, FORCE, TTS_MODEL } = process.env;
if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TENANT_SLUG) {
    console.error('Set OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY and TENANT_SLUG.');
    process.exit(1);
}

const BUCKET = 'call-audio';
const MODEL = TTS_MODEL || 'gpt-4o-mini-tts';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data: tenant, error: tErr } = await supabase
    .from('tenants').select('id, name').eq('slug', TENANT_SLUG).single();
if (tErr || !tenant) {
    console.error(`tenant "${TENANT_SLUG}" not found: ${tErr?.message || 'no row'}`);
    process.exit(1);
}

const { data: pb, error: pErr } = await supabase
    .from('call_playbooks').select('id, voice, audio_base_path')
    .eq('tenant_id', tenant.id).eq('is_active', true).is('campaign_id', null).single();
if (pErr || !pb) {
    console.error(`active playbook for "${TENANT_SLUG}" not found: ${pErr?.message || 'no row'}`);
    process.exit(1);
}

const { data: clips, error: cErr } = await supabase
    .from('audio_clips').select('key, filename, text, source')
    .eq('playbook_id', pb.id).eq('active', true).order('sort_order');
if (cErr) { console.error(`clips read failed: ${cErr.message}`); process.exit(1); }

const base = (pb.audio_base_path || '').trim();
const voice = pb.voice || 'alloy';
console.log(`tenant=${tenant.name} voice=${voice} base="${base}" model=${MODEL} clips=${clips.length}`);

let made = 0, skipped = 0, failed = 0;
for (const c of clips) {
    if (!c.text) { console.log(`skip ${c.key} (no text)`); skipped++; continue; }
    const path = base ? `${base}/${c.filename}` : c.filename;

    if (!FORCE) {
        const { data: existing } = await supabase.storage.from(BUCKET).list(base || '', { search: c.filename });
        if (existing?.some((f) => f.name === c.filename)) { console.log(`skip ${path} (exists)`); skipped++; continue; }
    }

    try {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, voice, input: c.text, response_format: 'mp3' }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text().catch(() => '')}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const { error: upErr } = await supabase.storage
            .from(BUCKET).upload(path, buf, { contentType: 'audio/mpeg', upsert: true });
        if (upErr) throw new Error(`upload failed: ${upErr.message}`);
        console.log(`made ${c.key} -> ${path} (${buf.length} bytes)`);
        made++;
    } catch (err) {
        console.error(`FAILED ${c.key}: ${err.message}`);
        failed++;
    }
}

console.log(`\ndone: made=${made} skipped=${skipped} failed=${failed}`);
if (failed > 0) process.exit(1);
