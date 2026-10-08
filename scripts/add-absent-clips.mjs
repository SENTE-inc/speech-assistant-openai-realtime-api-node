// 不在の流れの4本（voice-ai.js の ABSENT_CLIPS）を、1つの声セットに足す使い捨ての道具（2026-10-08 森さん FB）。
// 声セットの声（call_playbooks.voice_ai_voice_id）で ElevenLabs に作らせ、置き場（<audio_base_path>/<filename>）へ上げ、
// audio_clips に audio_ready=true で足す（false の行があると架電の関門で止まる）。既に在る行は飛ばす（FORCE=1 で作り直す）。
// 家＝~/sente/sente_aivoice_canonical.md §3「📐 実装の計画 v3」の 🎙。
// ⚠ 台本を作り直すと audio_clips は13本に入れ直される＝4本も消える（その声セットは今の流れ＝即終話に戻る）。
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... ELEVENLABS_API_KEY=... PLAYBOOK_ID=<uuid> node scripts/add-absent-clips.mjs
//   # DRY_RUN=1 で何を作るかだけ出す（ElevenLabs も DB も触らない）
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ELEVENLABS_API_KEY, PLAYBOOK_ID, FORCE, DRY_RUN } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !PLAYBOOK_ID || (!DRY_RUN && !ELEVENLABS_API_KEY)) {
    console.error('Set SUPABASE_URL, SUPABASE_SERVICE_KEY, PLAYBOOK_ID (and ELEVENLABS_API_KEY unless DRY_RUN=1).');
    process.exit(1);
}
// voice-ai.js は読み込んだ時に ELEVENLABS_API_KEY を読む＝env を確かめてから読む
const { ABSENT_CLIPS, elevenTts } = await import('../voice-ai.js');

const BUCKET = 'call-audio';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data: pb, error: pbErr } = await supabase.from('call_playbooks')
    .select('id, tenant_id, audio_base_path, voice_ai_voice_id, is_active').eq('id', PLAYBOOK_ID).maybeSingle();
if (pbErr || !pb) { console.error(`playbook ${PLAYBOOK_ID} not found: ${pbErr?.message || 'no row'}`); process.exit(1); }
if (!pb.voice_ai_voice_id) { console.error('この声セットには ElevenLabs の声（voice_ai_voice_id）がありません'); process.exit(1); }
const base = (pb.audio_base_path || '').trim();
if (!base) { console.error('audio_base_path が空です'); process.exit(1); }

const { data: have, error: hErr } = await supabase.from('audio_clips').select('key').eq('playbook_id', pb.id);
if (hErr) { console.error(`clips read failed: ${hErr.message}`); process.exit(1); }
const haveKeys = new Set((have || []).map((c) => c.key));
console.log(`playbook=${pb.id} active=${pb.is_active} voice=${pb.voice_ai_voice_id} base="${base}" clips=${haveKeys.size}`);

let made = 0, skipped = 0, failed = 0;
for (const [i, c] of ABSENT_CLIPS.entries()) {
    const exists = haveKeys.has(c.key);
    if (exists && !FORCE) { console.log(`skip ${c.key} (already exists)`); skipped++; continue; }
    const path = `${base}/${c.filename}`;
    if (DRY_RUN) { console.log(`would make ${c.key} → ${path}「${c.text}」`); continue; }
    try {
        const mp3 = await elevenTts(c.text, pb.voice_ai_voice_id);
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, mp3, { contentType: 'audio/mpeg', upsert: true });
        if (upErr) throw new Error(`upload: ${upErr.message}`);
        const row = {
            playbook_id: pb.id, tenant_id: pb.tenant_id, key: c.key, clip_type: 'response', filename: c.filename, text: c.text,
            source: 'elevenlabs', audio_ready: true, suppress_farewell: false, sort_order: 30 + i, active: true,
        };
        const { error: dbErr } = exists
            ? await supabase.from('audio_clips').update({ text: c.text, source: 'elevenlabs', audio_ready: true, updated_at: new Date().toISOString() }).eq('playbook_id', pb.id).eq('key', c.key)
            : await supabase.from('audio_clips').insert(row);
        if (dbErr) throw new Error(`clip row: ${dbErr.message}`);
        console.log(`made ${c.key} (${mp3.length} bytes) → ${path}`);
        made++;
    } catch (err) {
        console.error(`failed ${c.key}: ${err.message}`);
        failed++;
    }
}
console.log(`done: made=${made} skipped=${skipped} failed=${failed}`);
process.exit(failed ? 1 : 0);
