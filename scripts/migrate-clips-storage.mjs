// One-time migration: move each tenant's clips from the call-audio bucket
// root into a per-tenant folder (call-audio/<audio_base_path>/<filename>) and
// optionally flip the bucket to private. The clip list is read from the DB so
// it always matches what the server expects.
//
// Run once (clips not yet served from per-tenant paths):
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/migrate-clips-storage.mjs
//   # add MAKE_PRIVATE=1 to also set the bucket to private:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... MAKE_PRIVATE=1 node scripts/migrate-clips-storage.mjs
//
// Idempotent: clips already in their tenant folder are skipped.
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, MAKE_PRIVATE } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.');
    process.exit(1);
}

const BUCKET = 'call-audio';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data: clips, error } = await supabase
    .from('audio_clips')
    .select('filename, call_playbooks(audio_base_path)');
if (error) {
    console.error('Failed to read audio_clips:', error.message);
    process.exit(1);
}

let moved = 0;
let skipped = 0;
let failed = 0;

for (const clip of clips) {
    const base = clip.call_playbooks?.audio_base_path?.trim();
    if (!base) { skipped++; continue; }            // tenant served from root — nothing to move
    if (clip.filename.includes('/')) { skipped++; continue; } // already namespaced

    const from = clip.filename;
    const to = `${base}/${clip.filename}`;

    const { error: mvErr } = await supabase.storage.from(BUCKET).move(from, to);
    if (!mvErr) {
        console.log(`moved  ${from} -> ${to}`);
        moved++;
        continue;
    }

    // move() failed — treat as success only if the file is already at the target.
    const { data: atTarget } = await supabase.storage
        .from(BUCKET)
        .list(base, { search: clip.filename });
    if (atTarget?.some((f) => f.name === clip.filename)) {
        console.log(`skip   already at ${to}`);
        skipped++;
    } else {
        console.error(`FAILED ${from} -> ${to}: ${mvErr.message}`);
        failed++;
    }
}

console.log(`\ndone: moved=${moved} skipped=${skipped} failed=${failed}`);

if (MAKE_PRIVATE === '1') {
    const { error: bErr } = await supabase.storage.updateBucket(BUCKET, { public: false });
    console.log(bErr ? `bucket privacy update FAILED: ${bErr.message}` : `bucket "${BUCKET}" set to private`);
}

if (failed > 0) process.exit(1);
