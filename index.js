import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import {
    hasSufficientTransferEvidence, buildClassifierPrompt, buildTranscriptionPrompt,
    classifierIntentNames, sanitizeClassifierResult,
    decideBeforeClassifier, decideAfterClassifier, normalizeSettings, settingsHash,
    decideFastHandover, decideAfterClassifierV2, decideHold, isWordless, decideAskedQuestion, isCourtesyOnly,
    isIncompleteUtterance, isFillerWordsOnly, isRepeatRequest, classifyAbsentReply, parseRecallAt, retryIntervalFor,
    matchHandover, firstMatch, NEGATIVE_RE, chooseAizuchi, thanksRestText, thanksConfig, thanksTargets, THANKS_KEY, THANKS_TEXT, restKeyOf, thanksClipFilename, pickupBeepToneRatio,
} from './transfer-logic.js';
import {
    existsSync,
    statSync,
    accessSync,
    mkdtempSync,
    writeFileSync,
    rmSync,
    constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Blob } from 'node:buffer';
import crypto from 'node:crypto';
import { registerVoiceAi, makeNameAudio, DECIDED_VOICE_BY_GENDER, ABSENT_CLIPS, elevenTts } from './voice-ai.js';

dotenv.config();

// ---------------------------------------------------------------------
// ffmpeg binary discovery + boot-time diagnostics
// ---------------------------------------------------------------------
const FFMPEG_PATH = ffmpegStatic || 'ffmpeg';
console.log(`[ffmpeg] ffmpeg-static resolved to: ${ffmpegStatic ?? '(null)'}`);
console.log(`[ffmpeg] using binary path: ${FFMPEG_PATH}`);

if (ffmpegStatic) {
    try {
        if (!existsSync(ffmpegStatic)) {
            console.error(`[ffmpeg] WARNING: binary does not exist at ${ffmpegStatic}`);
        } else {
            const st = statSync(ffmpegStatic);
            console.log(
                `[ffmpeg] binary stat: size=${st.size}, mode=${st.mode.toString(8)}, ` +
                    `isFile=${st.isFile()}`
            );
            try {
                accessSync(ffmpegStatic, fsConstants.X_OK);
                console.log('[ffmpeg] binary is executable');
            } catch (e) {
                console.error('[ffmpeg] WARNING: binary is NOT executable:', e.message);
            }
        }
    } catch (err) {
        console.error('[ffmpeg] binary check failed:', err);
    }
}

// Smoke-test ffmpeg at boot so we know it can run.
(() => {
    try {
        const proc = spawn(FFMPEG_PATH, ['-version']);
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.stderr.on('data', (d) => (err += d.toString()));
        proc.on('error', (e) => console.error('[ffmpeg] -version spawn error:', e));
        proc.on('close', (code) => {
            const firstLine = (out || err).split('\n')[0];
            console.log(`[ffmpeg] -version exit=${code}: ${firstLine}`);
        });
    } catch (e) {
        console.error('[ffmpeg] -version smoke-test threw:', e);
    }
})();

const {
    OPENAI_API_KEY,
    ANTHROPIC_API_KEY,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
} = process.env;

const PORT = process.env.PORT || 5050;

if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY');
    process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
    process.exit(1);
}
if (!TWILIO_AUTH_TOKEN) {
    // Required for webhook signature verification and recording intake.
    console.error('Missing TWILIO_AUTH_TOKEN');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// =====================================================================
// Audio assets
// =====================================================================

// Audio clips and the call script ("playbook") are loaded per-tenant from
// Supabase at call start (see loadPlaybook). Only the storage bucket name and
// a couple of process-wide constants live here now.
const AUDIO_BUCKET = 'call-audio';

let haiPatternIndex = 0; // filler rotation index; reset on each new Twilio call

const MAX_REPROMPTS = 2; // ask to repeat this many times, then end the call

// =====================================================================
// Call-termination thresholds and patterns
// =====================================================================

// Time-based limits
const SILENCE_TIMEOUT_MS = 30 * 1000;            // 30s of no user speech (while LISTENING) → hang up
const CALL_DURATION_TIMEOUT_MS = 5 * 60 * 1000;  // 5min hard cap on overall call length
const TIMEOUT_CHECK_INTERVAL_MS = 5 * 1000;      // poll the timers every 5s

// Loop detection
const LOOP_DECISION_THRESHOLD = 3;               // same Claude audio_key N times in a row
const LOOP_UTTERANCE_THRESHOLD = 3;              // N highly-similar user utterances in a row
const UTTERANCE_SIMILARITY = 0.8;                // ≥80% similar → counts as repeat

// Voicemail detection — immediate hang-up, no farewell. Used as a fallback
// when a tenant's playbook leaves voicemail_patterns unset.
const DEFAULT_VOICEMAIL_PATTERNS = [
    'ただいま電話に出ることができません',
    '録音させていただきます',
    'メッセージをどうぞ',
    '発信音の後にお話しください',
    '留守番電話',
];

// User explicit hang-up — play farewell then hang up, skip Claude. Fallback
// when a tenant's playbook leaves hangup_patterns unset.
const DEFAULT_HANGUP_PATTERNS = [
    '電話を切ります',
    '失礼します',
    'もう結構です',
];

// Levenshtein distance between two strings. Used by the loop detector
// to spot a caller repeating the same utterance over and over.
function levenshteinDistance(a, b) {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

function stringSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(a, b) / maxLen;
}

const audioCache = new Map(); // storage path -> mulaw Buffer

// Download a clip from the (private) call-audio bucket using the service key.
async function fetchClip(path) {
    const { data, error } = await supabase.storage.from(AUDIO_BUCKET).download(path);
    if (error || !data) {
        throw new Error(`storage download failed for ${path}: ${error?.message || 'no data'}`);
    }
    const buf = Buffer.from(await data.arrayBuffer());
    console.log(`[fetch] ${path} -> ${buf.length} bytes`);
    if (buf.length === 0) {
        throw new Error(`Downloaded clip is empty: ${path}`);
    }
    return buf;
}

// 先頭のバイトで形式を決める（レビュー F）＝アップロードされた何かを ffmpeg の自動判定に任せない。
// 声のファイルは TTS の mp3・画面が録音を直した wav・それ以前に録った肉声の m4a（名前は .mp3 のまま中身は
// `ftypM4A `＝2026-09-12 本番の使用中48本のうち22本・sente の肉声）の3つ。m4a を落とすと今の肉声が無音になる。
function detectAudioFormat(buf) {
    if (!buf || buf.length < 4) return null;
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'wav';
    if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4'; // m4a／mp4（ISO BMFF）
    if (buf.toString('latin1', 0, 3) === 'ID3') return 'mp3';
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG の frame sync
    return null;
}

// Convert MP3 buffer -> mulaw 8kHz mono by spawning ffmpeg directly.
// We MUST write to a temp file rather than stdin, because the MP3 demuxer
// needs to seek over ID3v2/VBR headers — which fails on a pipe with
// "Failed to read frame size: Could not seek to N. pipe:0: Invalid argument".
function convertMp3ToMulaw(mp3Buffer, label = '') {
    return new Promise((resolve, reject) => {
        if (!mp3Buffer || mp3Buffer.length === 0) {
            return reject(new Error(`[ffmpeg ${label}] input mp3 buffer is empty`));
        }
        const format = detectAudioFormat(mp3Buffer);
        if (!format) {
            return reject(new Error(`[ffmpeg ${label}] not an mp3/wav/m4a file; refusing to decode`));
        }

        let tmpDir;
        let tmpFile;
        try {
            tmpDir = mkdtempSync(join(tmpdir(), 'mp3conv-'));
            tmpFile = join(tmpDir, `in.${format}`);
            writeFileSync(tmpFile, mp3Buffer);
        } catch (err) {
            console.error(`[ffmpeg ${label}] tmp file write failed:`, err);
            return reject(err);
        }

        const cleanup = () => {
            try { rmSync(tmpDir, { recursive: true, force: true }); }
            catch (e) { console.error(`[ffmpeg ${label}] tmp cleanup error:`, e); }
        };

        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            // 入力は手元の1ファイルだけ・形式は先頭のバイトで決めた物に固定する
            '-protocol_whitelist', 'file',
            '-f', format,
            '-i', tmpFile,
            '-ar', '8000',
            '-ac', '1',
            '-acodec', 'pcm_mulaw',
            '-f', 'mulaw',
            'pipe:1',
        ];
        console.log(
            `[ffmpeg ${label}] spawn ${FFMPEG_PATH} input=${mp3Buffer.length} bytes ` +
                `tmp=${tmpFile}`
        );

        let proc;
        try {
            proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            console.error(`[ffmpeg ${label}] spawn threw:`, err);
            cleanup();
            return reject(err);
        }

        const outChunks = [];
        const errChunks = [];
        let settled = false;
        const settle = (fn, val) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(val);
        };

        proc.stdout.on('data', (c) => outChunks.push(c));
        proc.stderr.on('data', (c) => errChunks.push(c));

        proc.on('error', (err) => {
            console.error(`[ffmpeg ${label}] process error:`, err);
            settle(reject, err);
        });

        proc.on('close', (code, signal) => {
            const out = Buffer.concat(outChunks);
            const errText = Buffer.concat(errChunks).toString('utf8').trim();
            console.log(
                `[ffmpeg ${label}] exit code=${code} signal=${signal || 'none'} ` +
                    `output=${out.length} bytes${errText ? `\n[ffmpeg ${label} stderr] ${errText}` : ''}`
            );
            if (code !== 0) {
                return settle(reject, new Error(
                    `ffmpeg ${label} exited with code ${code}: ${errText || 'no stderr'}`
                ));
            }
            if (out.length === 0) {
                return settle(reject, new Error(
                    `ffmpeg ${label} produced 0 bytes: ${errText || 'no stderr'}`
                ));
            }
            settle(resolve, out);
        });
    });
}

// Resolve a clip (by its playbook key) to mulaw bytes, caching per storage
// path so tenants never collide. Clips live at <audio_base_path>/<filename>.
async function getAudioBuffer(cfg, key) {
    const clip = cfg.clips.get(key);
    if (!clip) throw new Error(`unknown clip key "${key}" for tenant ${cfg.tenantId}`);
    // fullPath＝声セットの外の音（CM の名前＝user_profiles.spoken_name_audio_path）
    const path = clip.fullPath || (cfg.audioBasePath ? `${cfg.audioBasePath}/${clip.filename}` : clip.filename);
    if (audioCache.has(path)) return audioCache.get(path);

    const mp3 = await fetchClip(path);
    const mulaw = await convertMp3ToMulaw(mp3, path);
    if (mulaw.length === 0) {
        throw new Error(`Converted mulaw is 0 bytes for ${path}`);
    }
    audioCache.set(path, mulaw);
    console.log(`[clip] ${key} (${path}): mp3=${mp3.length} -> mulaw=${mulaw.length} bytes`);
    return mulaw;
}

// --- Per-tenant playbook (script + clips + intents) ----------------------
const PLAYBOOK_TTL_MS = 5 * 60 * 1000;
const playbookCache = new Map(); // `${tenantId}:${projectId}:${gender}` -> { cfg, loadedAt }

// Drop every cached playbook of a tenant (tenant default and each operator's set).
function bustPlaybookCache(tenantId) {
    for (const key of [...playbookCache.keys()]) {
        if (key === tenantId || key.startsWith(`${tenantId}:`)) playbookCache.delete(key);
    }
}

// 声セットの選び方（作る順番の2番目・家 §3-3）＝その会社の担当 CM の声セットがあればそれ、
// 無ければテナントの既定。「AI が話していた声の本人につながる」ための前提。
// 声（台本）はプロジェクトに1セット（家 §3-3「🚀」④ の決定・Tom 2026-09-11）＝そのプロジェクトの台本 → 無ければテナント既定。
// CM ごとの台本（owner_user_id 入り）は引かない。
// 🆕 声セットはプロジェクト × CM の性別に1セット（Tom 2026-10-05「架電した CM の性別で AI の声を切り替える」＝
// 取次で出る CM と、受付が聞いた声の性別をそろえる）。DB＝call_playbooks.voice_gender（空＝性別なしのセット）。
// 同じ範囲（プロジェクト、無ければテナント既定）の中の順＝
//   ① CM と同じ性別で音声が揃ったセット → ② 性別なしで揃ったセット → ③ ほかの揃ったセット
//   → 揃ったセットが無ければ同じ順で最初の1本（関門 voiceSetGate が「未設定」で止める＝今までと同じ）
// ＝性別のセットを作り始めても、音声が揃うまでは今のセットで鳴り続ける。CM の居ない通話（受電・手動）は性別なし＝②が先。
// プロジェクトにセットが1本も無い時だけテナント既定へ（今までと同じ）。
const parseVoiceGender = (v) => (v === 'male' || v === 'female' ? v : null);

// 声セットの範囲（プロジェクト × 性別）で台本を絞る＝/provision-playbook・/clip-audio・voice-ai.js が同じ1本を使う
function scopePlaybookQuery(query, projectId, gender) {
    const q = projectId ? query.eq('project_id', projectId) : query.is('project_id', null);
    return gender ? q.eq('voice_gender', gender) : q.is('voice_gender', null);
}

// 音声の置き場＝<slug>（テナント既定）／<slug>/p-<project>（プロジェクト）＋性別のセットは /male・/female
// （同じファイル名の音が性別のセットどうしで上書きし合わないように）
function voiceSetBase(slug, projectId, gender) {
    const base = projectId ? `${slug}/p-${projectId}` : slug;
    return gender ? `${base}/${gender}` : base;
}

// 架電した CM の性別（user_profiles.gender）。読めなければ null＝性別なしと同じ扱い（通話は止めない）
async function operatorGender(userId) {
    if (!userId) return null;
    const { data, error } = await supabase.from('user_profiles').select('gender').eq('id', userId).maybeSingle();
    if (error) {
        console.error('[playbook] operator gender lookup failed:', error.message);
        return null;
    }
    return parseVoiceGender(data?.gender);
}

// CM の名前の音声（2026-10-07 Tom「アカウントが作られたタイミングで男女えらんで、そのタイミングで名前の音声作ればいいじゃん」）
//   名前（user_profiles.spoken_name）と性別の声で「◯◯と申します。」を1本作って持たせる＝名前か声が変わった時だけ作り直す
//   呼び手＝/cm-name（画面が名前を保存した時・招待を受けた時）と /dial-tick の関門（作り損ねの拾い）
const cmNameInflight = new Map(); // userId -> Promise（同じ CM を同時に2回作らない）
const cmNameVerified = new Map(); // Storage に実体が在ると確かめた path -> 時刻（10分は確かめ直さない）
const CM_NAME_VERIFY_TTL_MS = 10 * 60 * 1000;
async function nameAudioExists(path) {
    const at = cmNameVerified.get(path);
    if (at && Date.now() - at < CM_NAME_VERIFY_TTL_MS) return true;
    try {
        await fetchClip(path);
        cmNameVerified.set(path, Date.now());
        return true;
    } catch (err) {
        console.error(`[cm-name] audio missing at ${path}: ${err.message}`);
        return false;
    }
}
async function ensureCmNameAudio(userId) {
    if (!userId) return { ok: false, reason: 'no_user' };
    if (cmNameInflight.has(userId)) return cmNameInflight.get(userId);
    const p = (async () => {
        const { data: u, error } = await supabase
            .from('user_profiles')
            .select('id, tenant_id, gender, spoken_name, spoken_name_audio_path, spoken_name_audio_key')
            .eq('id', userId)
            .maybeSingle();
        if (error || !u) return { ok: false, reason: 'lookup_failed' };
        const gender = parseVoiceGender(u.gender);
        if (!u.spoken_name || !gender) return { ok: false, reason: 'no_name' };
        const audioKey = `${DECIDED_VOICE_BY_GENDER[gender]}|${u.spoken_name}`;
        // DB の path を鵜呑みにしない＝実体が消えていたら作り直す（2026-10-07 codex レビュー）
        if (u.spoken_name_audio_path && u.spoken_name_audio_key === audioKey && await nameAudioExists(u.spoken_name_audio_path)) {
            return { ok: true, path: u.spoken_name_audio_path, text: `${u.spoken_name}と申します。` };
        }
        const { data: t } = await supabase.from('tenants').select('slug').eq('id', u.tenant_id).maybeSingle();
        if (!t?.slug) return { ok: false, reason: 'no_tenant' };
        const { mp3 } = await makeNameAudio(u.spoken_name, gender);
        // 名前を変えるたびに別の path＝通話の音のキャッシュ（path が鍵）に古い名前が残らない
        const path = `${t.slug}/_names/${u.id}-${Date.now()}.mp3`;
        const { error: upErr } = await supabase.storage.from(AUDIO_BUCKET).upload(path, mp3, { contentType: 'audio/mpeg', upsert: false });
        if (upErr) throw new Error(`name audio upload failed: ${upErr.message}`);
        // 作っている間に名前が変わっていたら書かない（次の呼び出しで新しい名前を作る）
        const { data: upd, error: updErr } = await supabase
            .from('user_profiles')
            .update({ spoken_name_audio_path: path, spoken_name_audio_key: audioKey })
            .eq('id', u.id).eq('spoken_name', u.spoken_name).eq('gender', gender)
            .select('id');
        if (updErr || !upd?.length) {
            await supabase.storage.from(AUDIO_BUCKET).remove([path]).catch(() => {});
            return { ok: false, reason: updErr ? 'update_failed' : 'changed_meanwhile' };
        }
        // 前の名前の音は消さない＝通話中の電話がまだその path を流すことがある（数十 KB・2026-10-07 codex レビュー）
        cmNameVerified.set(path, Date.now());
        console.log(`[cm-name] made ${path}`);
        return { ok: true, path, text: `${u.spoken_name}と申します。` };
    })().catch((err) => {
        console.error('[cm-name] failed:', err.message || err);
        return { ok: false, reason: 'make_failed' };
    }).finally(() => cmNameInflight.delete(userId));
    cmNameInflight.set(userId, p);
    return p;
}

// 通話の声セットに CM の名前の音をのせる（name_lead が在る声セットだけ・キャッシュの cfg は他の通話と共有＝複製する）
function withCmName(cfg, name) {
    if (!cfg?.clips?.has('name_lead') || !name?.path) return cfg;
    const clips = new Map(cfg.clips);
    clips.set('cm_name', { key: 'cm_name', clip_type: 'response', filename: '', fullPath: name.path, text: name.text });
    return { ...cfg, clips };
}

async function resolvePlaybookRow(tenantId, projectId, gender = null) {
    const base = () => supabase
        .from('call_playbooks')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .is('campaign_id', null)
        .is('owner_user_id', null);
    const pick = async (rows) => {
        if (!rows.length) return null;
        const rank = (r) => {
            const g = parseVoiceGender(r.voice_gender);
            return gender && g === gender ? 0 : !g ? 1 : 2;
        };
        // 同じ順位どうしは 男性 → 女性 で固定（性別が未登録の CM で、鳴るセットが呼ぶたびに変わらないように）
        const tie = (r) => (r.voice_gender === 'male' ? 0 : r.voice_gender === 'female' ? 1 : 2);
        const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || tie(a) - tie(b) || String(a.id).localeCompare(String(b.id)));
        if (ordered.length === 1) return ordered[0];
        const { data: clips, error } = await supabase
            .from('audio_clips').select('playbook_id, audio_ready')
            .in('playbook_id', ordered.map((r) => r.id)).eq('active', true);
        if (error) {
            console.error('[playbook] clip readiness lookup failed:', error.message);
            return ordered[0];
        }
        const isReady = (id) => {
            const mine = (clips || []).filter((c) => c.playbook_id === id);
            return mine.length > 0 && mine.every((c) => c.audio_ready);
        };
        return ordered.find((r) => isReady(r.id)) || ordered[0];
    };
    if (projectId) {
        const pj = await base().eq('project_id', projectId);
        if (pj.error) return { data: null, error: pj.error };
        const row = await pick(pj.data || []);
        if (row) return { data: row, error: null };
    }
    const td = await base().is('project_id', null);
    if (td.error) return { data: null, error: td.error };
    return { data: await pick(td.data || []), error: null };
}

// Claude の分類プロンプトは transfer-logic.js の buildClassifierPrompt（設定が無い時は今のまま）。

async function loadPlaybook(tenantId, projectId = null, gender = null) {
    if (!tenantId) return null;
    const cacheKey = `${tenantId}:${projectId || ''}:${gender || ''}`;
    const cached = playbookCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < PLAYBOOK_TTL_MS) return cached.cfg;

    const { data: pb, error: pbErr } = await resolvePlaybookRow(tenantId, projectId, gender);
    if (pbErr || !pb) {
        console.error(
            `[playbook] load failed for tenant ${tenantId}: ${pbErr?.message || 'no active playbook'}`
        );
        return null;
    }

    const [clipsRes, intentsRes] = await Promise.all([
        supabase.from('audio_clips').select('*').eq('playbook_id', pb.id).eq('active', true).order('sort_order'),
        supabase.from('call_intents').select('*').eq('playbook_id', pb.id).eq('active', true).order('sort_order'),
    ]);

    const clips = new Map();
    const clipsByType = { greeting: [], response: [], filler: [], pardon: [], farewell: [] };
    for (const c of clipsRes.data || []) {
        clips.set(c.key, c);
        if (clipsByType[c.clip_type]) clipsByType[c.clip_type].push(c);
    }

    const intents = intentsRes.data || [];
    const cfg = {
        tenantId,
        playbookId: pb.id,
        companyName: pb.company_name,
        realtimeSystemMessage: pb.realtime_system_message,
        voice: pb.voice || 'shimmer',
        audioBasePath: (pb.audio_base_path || '').trim(),
        voicemailPatterns: pb.voicemail_patterns?.length ? pb.voicemail_patterns : DEFAULT_VOICEMAIL_PATTERNS,
        hangupPatterns: pb.hangup_patterns?.length ? pb.hangup_patterns : DEFAULT_HANGUP_PATTERNS,
        clips,
        greetingKey: clipsByType.greeting[0]?.key || null,
        farewellKey: clipsByType.farewell[0]?.key || null,
        fillerKeys: clipsByType.filler.map((c) => c.key),
        pardonKeys: clipsByType.pardon.map((c) => c.key),
        intents,
        intentByName: new Map(intents.map((i) => [i.name, i])),
    };
    cfg.classifierPrompt = buildClassifierPrompt(cfg);
    // 相づちの「ありがとうございます」＝声セットに在り、「ありがとうございます」で始まる台本の全部に頭を落とした方が揃った時だけ使う（揃わなければ「はい」のまま）
    Object.assign(cfg, thanksConfig(cfg.clips, pb.voice_ai_voice_id));

    // Vocabulary hint for STT — biases gpt-transcribe toward this tenant's
    // expected phrases so homophones (e.g. 代表/対象) resolve correctly.
    // Capped well under the model's ~244-token prompt budget.
    // Sample a couple of triggers per intent (not all of them) so the hint
    // stays balanced across outcomes. Otherwise the transfer intent's long
    // trigger list dominates and is then truncated at 240 chars, which both
    // biases STT toward transfer phrases and drops the 不在/断り/折り返し
    // keywords entirely — exactly the words we most need disambiguated.
    cfg.transcriptionPrompt = buildTranscriptionPrompt(pb.company_name, intents);

    playbookCache.set(cacheKey, { cfg, loadedAt: Date.now() });
    // 不在の流れの4本が欠けていれば、その声セットの声で作って足す（裏で・人の手を通さない＝2026-10-08 Tom「勝手に作成できるようにしたい」）
    // 相づちの「ありがとうございます」は不在の4本の後に作る（不在の「ありがとうございます。ちなみに…」の頭を落とした方も作る＝監査 2026-10-10）
    ensureAbsentClips(pb, cfg).catch((err) => console.error(`[absent-clips] ${pb.id} failed: ${err.message}`))
        .then(() => ensureThanksClips(pb))
        .catch((err) => console.error(`[thanks-clips] ${pb.id} failed: ${err.message}`));

    // Warm the clip cache in the background so the first call isn't slow.
    for (const key of cfg.clips.keys()) {
        getAudioBuffer(cfg, key).catch((err) =>
            console.error(`[playbook] warm ${key} failed: ${err.message}`)
        );
    }
    console.log(
        `[playbook] loaded tenant=${tenantId} clips=${cfg.clips.size} intents=${intents.length}`
    );
    return cfg;
}

// --- 取次のつまみ（transfer_settings）--------------------------------------
// 家＝~/sente/sfav_transfer_tuning_plan.md §1-a〜1-c。プロジェクトの行 → 会社の既定の行 → 無し（＝今の挙動）。
// 通話の始めに1回読み、その通話の間は固定。キャッシュは60秒＝保存から最大60秒後に始まる通話から効く。
const TRANSFER_SETTINGS_TTL_MS = 60 * 1000;
const TRANSFER_SETTINGS_LOAD_TIMEOUT_MS = 1500;
const transferSettingsCache = new Map(); // `${tenantId}:${projectId}` -> { ts, loadedAt }
const savedSnapshotHashes = new Set();

async function loadTransferSettings(tenantId, projectId = null) {
    if (!tenantId) return { ts: null, error: null };
    if (projectId && !/^[0-9a-f-]{36}$/i.test(String(projectId))) projectId = null;
    const cacheKey = `${tenantId}:${projectId || ''}`;
    const cached = transferSettingsCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < TRANSFER_SETTINGS_TTL_MS) return { ts: cached.ts, error: null };
    let q = supabase.from('transfer_settings').select('*').eq('tenant_id', tenantId);
    q = projectId ? q.or(`project_id.eq.${projectId},project_id.is.null`) : q.is('project_id', null);
    const { data, error } = await q;
    if (error) {
        // 表が無い（DB 140 の前）も読取の失敗も、今の挙動で動かす
        console.error('[transfer-settings] load failed; using the built-in behaviour:', error.message);
        return { ts: null, error };
    }
    const rows = data || [];
    const row = (projectId && rows.find((r) => r.project_id === projectId)) || rows.find((r) => !r.project_id) || null;
    const ts = normalizeSettings(row);
    if (ts) {
        ts.hash = settingsHash(ts);
        // 中身の控え＝鍵は（会社, hash）。2社が同じ中身でも、それぞれの会社から読めるように
        const snapKey = `${tenantId}:${ts.hash}`;
        if (!savedSnapshotHashes.has(snapKey)) {
            savedSnapshotHashes.add(snapKey);
            supabase.from('transfer_settings_snapshots')
                .upsert({ tenant_id: tenantId, hash: ts.hash, settings: { ...ts, hash: undefined } },
                    { onConflict: 'tenant_id,hash', ignoreDuplicates: true })
                .then(({ error: e }) => { if (e) { savedSnapshotHashes.delete(snapKey); console.error('[transfer-settings] snapshot save failed:', e.message); } })
                .catch((e) => { savedSnapshotHashes.delete(snapKey); console.error('[transfer-settings] snapshot threw:', e); });
        }
    }
    transferSettingsCache.set(cacheKey, { ts, loadedAt: Date.now() });
    return { ts, error: null };
}

// =====================================================================
// Audio helpers (μ-law decode, VAD, WAV header)
// =====================================================================

function muLawDecode(byte) {
    const u = ~byte & 0xff;
    const sign = u & 0x80 ? -1 : 1;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const sample = ((mantissa << 3) + 0x84) << exponent;
    return sign * (sample - 0x84);
}

function calculateRms(mulawBytes) {
    if (mulawBytes.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < mulawBytes.length; i++) {
        const s = muLawDecode(mulawBytes[i]);
        sum += s * s;
    }
    return Math.sqrt(sum / mulawBytes.length);
}

function mulawToWav(mulawBuffer) {
    const pcm = Buffer.alloc(mulawBuffer.length * 2);
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm.writeInt16LE(muLawDecode(mulawBuffer[i]), i * 2);
    }
    const sampleRate = 8000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcm.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
}

// =====================================================================
// Whisper transcription
// =====================================================================

// 文字起こし＝{ ok, text }（ok=false＝API の失敗）。保留音の判定は「失敗」を「言葉なし」に数えない（障害で CM を呼ばない）
async function transcribeDetailed(mulawBuffer, prompt) {
    try {
        const text = await transcribeWhisperRaw(mulawBuffer, prompt);
        return text === undefined ? { ok: false, text: null } : { ok: true, text };
    } catch (err) {
        console.error('[stt] error:', err?.message || err);
        return { ok: false, text: null };
    }
}

// 話している最中から文字起こしを流す口（通話ごとに1本・2026-10-10 Tom「じゃあ0.8秒で」）。
//   ファイルの文字起こしは言い終わってから音を送るので約1秒かかる（試しの架電で閉じてから 1.03秒）。
//   こちらは発話の音を 20ms ずつ流しておき、無音 0.3秒で区切る（commit）＝区切ってから 0.5〜0.6秒で文字がそろう（日本からの実測）。
//   使えない時（つながっていない・設定が通る前・音が欠けた・時間切れ・失敗）は { ok:false } を返す＝呼び手がファイルの文字起こしに戻す。
//   おかしな事（error・時間切れ）が1回でもあれば、その通話では閉じて以後はファイルだけ（commit と結果の対応がずれると別の発話の文字を返すため＝codex 監査）
const LIVE_STT_MODEL = 'gpt-live-transcribe';
const LIVE_STT_TIMEOUT_MS = 2500;
function createLiveStt(prompt) {
    let ws = null;
    let open = false;   // session.updated まで来た（設定が通った）
    let intact = true;  // 区切りの間の音を全部送れたか（つながる前・切れた後に落とした音があれば false）
    let bytes = 0;
    const queue = [];   // commit した順の resolve（committed の item_id と結ぶ）
    const byItem = new Map();
    const settle = (resolve, r) => { try { resolve(r); } catch (_) {} };
    const failAll = (why) => {
        if (queue.length || byItem.size) console.log(`[live-stt] dropping ${queue.length + byItem.size} pending (${why})`);
        for (const r of queue.splice(0)) settle(r, { ok: false });
        for (const r of byItem.values()) settle(r, { ok: false });
        byItem.clear();
    };
    const send = (obj) => { if (open && ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; } return false; };
    const kill = (why) => {
        if (open) console.log(`[live-stt] closed for this call (${why}); file transcription from now on`);
        open = false;
        failAll(why);
        try { ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); } catch (_) {}
    };
    try {
        ws = new WebSocket(`${process.env.OPENAI_WSS_BASE || 'wss://api.openai.com'}/v1/realtime?intent=transcription`, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    } catch (err) {
        console.error('[live-stt] connect failed:', err?.message || err);
        return null;
    }
    ws.on('open', () => {
        intact = false; // 設定が通る前の音は送れていない＝次の発話の始めから使う
        const transcription = { model: LIVE_STT_MODEL, languages: ['ja'] };
        if (prompt) transcription.prompt = prompt;
        ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcmu' }, transcription, turn_detection: null } } } }));
    });
    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        if (m.type === 'session.updated') {
            if (!open) console.log('[live-stt] ready');
            open = true;
        } else if (m.type === 'input_audio_buffer.committed') {
            const r = queue.shift();
            if (r) byItem.set(m.item_id, r);
        } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
            const r = byItem.get(m.item_id);
            if (r) { byItem.delete(m.item_id); settle(r, { ok: true, text: String(m.transcript || '').trim() }); }
        } else if (m.type === 'conversation.item.input_audio_transcription.failed') {
            const r = byItem.get(m.item_id);
            if (r) { byItem.delete(m.item_id); settle(r, { ok: false }); }
            console.error('[live-stt] transcription failed:', m.error?.message || '');
        } else if (m.type === 'error') {
            console.error('[live-stt] error:', m.error?.code || '', m.error?.message || '');
            kill('error');
        }
    });
    ws.on('close', () => kill('closed'));
    ws.on('error', (err) => { console.error('[live-stt] ws error:', err?.message || err); kill('ws error'); });
    return {
        // 発話の始め＝前の区切りの残りを捨てて、この発話の音（先読み込み）から送り直す
        start(audio) {
            if (!send({ type: 'input_audio_buffer.clear' })) { intact = false; return; }
            intact = true;
            bytes = 0;
            this.append(audio);
        },
        append(audio) {
            if (!audio?.length) return;
            if (!send({ type: 'input_audio_buffer.append', audio: audio.toString('base64') })) { intact = false; return; }
            bytes += audio.length;
        },
        // 区切る＝ここまでの音の文字起こしを待つ。使えない時は即 { ok:false }
        commit() {
            if (!intact || bytes < 800 || !send({ type: 'input_audio_buffer.commit' })) return Promise.resolve({ ok: false });
            bytes = 0;
            intact = false; // 次の start まで追記しない
            return new Promise((resolve) => {
                let done = false;
                const once = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
                const timer = setTimeout(() => { once({ ok: false }); kill('timed out'); }, LIVE_STT_TIMEOUT_MS);
                queue.push(once);
            });
        },
        close() { kill('call ended'); },
    };
}

async function transcribeWhisper(mulawBuffer, prompt) {
    const text = await transcribeWhisperRaw(mulawBuffer, prompt);
    return text === undefined ? null : text;
}

// 戻り値＝文字列（空なら null）／失敗は undefined
async function transcribeWhisperRaw(mulawBuffer, prompt) {
    const wav = mulawToWav(mulawBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    // 2026-08-27: gpt-4o-transcribe → gpt-transcribe（ファイル文字起こしの現行推奨・2026-07-28）
    formData.append('model', 'gpt-transcribe');
    formData.append('language', 'ja');
    // Bias toward the tenant's expected vocabulary (company name + intent
    // trigger phrases) so homophones like 代表/対象 resolve correctly.
    if (prompt) formData.append('prompt', prompt);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: formData,
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('Whisper error:', res.status, txt);
        return undefined;
    }
    const data = await res.json();
    return (data?.text || '').trim() || null;
}

// =====================================================================
// Claude intent classifier
// =====================================================================

// The classifier prompt is generated per-tenant from call_intents at call
// start; see buildClassifierPrompt() / loadPlaybook().

async function classifyWithClaude(transcript, ctx = {}, prompt) {
    const contextLine = [
        ctx.company ? `架電先会社: ${ctx.company}` : null,
        ctx.contact ? `担当者: ${ctx.contact}` : null,
    ]
        .filter(Boolean)
        .join(' / ');

    const baseMessage = contextLine
        ? `[文脈] ${contextLine}\n[発話] ${transcript}`
        : transcript;
    // 待機中（受付に保留にされた後）の発話＝プロンプトの wait の判断文が読む（設定が在る通話だけ）
    const userMessage = ctx.afterHold ? `[状況] 保留の後に電話に出た人の発言\n${baseMessage}` : baseMessage;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            // Haiku 5.5（2026-10-08〜）＝prefill を 400 で弾く・思考は既定で入る＝思考を切り、JSON はプロンプトの指示で返させる
            // （json_schema で縛ると 0.6秒遅い＝試験 scripts/transfer-bench/model-bench.mjs の haiku55_plain が本番の形）
            const message = await anthropic.messages.create({
                model: 'claude-haiku-5-5',
                max_tokens: 200,
                thinking: { type: 'disabled' },
                system: [
                    {
                        type: 'text',
                        text: prompt,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: [{ role: 'user', content: userMessage }],
            });

            const raw = (message.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start < 0 || end < 0) throw new Error('No JSON found');
            const parsed = JSON.parse(raw.slice(start, end + 1));
            if (!parsed.intent) throw new Error('Missing intent');
            // 一覧に無い intent は信じない（監査 Low 6）＝null にして呼び手の「知らない intent」の道へ
            const clean = sanitizeClassifierResult(parsed, ctx.validIntents);
            if (clean.reason === 'invalid_intent') {
                console.log(`[claude] intent not in playbook ("${clean.raw_intent}"); treating as unknown`);
            }
            return clean;
        } catch (err) {
            const isOverloaded = err?.status === 529;
            if (isOverloaded && attempt < MAX_ATTEMPTS) {
                const waitMs = 1000 * attempt;
                console.log(`[claude] overloaded, retry ${attempt}/${MAX_ATTEMPTS} in ${waitMs}ms`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                continue;
            }
            console.error('Claude classification error:', err);
            return {
                intent: null,
                reason: 'classifier_error',
            };
        }
    }
}

// =====================================================================
// Deterministic transfer guard (review finding #12)
// =====================================================================
// The classifier prompt already says "only transfer on explicit evidence",
// but that is prompt-only and can mis-fire on naked filler ("はい" / "お待たせ"
// / "すいません" / "もしもし"). This is a hard, code-side gate applied right
// before we actually hand the call to a human: it rejects very short /
// filler-only utterances and requires explicit transfer-request OR
// responsible-person evidence in the transcript. Conservative by design — when
// in doubt it returns false so we reprompt instead of wrongly transferring.

// 関門の本体（TRANSFER_FILLER_ONLY・TRANSFER_EVIDENCE_PATTERNS・hasSufficientTransferEvidence）は
// transfer-logic.js へ移した＝試験 scripts/transfer-bench/ が同じ物を import する（2026-10-05）。

// 日本の番号だけにかける（レビュー C2）＝国外・高額番号へ SENTE の Twilio で発信しない。
// 0990（ダイヤルQ2）・0570（ナビダイヤル）・0180（テレドーム）は掛けた側に課金される番号＝かけない（監査 2026-10-09）。
const PREMIUM_JP_PREFIX = /^\+81(990|570|180)/;
const isJapaneseE164 = (p) => {
    const s = String(p || '');
    return /^\+81\d{9,10}$/.test(s) && !PREMIUM_JP_PREFIX.test(s);
};
// ログに電話番号を出さない（レビュー D1）＝末尾4桁だけ。
const maskPhone = (p) => {
    const s = String(p || '');
    return s.length > 4 ? `***${s.slice(-4)}` : (s ? '***' : '');
};

// =====================================================================
// Twilio REST: hand off the live call to a human agent
// =====================================================================

async function transferCall(callSid, agentPhone) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured');
    }
    // 担当者の番号は TwiML に埋める＝日本の番号でなければつながない・エスケープする（レビュー C2・F）
    if (!isJapaneseE164(agentPhone)) {
        throw new Error('agent phone is not a Japanese number');
    }
    const url =
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const twiml = `<Response><Dial>${xmlEsc(agentPhone)}</Dial></Response>`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Twiml: twiml }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Twilio transfer failed: ${res.status} ${text}`);
    }
    console.log(`✓ Call transferred to ${maskPhone(agentPhone)} (callSid=${callSid})`);
}

// =====================================================================
// 取次＝保留音 → 空いている CM のブラウザ（作る順番の2番目・家 §3-2）
// =====================================================================
// 相手の通話は <Enqueue>（保留音）に移し、CM のブラウザ（Twilio Voice SDK）へ
// 別の1本を鳴らして <Dial><Queue> でつなぐ。10秒出なければその CM を離席にして次の人へ。
// 誰もいなければ「改めてご連絡いたします」の録音を流して切り、要再架電を付ける。
// 既定は Twilio の保留音を https で（監査）＝バケット名に「.」が入るので仮想ホスト形式の https は証明書が合わない。
// パス形式（s3.amazonaws.com/<bucket>/…）なら https で同じ物（ETag 一致・2026-10-09 確認）が返る。
const HOLD_MUSIC_URL = process.env.HOLD_MUSIC_URL
    || 'https://s3.amazonaws.com/com.twilio.sounds.music/MARKOVICHAMP-Borghestral.mp3';
const AGENT_RING_TIMEOUT_S = parseInt(process.env.AGENT_RING_TIMEOUT_S || '10', 10);
// 保留の上限（秒・レビュー C4）＝超えたら保留から出して「改めてご連絡いたします」で切る。
// 保留音を1曲ごとに取りに来させてここで見る＝エンジンが再起動して handoffs が消えても止まる。
const HOLD_MAX_SECONDS = parseInt(process.env.HOLD_MAX_SECONDS || '120', 10);
const PER_OPERATOR_CONCURRENCY = parseInt(process.env.PER_OPERATOR_CONCURRENCY || '3', 10);
// まだかける会社（未通電・担当者不在）を次にかけるまでの間（作る順番の3番目）。
const RETRY_AFTER_HOURS = parseInt(process.env.RETRY_AFTER_HOURS || '24', 10);

// call_sessions.metadata に足して書く（丸ごと置き換えない）＝callback_info と recall_at（再コールの日時）。result も一緒に書ける
async function mergeSessionMetadata(callSid, patch, result = null) {
    if (!callSid) return;
    const { data, error } = await supabase.from('call_sessions').select('metadata').eq('call_sid', callSid).maybeSingle();
    if (error) { console.error('[metadata] read failed:', error.message); return; }
    const update = { metadata: { ...(data?.metadata || {}), ...patch } };
    if (result) update.result = result;
    const { error: upErr } = await supabase.from('call_sessions').update(update).eq('call_sid', callSid);
    if (upErr) console.error('[metadata] update failed:', upErr.message);
    else console.log(`[metadata] saved ${Object.keys(patch).join(',')}${result ? ` result=${result}` : ''}`);
}
const HANDOFF_TTL_MS = 15 * 60 * 1000;
const handoffs = new Map(); // prospect callSid -> { tenantId, projectId, agentId, agentCallSid, excluded, baseUrl, clipPath, createdAt }

// ブラウザ側の識別子（ダッシュボードの /api/voice-token と同じ規則）。英数字だけにする。
const agentIdentity = (userId) => `cm_${String(userId).replace(/[^0-9a-zA-Z]/g, '')}`;
const queueName = (callSid) => `h-${callSid}`;
const xmlEsc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function registerHandoff(callSid, h) {
    const now = Date.now();
    for (const [sid, v] of handoffs) {
        if (now - v.createdAt > HANDOFF_TTL_MS) handoffs.delete(sid);
    }
    handoffs.set(callSid, { ...h, createdAt: now });
}

function forgetHandoff(callSid) {
    handoffs.delete(callSid);
}

async function twilioApi(path, form) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured');
    }
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    // 応答が無いまま待たない（取次の切り替え中は終了の処理が手を出さない＝ここで止まると通話が止まったままになる）
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${path}`, {
        method: form ? 'POST' : 'GET',
        headers: {
            Authorization: `Basic ${auth}`,
            ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(TWILIO_API_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio ${path} ${res.status}: ${JSON.stringify(data)}`);
    return data;
}

const TWILIO_API_TIMEOUT_MS = 10 * 1000;
const updateLiveCall = (callSid, twiml) => twilioApi(`/Calls/${callSid}.json`, { Twiml: twiml });

// action＝保留から出た時（上限の <Leave/>・CM との通話の後）に Twilio が取りに来る＝/queue-exit
const enqueueTwiml = (baseUrl, callSid) =>
    `<Response><Enqueue action="${xmlEsc(`${baseUrl}/queue-exit`)}" method="POST" ` +
    `waitUrl="${xmlEsc(`${baseUrl}/hold-music`)}" waitUrlMethod="POST">${queueName(callSid)}</Enqueue></Response>`;

async function claimAgent(projectId, preferred, exclude) {
    const { data, error } = await supabase.rpc('claim_agent_for_handoff', {
        p_project: projectId,
        p_preferred: preferred || null,
        p_exclude: exclude || [],
    });
    if (error) throw new Error(error.message);
    return data || null;
}

async function setAgentState(userId, callState) {
    if (!userId) return;
    const { error } = await supabase.rpc('set_agent_state', { p_user: userId, p_state: callState });
    if (error) console.error(`[handoff] set_agent_state(${callState}) failed:`, error.message);
}

// Ring the claimed CM's browser. When they answer, /agent-bridge joins them to the queue.
async function dialAgent(prospectSid, agentId) {
    const h = handoffs.get(prospectSid);
    if (!h) throw new Error('handoff not found');
    const qs = new URLSearchParams({ prospect: prospectSid });
    h.agentId = agentId;
    const call = await twilioApi('/Calls.json', {
        To: `client:${agentIdentity(agentId)}`,
        From: TWILIO_FROM_NUMBER,
        Url: `${h.baseUrl}/agent-bridge?${qs}`,
        Timeout: String(AGENT_RING_TIMEOUT_S),
        StatusCallback: `${h.baseUrl}/agent-status?${qs}`,
        StatusCallbackMethod: 'POST',
    });
    h.agentCallSid = call.sid;
    console.log(`[handoff] ringing CM ${agentId} for ${prospectSid} (agent leg ${call.sid})`);
}

// 「改めてご連絡いたします」を流して切る TwiML を作り、要再架電の印（result=overflow_recall）を付ける。
// finishOverflow（保留中の相手を REST で切り替える）と /queue-exit（保留から出た相手に返す）の共通部分。
// 印は「取次の途中（result が transferred か空・誰も取っていない）」の時だけ＝別の結果を上書きしない。
async function buildOverflow(prospectSid, clipPath) {
    let twiml = '<Response><Hangup/></Response>';
    if (clipPath) {
        const { data } = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(clipPath, 300);
        if (data?.signedUrl) twiml = `<Response><Play>${xmlEsc(data.signedUrl)}</Play><Hangup/></Response>`;
    }
    const { error } = await supabase
        .from('call_sessions')
        .update({ result: 'overflow_recall' })
        .eq('call_sid', prospectSid)
        .is('handled_by', null)
        .or('result.is.null,result.eq.transferred');
    if (error) console.error('[handoff] overflow result update failed:', error.message);
    return twiml;
}

// 再起動で handoffs が消えた時の「改めてご連絡いたします」＝通話の行からプロジェクトの台本を引き直す。
async function callbackClipPathFor(prospectSid) {
    const { data: s } = await supabase
        .from('call_sessions')
        .select('tenant_id, project_id, operator_id')
        .eq('call_sid', prospectSid)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (!s?.tenant_id) return null;
    // 受付が聞いていた声と同じセット＝架電した CM の性別で選ぶ（Tom 2026-10-05）
    const { data: pb } = await resolvePlaybookRow(s.tenant_id, s.project_id || null, await operatorGender(s.operator_id));
    if (!pb) return null;
    const { data: clip } = await supabase
        .from('audio_clips')
        .select('filename, audio_ready')
        .eq('playbook_id', pb.id)
        .eq('key', 'callback_request')
        .eq('active', true)
        .maybeSingle();
    if (!clip?.audio_ready) return null;
    const base = (pb.audio_base_path || '').trim();
    return base ? `${base}/${clip.filename}` : clip.filename;
}

// Nobody can take the call: play 「改めてご連絡いたします」 to the waiting caller, hang up,
// and leave 要再架電 (the call-status handler reads result=overflow_recall).
async function finishOverflow(prospectSid) {
    const h = handoffs.get(prospectSid);
    // /queue-exit が先に片付けていれば何もしない（二重に流さない）
    if (!h || h.finished) return;
    h.finished = true;
    const twiml = await buildOverflow(prospectSid, h.clipPath);
    try {
        await updateLiveCall(prospectSid, twiml);
    } catch (err) {
        console.error('[handoff] could not end the waiting caller:', err);
    }
    forgetHandoff(prospectSid);
}

// The CM did not pick up (or the leg failed): mark them 離席 (10秒ルール) and try the next
// free CM in the same project while the caller is still waiting.
async function onAgentLegFailed(prospectSid, { markAway, agentId } = {}) {
    const h = handoffs.get(prospectSid);
    // /queue-exit か finishOverflow がもう片付けている＝その CM は向こうで空きに戻した（二重に動かない）
    if (!h || h.finished) return;
    const failedAgent = agentId || h.agentId;
    await setAgentState(failedAgent, markAway ? 'away' : 'idle');
    if (failedAgent) h.excluded.push(failedAgent);
    h.agentId = null;
    h.agentCallSid = null;

    let waiting = false;
    try {
        const c = await twilioApi(`/Calls/${prospectSid}.json`);
        waiting = ['queued', 'ringing', 'in-progress'].includes(c.status);
    } catch (err) {
        console.error('[handoff] could not read the caller status:', err);
    }
    if (!waiting) {
        forgetHandoff(prospectSid);
        return;
    }
    if (h.finished) return; // 上の await の間に /queue-exit が片付けた

    // 保留の上限（レビュー C4）＝保留音の曲の変わり目を待たず、次の CM を探す前にもここで見る
    if (Date.now() - h.createdAt > HOLD_MAX_SECONDS * 1000) {
        console.log(`[handoff] ${prospectSid} on hold > ${HOLD_MAX_SECONDS}s; not ringing another CM`);
        await finishOverflow(prospectSid);
        return;
    }

    let next = null;
    try {
        next = await claimAgent(h.projectId, null, h.excluded);
    } catch (err) {
        console.error('[handoff] claim next agent failed:', err);
    }
    if (!next) {
        await finishOverflow(prospectSid);
        return;
    }
    try {
        await dialAgent(prospectSid, next);
    } catch (err) {
        console.error('[handoff] could not ring the next CM:', err);
        await setAgentState(next, 'idle');
        await finishOverflow(prospectSid);
    }
}

// =====================================================================
// Concurrent-call transfer lock
// =====================================================================
// When multiple calls run in parallel for the same operator, only one
// can be handed off at a time. The lock is keyed by tenant + agent
// phone so each operator has their own slot. Entries auto-expire after
// LOCK_TTL_MS so a crashed/stuck call cannot block the operator forever.
// key: `${tenantId}:${agentPhone}` -> { lockedAt, callSid }
const transferLocks = new Map();
const LOCK_TTL_MS = 60_000;

function acquireTransferLock(tenantId, agentPhone, callSid) {
    const key = `${tenantId}:${agentPhone}`;
    const existing = transferLocks.get(key);
    const now = Date.now();
    if (existing && now - existing.lockedAt < LOCK_TTL_MS) {
        console.log(`[lock] transfer blocked for ${tenantId}:${maskPhone(agentPhone)} (held by ${existing.callSid})`);
        return false;
    }
    transferLocks.set(key, { lockedAt: now, callSid });
    console.log(`[lock] transfer acquired for ${tenantId}:${maskPhone(agentPhone)} by ${callSid}`);
    return true;
}

function releaseTransferLock(tenantId, agentPhone) {
    const key = `${tenantId}:${agentPhone}`;
    transferLocks.delete(key);
    console.log(`[lock] transfer released for ${tenantId}:${maskPhone(agentPhone)}`);
}

// =====================================================================
// Fastify app
// =====================================================================

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Twilio に渡す URL の元（レビュー F）＝env PUBLIC_BASE_URL があればそれ、無ければ今どおり Host ヘッダ。
// 署名の検証は Twilio が実際に叩いた URL（Host）で行う＝ここは変えない。
// 形は https://<host> だけ（パス付き・http は使わず、警告を出して今どおり Host にする）。
const PUBLIC_BASE_URL = (() => {
    const raw = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (!/^https:\/\/[^/]+$/.test(raw)) {
        console.warn('[config] PUBLIC_BASE_URL is not "https://<host>"; ignoring it (using the Host header)');
        return '';
    }
    return raw;
})();
const publicBaseUrl = (host) => PUBLIC_BASE_URL || `https://${host}`;

// Public liveness endpoints. Kept intentionally minimal — no architecture
// details, build info, env, or tenant data — so they leak nothing to an
// unauthenticated caller while still serving uptime checks / load balancers.
fastify.get('/', async (_req, reply) => {
    reply.send({ status: 'ok' });
});

fastify.get('/health', async (_request, reply) => {
    return {
        status: 'ok',
        uptime: Math.round(process.uptime()),
    };
});

// =====================================================================
// Tenant playbook provisioning (self-serve onboarding)
// ---------------------------------------------------------------------
// Receives a tenant's script texts from the dashboard, (re)creates the
// playbook + clips + intents, then synthesizes each clip with OpenAI TTS
// and uploads it to the call-audio bucket. The per-tenant script only
// varies the clip TEXT and a couple of playbook fields — the structure
// (clip keys/types/filenames and the intent set) is fixed here so the
// dashboard form stays simple. Protected by a shared secret header.
// =====================================================================

const PROVISION_SECRET = process.env.PROVISION_SECRET || '';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';

// Constant-time verification of the x-provision-secret header. Fails closed
// when PROVISION_SECRET is unset/empty. Both sides are SHA-256-hashed to a
// fixed length before timingSafeEqual so the comparison is always over
// equal-length buffers (never throws) and never leaks the secret's length.
function verifyProvisionSecret(req) {
    if (!PROVISION_SECRET) return false; // fail closed if not configured
    const provided = req.headers['x-provision-secret'];
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const a = crypto.createHash('sha256').update(provided, 'utf-8').digest();
    const b = crypto.createHash('sha256').update(PROVISION_SECRET, 'utf-8').digest();
    return crypto.timingSafeEqual(a, b);
}

// Structural template. `key` is the contract with the dashboard setup form,
// which supplies the text for each key. Mirrors the proven demo/sente layout.
const CLIP_TEMPLATE = [
    // 名乗りは CM 本人の名前（2026-10-07 Tom）＝あいさつ＝name_lead（「お世話になっております。◯◯の」）→ CM の名前の音声 → greeting（用件〜取次の頼み）
    //   name_lead が在る声セットだけ名前をつなぐ（無い声セット＝それまでの形＝greeting 1本で名乗りまで言う）
    { key: 'name_lead',        clip_type: 'response', filename: '00_name_lead.mp3',        sort_order: 0 },
    { key: 'greeting',         clip_type: 'greeting', filename: '01_greeting.mp3',         sort_order: 1 },
    { key: 'reason',           clip_type: 'response', filename: '04_reason.mp3',           sort_order: 2 },
    // 社名と担当は1本（D8）＝「社名は？」「どなたですか？」の両方にこれで答える（name_lead の声セットでは後ろに CM の名前をつなぐ）
    { key: 'company',          clip_type: 'response', filename: '05_company.mp3',          sort_order: 3 },
    // 受付の答え2本（2026-10-07 Tom「1足す」）＝宛先を聞かれた／資料を送ってと言われた（送付先は CM が伺う＝then_agent）
    { key: 'addressee',        clip_type: 'response', filename: '06_addressee.mp3',        sort_order: 4 },
    { key: 'send_material',    clip_type: 'response', filename: '08_send_material.mp3',    sort_order: 10 },
    { key: 'appointment',      clip_type: 'response', filename: '07_appointment.mp3',      sort_order: 5 },
    { key: 'transfer_success', clip_type: 'response', filename: '09_transfer_success.mp3', sort_order: 6 },
    { key: 'callback_request', clip_type: 'response', filename: '11_callback_request.mp3', sort_order: 7 },
    { key: 'sorry_disturb',    clip_type: 'response', filename: '15_sorry_disturb.mp3',    sort_order: 8, suppress_farewell: true },
    // 相づち・聞き返しは1本ずつ（D8）＝fillerKeys／pardonKeys は1本でも回る
    { key: '16a_hai',          clip_type: 'filler',   filename: '16a_hai.mp3',             sort_order: 9 },
    { key: '22a_pardon',       clip_type: 'pardon',   filename: '22a_pardon.mp3',          sort_order: 11 },
    { key: 'farewell',         clip_type: 'farewell', filename: '21_farewell.mp3',         sort_order: 13 },
];

// 不在の流れの4本＝voice-ai.js の ABSENT_CLIPS（4本とも在る声セットだけ「戻りの時間を聞く」流れ）
const ABSENT_KEYS = ABSENT_CLIPS.map((c) => c.key);

// 声セットを読んだ時に、不在の4本が欠けていれば ElevenLabs でその声セットの声（voice_ai_voice_id）で作り、置き場へ上げ、
// audio_clips に audio_ready=true で足す（音を上げた後に行を足す＝欠けた行で架電の関門を止めない）。台本の作り直しで消えても次の読み込みで戻る。
// ElevenLabs の声が無い声セット（肉声だけ等）は作らない＝今の流れ（辞去で終話）のまま。失敗したらその声セットは1時間おく。
// 4本で約150字・声セットごとに1回（ElevenLabs の月の上限の数には入れない）。家＝~/sente/sente_aivoice_canonical.md §3「📐 実装の計画 v3」
const absentClipsTried = new Map(); // playbookId -> 次に試してよい時刻
// 相づちの「ありがとうございます」（2026-10-10 Tom「本番にgo」・森さん「ありがとうございます。でもいいかもね」）
//   aizuchi_thanks＝「ありがとうございます。」1本と、「ありがとうございます」で始まる台本ごとに頭を落とした方（<key>__rest）を
//   声セットの ElevenLabs の声で作って足す（不在の4本と同じ作り）。相づちとその声セットの台本が ElevenLabs の声の物だけ（肉声・別の声に混ぜない）。
//   台本の文が変わったら頭を落とした方も作り直す（文を比べる）。家＝~/sente/sfav_transfer_tuning_plan.md「相づち」
const thanksClipsBusy = new Set(); // playbookId＝作っている最中（同じプロセスで重ねない）
const thanksClipsFailedAt = new Map(); // playbookId -> 失敗した時刻（失敗した時だけ1時間おく）
async function ensureThanksClips(pb) {
    if (!process.env.ELEVENLABS_API_KEY || !pb?.voice_ai_voice_id) return;
    const base = (pb.audio_base_path || '').trim();
    if (!base || thanksClipsBusy.has(pb.id)) return;
    const failed = thanksClipsFailedAt.get(pb.id);
    if (failed && Date.now() - failed < 60 * 60 * 1000) return;
    thanksClipsBusy.add(pb.id);
    let wrote = 0;
    try {
        // 今の行を読み直す（不在の4本を足した直後も拾う）
        const { data, error } = await supabase.from('audio_clips').select('*').eq('playbook_id', pb.id).eq('active', true);
        if (error) throw new Error(`read clips: ${error.message}`);
        const clips = new Map((data || []).map((c) => [c.key, c]));
        const voice = pb.voice_ai_voice_id;
        const fillers = [...clips.values()].filter((c) => c.clip_type === 'filler');
        const targets = thanksTargets(clips);
        if (!fillers.length || [...fillers, ...targets].some((c) => c.source !== 'elevenlabs')) return;
        const want = [{ key: THANKS_KEY, text: THANKS_TEXT, sort_order: 40 }];
        for (const c of targets) {
            const rest = thanksRestText(c.text);
            if (rest.trim()) want.push({ key: restKeyOf(c.key), text: rest, sort_order: (c.sort_order ?? 0) + 100 });
        }
        for (const c of want) {
            const filename = thanksClipFilename(c.key, c.text, voice);
            const have = clips.get(c.key);
            if (have && have.source === 'elevenlabs' && have.audio_ready === true && have.text === c.text && have.filename === filename) continue;
            const mp3 = await elevenTts(c.text, voice);
            const { error: upErr } = await supabase.storage.from(AUDIO_BUCKET)
                .upload(`${base}/${filename}`, mp3, { contentType: 'audio/mpeg', upsert: true });
            if (upErr) throw new Error(`upload ${c.key}: ${upErr.message}`);
            const { error: wErr } = await supabase.from('audio_clips').upsert({
                playbook_id: pb.id, tenant_id: pb.tenant_id, key: c.key, clip_type: 'response', filename, text: c.text,
                source: 'elevenlabs', audio_ready: true, suppress_farewell: false, sort_order: c.sort_order, active: true,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'playbook_id,key' });
            if (wErr) throw new Error(`write ${c.key}: ${wErr.message}`);
            wrote++;
        }
        thanksClipsFailedAt.delete(pb.id);
    } catch (err) {
        thanksClipsFailedAt.set(pb.id, Date.now());
        throw err;
    } finally {
        thanksClipsBusy.delete(pb.id);
        if (wrote) {
            console.log(`[thanks-clips] wrote ${wrote} clips to playbook ${pb.id}`);
            bustPlaybookCache(pb.tenant_id); // 途中で落ちても書けた分は次の電話から読む
        }
    }
}

async function ensureAbsentClips(pb, cfg) {
    if (!process.env.ELEVENLABS_API_KEY || !pb?.voice_ai_voice_id) return;
    const base = (pb.audio_base_path || '').trim();
    if (!base) return;
    const missing = ABSENT_CLIPS.map((c, i) => ({ ...c, sort_order: 30 + i })).filter((c) => !cfg.clips.has(c.key));
    if (!missing.length) return;
    const next = absentClipsTried.get(pb.id);
    if (next && Date.now() < next) return;
    absentClipsTried.set(pb.id, Date.now() + 60 * 60 * 1000);
    let made = 0;
    for (const c of missing) {
        const mp3 = await elevenTts(c.text, pb.voice_ai_voice_id);
        const { error: upErr } = await supabase.storage.from(AUDIO_BUCKET)
            .upload(`${base}/${c.filename}`, mp3, { contentType: 'audio/mpeg', upsert: true });
        if (upErr) throw new Error(`upload ${c.key}: ${upErr.message}`);
        const { error: insErr } = await supabase.from('audio_clips').insert({
            playbook_id: pb.id, tenant_id: pb.tenant_id, key: c.key, clip_type: 'response', filename: c.filename, text: c.text,
            source: 'elevenlabs', audio_ready: true, suppress_farewell: false, sort_order: c.sort_order, active: true,
        });
        if (insErr) throw new Error(`insert ${c.key}: ${insErr.message}`);
        made++;
    }
    console.log(`[absent-clips] added ${made} clips to playbook ${pb.id}`);
    bustPlaybookCache(pb.tenant_id); // 次の電話から4本を読む（通話中の電話は読み込んだ声セットのまま）
}

// Intent set + trigger phrases. Company-independent, so it's fixed here and
// not exposed in the dashboard form. audio_key references CLIP_TEMPLATE keys.
const INTENT_TEMPLATE = [
    { name: 'transfer', audio_key: 'transfer_success', is_transfer: true, sort_order: 1,
        triggers: ['お繋ぎします', '少々お待ち', '担当者に代わります', '私が担当です', '代表です', '私が代表です', '社長です', '興味があります', '詳しく聞かせてください', '担当に代わります', '担当に変わります', '今変わります'] },
    { name: 'reason', audio_key: 'reason', sort_order: 2,
        triggers: ['どのようなご用件', '何のご用件', 'どういったご提案', '営業のお電話ですか', '営業ですか', 'セールスですか'] },
    { name: 'company', audio_key: 'company', sort_order: 3,
        triggers: ['どちらの会社', 'どこの会社', '会社名は'] },
    { name: 'who', audio_key: 'company', sort_order: 4,
        triggers: ['どなた様', 'お名前は', 'お名前をもう一度'] },
    { name: 'addressee', audio_key: 'addressee', sort_order: 12,
        triggers: ['どなた宛て', 'どちら宛て', '誰宛て', '担当者のお名前は分かりますか', 'お名前はご存知ですか', 'どの部署の'] },
    { name: 'material_request', audio_key: 'send_material', then_agent: true, sort_order: 13,
        triggers: ['資料を送ってください', 'メールで送ってください', '資料をお送りいただけますか', 'メールでお願いします', 'ホームページから問い合わせて'] },
    { name: 'appointment', audio_key: 'appointment', sort_order: 5,
        triggers: ['アポイントは', 'お約束は', 'ご予約は'] },
    { name: 'callback_request', audio_key: 'callback_request', sort_order: 6,
        triggers: ['折り返しましょうか', '後ほど', 'またかけ直して', '折り返しますので', 'お電話番号を', '番号を教えて', 'ご連絡先を'] },
    { name: 'callback_scheduled', audio_key: 'callback_request', end_call: true, end_reason: 'callback_scheduled', wants_callback_info: true, sort_order: 7,
        triggers: ['夕方には戻ります', '16時頃戻ります', '明日には戻ります', '担当者は不在だが戻り時間が明示されている'] },
    { name: 'not_available', audio_key: 'sorry_disturb', end_call: true, end_reason: 'not_available', sort_order: 8,
        triggers: ['本日不在', '外出中で戻り未定', '只今不在', 'いません（戻り時間不明）'] },
    { name: 'rejected', audio_key: 'sorry_disturb', end_call: true, end_reason: 'rejected', sort_order: 9,
        triggers: ['必要ありません', '結構です', '間に合っています', 'すでに他社と契約', 'お断りします', '興味ないです', 'いりません'] },
    { name: 'reprompt', action: 'reprompt', audio_key: null, sort_order: 10,
        triggers: ['雑音', '咳', 'もごもご', '語として成立しない音', '文字起こしの失敗'] },
    { name: 'openai_realtime', action: 'openai_realtime', audio_key: null, sort_order: 11,
        triggers: ['意味は通じるが上記に無い質問・発言', '雑談', '反論'] },
];

// Synthesize a single clip with OpenAI TTS, returning MP3 bytes.
async function synthesizeClip(text, voice) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: 'mp3' }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`TTS ${res.status}: ${detail.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

fastify.post('/provision-playbook', async (request, reply) => {
    if (!verifyProvisionSecret(request)) {
        return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = request.body || {};
    // TODO(security): bind to per-tenant principal; do not trust body tenant_id
    // from a shared secret. Anyone holding PROVISION_SECRET can act on any
    // tenant_id today — a per-tenant JWT/principal is the proper fix.
    const tenant_id = (body.tenant_id || '').trim();
    // project_id null => tenant default set; a uuid => that project's voice set
    // (声はプロジェクトに1セット). The dashboard route authorizes the project
    // server-side (admin / client_admin, same tenant); we trust it here.
    const project_id = (body.project_id || '').trim() || null;
    // voice_gender null => 性別なしのセット; male/female => その性別の CM が架電した時のセット（Tom 2026-10-05）
    const voice_gender = parseVoiceGender(body.voice_gender);
    const company_name = (body.company_name || '').trim();
    const voice = (body.voice || 'shimmer').trim();
    const clipTexts = body.clip_texts && typeof body.clip_texts === 'object' ? body.clip_texts : {};
    // synthesize=false => 台本だけ作成: build the structure with NO TTS (no cost).
    // The tenant then fills each clip by recording or per-clip AI generation.
    const synthesize = body.synthesize !== false;
    if (!tenant_id || !company_name) {
        return reply.code(400).send({ error: 'tenant_id and company_name are required' });
    }

    // Resolve the tenant (and its slug, used as the storage folder).
    const { data: tenant, error: tErr } = await supabase
        .from('tenants').select('id, slug').eq('id', tenant_id).maybeSingle();
    if (tErr || !tenant) return reply.code(404).send({ error: 'tenant not found' });
    const slug = (tenant.slug || '').trim();
    // Per-project sets live under <slug>/p-<project>/ (gendered sets under …/male|female) so storage separates cleanly.
    const base = voiceSetBase(slug, project_id, voice_gender);

    // 通話中の電話がある間は作り直さない（レビュー E3）＝下でクリップを消して入れ直す間に
    // 始まった通話が0本の台本を掴むと、無言電話になる。テナント既定の声はプロジェクトを持たない
    // 通話も使うので、テナント全体で見る。
    const liveSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    let liveQuery = supabase
        .from('call_sessions').select('id', { count: 'exact', head: true })
        .eq('status', 'calling').gte('created_at', liveSince);
    liveQuery = project_id ? liveQuery.eq('project_id', project_id) : liveQuery.eq('tenant_id', tenant_id);
    const { count: liveCalls, error: liveErr } = await liveQuery;
    if (liveErr) {
        console.error('[provision] live call check failed:', liveErr.message);
        return reply.code(500).send({ error: '通話の状態を確かめられませんでした' });
    }
    if (liveCalls) {
        return reply.code(409).send({ error: '通話中の電話があるため、今は音声を作り直せません' });
    }

    const realtimeSystemMessage =
        (typeof body.realtime_system_message === 'string' && body.realtime_system_message.trim()) ||
        `あなたはプロの営業アシスタントです。必ず日本語で話してください。\n${company_name}の担当者です。\n簡潔に丁寧に対応してください。`;

    // Find the tenant's active default playbook; update-in-place if it exists,
    // otherwise create one. Either way we rebuild its clips and intents.
    const { data: existing } = await scopePlaybookQuery(
        supabase
            .from('call_playbooks').select('id')
            .eq('tenant_id', tenant_id).is('campaign_id', null).is('owner_user_id', null).eq('is_active', true),
        project_id, voice_gender,
    ).maybeSingle();

    // Preserve any clip a tenant recorded in their own voice (source='recorded')
    // across a regenerate: keep that flag and DON'T re-synthesize/overwrite the
    // stored audio. TTS clips are rebuilt from the submitted text as usual.
    const priorByKey = {};
    let playbookId;
    if (existing) {
        playbookId = existing.id;
        const { data: priorClips } = await supabase
            .from('audio_clips').select('key, source, recorded_filename').eq('playbook_id', playbookId);
        for (const pc of priorClips || []) priorByKey[pc.key] = pc;
        const { error: upErr } = await supabase.from('call_playbooks').update({
            company_name, voice, audio_base_path: base,
            realtime_system_message: realtimeSystemMessage, updated_at: new Date().toISOString(),
        }).eq('id', playbookId);
        if (upErr) {
            console.error('[provision] playbook update failed:', upErr.message);
            return reply.code(500).send({ error: '台本を保存できませんでした' });
        }
        await supabase.from('audio_clips').delete().eq('playbook_id', playbookId);
        await supabase.from('call_intents').delete().eq('playbook_id', playbookId);
    } else {
        const { data: created, error: insErr } = await supabase.from('call_playbooks').insert({
            tenant_id, project_id, ...(voice_gender ? { voice_gender } : {}),
            name: 'default', company_name, voice, audio_base_path: base,
            realtime_system_message: realtimeSystemMessage, is_active: true,
        }).select('id').single();
        if (insErr) {
            console.error('[provision] playbook insert failed:', insErr.message);
            return reply.code(500).send({ error: '台本を保存できませんでした' });
        }
        playbookId = created.id;
    }

    // Build and insert clip + intent rows from the templates.
    // 肉声（recorded）と音声タブで選んだ ElevenLabs のテイク（elevenlabs）は作り直さない＝音も source もそのまま
    // （OpenAI TTS で上書きすると声が変わる・voice-ai.js）
    const clipRows = CLIP_TEMPLATE.map((c) => {
        const prior = priorByKey[c.key];
        const kept = prior?.source === 'recorded' || prior?.source === 'elevenlabs';
        return {
            playbook_id: playbookId, tenant_id, key: c.key, clip_type: c.clip_type,
            filename: c.filename, text: String(clipTexts[c.key] ?? '').trim(),
            source: kept ? prior.source : 'tts',
            audio_ready: kept,
            recorded_filename: prior?.source === 'recorded' ? (prior?.recorded_filename ?? null) : null,
            suppress_farewell: !!c.suppress_farewell, sort_order: c.sort_order, active: true,
        };
    });
    const { error: clipErr } = await supabase.from('audio_clips').insert(clipRows);
    if (clipErr) {
        console.error('[provision] clips insert failed:', clipErr.message);
        return reply.code(500).send({ error: 'セリフを保存できませんでした' });
    }

    const intentRows = INTENT_TEMPLATE.map((i) => ({
        playbook_id: playbookId, tenant_id, name: i.name, action: i.action || 'play_audio',
        audio_key: i.audio_key, triggers: i.triggers, is_transfer: !!i.is_transfer,
        end_call: !!i.end_call, end_reason: i.end_reason ?? null,
        wants_callback_info: !!i.wants_callback_info, then_agent: !!i.then_agent, sort_order: i.sort_order, active: true,
    }));
    const { error: intErr } = await supabase.from('call_intents').insert(intentRows);
    if (intErr) {
        console.error('[provision] intents insert failed:', intErr.message);
        return reply.code(500).send({ error: '台本を保存できませんでした' });
    }

    // Synthesize each clip with text and upload it — unless this is a
    // structure-only build (synthesize=false = 台本だけ作成), in which case the
    // clips start with no audio and the tenant fills each one by recording or
    // per-clip AI generation. Recorded clips are always kept as-is.
    const results = [];
    const readyKeys = [];
    for (const c of clipRows) {
        // Keep a tenant's own recording — never synthesize over 肉声.
        if (c.source === 'recorded') { results.push({ key: c.key, status: 'kept_recorded', recorded_filename: c.recorded_filename ?? null }); continue; }
        if (c.source === 'elevenlabs') { results.push({ key: c.key, status: 'kept_elevenlabs' }); continue; }
        if (!synthesize) { results.push({ key: c.key, status: 'no_audio' }); continue; }
        if (!c.text) { results.push({ key: c.key, status: 'skipped_no_text' }); continue; }
        const path = base ? `${base}/${c.filename}` : c.filename;
        try {
            const buf = await synthesizeClip(c.text, voice);
            const { error: upErr } = await supabase.storage
                .from(AUDIO_BUCKET).upload(path, buf, { contentType: 'audio/mpeg', upsert: true });
            if (upErr) throw new Error(upErr.message);
            results.push({ key: c.key, status: 'ok', bytes: buf.length });
            readyKeys.push(c.key);
        } catch (err) {
            console.error(`[provision] clip ${c.key} failed:`, err.message);
            results.push({ key: c.key, status: 'failed', error: '音声を作れませんでした' });
        }
    }
    // Flag successfully synthesized clips as having audio.
    if (readyKeys.length) {
        await supabase.from('audio_clips').update({ audio_ready: true })
            .eq('playbook_id', playbookId).in('key', readyKeys);
    }

    // Bust the per-tenant playbook cache and this tenant's clip audio cache so
    // the next call picks up the new script immediately.
    bustPlaybookCache(tenant_id);
    for (const key of [...audioCache.keys()]) {
        if (key === `${base}` || key.startsWith(`${base}/`)) audioCache.delete(key);
    }

    const failed = results.filter((r) => r.status === 'failed');
    console.log(`[provision] tenant=${tenant_id} playbook=${playbookId} clips=${clipRows.length} failed=${failed.length}`);
    return reply.send({ ok: failed.length === 0, playbook_id: playbookId, results });
});

// =====================================================================
// Call recording intake (Twilio RecordingStatusCallback)
// ---------------------------------------------------------------------
// The kick-call workflow starts every outbound call with Record=true +
// RecordingChannels=dual, pointing RecordingStatusCallback here. On
// "completed" we pull the dual-channel MP3 from Twilio, store it in the
// private call-recordings bucket under the owning tenant's folder, write
// a call_recordings row with the tenant's retention window, and only
// then delete Twilio's copy. Auth is Twilio's own request signature.
// =====================================================================

const RECORDING_BUCKET = 'call-recordings';
const DEFAULT_RECORDING_RETENTION_DAYS = 30;

// Verify X-Twilio-Signature: HMAC-SHA1 over the callback URL plus the POST
// params concatenated in key order, base64-encoded with the auth token.
function isValidTwilioSignature(url, params, signature) {
    if (!signature || !TWILIO_AUTH_TOKEN) return false;
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest();
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Twilio が叩いた URL で署名を確かめる。PUBLIC_BASE_URL があればそれで先に試し、合わなければ今どおり Host で。
function isValidTwilioRequest(request, params) {
    const signature = request.headers['x-twilio-signature'];
    const path = request.raw.url;
    if (PUBLIC_BASE_URL && isValidTwilioSignature(`${PUBLIC_BASE_URL}${path}`, params, signature)) return true;
    return isValidTwilioSignature(`https://${request.headers.host}${path}`, params, signature);
}

// Delete recordings past their retention window: storage object first, then
// the metadata row. Runs opportunistically after each intake and via the
// secret-protected endpoint below (Railway sleeps, so no in-process timer).
// 取次の判定の記録（call_turn_decisions）も録音と同じ保持日数で消す＝録音が0件でも走る（DB 140 の関数）
async function purgeExpiredDecisions() {
    const { data, error } = await supabase.rpc('purge_call_turn_decisions');
    if (error) {
        // DB 140 の前は関数が無い＝黙って何もしない
        if (!/purge_call_turn_decisions/.test(error.message || '')) console.error('[decision-log] purge failed:', error.message);
        return 0;
    }
    if (data) console.log(`[decision-log] purged ${data} expired row(s)`);
    return data || 0;
}

// 文字起こしも録音と同じ保持日数で消す（監査 2026-10-09・Tom「30日でgo」＝DB の purge_call_transcripts）
async function purgeExpiredTranscripts() {
    const { data, error } = await supabase.rpc('purge_call_transcripts');
    if (error) {
        console.error('[transcripts] purge failed:', error.message);
        return 0;
    }
    if (data) console.log(`[transcripts] purged ${data} expired row(s)`);
    return data || 0;
}

async function purgeExpiredRecordings() {
    const { data: expired, error } = await supabase
        .from('call_recordings')
        .select('id, storage_path')
        .lt('expires_at', new Date().toISOString())
        .limit(100);
    if (error) {
        console.error('[recording] purge query failed:', error.message);
        return { purged: 0 };
    }
    if (!expired?.length) return { purged: 0 };
    const { error: rmErr } = await supabase.storage
        .from(RECORDING_BUCKET)
        .remove(expired.map((r) => r.storage_path));
    if (rmErr) {
        console.error('[recording] purge storage remove failed:', rmErr.message);
        return { purged: 0 };
    }
    const { error: delErr } = await supabase
        .from('call_recordings')
        .delete()
        .in('id', expired.map((r) => r.id));
    if (delErr) console.error('[recording] purge row delete failed:', delErr.message);
    console.log(`[recording] purged ${expired.length} expired recording(s)`);
    return { purged: expired.length };
}

fastify.post('/recording-status', async (request, reply) => {
    const params = request.body || {};
    if (!isValidTwilioRequest(request, params)) {
        console.error('[recording] rejected callback with bad signature');
        return reply.code(403).send({ error: 'invalid signature' });
    }

    const { CallSid, RecordingSid, RecordingStatus, RecordingDuration } = params;
    console.log(`[recording] status=${RecordingStatus} call=${CallSid} sid=${RecordingSid}`);
    if (RecordingStatus !== 'completed') return reply.send({ ok: true });

    try {
        // Owning session → tenant. The kick-call WF creates the session right
        // after dialing, so it exists long before the recording completes.
        const { data: session } = await supabase
            .from('call_sessions')
            .select('id, tenant_id')
            .eq('call_sid', CallSid)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!session?.tenant_id) {
            // Leave Twilio's copy in place so the recording isn't lost.
            console.error(`[recording] no session/tenant for call=${CallSid}, leaving recording on Twilio`);
            return reply.send({ ok: false, reason: 'session not found' });
        }

        // Dual-channel MP3: one side of the conversation per channel.
        // SSRF guard: construct the download URL from trusted ids
        // (TWILIO_ACCOUNT_SID + the validated RecordingSid) rather than
        // trusting the webhook-supplied RecordingUrl, which an attacker could
        // point elsewhere. The Twilio signature is already verified above; this
        // makes the fetch target non-spoofable regardless.
        if (!RecordingSid || !/^RE[0-9a-fA-F]{32}$/.test(RecordingSid)) {
            throw new Error(`invalid RecordingSid: ${RecordingSid}`);
        }
        const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
        const recordingUrl =
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
        const dl = await fetch(recordingUrl, { headers: { Authorization: `Basic ${auth}` } });
        if (!dl.ok) throw new Error(`recording download failed: ${dl.status}`);
        const mp3 = Buffer.from(await dl.arrayBuffer());
        if (mp3.length === 0) throw new Error('recording download was empty');

        const storagePath = `${session.tenant_id}/${CallSid}.mp3`;
        const { error: upErr } = await supabase.storage
            .from(RECORDING_BUCKET)
            .upload(storagePath, mp3, { contentType: 'audio/mpeg', upsert: true });
        if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);

        // Retention is per tenant; a missing row or NULL column falls back
        // to the default window.
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
            duration_seconds: RecordingDuration ? parseInt(RecordingDuration, 10) : null,
            expires_at: expiresAt,
        }, { onConflict: 'call_sid' });
        if (insErr) throw new Error(`call_recordings upsert failed: ${insErr.message}`);

        // Only after our copy is safe do we delete Twilio's.
        const delRes = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${RecordingSid}.json`,
            { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } },
        );
        if (!delRes.ok && delRes.status !== 404) {
            console.error(`[recording] Twilio delete failed: ${delRes.status} (copy saved at ${storagePath})`);
        }

        console.log(`✓ [recording] saved ${storagePath} (${mp3.length} bytes, expires=${expiresAt || 'never'})`);
        purgeExpiredRecordings().catch((e) => console.error('[recording] purge error:', e));
        purgeExpiredDecisions().catch((e) => console.error('[decision-log] purge error:', e));
        purgeExpiredTranscripts().catch((e) => console.error('[transcripts] purge error:', e));
        return reply.send({ ok: true });
    } catch (err) {
        // The recording stays on Twilio (we delete only after success), so a
        // failed intake loses nothing — it can be re-fetched later.
        console.error('[recording] intake failed:', err);
        return reply.code(500).send({ error: 'recording intake failed' });
    }
});

// Manual/cron purge trigger, protected like /provision-playbook.
fastify.post('/purge-recordings', async (request, reply) => {
    if (!verifyProvisionSecret(request)) {
        return reply.code(403).send({ error: 'forbidden' });
    }
    const recordings = await purgeExpiredRecordings();
    const decisions = await purgeExpiredDecisions().catch(() => 0);
    const transcripts = await purgeExpiredTranscripts().catch(() => 0);
    return reply.send({ ...recordings, decisions, transcripts });
});

// =====================================================================
// Outbound dialing (POST /kick-call) — moved from the n8n "Kick Call" WF
// =====================================================================
// SaaS backlog #2: the dashboard POSTs here instead of having n8n dial Twilio
// directly, so per-tenant concurrency control + Twilio rate-limiting live
// server-side and n8n's execution-concurrency cap is no longer the dialing
// bottleneck (the old "架電中"-stuck root cause). Reuses the existing Twilio +
// Supabase env — no new secrets, and it removes the hardcoded service key and
// Twilio creds that used to sit inline in the n8n nodes. Same x-provision-secret
// gate as /provision-playbook and /purge-recordings. This route waking the
// container is itself the warm-up: by the time Twilio rings and connects back
// to /incoming-call, the app is hot — so a persistent warmer is unnecessary.

const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '+18312734595';
// Call-status callbacks now go to this server's own /call-status (was the n8n
// OB handler). Set TWILIO_STATUS_CALLBACK_URL only to override the default.
const TWILIO_STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || '';
// Per-tenant ceiling on simultaneous in-flight calls (runaway backstop; tunable).
const MAX_CONCURRENT_PER_TENANT = parseInt(process.env.MAX_CONCURRENT_PER_TENANT || '5', 10);
const DIAL_SPACING_MS = parseInt(process.env.DIAL_SPACING_MS || '1100', 10); // Twilio ≈1 CPS/number
// 1本の電話の上限（秒・レビュー C4）＝保留や通話が何かの理由で終わらなくても、ここで Twilio が切る。
const CALL_TIME_LIMIT_S = parseInt(process.env.CALL_TIME_LIMIT_S || '3600', 10);
// 声セットの関門（台本が無い・セリフが0件・音声が未設定）で止めた応答にだけ付ける code。
// 画面はこの code だけで判定する（reason の文言が変わっても壊れない）＝/kick-call と /dial-tick の両方。
const VOICE_NOT_READY = 'voice_not_ready';

async function placeOutboundCall(baseUrl, contact, ctx) {
    // 日本の番号だけにかける（レビュー C2）＝国外・高額番号は Twilio に投げず、人が見る「要確認」へ回す
    // （自動では掛け直さない＝DB 060 の人間確認レーン）。呼び手は NON_JP_NUMBER を見て架電中へ戻さない。
    if (!isJapaneseE164(contact.phone_number)) {
        const contactId = contact.id || ctx.contact_id || null;
        if (contactId) {
            // 自動架電（operator_id あり）は取り出しで回数を1つ足している＝unclaim_contact で戻してから
            // （架電中→未架電・回数−1）、未架電の行だけを要確認へ。手動の /kick-call は回数を足していないので直接。
            let fromStatus = '架電中';
            if (ctx.operator_id) {
                const { error: unErr } = await supabase.rpc('unclaim_contact', { p_contact: contactId });
                if (unErr) console.error(`[dial] unclaim failed for contact ${contactId}:`, unErr.message);
                else fromStatus = '未架電';
            }
            const { error } = await supabase.from('contacts')
                .update({ status: '要確認', updated_at: new Date().toISOString() })
                .eq('id', contactId)
                .eq('status', fromStatus);
            if (error) console.error(`[dial] could not move contact ${contactId} to 要確認:`, error.message);
        }
        const err = new Error('not a Japanese phone number');
        err.code = 'NON_JP_NUMBER';
        throw err;
    }
    // Make the local session durable BEFORE dialing so a fast status/recording
    // callback can never hit "session not found". We create the row with a
    // synthetic provisional call_sid (no Twilio sid yet), then patch in the
    // real sid once Twilio returns. If the dial fails the provisional row is
    // deleted, so callbacks never see a stranded pending session.
    const provisionalSid = `pending-${crypto.randomBytes(12).toString('hex')}`;
    const { data: sessionRow, error: sInsErr } = await supabase.from('call_sessions').insert({
        phone_number: contact.phone_number,
        company_name: contact.company_name || '',
        contact_name: contact.contact_name || '',
        call_sid: provisionalSid,
        status: 'pending',
        script_phase: 'greeting',
        tenant_id: ctx.tenant_id,
        contact_id: ctx.contact_id || null,
        operator_id: ctx.operator_id || null,
        project_id: ctx.project_id || null,
    }).select('id').single();
    if (sInsErr) {
        // If we can't create the session row we must not dial — a dial without
        // a durable session would strand the recording/status callbacks.
        throw new Error(`session pre-insert failed: ${sInsErr.message}`);
    }

    // 客の社名・担当者名・電話番号は Url に載せない（監査 Low 5）＝Twilio は Url を自分のログに残す。
    // 代わりに上で作った call_sessions の行の id（session_id）を渡し、/incoming-call がその行から引く。
    // agent_phone／agent_name は自社の CM＝そのまま。
    const qs = new URLSearchParams({
        session_id: String(sessionRow.id),
        agent_phone: ctx.agent_phone || '',
        agent_name: ctx.agent_name || '',
        tenant_id: ctx.tenant_id || '',
        operator_id: ctx.operator_id || '',
        operator_gender: parseVoiceGender(ctx.operator_gender) || '',
        project_id: ctx.project_id || '',
        contact_id: ctx.contact_id || '',
    });
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const form = new URLSearchParams({
        To: contact.phone_number,
        // プロジェクトの番号（作る順番の6番目）があればそれ、無ければ共通の番号
        From: ctx.from_number || TWILIO_FROM_NUMBER,
        Url: `${baseUrl}/incoming-call?${qs.toString()}`,
        StatusCallback: TWILIO_STATUS_CALLBACK_URL || `${baseUrl}/call-status`,
        StatusCallbackMethod: 'POST',
        TimeLimit: String(CALL_TIME_LIMIT_S),
        Record: 'true',
        RecordingChannels: 'dual',
        RecordingStatusCallback: `${baseUrl}/recording-status`,
        RecordingStatusCallbackMethod: 'POST',
    });

    let callSid;
    try {
        const res = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
            {
                method: 'POST',
                headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: form,
            },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Twilio calls.create ${res.status}: ${JSON.stringify(data)}`);
        callSid = data.sid;
    } catch (e) {
        // Dial failed — discard the provisional session so it can't be picked
        // up by a stray callback, then propagate so the caller reverts the
        // contact claim.
        await supabase.from('call_sessions').delete().eq('id', sessionRow.id);
        throw e;
    }

    // Patch the real Twilio sid + calling status into the pre-created row.
    const { error: sPatchErr } = await supabase.from('call_sessions')
        .update({ call_sid: callSid, status: 'calling' })
        .eq('id', sessionRow.id);
    if (sPatchErr) console.error('[kick-call] session call_sid patch failed:', sPatchErr.message);

    return callSid;
}

fastify.post('/kick-call', async (request, reply) => {
    if (!verifyProvisionSecret(request)) {
        return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body || {};
    // TODO(security): bind to per-tenant principal; do not trust body tenant_id
    // from a shared secret. Anyone holding PROVISION_SECRET can dial on behalf
    // of any tenant today — a per-tenant JWT/principal is the proper fix.
    const tenant_id = (body.tenant_id || '').trim();
    if (!tenant_id) return reply.code(400).send({ error: 'tenant_id is required' });

    const requested = Math.max(1, parseInt(body.concurrent_count ?? 1, 10) || 1);
    const ctx = {
        tenant_id,
        agent_phone: body.agent_phone || '',
        agent_name: body.agent_name || '',
    };
    const baseUrl = publicBaseUrl(request.headers.host);

    // 🔴 D1 ゲート（Tom 決定 2026-07-19 / 実装 2026-07-31）＝声セットが未完成なら
    // 架電しない。フォールバックもしない。
    // 理由＝音声ファイルが無いクリップは playAudio がエラーログを出して再生を
    // スキップするだけなので、ゲートが無いと「つながるのに何も喋らない電話」が
    // 営業先に飛ぶ（無言電話）。発信の口はここだけなので、最後の砦はここに置く。
    // 判定対象＝手動の /kick-call はプロジェクトを持たない＝テナント既定の声セット
    // （campaign_id／owner_user_id／project_id が空・is_active）。
    const { data: gatePb, error: gatePbErr } = await supabase
        .from('call_playbooks').select('id')
        .eq('tenant_id', tenant_id).is('campaign_id', null).is('owner_user_id', null).is('project_id', null)
        .eq('is_active', true).maybeSingle();
    if (gatePbErr) {
        console.error('[kick-call] playbook lookup failed:', gatePbErr.message);
        return reply.code(500).send({ error: 'playbook lookup failed' });
    }
    if (!gatePb) {
        console.log(`[kick-call] blocked tenant=${tenant_id} reason=no_playbook`);
        return reply.send({ ok: true, dialed: 0, code: VOICE_NOT_READY, reason: '台本がありません（Voice Setup で台本と音声を設定してください）' });
    }
    const { data: gateClips, error: gateClipErr } = await supabase
        .from('audio_clips').select('audio_ready')
        .eq('playbook_id', gatePb.id).eq('active', true);
    if (gateClipErr) {
        console.error('[kick-call] clip audio check failed:', gateClipErr.message);
        return reply.code(500).send({ error: 'clip audio check failed' });
    }
    const missingAudio = (gateClips || []).filter((c) => !c.audio_ready).length;
    if (!gateClips || gateClips.length === 0) {
        console.log(`[kick-call] blocked tenant=${tenant_id} reason=no_clips`);
        return reply.send({ ok: true, dialed: 0, code: VOICE_NOT_READY, reason: 'セリフが1件もありません（Voice Setup で台本を作ってください）' });
    }
    if (missingAudio > 0) {
        console.log(`[kick-call] blocked tenant=${tenant_id} reason=missing_audio count=${missingAudio}`);
        return reply.send({
            ok: true, dialed: 0, code: VOICE_NOT_READY, missing_audio: missingAudio,
            reason: `音声が未設定のセリフが ${missingAudio} 件あるため架電できません（Voice Setup で録音またはAI音声を設定してください）`,
        });
    }

    // Per-tenant concurrency: never exceed MAX_CONCURRENT_PER_TENANT in flight.
    // In-flight is approximated by contacts still in '架電中' for this tenant
    // (the StatusCallback handler moves them to a terminal status when done).
    const { count: inFlight } = await supabase
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant_id)
        .eq('status', '架電中');
    const slots = Math.max(0, MAX_CONCURRENT_PER_TENANT - (inFlight || 0));
    const want = Math.min(requested, slots);
    if (want <= 0) {
        return reply.send({ ok: true, dialed: 0, reason: 'tenant at concurrency cap', in_flight: inFlight || 0 });
    }

    // Pick candidate 未架電 contacts ordered by priority/age. We over-select a
    // little (want * 2, capped) so that if a concurrent kick claims some rows
    // out from under us we still have alternates to fill our slots.
    const CANDIDATE_OVERSELECT = Math.min(want * 2, want + 20);
    const { data: candidates, error } = await supabase
        .from('contacts')
        .select('id, company_name, contact_name, phone_number')
        .eq('tenant_id', tenant_id)
        .eq('status', '未架電')
        .order('priority', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(CANDIDATE_OVERSELECT);
    if (error) {
        console.error('[kick-call] contacts query failed:', error.message);
        return reply.code(500).send({ error: 'contacts query failed' });
    }
    if (!candidates || candidates.length === 0) {
        return reply.send({ ok: true, dialed: 0, reason: 'no 未架電 contacts' });
    }

    // Atomically CLAIM up to `want` contacts before dialing: conditional update
    // 未架電 -> 架電中 returning only the rows we actually won. Concurrent kicks
    // racing on the same rows will each only get the subset they flipped, so we
    // can never dial the same contact twice or exceed the cap. (A Postgres RPC
    // with FOR UPDATE SKIP LOCKED would be even tighter, see
    // scripts/sql/claim_contacts.sql, but this conditional-update claim is
    // race-safe with the current schema and needs no migration.)
    const candidateIds = candidates
        .filter((c) => c.phone_number)
        .slice(0, want)
        .map((c) => c.id);
    if (candidateIds.length === 0) {
        return reply.send({ ok: true, dialed: 0, reason: 'no dialable 未架電 contacts' });
    }
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
        .from('contacts')
        .update({ status: '架電中', last_called_at: nowIso, updated_at: nowIso })
        .eq('tenant_id', tenant_id)
        .eq('status', '未架電')
        .in('id', candidateIds)
        .select('id, company_name, contact_name, phone_number');
    if (claimErr) {
        console.error('[kick-call] contact claim failed:', claimErr.message);
        return reply.code(500).send({ error: 'contact claim failed' });
    }
    const contacts = claimed || [];
    if (contacts.length === 0) {
        return reply.send({ ok: true, dialed: 0, reason: 'all candidates claimed by a concurrent kick' });
    }

    const calls = [], errors = [];
    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        if (!c.phone_number) continue;
        try {
            // 通話の行に架電先の id を残す＝通話の終わりで同じ番号の別の行まで書き換えない（レビュー E2）
            const sid = await placeOutboundCall(baseUrl, c, { ...ctx, contact_id: c.id });
            calls.push({ contact_id: c.id, call_sid: sid });
            console.log(`[kick-call] dialed ${maskPhone(c.phone_number)} (tenant=${tenant_id}, sid=${sid})`);
        } catch (e) {
            console.error(`[kick-call] dial failed for contact ${c.id}:`, e.message || e);
            errors.push({ contact_id: c.id, error: e.code === 'NON_JP_NUMBER' ? 'not a Japanese number' : 'dial failed' });
            // Dial (or session pre-insert) failed for a claimed contact —
            // revert it to 未架電 so it isn't stranded at 架電中.
            const { error: revErr } = await supabase
                .from('contacts')
                .update({ status: '未架電', updated_at: new Date().toISOString() })
                .eq('id', c.id)
                .eq('tenant_id', tenant_id)
                .eq('status', '架電中');
            if (revErr) console.error(`[kick-call] revert claim failed for contact ${c.id}:`, revErr.message);
        }
        // Stay under Twilio's ~1 call/sec per-number limit.
        if (i < contacts.length - 1) await new Promise((r) => setTimeout(r, DIAL_SPACING_MS));
    }
    return reply.send({
        ok: true,
        dialed: calls.length,
        failed: errors.length,
        calls,
        errors,
        in_flight_before: inFlight || 0,
    });
});

// =====================================================================
// Call-status handler (POST /call-status) — moved from the n8n
// "OB_Twilio StatusCallback Handler" WF
// =====================================================================
// Twilio posts the final call status here when a call ends. The old n8n chain
// made the contact's 架電中→terminal reset the LAST step, behind transcript
// fetch + Claude classification — so any failure there left the contact stuck
// at 架電中 forever. Here the reset is done FIRST and unconditionally; Claude
// enrichment (memo/next_call_date) is a best-effort follow-up that can fail
// without stranding the contact. Removes the last hardcoded sb_secret from n8n.
// Twilio-signature gated, like /recording-status.

const CALL_STATUS_LABELS = {
    completed: '架電済', 'no-answer': '不在', busy: '話し中', failed: '失敗', canceled: 'キャンセル',
};
// The session's rich result (set during the call) → contact label.
const RESULT_STATUS_MAP = {
    transferred: '取次済', completed: '架電済', callback_scheduled: '折り返し予定',
    not_available: '不在', rejected: '断り', voicemail: '留守電',
    silence_timeout: '無音切断', duration_timeout: '時間切れ',
    loop_detected: 'ループ', error_limit: 'エラー',
    // 受付は突破したが渡せる CM がいなかった＝未架電に戻し、要再架電で優先して掛け直す
    overflow_recall: '未架電',
    'no-answer': '不在', busy: '話し中', failed: '失敗', canceled: 'キャンセル',
};
function priorityForResult(result) {
    if (result === 'transferred' || result === 'callback_scheduled') return '高';
    if (result === 'rejected' || result === 'voicemail') return '低';
    return '中';
}

fastify.post('/call-status', async (request, reply) => {
    const params = request.body || {};
    if (!isValidTwilioRequest(request, params)) {
        console.error('[call-status] rejected callback with bad signature');
        return reply.code(403).send({ error: 'invalid signature' });
    }

    const callStatus = params.CallStatus || '';
    const callSid = params.CallSid || '';
    const duration = params.CallDuration ? parseInt(params.CallDuration, 10) : null;

    // Twilio fires StatusCallback for terminal statuses only; ignore anything else.
    if (!(callStatus in CALL_STATUS_LABELS)) {
        return reply.send({ ok: true, ignored: callStatus });
    }

    try {
        // (a) Stamp the session as ended. CRITICAL: only write the Twilio
        // CallStatus into `result` when the session has NO in-call result yet
        // (result IS NULL). The in-call flow sets rich semantic results —
        // transferred / callback_scheduled / not_available / rejected /
        // voicemail / silence_timeout / duration_timeout / loop_detected /
        // error_limit — and Twilio's terminal "completed" must NEVER clobber
        // them (that's the bug that reset 取次済/折り返し予定/etc. back to
        // 架電済). status/ended_at/duration are always stamped; only `result`
        // is conditional.
        await supabase.from('call_sessions')
            .update({ status: 'completed', ended_at: new Date().toISOString(), duration_seconds: duration })
            .eq('call_sid', callSid);
        // Fill result ONLY if still null (i.e. the call never reached the
        // in-call classifier — no-answer / busy / failed / etc.).
        await supabase.from('call_sessions')
            .update({ result: callStatus })
            .eq('call_sid', callSid)
            .is('result', null);

        // (b) Resolve the owning session (tenant/contact/result) — read back the
        // PRESERVED result so the contact's terminal label is derived from the
        // rich in-call result, not blindly from Twilio's CallStatus.
        const { data: session } = await supabase.from('call_sessions')
            .select('id, company_name, contact_name, result, phone_number, tenant_id, metadata, contact_id, project_id')
            .eq('call_sid', callSid)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!session) {
            console.error(`[call-status] no session for call=${callSid}`);
            return reply.send({ ok: false, reason: 'session not found' });
        }

        // Derive the contact's terminal status from the PRESERVED session
        // result first (rich, set in-call), then fall back to the Twilio
        // CallStatus label only when there is no in-call result. Either way
        // the contact is moved off 架電中 (the reset-first guarantee).
        const result = session.result;
        const contactStatus = RESULT_STATUS_MAP[result]
            || CALL_STATUS_LABELS[callStatus]
            || '不明';
        const priority = priorityForResult(result);

        // (c) CRITICAL reset — always move the contact off 架電中, even if the
        // Claude enrichment below fails. This is the fix for the stuck-架電中 bug.
        // 自動架電の通話（contact_id とプロジェクトあり）＝AI が付ける結果・上限回数・再コールは DB 関数が決める
        // （作る順番の3番目・家 ▼Tom 待ち #3）。手動の /kick-call は架電先の id で1行だけ当てる（レビュー E2）。
        // id の無い旧い通話だけ、これまでどおり番号で当てる。
        let cErr = null;
        if (session.contact_id && session.project_id) {
            const { data: applied, error } = await supabase.rpc('apply_call_outcome', {
                p_session: session.id,
                // 通話で決まった再コールの日時（不在の流れ・戻り時間）があれば、そこまでの間隔＝結果と同じ1回の更新で入る
                p_retry: retryIntervalFor(session.metadata?.recall_at, new Date(), RETRY_AFTER_HOURS),
            });
            cErr = error;
            if (!error) {
                console.log(
                    `[call-status] contact ${session.contact_id} → ${applied ?? '(CM が付ける／回数に数えない)'} ` +
                        `(result=${result}, call=${callSid})`
                );
            }
            await supabase.from('contacts').update({ call_duration_seconds: duration }).eq('id', session.contact_id);
        } else {
            const patch = { status: contactStatus, priority, call_duration_seconds: duration, updated_at: new Date().toISOString() };
            const { error } = await (session.contact_id
                ? supabase.from('contacts').update(patch).eq('id', session.contact_id)
                : supabase.from('contacts').update(patch)
                    .eq('phone_number', session.phone_number)
                    .eq('tenant_id', session.tenant_id));
            cErr = error;
            if (!error) console.log(`[call-status] contact ${session.contact_id || maskPhone(session.phone_number)} → ${contactStatus} (result=${result}, call=${callSid})`);
        }
        if (cErr) console.error('[call-status] contact reset failed:', cErr.message);

        // (d) Best-effort enrichment: summarize the conversation for memo/next_call_date.
        try {
            const { data: transcripts } = await supabase.from('call_transcripts')
                .select('role, content')
                .eq('session_id', session.id)
                .order('timestamp', { ascending: true });
            const log = (transcripts && transcripts.length)
                ? transcripts.map((t) => `${t.role}: ${t.content}`).join('\n')
                : '(会話ログなし)';
            const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
            const callbackInfo = JSON.stringify(session.metadata?.callback_info || null);
            const prompt =
`以下は営業電話の会話ログです。分析してJSON形式のみで返答してください。

今日の日付：${today}
会社名：${session.company_name || ''}
担当者名：${session.contact_name || ''}
通話結果：${result || ''}
コールバック情報：${callbackInfo}

会話ログ：
${log}

通話結果(result)の意味：
- transferred: 担当者に転送成功（最高評価）
- completed: 通話成立（中間評価）
- callback_scheduled: 戻り時間あり、再架電希望
- not_available: 担当者不在（戻り時間不明）
- rejected: 断られた
- voicemail: 留守番電話
- silence_timeout / duration_timeout: タイムアウト
- loop_detected / error_limit: 異常終了
- overflow_recall: 受付は突破したが取れる担当がいなかった（要再架電・優先して掛け直す）
- no-answer / busy / failed / canceled: Twilio標準

以下のJSONのみを返してください（他のテキスト不要）：
{
  "memo": "通話内容の要約（100文字以内、結果に応じた次回のヒントも含める）",
  "priority": "高/中/低",
  "next_call_date": "次回架電日（YYYY-MM-DD形式）。callback_scheduledの場合はコールバック情報から推測。rejectedは空文字。それ以外は3営業日後"
}`;
            const resp = await anthropic.messages.create({
                // 2026-10-08 Sonnet 4.6→5.5＝思考が既定で入る（effort high）＝枠を思考と本文の合算で 4000 に
                model: 'claude-sonnet-5-5',
                max_tokens: 4000,
                messages: [{ role: 'user', content: prompt }],
            });
            const text = resp.content.find((b) => b.type === 'text')?.text || '';
            let memo = '', nextCallDate = null;
            try {
                const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```/g, '').trim());
                // 要約は相手の発言からも作られる＝形と長さを縛ってから書く（レビュー E2）
                memo = String(parsed.memo || '').slice(0, 500);
                const d = String(parsed.next_call_date || '');
                nextCallDate = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;
            } catch { memo = text.substring(0, 100); }

            const enrich = { memo, next_call_date: nextCallDate || null };
            await (session.contact_id
                ? supabase.from('contacts').update(enrich).eq('id', session.contact_id)
                : supabase.from('contacts').update(enrich)
                    .eq('phone_number', session.phone_number)
                    .eq('tenant_id', session.tenant_id));
        } catch (e) {
            console.error('[call-status] enrichment failed (contact already reset):', e);
        }

        return reply.send({ ok: true, contact_status: contactStatus, result });
    } catch (err) {
        console.error('[call-status] failed:', err);
        return reply.code(500).send({ error: 'call-status failed' });
    }
});

// ---------------------------------------------------------------------
// Short-lived tokens bridging /incoming-call → /media-stream. The media
// WS upgrade carries no X-Twilio-Signature, so the signed TwiML embeds a
// one-time token via <Stream><Parameter>; Twilio echoes it back in the
// 'start' event's customParameters, where we verify and consume it.
// ---------------------------------------------------------------------
const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000;
const streamTokens = new Map(); // token -> expiry epoch ms

// A media-stream WS is only authenticated once it sends a valid 'start' with a
// good one-time stream_token. Until then it's "unauthenticated": we bound how
// long such a socket may idle (pre-auth timeout) and how many may exist at once
// so an attacker can't open sockets and sit on them to exhaust resources.
const WS_PREAUTH_TIMEOUT_MS = parseInt(process.env.WS_PREAUTH_TIMEOUT_MS || '5000', 10);
const MAX_UNAUTH_WS = parseInt(process.env.MAX_UNAUTH_WS || '50', 10);
let unauthWsCount = 0;
// 同じ送り元から張れる未認証の本数（レビュー E4）＝1か所から50本張られて本物の通話が断られるのを防ぐ。
// Twilio の media server は IP を共有する＝本物の通話が同じ IP から重なっても届く幅（20）にしてある。
const MAX_UNAUTH_WS_PER_IP = parseInt(process.env.MAX_UNAUTH_WS_PER_IP || '20', 10);
const unauthWsByIp = new Map(); // ip -> 未認証の本数

function issueStreamToken() {
    // Opportunistic sweep so the map can't grow unbounded.
    const now = Date.now();
    for (const [t, exp] of streamTokens) {
        if (exp < now) streamTokens.delete(t);
    }
    const token = crypto.randomBytes(16).toString('hex');
    streamTokens.set(token, now + STREAM_TOKEN_TTL_MS);
    return token;
}

function consumeStreamToken(token) {
    if (!token) return false;
    const exp = streamTokens.get(token);
    if (exp === undefined) return false;
    streamTokens.delete(token); // single use
    return exp >= Date.now();
}
// Sample line spoken when previewing a voice in the dashboard. Short, neutral
// sales greeting so the agent can judge tone without supplying their own text.
const PREVIEW_SAMPLE_TEXT = 'お世話になっております。本日はお時間をいただきありがとうございます。';

// Synthesize a one-off sample with OpenAI TTS so the dashboard can let agents
// audition a voice before saving. Mirrors /provision-playbook's secret guard
// and TTS call, but returns the MP3 bytes directly — nothing is stored.
fastify.post('/preview-voice', async (request, reply) => {
    if (!verifyProvisionSecret(request)) {
        return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = request.body || {};
    const voice = (body.voice || 'shimmer').trim();
    // Cap the text so a stray long input can't run up TTS cost; fall back to
    // the built-in sample when none is supplied.
    const text = (typeof body.text === 'string' && body.text.trim())
        ? body.text.trim().slice(0, 300)
        : PREVIEW_SAMPLE_TEXT;

    try {
        const buf = await synthesizeClip(text, voice);
        return reply.type('audio/mpeg').send(buf);
    } catch (err) {
        console.error(`[preview-voice] voice=${voice} failed: ${err.message}`);
        return reply.code(502).send({ error: '音声を作れませんでした' });
    }
});

// =====================================================================
// Per-clip human voice (肉声) upload / delete / preview
// ---------------------------------------------------------------------
// Lets the dashboard replace a single clip's TTS with a staff member's own
// recording (source='recorded'), preview what's stored, or revert to TTS.
// Same shared-secret gate as /provision-playbook. The clip's storage
// FILENAME is unchanged (call-time fetches by filename; ffmpeg decodes by
// content), so the call path is untouched — only the bytes + the source
// flag change. On delete we re-synthesize TTS from the clip's current text
// so a revert never leaves the clip silent.
// =====================================================================

// Decoded upload cap. Kept well under Vercel's ~4.5MB request-body limit once
// base64-inflated (×4/3): a single-utterance clip is normally < 1MB anyway.
const MAX_CLIP_UPLOAD_BYTES = 3 * 1024 * 1024;

// Drop cached audio + playbook for a tenant so the next call reloads them.
function bustTenantAudio(tenantId, base) {
    bustPlaybookCache(tenantId);
    for (const k of [...audioCache.keys()]) {
        if (k === `${base}` || k.startsWith(`${base}/`)) audioCache.delete(k);
    }
}

fastify.post('/clip-audio', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    if (!verifyProvisionSecret(request)) {
        return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = request.body || {};
    // TODO(security): same shared-secret caveat as /provision-playbook — anyone
    // holding PROVISION_SECRET can act on any tenant_id until per-tenant auth.
    const action = (body.action || '').trim();
    const tenant_id = (body.tenant_id || '').trim();
    // project_id null => tenant default set; a uuid => that project's set.
    // Authorized server-side by the dashboard route (admin / client_admin, same tenant).
    const project_id = (body.project_id || '').trim() || null;
    const voice_gender = parseVoiceGender(body.voice_gender);
    const key = (body.key || '').trim();
    if (!tenant_id || !key || !['upload', 'delete', 'synthesize', 'preview'].includes(action)) {
        return reply.code(400).send({ error: 'action(upload|delete|synthesize|preview), tenant_id and key are required' });
    }

    // Resolve tenant slug (storage folder) + the active default playbook + clip.
    const { data: tenant, error: tErr } = await supabase
        .from('tenants').select('id, slug').eq('id', tenant_id).maybeSingle();
    if (tErr || !tenant) return reply.code(404).send({ error: 'tenant not found' });
    const slug = (tenant.slug || '').trim();
    const base = voiceSetBase(slug, project_id, voice_gender);

    const { data: pb, error: pbErr } = await scopePlaybookQuery(
        supabase
            .from('call_playbooks').select('id, voice')
            .eq('tenant_id', tenant_id).is('campaign_id', null).is('owner_user_id', null).eq('is_active', true),
        project_id, voice_gender,
    ).maybeSingle();
    if (pbErr || !pb) return reply.code(409).send({ error: '先に台本を作成してください' });

    const { data: clip, error: clipErr } = await supabase
        .from('audio_clips').select('id, filename, text, source')
        .eq('playbook_id', pb.id).eq('key', key).maybeSingle();
    if (clipErr || !clip) return reply.code(404).send({ error: `clip "${key}" not found` });

    const path = base ? `${base}/${clip.filename}` : clip.filename;

    // 音声タブで選んだ ElevenLabs の音は OpenAI TTS で上書きしない（作り直しは音声タブのテイクで＝voice-ai.js）
    if (clip.source === 'elevenlabs' && (action === 'delete' || action === 'synthesize')) {
        return reply.code(409).send({ error: 'この音声は「AI音声を生成」のテイクで作り直してください' });
    }

    try {
        if (action === 'preview') {
            const { data: signed, error: sErr } = await supabase.storage
                .from(AUDIO_BUCKET).createSignedUrl(path, 300);
            if (sErr || !signed?.signedUrl) return reply.code(404).send({ error: '音声がまだありません' });
            return reply.send({ ok: true, key, source: clip.source, signed_url: signed.signedUrl });
        }

        if (action === 'upload') {
            const b64 = typeof body.audio_base64 === 'string' ? body.audio_base64 : '';
            if (!b64) return reply.code(400).send({ error: 'audio_base64 is required' });
            const buf = Buffer.from(b64, 'base64');
            if (buf.length === 0) return reply.code(400).send({ error: 'empty audio' });
            if (buf.length > MAX_CLIP_UPLOAD_BYTES) {
                return reply.code(413).send({ error: 'ファイルが大きすぎます（上限3MB）' });
            }
            // 通話で鳴らせない形式は受け取らない（鳴らせないクリップは無言電話になる・レビュー F）
            if (!detectAudioFormat(buf)) {
                return reply.code(415).send({ error: 'mp3・wav・m4a のファイルにしてください' });
            }
            const contentType = (typeof body.content_type === 'string' && body.content_type.startsWith('audio/'))
                ? body.content_type : 'audio/mpeg';
            const originalName = typeof body.original_filename === 'string'
                ? (body.original_filename.trim().slice(0, 200) || null) : null;
            const { error: upErr } = await supabase.storage
                .from(AUDIO_BUCKET).upload(path, buf, { contentType, upsert: true });
            if (upErr) throw new Error(upErr.message);
            const { error: updErr } = await supabase.from('audio_clips')
                .update({ source: 'recorded', audio_ready: true, recorded_filename: originalName, updated_at: new Date().toISOString() })
                .eq('playbook_id', pb.id).eq('key', key);
            if (updErr) throw new Error(updErr.message);
            bustTenantAudio(tenant_id, base);
            const { data: signed } = await supabase.storage
                .from(AUDIO_BUCKET).createSignedUrl(path, 300);
            console.log(`[clip-audio] upload tenant=${tenant_id} key=${key} bytes=${buf.length}`);
            return reply.send({ ok: true, key, source: 'recorded', audio_ready: true, recorded_filename: originalName, bytes: buf.length, signed_url: signed?.signedUrl ?? null });
        }

        // action === 'delete' (revert 肉声 → AI) or 'synthesize' (generate AI for
        // a clip): both (re)synthesize TTS from the clip's text. 'delete' on an
        // empty-text clip just clears it to no-audio; 'synthesize' needs text.
        const text = String(clip.text ?? '').trim();
        if (!text) {
            if (action === 'synthesize') {
                return reply.code(400).send({ error: 'テキストが空のためAI音声を生成できません' });
            }
            await supabase.from('audio_clips')
                .update({ source: 'tts', audio_ready: false, recorded_filename: null, updated_at: new Date().toISOString() })
                .eq('playbook_id', pb.id).eq('key', key);
            bustTenantAudio(tenant_id, base);
            return reply.send({ ok: true, key, source: 'tts', audio_ready: false, resynthesized: false });
        }
        const buf = await synthesizeClip(text, pb.voice || 'shimmer');
        const { error: upErr } = await supabase.storage
            .from(AUDIO_BUCKET).upload(path, buf, { contentType: 'audio/mpeg', upsert: true });
        if (upErr) throw new Error(upErr.message);
        const { error: updErr } = await supabase.from('audio_clips')
            .update({ source: 'tts', audio_ready: true, recorded_filename: null, updated_at: new Date().toISOString() })
            .eq('playbook_id', pb.id).eq('key', key);
        if (updErr) throw new Error(updErr.message);
        bustTenantAudio(tenant_id, base);
        console.log(`[clip-audio] ${action} tenant=${tenant_id} key=${key} bytes=${buf.length}`);
        return reply.send({ ok: true, key, source: 'tts', audio_ready: true, recorded_filename: null, resynthesized: true, bytes: buf.length });
    } catch (err) {
        console.error('[clip-audio] handler threw:', err);
        return reply.code(500).send({ error: '音声を保存できませんでした' });
    }
});

// 音声タブ（案件 → 台本の提案 → ElevenLabs のテイク → 選んで保存・上限）＝voice-ai.js
registerVoiceAi(fastify, {
    supabase, anthropic, verifyProvisionSecret, AUDIO_BUCKET, CLIP_TEMPLATE, INTENT_TEMPLATE, bustTenantAudio, detectAudioFormat,
    parseVoiceGender, scopePlaybookQuery, voiceSetBase,
});

// ---------------------------------------------------------------------
// 自動架電（作る順番の2番目）＝ログイン中の CM のブラウザが数秒おきにここを叩く。
// その CM が「空き」なら、その CM の担当分を、同時にかける件数の枠まで発信する。
// CM がタブを閉じれば叩かれなくなる＝架電も止まる（サーバ側に常駐の仕組みを持たない）。
// ---------------------------------------------------------------------
// 止めた理由（reason＝画面にそのまま出す文）と、声セットが揃っていないせいで止めた時だけ code（VOICE_NOT_READY）。
async function voiceSetGate(tenantId, projectId, gender = null, userId = null) {
    const { data: pb, error } = await resolvePlaybookRow(tenantId, projectId, gender);
    if (error) {
        console.error('[dial-tick] playbook lookup failed:', error.message);
        return { reason: '台本を読めませんでした' };
    }
    if (!pb) return { reason: '台本がありません（Voice Setup で台本と音声を設定してください）', code: VOICE_NOT_READY };
    const { data: clips, error: clipErr } = await supabase
        .from('audio_clips').select('key, audio_ready').eq('playbook_id', pb.id).eq('active', true);
    if (clipErr) {
        console.error('[dial-tick] clip audio check failed:', clipErr.message);
        return { reason: '音声を確かめられませんでした' };
    }
    if (!clips || clips.length === 0) return { reason: 'セリフが1件もありません（Voice Setup で台本を作ってください）', code: VOICE_NOT_READY };
    const missing = clips.filter((c) => !c.audio_ready).length;
    if (missing > 0) return { reason: `音声が未設定のセリフが ${missing} 件あるため架電できません`, code: VOICE_NOT_READY };
    // 名前で名乗る声セット＝架電する CM の名前の音声が要る（無いと「◯◯の」の後に名前が入らない）
    if (clips.some((c) => c.key === 'name_lead')) {
        const name = await ensureCmNameAudio(userId);
        if (!name.ok) {
            return name.reason === 'no_name'
                ? { reason: '名乗る名前が未登録です（Company › メンバーで名前を入れてください）', code: VOICE_NOT_READY }
                : { reason: '名乗る名前の音声を用意できませんでした' };
        }
    }
    return null;
}

// CM の名前の音声を作る（画面が名前・性別を保存した時と、招待を受けてアカウントができた時に叩く）。作り済みなら何もしない
fastify.post('/cm-name', async (request, reply) => {
    if (!verifyProvisionSecret(request)) {
        return reply.code(401).send({ error: 'unauthorized' });
    }
    const userId = String(request.body?.user_id || '').trim();
    if (!userId) return reply.code(400).send({ error: 'user_id is required' });
    const r = await ensureCmNameAudio(userId);
    return reply.send({ ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) });
});

fastify.post('/dial-tick', async (request, reply) => {
    if (!verifyProvisionSecret(request)) {
        return reply.code(401).send({ error: 'unauthorized' });
    }
    const userId = String(request.body?.user_id || '').trim();
    if (!userId) return reply.code(400).send({ error: 'user_id is required' });

    const { data: u, error: uErr } = await supabase
        .from('user_profiles')
        .select('id, tenant_id, is_active, is_online, call_state, call_state_at')
        .eq('id', userId)
        .maybeSingle();
    if (uErr) {
        console.error('[dial-tick] profile lookup failed:', uErr.message);
        return reply.code(500).send({ error: 'profile lookup failed' });
    }
    if (!u || !u.is_active) return reply.send({ ok: true, dialed: 0, reason: 'inactive' });

    // 通話中のまま残った状態の掃除＝取った通話がもう無く、2分以上たっていれば空きに戻す。
    if (u.call_state === 'on_call') {
        const stale = Date.now() - new Date(u.call_state_at).getTime() > 2 * 60 * 1000;
        const ringing = [...handoffs.values()].some((h) => h.agentId === userId);
        if (stale && !ringing) {
            const { count: live } = await supabase
                .from('call_sessions')
                .select('id', { count: 'exact', head: true })
                .eq('handled_by', userId)
                .eq('status', 'calling');
            if (!live) await setAgentState(userId, 'idle');
        }
        return reply.send({ ok: true, dialed: 0, reason: 'on_call' });
    }
    if (!u.is_online || u.call_state !== 'idle') {
        return reply.send({ ok: true, dialed: 0, reason: u.is_online ? u.call_state : 'offline' });
    }

    // 声はプロジェクトに1セット＝その CM の「今日」のプロジェクトの声で判定する
    const { data: cur } = await supabase
        .from('project_members')
        .select('project_id')
        .eq('user_id', userId)
        .eq('is_current', true)
        .limit(1)
        .maybeSingle();
    // 声セットは CM の性別でも選ぶ（Tom 2026-10-05）＝この CM の通話が鳴らすセットで判定する
    const gender = await operatorGender(userId);
    const gate = await voiceSetGate(u.tenant_id, cur?.project_id || null, gender, userId);
    if (gate) {
        console.log(`[dial-tick] blocked operator=${userId} reason=${gate.reason}`);
        return reply.send({ ok: true, dialed: 0, reason: gate.reason, ...(gate.code ? { code: gate.code } : {}) });
    }

    // 同時にかける件数＝この CM の分（「一人あたり3〜5件」か「人数に応じて自動」かは試しながら調整＝env）。
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count: inFlight } = await supabase
        .from('call_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('operator_id', userId)
        .in('status', ['pending', 'calling'])
        .gte('created_at', since);
    const slots = Math.max(0, PER_OPERATOR_CONCURRENCY - (inFlight || 0));
    if (slots === 0) return reply.send({ ok: true, dialed: 0, reason: 'at concurrency cap', in_flight: inFlight || 0 });

    const { data: claimed, error: claimErr } = await supabase
        .rpc('claim_contacts_for_operator', { p_user: userId, p_limit: slots });
    if (claimErr) {
        console.error('[dial-tick] claim failed:', claimErr.message);
        return reply.code(500).send({ error: 'claim failed' });
    }
    const contacts = claimed || [];
    if (contacts.length === 0) return reply.send({ ok: true, dialed: 0, reason: 'no 未架電 contacts' });

    const baseUrl = publicBaseUrl(request.headers.host);
    // 発信番号＝プロジェクトごとに1本（BAN 対策・家 §3-3）。付いていなければ共通の番号。
    const projectIds = [...new Set(contacts.map((c) => c.project_id).filter(Boolean))];
    const fromByProject = new Map();
    if (projectIds.length > 0) {
        const { data: nums, error: numErr } = await supabase
            .from('phone_numbers')
            .select('project_id, e164')
            .in('project_id', projectIds)
            .eq('status', 'active');
        if (numErr) console.error('[dial-tick] phone number lookup failed:', numErr.message);
        for (const n of nums || []) fromByProject.set(n.project_id, n.e164);
    }
    let dialed = 0;
    let failed = 0;
    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        try {
            await placeOutboundCall(baseUrl, c, {
                tenant_id: c.tenant_id,
                operator_id: userId,
                // 性別は発信の時に分かっている＝通話に載せて、つながった後のあいさつ前に DB を引かない
                operator_gender: gender,
                project_id: c.project_id,
                contact_id: c.id,
                from_number: fromByProject.get(c.project_id) || null,
            });
            dialed++;
        } catch (e) {
            failed++;
            console.error(`[dial-tick] dial failed for contact ${c.id}:`, e.message || e);
            // 日本の番号でない＝もう「要確認」に回した（未架電へ戻すと10秒おきに同じ所で止まる）
            if (e.code !== 'NON_JP_NUMBER') {
                const { error: revErr } = await supabase.rpc('unclaim_contact', { p_contact: c.id });
                if (revErr) console.error(`[dial-tick] unclaim failed for contact ${c.id}:`, revErr.message);
            }
        }
        if (i < contacts.length - 1) await new Promise((r) => setTimeout(r, DIAL_SPACING_MS));
    }
    return reply.send({ ok: true, dialed, failed, in_flight_before: inFlight || 0 });
});

// 保留音（<Enqueue waitUrl>）。Twilio が待っている間くり返し取りに来る。
// 1曲ずつ返す（loop="0" だと二度と取りに来ない）＝来るたびに保留の長さ（QueueTime）を見て、
// 上限を超えていたら <Leave/> で保留から出す → /queue-exit（レビュー C4）。
fastify.all('/hold-music', async (request, reply) => {
    const params = request.method === 'POST' ? (request.body || {}) : {};
    if (!isValidTwilioRequest(request, params)) {
        return reply.code(403).send({ error: 'invalid signature' });
    }
    const queueTime = parseInt(params.QueueTime || '0', 10) || 0;
    if (queueTime > HOLD_MAX_SECONDS) {
        console.log(`[handoff] ${params.CallSid || '(no sid)'} on hold ${queueTime}s > ${HOLD_MAX_SECONDS}s; leaving the queue`);
        return reply.type('text/xml').send('<Response><Leave/></Response>');
    }
    reply.type('text/xml').send(`<Response><Play>${xmlEsc(HOLD_MUSIC_URL)}</Play></Response>`);
});

// 保留から出た（<Enqueue action>）。取った CM との通話が終わった後にも来る。
// 上限の <Leave/> かエラーで出た時は、渡せる CM がいなかったのと同じ＝「改めてご連絡いたします」で切って要再架電。
// finishOverflow（REST で相手を切り替えた側）と二重に動かない＝handoff の finished を見る／result の上書きもしない。
fastify.post('/queue-exit', async (request, reply) => {
    const params = request.body || {};
    if (!isValidTwilioRequest(request, params)) {
        return reply.code(403).send({ error: 'invalid signature' });
    }
    const xml = (twiml) => reply.type('text/xml').send(twiml);
    const prospect = String(params.CallSid || '');
    const queueResult = String(params.QueueResult || '');

    // CM が取った＝その通話が終わった後に来る → 切るだけ
    if (queueResult === 'bridged' || queueResult === 'bridging-in-process') {
        return xml('<Response><Hangup/></Response>');
    }
    // 相手が切った／REST で切り替え済み（finishOverflow）→ 何もしない
    if (queueResult === 'hangup' || queueResult === 'redirected' || !prospect) {
        return xml('<Response/>');
    }

    const h = handoffs.get(prospect);
    if (h?.finished) return xml('<Response/>');
    if (h) {
        h.finished = true;
        // 鳴らしている CM がいれば止めて空きに戻す（出ても保留の相手はもういない）
        if (h.agentCallSid) {
            try {
                await twilioApi(`/Calls/${h.agentCallSid}.json`, { Status: 'canceled' });
            } catch (_) {
                try { await twilioApi(`/Calls/${h.agentCallSid}.json`, { Status: 'completed' }); }
                catch (err) { console.error('[handoff] could not stop the CM leg:', err.message); }
            }
        }
        if (h.agentId) await setAgentState(h.agentId, 'idle');
    }
    // 再起動で handoffs が消えていれば、通話の行から台本を引き直す
    const clipPath = h ? h.clipPath : await callbackClipPathFor(prospect);
    const twiml = await buildOverflow(prospect, clipPath);
    forgetHandoff(prospect);
    console.log(`[handoff] ${prospect} left the queue (${queueResult || 'unknown'}); nobody took it`);
    return xml(twiml);
});

// CM のブラウザが出た瞬間に Twilio が取りに来る＝保留中の相手とつなぐ。
fastify.all('/agent-bridge', async (request, reply) => {
    const params = request.method === 'POST' ? (request.body || {}) : {};
    if (!isValidTwilioRequest(request, params)) {
        return reply.code(403).send({ error: 'invalid signature' });
    }
    const prospect = String(request.query.prospect || '');
    const h = handoffs.get(prospect);
    // 保留の相手がもう出た（/queue-exit・finishOverflow）＝つなぐ先が無い
    if (!h || h.finished || !h.agentId) {
        return reply.type('text/xml').send('<Response><Hangup/></Response>');
    }
    const { error } = await supabase
        .from('call_sessions')
        .update({ handled_by: h.agentId })
        .eq('call_sid', prospect);
    if (error) console.error('[handoff] handled_by update failed:', error.message);
    console.log(`[handoff] CM ${h.agentId} picked up ${prospect}`);
    reply.type('text/xml').send(`<Response><Dial><Queue>${queueName(prospect)}</Queue></Dial></Response>`);
});

// CM 側の1本が終わった／出なかった。出た通話が終わった → 空きに戻す。出なかった → 離席にして次の人へ。
fastify.post('/agent-status', async (request, reply) => {
    const params = request.body || {};
    if (!isValidTwilioRequest(request, params)) {
        return reply.code(403).send({ error: 'invalid signature' });
    }
    const prospect = String(request.query.prospect || '');
    const h = handoffs.get(prospect);
    // 片付け中（finished）の handoff には触らない＝CM の状態は片付けた側が戻す
    if (!h || h.finished || params.CallSid !== h.agentCallSid) return reply.send({ ok: true, ignored: true });

    const status = params.CallStatus || '';
    const duration = params.CallDuration ? parseInt(params.CallDuration, 10) : 0;
    if (status === 'completed' && duration > 0) {
        // 取った電話が終わった＝CM は結果入力中。空きに戻すのは画面（結果を保存した時に set_my_presence idle）。
        // ここで idle にすると、入力の途中で次の電話が回ってきて画面が変わる（家 §3-3「画面の組み直し」）。
        await setAgentState(h.agentId, 'away');
        forgetHandoff(prospect);
        return reply.send({ ok: true, released: true });
    }
    console.log(`[handoff] CM ${h.agentId} did not pick up (${status}); trying the next CM`);
    await onAgentLegFailed(prospect, { markAway: true });
    return reply.send({ ok: true, retried: true });
});

// ---------------------------------------------------------------------
// 発信番号（作る順番の6番目）＝アプリの中から Twilio で 050 を買う／今ある番号を登録する。
// 買い方＝承認済みの Regulatory Bundle と、その Bundle に入っている住所を付けて買う（家 §3「▼ Twilio
// Regulatory Bundle と 050番号」）。050 は type=Local を Contains=8150* で絞る（National は 404）。
// 🔴 買う＝月額が発生する＝1回ごとに人（Tom）が画面で確認して押す。ここは言われた番号を買うだけ。
// ---------------------------------------------------------------------
const TWILIO_BUNDLE_SID = process.env.TWILIO_BUNDLE_SID || 'BU176d3e3a0538e56b0bcef459b2b4e8ec';
const TWILIO_ADDRESS_SID = process.env.TWILIO_ADDRESS_SID || 'AD2e3d30278b1b6aab805156d67342c62c';
const NUMBER_MONTHLY_JPY = parseFloat(process.env.NUMBER_MONTHLY_JPY || '766.64'); // 2026-09-10 Twilio Pricing API 実測

fastify.post('/numbers/available', async (request, reply) => {
    if (!verifyProvisionSecret(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
        const data = await twilioApi('/AvailablePhoneNumbers/JP/Local.json?Contains=8150*&VoiceEnabled=true&PageSize=10');
        const numbers = (data.available_phone_numbers || [])
            .filter((n) => String(n.phone_number || '').startsWith('+8150'))
            .map((n) => ({ phone_number: n.phone_number, friendly_name: n.friendly_name }));
        return reply.send({ ok: true, numbers, monthly_cost_jpy: NUMBER_MONTHLY_JPY });
    } catch (err) {
        console.error('[numbers] search failed:', err);
        return reply.code(502).send({ error: '空き番号を探せませんでした' });
    }
});

fastify.post('/numbers/owned', async (request, reply) => {
    if (!verifyProvisionSecret(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
        const data = await twilioApi('/IncomingPhoneNumbers.json?PageSize=100');
        const owned = (data.incoming_phone_numbers || []).map((n) => ({
            sid: n.sid,
            phone_number: n.phone_number,
            friendly_name: n.friendly_name,
        }));
        const { data: known } = await supabase.from('phone_numbers').select('twilio_sid, tenant_id');
        const knownBySid = new Map((known || []).map((k) => [k.twilio_sid, k.tenant_id]));
        return reply.send({
            ok: true,
            numbers: owned.map((n) => ({ ...n, registered_tenant_id: knownBySid.get(n.sid) || null })),
        });
    } catch (err) {
        console.error('[numbers] list failed:', err);
        return reply.code(502).send({ error: 'Twilio の番号を読めませんでした' });
    }
});

fastify.post('/numbers/purchase', async (request, reply) => {
    if (!verifyProvisionSecret(request)) return reply.code(401).send({ error: 'unauthorized' });
    const tenantId = String(request.body?.tenant_id || '').trim();
    const phoneNumber = String(request.body?.phone_number || '').trim();
    const friendlyName = String(request.body?.friendly_name || '').trim() || `AI Voice ${phoneNumber}`;
    if (!tenantId || !/^\+8150\d{8}$/.test(phoneNumber)) {
        return reply.code(400).send({ error: '050 の番号とテナントを指定してください' });
    }
    let bought;
    try {
        bought = await twilioApi('/IncomingPhoneNumbers.json', {
            PhoneNumber: phoneNumber,
            BundleSid: TWILIO_BUNDLE_SID,
            AddressSid: TWILIO_ADDRESS_SID,
            FriendlyName: friendlyName,
        });
    } catch (err) {
        console.error('[numbers] purchase failed:', err);
        return reply.code(502).send({ error: '番号を買えませんでした（Twilio が受け付けませんでした）' });
    }
    const { data: row, error } = await supabase
        .from('phone_numbers')
        .insert({
            tenant_id: tenantId,
            e164: bought.phone_number,
            twilio_sid: bought.sid,
            friendly_name: bought.friendly_name || friendlyName,
            monthly_cost_jpy: NUMBER_MONTHLY_JPY,
        })
        .select('id, e164, twilio_sid')
        .single();
    if (error) {
        // 買えたのに記録できなかった＝登録し直せば済む（番号は Twilio に在る）
        console.error(`[numbers] bought ${bought.sid} but could not record it:`, error.message);
        return reply.code(500).send({ error: `番号は買えましたが記録に失敗しました（${bought.phone_number}）。「Twilio にある番号を登録」から登録してください` });
    }
    console.log(`[numbers] purchased ${bought.phone_number} (${bought.sid}) for tenant ${tenantId}`);
    return reply.send({ ok: true, number: row });
});

fastify.post('/numbers/register', async (request, reply) => {
    if (!verifyProvisionSecret(request)) return reply.code(401).send({ error: 'unauthorized' });
    const tenantId = String(request.body?.tenant_id || '').trim();
    const sid = String(request.body?.sid || '').trim();
    if (!tenantId || !/^PN[0-9a-f]{32}$/.test(sid)) return reply.code(400).send({ error: 'テナントと番号の SID を指定してください' });
    let n;
    try {
        n = await twilioApi(`/IncomingPhoneNumbers/${sid}.json`);
    } catch (err) {
        console.error('[numbers] lookup failed:', err);
        return reply.code(404).send({ error: 'その番号は Twilio にありません' });
    }
    const { data: row, error } = await supabase
        .from('phone_numbers')
        .insert({
            tenant_id: tenantId,
            e164: n.phone_number,
            twilio_sid: n.sid,
            friendly_name: n.friendly_name,
            monthly_cost_jpy: String(n.phone_number || '').startsWith('+8150') ? NUMBER_MONTHLY_JPY : null,
            purchased_at: n.date_created ? new Date(n.date_created).toISOString() : new Date().toISOString(),
        })
        .select('id, e164, twilio_sid')
        .single();
    if (error) {
        if (!error.message.includes('duplicate')) console.error('[numbers] register failed:', error.message);
        return reply.code(400).send({ error: error.message.includes('duplicate') ? 'この番号はもう登録されています' : '番号を登録できませんでした' });
    }
    return reply.send({ ok: true, number: row });
});

fastify.all('/incoming-call', async (request, reply) => {
    // Same Twilio-signature gate as /recording-status. The kick-call WF
    // passes call params in the query string, which Twilio includes in the
    // signed URL; POST body params (if any) are appended per the spec.
    const params = request.method === 'POST' ? (request.body || {}) : {};
    if (!isValidTwilioRequest(request, params)) {
        console.error('[incoming-call] rejected request with bad signature');
        return reply.code(403).send({ error: 'invalid signature' });
    }

    // query は Fastify がもうデコード済み＝もう一度 decodeURIComponent すると、社名の「%」
    // （例「100%ジュース」）で URIError → 500 になり、相手に「application error」が流れて切れる（レビュー E1）。
    const q = (key, fallback = '') => xmlEsc(String(request.query[key] || fallback));
    // 客の社名・担当者名・番号は session_id から call_sessions を引く（監査 Low 5＝Url に客の情報を載せない）。
    // session_id の無い Url（デプロイ前に発信した通話・sim）は今までどおり query の値を使う。
    let company = q('company', 'unknown');
    let contact = q('contact', 'unknown');
    let phone = q('phone', 'unknown');
    const sessionId = String(request.query.session_id || '');
    if (sessionId) {
        const { data: sess, error: sessErr } = await supabase.from('call_sessions')
            .select('company_name, contact_name, phone_number')
            .eq('id', sessionId).maybeSingle();
        if (sessErr || !sess) {
            console.error(`[incoming-call] session ${sessionId} lookup failed:`, sessErr?.message || 'not found');
        } else {
            company = xmlEsc(String(sess.company_name || 'unknown'));
            contact = xmlEsc(String(sess.contact_name || 'unknown'));
            phone = xmlEsc(String(sess.phone_number || 'unknown'));
        }
    }
    const agent_phone = q('agent_phone');
    const agent_name = q('agent_name');
    const tenant_id = q('tenant_id');
    const operator_id = q('operator_id');
    const operator_gender = parseVoiceGender(request.query.operator_gender) || '';
    const project_id = q('project_id');
    const contact_id = q('contact_id');
    const streamUrl = `${publicBaseUrl(request.headers.host).replace(/^http/, 'ws')}/media-stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${xmlEsc(streamUrl)}">
            <Parameter name="company" value="${company}" />
            <Parameter name="contact" value="${contact}" />
            <Parameter name="phone" value="${phone}" />
            <Parameter name="agent_phone" value="${agent_phone}" />
            <Parameter name="agent_name" value="${agent_name}" />
            <Parameter name="tenant_id" value="${tenant_id}" />
            <Parameter name="operator_id" value="${operator_id}" />
            <Parameter name="operator_gender" value="${operator_gender}" />
            <Parameter name="project_id" value="${project_id}" />
            <Parameter name="contact_id" value="${contact_id}" />
            <Parameter name="stream_token" value="${issueStreamToken()}" />
        </Stream>
    </Connect>
</Response>`;
    reply.type('text/xml').send(twiml);
});

// =====================================================================
// Per-call WebSocket handler
// =====================================================================

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        const publicHost = req?.headers?.host || '';
        console.log('▶ Twilio client connected');

        // --- Pre-auth gate (review finding #6) ---------------------------
        // The WS upgrade itself carries no Twilio signature; a socket is only
        // trusted once it sends a valid 'start' with a good one-time
        // stream_token. Cap concurrent unauthenticated sockets and close any
        // that don't authenticate within WS_PREAUTH_TIMEOUT_MS so an attacker
        // can't connect and idle to exhaust resources.
        let authenticated = false;
        const clientIp = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
            || req?.socket?.remoteAddress || 'unknown';
        if ((unauthWsByIp.get(clientIp) || 0) >= MAX_UNAUTH_WS_PER_IP) {
            console.error(`[media-stream] too many unauthenticated sockets from one client (≥ ${MAX_UNAUTH_WS_PER_IP}); refusing`);
            try { connection.close(); } catch (_) {}
            return;
        }
        if (unauthWsCount >= MAX_UNAUTH_WS) {
            console.error(
                `[media-stream] too many unauthenticated sockets (${unauthWsCount} ≥ ${MAX_UNAUTH_WS}); refusing`
            );
            try { connection.close(); } catch (_) {}
            return;
        }
        unauthWsCount++;
        unauthWsByIp.set(clientIp, (unauthWsByIp.get(clientIp) || 0) + 1);
        let preAuthTimer = setTimeout(() => {
            preAuthTimer = null;
            if (!authenticated) {
                console.error(
                    `[media-stream] no valid start within ${WS_PREAUTH_TIMEOUT_MS}ms; closing unauthenticated socket`
                );
                try { connection.close(); } catch (_) {}
            }
        }, WS_PREAUTH_TIMEOUT_MS);
        const clearPreAuth = () => {
            if (preAuthTimer) {
                clearTimeout(preAuthTimer);
                preAuthTimer = null;
            }
        };
        // Decrement the unauthenticated-socket counter exactly once per socket,
        // whether the socket authenticated, was rejected, or just closed.
        let slotReleased = false;
        const releaseUnauthSlot = () => {
            if (slotReleased) return;
            slotReleased = true;
            if (unauthWsCount > 0) unauthWsCount--;
            const n = (unauthWsByIp.get(clientIp) || 0) - 1;
            if (n > 0) unauthWsByIp.set(clientIp, n); else unauthWsByIp.delete(clientIp);
        };

        // Identity
        let streamSid = null;
        let callSid = null;
        let callParams = {};
        // Per-tenant playbook (script + clips + intents), loaded at 'start'.
        let cfg = null;

        // State machine
        // 'INITIAL' | 'AWAIT_ANSWER' | 'PLAYING' | 'LISTENING' | 'PROCESSING' | 'REALTIME' | 'ENDED'
        let state = 'INITIAL';

        // Realtime fallback
        let realtimeWs = null;
        let lastUserTranscript = null;

        // Re-prompt tracking. consecutiveEmpty counts back-to-back utterances
        // we couldn't act on; it resets the moment we get a usable one.
        // pardonIndex rotates across the tenant's pardon clips.
        let consecutiveEmpty = 0;
        let pardonIndex = 0;

        // 取次のつまみ（transfer_settings の行）。null＝今の挙動。通話の始めに1回読んで固定（家＝~/sente/sfav_transfer_tuning_plan.md）
        let ts = null;
        // 待機（受付に「少々お待ちください」と言われて保留中）＝状態とは別に持つ。{ startedAt, deadline }
        let waitCtx = null;
        // 待機中は処理している間も音を受け続ける＝その間に閉じた発話は最新の1つだけ持ち越す
        let pendingUtterance = null; // { audio, forced }
        // 処理している間も音を受け続ける（待機中と、6秒で区切った発話の処理中）＝§1-d
        let captureWhileProcessing = false;
        // 処理中に相手の続きの言葉が来た時のつなぎ（2026-10-06 Tom go）＝「あ、」で閉じた発話の判定を捨てて、続きとつないで判定し直す。
        // 💥 KWK の試しの電話＝「あ」＋0.5秒の間で発話を閉じ、処理中に来た「用件はなんですか？」を捨てて聞き返しを繰り返した
        let carryAudio = null;  // 捨てた判定の発話（次に閉じる発話の頭へつなぐ）
        let turnSeq = 0;        // 発話ごとの番号
        let liveTurn = 0;       // いま生きている判定の番号（つなぎ直した判定は 0 で止まる）
        let mergeTurn = null;   // { turn, audio }＝つなぎ直してよい判定（待機中・6秒で区切った発話は今の持ち越しの形のまま）
        // 切れ端の上限＝先読み0.3秒＋閉じる0.8秒＋話した0.5秒（8kHz μ-law＝1秒8,000バイト）。KWK の「あ」は 5,120 バイト
        const MERGE_MAX_FRAGMENT_BYTES = 12800;
        // 言いかけ（「責任者のもの」「あのー」）には返さず、文字起こしの後この時間だけ続きを待つ（2026-10-08 森さん FB）
        const INCOMPLETE_WAIT_MS = 1500;
        let held = null;        // { audio, transcript }＝返さずに持っている言いかけ
        let heldTimer = null;
        // 不在の流れの段（null／asked＝戻りの時間を聞いた／proposed＝明日の午後を出した）
        let absentStage = null;
        let absentAsked = false; // 1通話に1回だけ聞く（段を抜けた後にもう一度「不在」と言われても聞き直さない）
        // 「もう一度」で流し直す、最後に流し終えた返答の列（つなぎの「はい」と聞き返しは入れない）
        let lastResponseSeq = null;
        let repeatCount = 0;
        let thanksSaidAt = 0; // 相づちの「ありがとうございます」を言い終えた時刻＝直後の「ありがとうございます…」の台本は頭を落として流す
        const REPEAT_MAX = 2;
        let lastRecorded = null; // { turn, text }＝同じ発話の繰り返しの数に最後に入れた発話（捨てた切れ端を外すため）
        // あいさつは相手の第一声が終わってから流す（2026-10-06 Tom「最初は向こうが名乗るだろうから、それを待ってから自己紹介」＝声セットの家 D7 を覆した）
        // 💥 森さんの試しの電話＝電話の録音の案内とあいさつが重なり、想定外の返事から自由会話へ落ちた
        const ANSWER_QUIET_MS = 2500; // だれも話さなければこの時間であいさつ
        const ANSWER_MAX_MS = 8000;   // 相手が話し続けても（録音の案内など）この時間であいさつ
        // ププッの見分け＝声の線を越えた枠が 0.3秒未満・400〜500Hz の1本の音に 50% 以上が集まる（20ms ごとに測った平均）
        //   （録音10本のププッは 0.12秒・0.88／短い「はい」0.11・人の声 0.01＝2026-10-10 実測）
        const ANSWER_BEEP_MAX_S = 0.3;
        const ANSWER_BEEP_MIN_RATIO = 0.5;
        const pickupBeepOf = (mulaw) => {
            const voiced = [];
            for (let i = 0; i + 160 <= mulaw.length; i += 160) {
                const fr = mulaw.subarray(i, i + 160);
                if (calculateRms(fr) > VAD_RMS_THRESHOLD) for (const b of fr) voiced.push(muLawDecode(b));
            }
            return { seconds: voiced.length / 8000, ratio: pickupBeepToneRatio(voiced) };
        };
        let answerTimers = [];
        // 設定を読めず今の挙動で動いた通話（判定の記録に event=fallback を1行残す）
        let tsFallback = false;
        // 取次と終了の取り合い（段0）＝aborted は「切れた／こちらが切った」。
        // transferPhase が committing／committed の間は取次が通話を持っている＝終了の処理は手を出さない
        let aborted = false;
        let transferPhase = 'none'; // none | claiming | committing | committed
        let sessionIdPromise = null;
        // 版6＝取次は1通話に1回（commitTransfer だけが立てる）／受付の言葉を聞いた時刻（保留音の「言葉の後」の判定）
        let transferCommitted = false;
        let announcedAt = 0;
        // 版6＝保留音の検知（発話の VAD とは別の時計）。20ms の枠ごとに音量を見て、切れ目の短い連続を数える
        let holdRing = [];
        let holdRun = null;      // { start, lastLoud, rms: [] }（枠の番号）
        let holdFrame = 0;
        let holdCheckInFlight = false;
        let holdCooldownUntil = 0;
        // 保留音の候補（文字起こしまで済んだ物）＝処理中・持ち越しの発話があれば、その判定が終わるまで取っておいて決め直す
        let holdCandidate = null; // { seconds, rms, text, at }
        // こちらが話している間と話し終えた直後0.8秒は保留音を数えない（つなぎの「はい」も含む＝codex レビュー 6）
        let playbackActive = 0;
        let holdQuietUntil = 0;

        // VAD
        const VAD_RMS_THRESHOLD = 2000;
        const SPEECH_START_FRAMES = 3;   // 3 consecutive frames (~60ms) required
        const SILENCE_END_FRAMES = 40;   // 40 frames * 20ms = 800ms of silence ends utterance（2026-10-08 森さん「返しが早い」＝0.5秒→0.8秒）
        const MIN_UTTERANCE_BYTES = 4000; // ~500ms of audio (8kHz mulaw)
        const CALL_START_GRACE_MS = 5000;  // ignore inbound audio for the first 5s (Twilio trial preamble)
        const POST_PLAYBACK_DELAY_MS = 800; // wait this long after a clip before re-arming VAD
        // 相づちは文字起こしが返ったらすぐ流す（言い終わりの判定の 0.8秒が人の間の代わり）。
        //   2026-10-10 Tom「じゃあ0.8秒で」＝人の CM の返事は 90% が言い終わりから 0.8秒以内（SF の録音 465本）＝旧 600ms の待ちを外した
        const HUMAN_PAUSE_MS = 0;
        // 黙って 0.3秒で文字起こしを先に始める（言い終わりの判定は 0.8秒のまま）＝閉じた時に結果が出ていれば相づちは 0.8秒で出る。
        //   その前に話し始めたら捨てる（音も文字起こしもやり直し）
        const EARLY_STT_FRAMES = 15;
        // 先に始めた後にこれより大きい音が1枚でも来たら使わない＝閉じた時の全部の音で取り直す（codex 監査2回）。
        //   線は保留音の「音あり」と同じ 350＝小声も拾う側に倒す（回線の雑音で超えても、いつもの文字起こしに戻るだけ）
        const EARLY_STT_QUIET_RMS = 350; // ＝HOLD_RMS_THRESHOLD（下で宣言）
        let earlyStt = null; // { chunks, promise, maxRms }＝speechChunks の同じ配列・その後ずっと静かだった時だけ使う
        // 話している最中から流す文字起こし（createLiveStt）。liveFor＝いま流している発話の speechChunks（区切った・崩れたら null）
        let liveStt = null;
        let liveFor = null;
        // 先に始めた文字起こしを捨てる（失敗しても、捨てた音でファイルの文字起こしを走らせない）
        const dropEarly = () => { if (earlyStt) earlyStt.cancelled = true; earlyStt = null; };
        let adoptedEarly = null; // 閉じた発話に使った先の文字起こし（つなぎ直しで判定を捨てた時に止める）
        const PREROLL_FRAMES = 15;       // ~300ms kept before VAD confirms speech, so soft onsets aren't clipped
        const MAX_UTTERANCE_FRAMES = 300; // 6s＝設定が在る通話の1発話の上限（§1-d）
        const HOLD_RMS_THRESHOLD = 350;   // 保留音の「音あり」の線＝発話の線（2000）より低い＝小さな保留音も拾う（試しの電話で決め直す）
        const HOLD_GAP_FRAMES = 50;       // 1.0s 未満の休みはつなぐ（音楽の小節の休み）
        const HOLD_RING_FRAMES = 800;     // 16s ぶんの音を手元に持つ（候補の区間を文字起こしへ回す）
        const SPLIT_OVERLAP_FRAMES = 50;  // 1s＝区切った時に次の発話の頭へ重ねる分
        let speechActive = false;
        let speechStartedAt = 0; // 今の発話の話し始め（保留音の候補の後に話し始めたかを見る）
        let speechFrames = 0;
        let silenceFrames = 0;
        let speechChunks = [];
        let preRoll = [];                // rolling buffer of the most recent frames while listening
        let vadEnabled = false;
        let vadEnableTimer = null;
        let callStartTime = 0;

        // -----------------------------------------------------------------
        // Call-termination tracking (timeouts, loop detection, errors)
        // -----------------------------------------------------------------
        // Updated when the caller starts speaking (VAD start) or after we
        // confirm a transcript. checkTimeouts compares it against now() to
        // fire silence_timeout. Initialized to call-start so we don't wait
        // forever when the caller never says anything.
        let lastSpeechAt = Date.now();
        let callStartAt = Date.now();
        // Rolling windows for loop detection. Each holds the last N items;
        // the recordX helpers below trim them in place.
        let recentClaudeDecisions = [];
        let recentUserUtterances = [];
        let endReason = null;
        let timeoutInterval = null;
        // The most recent audio key/filename passed to playAudio. Used by
        // endCallWithFarewell to suppress the farewell clip when the
        // closing recording already says 「失礼いたします」.
        let lastPlayedAudioKey = null;
        // Realtime connection-failure tracking — flips true on 'open',
        // stays false if the connection fails before opening.
        let realtimeOpened = false;

        const resetVadCapture = () => {
            liveFor = null;
            dropEarly();
            speechActive = false;
            speechFrames = 0;
            silenceFrames = 0;
            speechChunks = [];
            preRoll = [];
        };

        // 言いかけの持ち（held）を捨てる＝待機・取次・終話・切断で
        const dropHeld = (why) => {
            if (heldTimer) { clearTimeout(heldTimer); heldTimer = null; }
            if (held) console.log(`[held] dropped (${why})`);
            held = null;
        };

        const disableVad = (reason) => {
            if (vadEnableTimer) {
                clearTimeout(vadEnableTimer);
                vadEnableTimer = null;
            }
            if (vadEnabled) console.log(`[vad] disabled (${reason})`);
            vadEnabled = false;
            captureWhileProcessing = false;
            pendingUtterance = null;
            resetVadCapture();
        };

        const enableVadDelayed = (minDelayMs, reason) => {
            if (vadEnableTimer) clearTimeout(vadEnableTimer);
            const sinceStart = callStartTime ? Date.now() - callStartTime : 0;
            const remainingGrace = Math.max(0, CALL_START_GRACE_MS - sinceStart);
            const delay = Math.max(minDelayMs, remainingGrace);
            vadEnableTimer = setTimeout(() => {
                vadEnableTimer = null;
                // 待機中は処理している間も聞く（持ち越しの発話を処理中でも次の声を捨てない）
                if (state !== 'LISTENING' && !(state === 'PROCESSING' && waitCtx)) {
                    console.log(`[vad] enable timer fired but state=${state}; staying disabled`);
                    return;
                }
                vadEnabled = true;
                resetVadCapture();
                console.log(`[vad] enabled (after ${delay}ms, ${reason})`);
            }, delay);
        };

        // Playback / mark tracking
        let markCounter = 0;
        let currentPlaybackToken = null;
        const pendingMarks = new Map(); // markName -> resolve()

        // -----------------------------------------------------------------
        // Supabase transcript persistence (preserved from previous version)
        // -----------------------------------------------------------------
        const saveTranscript = (role, content) => {
            const trimmed = content?.trim();
            console.log(
                `[saveTranscript] called role=${role} callSid=${callSid} ` +
                    `contentLen=${trimmed?.length ?? 0}`
            );
            if (!callSid) {
                console.warn('[saveTranscript] SKIPPED: callSid is missing');
                return;
            }
            if (!trimmed) {
                console.warn('[saveTranscript] SKIPPED: content is empty');
                return;
            }
            supabase
                .from('call_sessions')
                .select('id')
                .eq('call_sid', callSid)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()
                .then(({ data, error }) => {
                    console.log(
                        `[saveTranscript] session lookup callSid=${callSid} ` +
                            `result=${JSON.stringify(data)} error=${JSON.stringify(error)}`
                    );
                    if (error || !data) {
                        console.error('[saveTranscript] Session lookup failed:', error);
                        return;
                    }
                    return supabase
                        .from('call_transcripts')
                        .insert({
                            session_id: data.id,
                            role,
                            content: trimmed,
                        })
                        .then(({ error: insErr }) => {
                            if (insErr) {
                                console.error(
                                    `[saveTranscript] INSERT FAILED session_id=${data.id} role=${role}:`,
                                    insErr
                                );
                            } else {
                                console.log(
                                    `[saveTranscript] ✓ INSERT OK session_id=${data.id} role=${role} len=${trimmed.length}`
                                );
                            }
                        });
                })
                // Terminal catch: saveTranscript is fire-and-forget, so without
                // this a thrown/rejected query would surface as an unhandled
                // promise rejection and could crash the process.
                .catch((err) => {
                    console.error(`[saveTranscript] unexpected error callSid=${callSid}:`, err);
                });
        };

        // -----------------------------------------------------------------
        // Twilio output helpers
        // -----------------------------------------------------------------
        const sendMedia = (base64Payload) => {
            if (!streamSid) return;
            connection.send(
                JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: base64Payload },
                })
            );
        };

        const sendMark = (name) => {
            if (!streamSid) return;
            connection.send(
                JSON.stringify({
                    event: 'mark',
                    streamSid,
                    mark: { name },
                })
            );
        };

        const clearTwilioBuffer = () => {
            if (!streamSid) return;
            connection.send(JSON.stringify({ event: 'clear', streamSid }));
        };

        // -----------------------------------------------------------------
        // Playback (one key → cached mulaw → chunked → mark → await)
        // -----------------------------------------------------------------
        const playAudio = async (key) => {
            // 相づちの「ありがとうございます」の直後（2秒以内）に「ありがとうございます」で始まる台本＝頭を落とした方（二重に言わない）
            if (thanksSaidAt && key !== cfg?.thanksKey) {
                const recent = Date.now() - thanksSaidAt < 2000;
                thanksSaidAt = 0;
                const sub = recent ? cfg?.thanksRestKey?.get(key) : undefined;
                if (sub === '') return 'done';
                if (sub) key = sub;
            }
            playbackActive++;
            try {
                return await playAudioInner(key);
            } finally {
                playbackActive--;
                holdQuietUntil = Date.now() + POST_PLAYBACK_DELAY_MS;
            }
        };
        // 台本の1本を流す＝社名の答え（company）は、名前で名乗る声セットなら後ろに CM の名前をつなぐ
        //   返す値＝'done'（全部流し終えた）／'missing'（音が無い・読めない）／'cancelled'（止められた・切れた）。
        //   流し終えた返答は「もう一度」で流し直す列として持つ（record=false＝流し直しそのもの）
        const playClip = async (key, { record = true } = {}) => {
            const seq = [key];
            let r = await playAudio(key);
            if (r === 'done' && key === 'company' && cfg?.clips?.has('name_lead') && cfg.clips.has('cm_name') && state === 'PLAYING') {
                seq.push('cm_name');
                r = await playAudio('cm_name');
            }
            if (r === 'done' && record) { lastResponseSeq = seq; repeatCount = 0; }
            return r;
        };
        const playSeq = async (keys) => {
            for (const k of keys) {
                const r = await playAudio(k);
                if (r !== 'done') return r;
                if (state !== 'PLAYING') return 'cancelled';
            }
            return 'done';
        };
        const playAudioInner = async (key) => {
            const token = ++markCounter;
            currentPlaybackToken = token;

            const clip = cfg?.clips.get(key);
            if (!clip) {
                console.error(`[playAudio] unknown clip "${key}" for tenant ${cfg?.tenantId}`);
                return 'missing';
            }
            const loadT0 = Date.now();
            let mulaw;
            try {
                mulaw = await getAudioBuffer(cfg, key);
            } catch (err) {
                console.error(`Failed to load ${key}:`, err.message);
                return 'missing';
            }
            const loadMs = Date.now() - loadT0;
            if (currentPlaybackToken !== token) return 'cancelled'; // Interrupted while loading

            console.log(`▶ Playing ${key} (${clip.filename}) load=${loadMs}ms size=${mulaw.length}B`);
            // Record what we just played so endCallWithFarewell can decide
            // whether to append the farewell clip or not.
            lastPlayedAudioKey = key;
            const chunkSize = 160; // 20ms at 8kHz mulaw
            for (let i = 0; i < mulaw.length; i += chunkSize) {
                if (currentPlaybackToken !== token) return 'cancelled';
                sendMedia(mulaw.subarray(i, i + chunkSize).toString('base64'));
            }

            const markName = `mark-${token}`;
            // Await the Twilio mark, but never hang forever if the mark never
            // arrives (socket stalled / Twilio dropped it). Time out after the
            // clip's playback duration (8kHz mulaw = 1 byte/sample → ms =
            // bytes/8) plus a generous margin, then resolve and continue so the
            // call can still end/advance instead of wedging on this await.
            const clipDurationMs = Math.ceil(mulaw.length / 8);
            const markTimeoutMs = clipDurationMs + 5000;
            await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    pendingMarks.delete(markName);
                    resolve();
                };
                const timer = setTimeout(() => {
                    if (done) return;
                    console.warn(
                        `[playAudio] mark "${markName}" timed out after ${markTimeoutMs}ms ` +
                            `(clip=${key}); continuing without it`
                    );
                    finish();
                }, markTimeoutMs);
                pendingMarks.set(markName, finish);
                sendMark(markName);
            });

            console.log(`✓ Finished ${key}`);
            saveTranscript('assistant', clip.text || '');
            // 流し終えた後に通話が切れていた・止められた＝届いたとは限らない
            if (state === 'ENDED' || currentPlaybackToken !== token) return 'cancelled';
            return 'done';
        };

        // -----------------------------------------------------------------
        // Greeting flow (single clip)
        // -----------------------------------------------------------------
        const clearAnswerTimers = () => {
            for (const t of answerTimers) clearTimeout(t);
            answerTimers = [];
        };
        // つながったら（start の時点から）聞き始め、相手の第一声が終わってからあいさつ（2.5秒だれも話さない・8秒たっても流す）。
        // 声セットの読込が終わるまではあいさつを持ち越す（greetPending）＝読込の間の名乗りも捨てない（codex レビュー）
        let greetReady = false;
        let greetPending = null;
        const awaitAnswer = () => {
            if (aborted || state === 'ENDED') return;
            state = 'AWAIT_ANSWER';
            if (vadEnableTimer) {
                clearTimeout(vadEnableTimer);
                vadEnableTimer = null;
            }
            resetVadCapture();
            vadEnabled = true;
            console.log('▶ State: AWAIT_ANSWER');
            answerTimers.push(setTimeout(() => {
                if (state === 'AWAIT_ANSWER' && !speechActive) greetAfterAnswer('quiet');
            }, ANSWER_QUIET_MS));
            answerTimers.push(setTimeout(() => {
                if (state !== 'AWAIT_ANSWER') return;
                // 話し続けている（留守電の案内など）＝そこまでの音も留守電の判定に回す
                if (speechActive && speechChunks.length) checkAnswerUtterance(Buffer.concat(speechChunks));
                greetAfterAnswer('max');
            }, ANSWER_MAX_MS));
        };
        // 声セットを読み終えた＝持ち越したあいさつを流す（無言で持ち越した後に相手が話し始めていたら、その声の終わりを待つ）
        const answerReady = () => {
            greetReady = true;
            // 読み終える前に文字起こしが終わった第一声＝ここで留守電の判定をやり直す
            if (answerText != null) {
                const t = answerText;
                answerText = null;
                if (judgeAnswerVoicemail(t)) return;
            }
            if (state !== 'AWAIT_ANSWER' || !greetPending) return;
            // 相手がまた話している＝その声の終わりを待つ（8秒の上限だけはそのまま流す）
            if (greetPending !== 'max' && speechActive) { greetPending = null; return; }
            greetAfterAnswer(greetPending);
        };
        let answerText = null; // 声セットを読み終える前に文字起こしが終わった第一声
        const judgeAnswerVoicemail = (t) => {
            const vm = (cfg?.voicemailPatterns || []).find((p) => t.includes(p));
            if (!vm || state === 'ENDED' || transferCommitted) return false;
            console.log(`[voicemail] first utterance matched "${vm}"; hanging up without farewell`);
            currentPlaybackToken = ++markCounter;
            clearTwilioBuffer();
            endCallWithFarewell('voicemail', { playFarewell: false }).catch(() => {});
            return true;
        };
        // 第一声を文字起こしして残す＋留守電の案内なら、あいさつを止めて黙って切る（今までどおり留守電に声を残さない）
        let answerCheckPromise = null; // 第一声の文字起こし＋留守電の判定（終わるまで CM へのつなぎを待たせる）
        const checkAnswerUtterance = (audio) => {
            if (audio.length < MIN_UTTERANCE_BYTES) return;
            const p = transcribeWhisper(audio, cfg?.transcriptionPrompt)
                .then((t) => {
                    if (!t) return;
                    saveTranscript('user', t);
                    if (!greetReady) { answerText = t; return; } // 読み終えてから判定する（answerReady）
                    judgeAnswerVoicemail(t);
                })
                .catch((err) => console.error('[answer] transcribe failed:', err));
            answerCheckPromise = p;
            p.finally(() => { if (answerCheckPromise === p) answerCheckPromise = null; });
        };
        const greetAfterAnswer = (why) => {
            if (state !== 'AWAIT_ANSWER') return;
            if (!greetReady) {
                greetPending = greetPending || why;
                return;
            }
            greetPending = null;
            clearAnswerTimers();
            console.log(`[answer] greeting after ${why}`);
            playGreeting().catch((err) => {
                console.error('[answer] greeting failed:', err);
                endCallWithFarewell('error_limit').catch(() => {});
            });
        };

        const playGreeting = async () => {
            if (aborted || state === 'ENDED') return; // 読込の間に切れた
            clearAnswerTimers();
            state = 'PLAYING';
            disableVad('playing greeting');
            // 名前で名乗る声セット＝「お世話になっております。◯◯の」→ CM の名前（後ろに間つき）→ 用件〜取次の頼み
            if (cfg?.clips?.has('name_lead') && cfg.clips.has('cm_name')) {
                await playAudio('name_lead');
                if (state !== 'PLAYING') return;
                await playAudio('cm_name');
                if (state !== 'PLAYING') return;
            } else if (cfg?.clips?.has('name_lead')) {
                // 関門で止まるはずの形（受電・手動・名前の音の読み損ね）＝名前を抜いて「◯◯の」から用件へつなぐ
                console.error('[greeting] name_lead set without the operator name audio; skipping the name');
                await playAudio('name_lead');
                if (state !== 'PLAYING') return;
            }
            if (cfg?.greetingKey) await playAudio(cfg.greetingKey);
            if (state !== 'PLAYING') return;
            // 「もう一度」で流し直す列＝あいさつは名乗りから（名前の音が無い声セットは在る物だけ）
            lastResponseSeq = ['name_lead', 'cm_name', cfg?.greetingKey].filter((k) => k && cfg?.clips?.has(k));

            state = 'LISTENING';
            // Reset the silence clock now that we're actually listening —
            // gives the caller a clean SILENCE_TIMEOUT_MS window to respond.
            lastSpeechAt = Date.now();
            console.log('▶ State: LISTENING');
            enableVadDelayed(POST_PLAYBACK_DELAY_MS, 'after greeting');
        };

        // -----------------------------------------------------------------
        // Hand off the live call to a human agent via Twilio Calls API.
        // Called after the transfer_success clip has finished playing.
        //
        // Concurrent calls: only one transfer per (tenant, agent) at a
        // time. If the lock is held by another call, fall back to the
        // callback flow so the prospect doesn't hear silence. Lock is
        // kept after a successful transfer and auto-expires via TTL —
        // there is no live-call signal we can use to release it early.
        // -----------------------------------------------------------------
        // 作る順番の2番目（家 §3-2）＝相手を保留（保留音）にして、空いている CM のブラウザへつなぐ。
        // 渡す相手＝かけた本人 → 同じプロジェクトで一番長く空いている人 → 誰もいなければ
        // 「改めてご連絡いたします」で切って、要再架電を付ける。
        const handoffToBrowser = async () => {
            const tenantId = callParams.tenant_id;
            const projectId = callParams.project_id;
            const operatorId = callParams.operator_id || null;
            let agentId = null;
            transferPhase = 'claiming';
            try {
                agentId = await claimAgent(projectId, operatorId, []);
            } catch (err) {
                console.error('[handoff] claim agent failed:', err);
            }
            // CM を確保している間に切れた・こちらが切った＝確保を戻して抜ける（段0）
            if (aborted) {
                console.log('[handoff] call ended while claiming a CM; releasing');
                transferPhase = 'none';
                if (agentId) await setAgentState(agentId, 'idle');
                return;
            }
            if (!agentId) {
                transferPhase = 'none';
                console.log(`[handoff] no free CM in project ${projectId}; asking to call back later`);
                if (cfg?.clips.has('callback_request')) {
                    try {
                        await playAudio('callback_request');
                    } catch (err) {
                        console.error('[handoff] callback_request playback failed:', err);
                    }
                }
                await endCallWithFarewell('overflow_recall', { playFarewell: false });
                return;
            }

            const clip = cfg?.clips.get('callback_request');
            registerHandoff(callSid, {
                tenantId,
                projectId,
                agentId: null,
                agentCallSid: null,
                excluded: [],
                baseUrl: publicBaseUrl(publicHost),
                clipPath: clip ? (cfg.audioBasePath ? `${cfg.audioBasePath}/${clip.filename}` : clip.filename) : null,
            });
            if (aborted) {
                transferPhase = 'none';
                await setAgentState(agentId, 'idle');
                forgetHandoff(callSid);
                return;
            }
            // ここから Twilio を <Enqueue> へ切り替える＝成否が出るまで終了の処理は手を出さない（段0）
            transferPhase = 'committing';
            try {
                await updateLiveCall(callSid, enqueueTwiml(publicBaseUrl(publicHost), callSid));
            } catch (err) {
                console.error('[handoff] could not put the caller on hold:', err);
                transferPhase = 'none';
                await setAgentState(agentId, 'idle');
                forgetHandoff(callSid);
                await endCallWithFarewell('error_limit');
                return;
            }
            transferPhase = 'committed';
            // The live call now runs the <Enqueue> TwiML; this media stream is over.
            state = 'ENDED';
            const { error: updErr } = await supabase
                .from('call_sessions')
                .update({ result: 'transferred' })
                .eq('call_sid', callSid);
            if (updErr) console.error('[handoff] call_sessions update error:', updErr);
            try {
                await dialAgent(callSid, agentId);
            } catch (err) {
                console.error('[handoff] could not ring the CM:', err);
                await onAgentLegFailed(callSid, { markAway: false, agentId });
            }
        };

        const handleTransfer = async () => {
            if (aborted) return; // 「おつなぎします」の最中に切れた（段0）
            disableVad('transferring');
            const tenantId = callParams?.tenant_id;
            const agentPhone = callParams?.agent_phone;
            const agentName = callParams?.agent_name;

            // 担当 CM とプロジェクトが付いた通話（自動架電）は、保留音 → ブラウザ。
            // 手動の「Make a Call」（担当者の携帯へ直結）はこれまでどおり下の経路。
            if (callSid && tenantId && callParams?.project_id) {
                await handoffToBrowser();
                return;
            }

            if (!callSid) {
                console.error('[transfer] callSid missing; cannot transfer');
                state = 'ENDED';
                return;
            }
            if (!tenantId || !agentPhone) {
                console.error(
                    `[transfer] missing tenant_id (${tenantId || 'none'}) or ` +
                        `agent_phone (${agentPhone ? 'set' : 'none'}); cannot transfer`
                );
                await endCallWithFarewell('error_limit');
                return;
            }

            if (!acquireTransferLock(tenantId, agentPhone, callSid)) {
                console.log(
                    `[transfer] agent ${maskPhone(agentPhone)} already busy with another call; ` +
                        `falling back to callback flow`
                );
                if (cfg?.clips.has('callback_request')) {
                    try {
                        await playAudio('callback_request');
                    } catch (err) {
                        console.error('[transfer] callback_request playback failed:', err);
                    }
                }
                await endCallWithFarewell('callback_scheduled', { playFarewell: false });
                return;
            }

            console.log(
                `[transfer] handing off callSid=${callSid} to ${agentName || '(no name)'} <${maskPhone(agentPhone)}>`
            );
            transferPhase = 'committing';
            try {
                await transferCall(callSid, agentPhone);
            } catch (err) {
                console.error('[transfer] Twilio transfer failed:', err);
                transferPhase = 'none';
                releaseTransferLock(tenantId, agentPhone);
                await endCallWithFarewell('error_limit');
                return;
            }
            transferPhase = 'committed';

            state = 'ENDED';

            const { error: updErr } = await supabase
                .from('call_sessions')
                .update({ result: 'transferred' })
                .eq('call_sid', callSid);
            if (updErr) {
                console.error('[transfer] call_sessions update error:', updErr);
            } else {
                console.log(`[transfer] call_sessions.result='transferred' set for ${callSid}`);
            }
        };

        // -----------------------------------------------------------------
        // Unified call-termination helper. Plays the farewell clip (unless
        // suppressed, e.g. for voicemail), records the reason on
        // call_sessions.result, and closes the Twilio WS shortly after.
        // Safe to call multiple times — re-entrancy is gated on state.
        // -----------------------------------------------------------------
        const endCallWithFarewell = async (reason, { playFarewell = true } = {}) => {
            // 取次が Twilio を切り替えている最中・切り替えた後は、取次が通話を持っている（段0）
            if (transferPhase === 'committing' || transferPhase === 'committed') {
                console.log(`[end] endCallWithFarewell(${reason}) ignored; transfer is ${transferPhase}`);
                return;
            }
            aborted = true;
            clearAnswerTimers();
            dropHeld('end');
            if (state === 'ENDED') {
                console.log(`[end] endCallWithFarewell(${reason}) called but state=ENDED already; ignoring`);
                return;
            }
            // Suppress the appended farewell if the last clip we played
            // already contains 「失礼いたします」 (e.g. sorry_disturb / thanks).
            // The caller's explicit `playFarewell: false` still wins.
            if (playFarewell && cfg?.clips.get(lastPlayedAudioKey)?.suppress_farewell) {
                console.log(
                    `[end] suppressing farewell: last clip '${lastPlayedAudioKey}' already ` +
                        `includes 「失礼いたします」`
                );
                playFarewell = false;
            }
            console.log(`[end] ending call: reason=${reason} playFarewell=${playFarewell}`);
            state = 'ENDED';
            endReason = reason;
            disableVad(`end: ${reason}`);

            // Stop the timeout poll — we're going down regardless.
            if (timeoutInterval) {
                clearInterval(timeoutInterval);
                timeoutInterval = null;
            }

            // Invalidate any in-progress playback so the filler "はい" or a
            // partially-streamed response doesn't keep sending media after
            // we've decided to end. playAudio() loops check this token and
            // bail when it changes.
            currentPlaybackToken = ++markCounter;

            if (playFarewell && cfg?.farewellKey) {
                try {
                    await playAudio(cfg.farewellKey);
                } catch (err) {
                    console.error('[end] farewell playback failed:', err);
                }
            }

            if (callSid) {
                try {
                    const { error: updErr } = await supabase
                        .from('call_sessions')
                        .update({ result: reason })
                        .eq('call_sid', callSid);
                    if (updErr) {
                        console.error(`[end] call_sessions.result='${reason}' update failed:`, updErr);
                    } else {
                        console.log(`[end] call_sessions.result='${reason}' saved for ${callSid}`);
                    }
                } catch (err) {
                    console.error('[end] Supabase update threw:', err);
                }
            }

            // Give Twilio a moment to flush the farewell audio before we
            // tear down the WebSocket. 500ms matches what handleUserUtterance
            // historically used for end_call paths.
            setTimeout(() => {
                try { connection.close(); } catch (_) {}
            }, 500);
        };

        // Periodic timer check — runs every TIMEOUT_CHECK_INTERVAL_MS while
        // the call is active. Bails on ENDED to avoid double-firing.
        const checkTimeouts = () => {
            if (state === 'ENDED') return;
            const now = Date.now();
            const silenceMs = now - lastSpeechAt;
            const durationMs = now - callStartAt;

            // 待機の期限＝状態に関係なく見る（処理中・再生中でもすり抜けない）。結果は今の「無音切断」と同じ値
            // （待機の期限切れだったことは判定の記録に残す）。待機中は下の無音の30秒は見ない＝§1-e
            if (waitCtx) {
                if (now >= waitCtx.deadline) {
                    console.log(`[timeout] wait ${Math.round((now - waitCtx.startedAt) / 1000)}s reached the limit; ending call`);
                    logDecision({ event: 'wait_timeout', in_wait: true, action: 'silence_timeout' });
                    endCallWithFarewell('silence_timeout').catch((err) =>
                        console.error('[timeout] wait handler error:', err)
                    );
                    return;
                }
            }

            // Silence timeout only fires while we're actively waiting for
            // the caller. During PLAYING/PROCESSING/REALTIME the assistant
            // is busy and silence is expected.
            if (!waitCtx && state === 'LISTENING' && silenceMs >= SILENCE_TIMEOUT_MS) {
                console.log(
                    `[timeout] silence ${Math.round(silenceMs / 1000)}s ≥ ` +
                        `${SILENCE_TIMEOUT_MS / 1000}s; ending call`
                );
                endCallWithFarewell('silence_timeout').catch((err) =>
                    console.error('[timeout] silence handler error:', err)
                );
                return;
            }

            // Duration cap is unconditional (except already-ended). Note
            // transferred calls have state=ENDED, so they're skipped.
            if (durationMs >= CALL_DURATION_TIMEOUT_MS) {
                console.log(
                    `[timeout] duration ${Math.round(durationMs / 1000)}s ≥ ` +
                        `${CALL_DURATION_TIMEOUT_MS / 1000}s; ending call`
                );
                endCallWithFarewell('duration_timeout').catch((err) =>
                    console.error('[timeout] duration handler error:', err)
                );
            }
        };

        // Loop detection: same audio_key returned LOOP_DECISION_THRESHOLD
        // times in a row implies Claude is stuck — caller probably keeps
        // saying the same thing back.
        const recordClaudeDecision = (audioKey) => {
            if (!audioKey) return false;
            recentClaudeDecisions.push(audioKey);
            if (recentClaudeDecisions.length > LOOP_DECISION_THRESHOLD) {
                recentClaudeDecisions.shift();
            }
            if (recentClaudeDecisions.length < LOOP_DECISION_THRESHOLD) return false;
            const looped = recentClaudeDecisions.every((k) => k === recentClaudeDecisions[0]);
            if (looped) {
                console.log(
                    `[loop] same Claude decision '${recentClaudeDecisions[0]}' ` +
                        `${LOOP_DECISION_THRESHOLD}x in a row`
                );
            }
            return looped;
        };

        // Loop detection: caller repeating themselves. Every pair in the
        // last N utterances must be ≥UTTERANCE_SIMILARITY similar.
        const recordUserUtterance = (text) => {
            recentUserUtterances.push(text);
            if (recentUserUtterances.length > LOOP_UTTERANCE_THRESHOLD) {
                recentUserUtterances.shift();
            }
            if (recentUserUtterances.length < LOOP_UTTERANCE_THRESHOLD) return false;
            for (let i = 0; i < recentUserUtterances.length; i++) {
                for (let j = i + 1; j < recentUserUtterances.length; j++) {
                    const sim = stringSimilarity(recentUserUtterances[i], recentUserUtterances[j]);
                    if (sim < UTTERANCE_SIMILARITY) return false;
                }
            }
            console.log(
                `[loop] caller repeated ${LOOP_UTTERANCE_THRESHOLD} highly-similar ` +
                    `utterances (≥${UTTERANCE_SIMILARITY * 100}% similar)`
            );
            return true;
        };

        // -----------------------------------------------------------------
        // Re-prompt ("聞き返し"). Shared by two "couldn't understand" paths:
        // an empty Whisper result, and Claude's `reprompt` decision for
        // gibberish that did transcribe. Increments the shared miss counter,
        // plays a rotating pardon clip, and ends the call once we've asked
        // MAX_REPROMPTS times without getting through.
        // Callers must `await fillerPromise` before calling this so the "はい"
        // filler lands before the pardon.
        // -----------------------------------------------------------------
        const repromptOrEnd = async () => {
            consecutiveEmpty++;
            console.log(`[reprompt] miss ${consecutiveEmpty}/${MAX_REPROMPTS}`);
            if (state === 'ENDED') return;

            if (consecutiveEmpty > MAX_REPROMPTS) {
                console.log('[reprompt] exhausted; ending call with farewell');
                await endCallWithFarewell('silence_timeout');
                return;
            }

            // Rotate the phrasing so a second ask doesn't sound like a recording.
            const pardonKeys = cfg?.pardonKeys || [];
            if (pardonKeys.length) {
                const pardonKey = pardonKeys[pardonIndex % pardonKeys.length];
                pardonIndex++;
                state = 'PLAYING';
                disableVad('playing pardon');
                await playAudio(pardonKey);
            }
            if (state === 'ENDED') return;
            state = 'LISTENING';
            lastSpeechAt = Date.now();
            enableVadDelayed(POST_PLAYBACK_DELAY_MS, 'after pardon');
            afterBackToListening();
        };

        // -----------------------------------------------------------------
        // 取次のつまみが在る通話だけ＝判定の記録・待機の出入り・判定の実行
        // 家＝~/sente/sfav_transfer_tuning_plan.md §1-e〜1-g
        // -----------------------------------------------------------------
        // 版6＝取次を決める所は1か所（音の判定と言葉の判定が同時に決めても1回だけ・切れた後には進まない）
        //   clipKey＝取次の声（受付に向けて流す時だけ）。本人の名乗り・保留音では流さない（Tom「早く取り次いで欲しい」）
        const commitTransfer = async (why, { clipKey = null } = {}) => {
            if (transferCommitted || aborted || state === 'ENDED') return false;
            transferCommitted = true;
            holdRun = null;
            holdCandidate = null;
            dropHeld('transfer');
            absentStage = null;
            leaveWait(why);
            consecutiveEmpty = 0;
            currentPlaybackToken = ++markCounter; // 流れかけのつなぎの「はい」を止める
            state = 'PLAYING';
            disableVad(`transfer (${why})`);
            console.log(`[transfer] committed (${why}${clipKey ? `, clip ${clipKey}` : ', no clip'})`);
            if (clipKey) {
                await playAudio(clipKey);
                if (aborted || state === 'ENDED') return true; // 段0
            }
            await handleTransfer();
            if (timeoutInterval) {
                clearInterval(timeoutInterval);
                timeoutInterval = null;
            }
            return true;
        };

        // 保留音の候補を、その時の設定と状況で決める（処理中・持ち越しの発話があれば待つ＝追い越さない＝codex レビュー 4・5・7）
        //   決め直すたびに「受付の言葉を聞いたか」を取り直す＝先に届いた「少々お待ちください」の判定の後で決まる
        const tryHoldCommit = async () => {
            const c = holdCandidate;
            if (!c) return;
            if (transferCommitted || aborted || state === 'ENDED' || state === 'REALTIME') { holdCandidate = null; return; }
            if (Date.now() - c.at > 15000) { holdCandidate = null; return; } // 古い候補は捨てる
            // carryAudio＝切れ端の続きを聞いている途中（つないだ発話を判定してから決める＝2026-10-06 codex レビュー）
            if (state !== 'LISTENING' || pendingUtterance || carryAudio || held) return; // 処理が終わって聞き取りに戻った時に、もう一度ここへ来る（held＝言いかけの続きを待っている）
            // 候補の区間の後に話し始めた発話がある＝その中身（「担当者はいません」等）を聞いてから決める（codex レビュー 版7 の1）
            //   保留音そのものも VAD では「話している」になるので、区間より前から続く発話は待たない
            if (speechActive && speechStartedAt > c.regionEndAt) return;
            holdCandidate = null;
            const announced = !!waitCtx || (announcedAt && Date.now() - announcedAt <= ts.wait_max_seconds * 1000);
            const dec = decideHold({ ts, announced });
            const base = { event: 'hold_music', hold_seconds: c.seconds, hold_rms: c.rms, transcript: c.text, in_wait: !!waitCtx, gate: dec.reason };
            console.log(`[hold] music ${c.seconds}s rms=${c.rms} announced=${!!announced} → ${dec.transfer ? 'transfer' : dec.reason}`);
            if (!dec.transfer) { logDecision({ ...base, action: 'no_transfer' }); return; }
            logDecision({ ...base, action: 'transfer' });
            await commitTransfer('hold');
        };
        // 聞き取りに戻った時＝取っておいた保留音の候補を決め直す（処理が否定・取次・終了に進んだ時はここに来ない）
        const afterBackToListening = () => {
            if (!holdCandidate || transferCommitted) return;
            setImmediate(() => tryHoldCommit().catch((e) => console.error('[hold] commit error:', e)));
        };

        // 版6＝保留音の検知（§3-1）。設定の行が v2 の通話で、聞いている間・処理中に数える
        const holdTick = (mulaw) => {
            holdFrame++;
            holdRing.push(mulaw);
            if (holdRing.length > HOLD_RING_FRAMES) holdRing.shift();
            const rms = calculateRms(mulaw);
            if (rms > HOLD_RMS_THRESHOLD) {
                if (!holdRun) holdRun = { start: holdFrame, lastLoud: holdFrame, rms: [] };
                holdRun.lastLoud = holdFrame;
                holdRun.rms.push(rms);
            } else if (holdRun && holdFrame - holdRun.lastLoud >= HOLD_GAP_FRAMES) {
                holdRun = null;
            }
            if (!holdRun || holdCheckInFlight || Date.now() < holdCooldownUntil) return;
            const frames = holdFrame - holdRun.start + 1;
            if (frames < ts.hold_music_seconds * 50) return;
            const sorted = [...holdRun.rms].sort((a, b) => a - b);
            checkHold(frames, Math.round(sorted[Math.floor(sorted.length / 2)] || 0)).catch((e) => {
                holdCheckInFlight = false;
                console.error('[hold] check error:', e);
            });
        };

        const checkHold = async (frames, medianRms) => {
            holdCheckInFlight = true;
            const regionEndAt = Date.now();
            const seconds = Math.round((frames / 50) * 10) / 10;
            const audio = Buffer.concat(holdRing.slice(-Math.min(frames, HOLD_RING_FRAMES)));
            const res = await transcribeDetailed(audio, cfg?.transcriptionPrompt);
            holdCheckInFlight = false;
            holdCooldownUntil = Date.now() + 2000;
            holdRun = null; // 次の判定は、もう一度 秒数ぶん鳴ってから
            if (transferCommitted || aborted || state === 'ENDED' || state === 'REALTIME') return;
            const base = { event: 'hold_music', hold_seconds: seconds, hold_rms: medianRms, transcript: res.text ?? null, in_wait: !!waitCtx };
            if (!res.ok) { logDecision({ ...base, action: 'stt_error' }); return; }
            if (!isWordless(res.text)) { logDecision({ ...base, action: 'has_words' }); return; }
            holdCandidate = { seconds, rms: medianRms, text: res.text ?? null, at: Date.now(), regionEndAt };
            await tryHoldCommit();
        };

        // 判定の記録（call_turn_decisions）。失敗しても通話は止めない
        const logDecision = (fields) => {
            if ((!ts && !tsFallback) || !callSid) return;
            if (!sessionIdPromise) {
                sessionIdPromise = supabase.from('call_sessions').select('id').eq('call_sid', callSid)
                    .order('created_at', { ascending: false }).limit(1).maybeSingle()
                    .then(({ data }) => data?.id || null)
                    .catch(() => null);
            }
            const row = {
                tenant_id: callParams?.tenant_id,
                event: fields.event,
                state_before: fields.state_before ?? null,
                in_wait: fields.in_wait ?? !!waitCtx,
                transcript: fields.transcript ?? null,
                forced_split: !!fields.forced_split,
                step: fields.step ?? null,
                haiku_intent: fields.haiku_intent ?? null,
                gate: fields.gate ?? null,
                matched_phrase: fields.matched_phrase ?? null,
                action: fields.action ?? null,
                settings_id: ts?.id ?? null,
                settings_scope: ts?.scope ?? null,
                settings_version: ts?.version ?? null,
                settings_hash: ts?.hash ?? null,
                ...(fields.hold_seconds != null ? { hold_seconds: fields.hold_seconds, hold_rms: fields.hold_rms ?? null } : {}),
            };
            const pending = sessionIdPromise;
            pending.then((sid) => {
                if (!sid) {
                    if (sessionIdPromise === pending) sessionIdPromise = null; // 通話の行がまだ無い＝次で引き直す
                    return;
                }
                return supabase.from('call_turn_decisions').insert({ ...row, session_id: sid })
                    .then(({ error }) => { if (error) console.error('[decision-log] insert failed:', error.message); });
            }).catch((err) => console.error('[decision-log] threw:', err));
        };

        // 聞き取りへ戻る。afterPlayback＝こちらが話し終えた直後（VAD を少し遅らせて開ける）
        const resumeListening = (afterPlayback) => {
            if (state === 'ENDED') return;
            state = 'LISTENING';
            captureWhileProcessing = false;
            if (!waitCtx) lastSpeechAt = Date.now(); // 待機中は無音の30秒を見ない＝時計は触らない
            if (afterPlayback) {
                enableVadDelayed(POST_PLAYBACK_DELAY_MS, waitCtx ? 'waiting (after response)' : 'after response');
            } else if (!vadEnabled) {
                enableVadDelayed(0, 'waiting');
            }
            if (!(waitCtx && pendingUtterance)) afterBackToListening(); // 持ち越しの発話があれば、その判定の後で保留音を決め直す
            if (waitCtx && pendingUtterance) {
                const u = pendingUtterance;
                pendingUtterance = null;
                // 回す時にもう一度確かめる（その間に別の発話が応答・取次へ進んでいたら回さない）
                setImmediate(() => {
                    if (state !== 'LISTENING' || !waitCtx) return;
                    handleUserUtterance(u.audio, { forced: u.forced }).catch((err) => console.error('handleUserUtterance error:', err));
                });
            }
        };
        const enterWait = () => {
            dropHeld('wait');
            absentStage = null;
            const now = Date.now();
            waitCtx = { startedAt: now, deadline: now + ts.wait_max_seconds * 1000 };
            recentUserUtterances = [];
            recentClaudeDecisions = [];
            console.log(`[wait] entered (max ${ts.wait_max_seconds}s)`);
            logDecision({ event: 'wait_enter', in_wait: true });
            // 6秒で区切った発話から入った時は、処理の間も聞き続けている＝その音（と持ち越し）を捨てない
            resumeListening(!vadEnabled);
        };
        const continueWait = () => resumeListening(false);
        const leaveWait = (why) => {
            if (!waitCtx) return;
            console.log(`[wait] left after ${Math.round((Date.now() - waitCtx.startedAt) / 1000)}s (${why})`);
            waitCtx = null;
            pendingUtterance = null;
            recentUserUtterances = [];
            recentClaudeDecisions = [];
            logDecision({ event: 'wait_leave', in_wait: false, action: why });
        };

        // 判定（transfer-logic.js の decideBeforeClassifier／decideAfterClassifier）を実行する
        // -----------------------------------------------------------------
        // 2026-10-08 森さんの FB（家＝~/sente/sente_aivoice_canonical.md §3「📐 実装の計画 v3」）
        // -----------------------------------------------------------------
        // 聞き取りに戻る（設定がある通話は resumeListening・無い通話は今までの戻り方）
        const backToListening = (why) => {
            if (state === 'ENDED') return;
            if (ts) { resumeListening(true); return; }
            state = 'LISTENING';
            lastSpeechAt = Date.now();
            enableVadDelayed(POST_PLAYBACK_DELAY_MS, why);
        };

        // 言いかけ（「責任者のもの」「あのー」）＝返さずに持ち、続きが来たらつないで文字起こしからやり直す。
        // 来なければ期限で、その文のまま判定へ（同じ発話の番号の取り合いは handleUserUtterance の入口と同じ管理を通す）
        const holdIncomplete = (turn, audio, transcript) => {
            dropHeld('replaced');
            held = { turn, audio, transcript };
            mergeTurn = null;
            liveTurn = 0;
            captureWhileProcessing = false;
            state = 'LISTENING';
            lastSpeechAt = Date.now();
            // 長い発話は文字起こしの間 VAD を止めている＝すぐ開け直す（動いていれば捕まえかけの音を捨てない）
            if (!vadEnabled) enableVadDelayed(0, 'held (incomplete)');
            console.log(`[held] incomplete utterance (${transcript.length} chars); waiting ${INCOMPLETE_WAIT_MS}ms for the rest`);
            logDecision({ event: 'turn', step: 'held', transcript, action: 'wait_rest' });
            heldTimer = setTimeout(() => {
                heldTimer = null;
                if (!held || held.turn !== turn) return;
                // 話し始めていれば、話し始めの所で carryAudio へ移している（ここへは来ない）
                if (state !== 'LISTENING' || speechActive) return;
                const h = held;
                held = null;
                console.log('[held] no continuation; judging the held utterance as-is');
                handleUserUtterance(h.audio, { heldTranscript: h.transcript })
                    .catch((err) => console.error('handleUserUtterance (held) error:', err));
            }, INCOMPLETE_WAIT_MS);
        };

        // 「もう一度」＝最後に流し終えた返答の列を流し直す（2回まで・3回目は聞き返し＝回数は聞き返しの上限で数える）
        const replayLastResponse = async () => {
            if (!lastResponseSeq?.length || repeatCount >= REPEAT_MAX) {
                console.log(`[repeat] ${lastResponseSeq?.length ? 'limit reached' : 'nothing to replay'}; reprompting`);
                await repromptOrEnd();
                return;
            }
            repeatCount++;
            console.log(`[repeat] replaying ${lastResponseSeq.join('+')} (${repeatCount}/${REPEAT_MAX})`);
            logDecision({ event: 'turn', step: 'repeat', action: 'replay', matched_phrase: lastResponseSeq.join('+') });
            state = 'PLAYING';
            disableVad('replaying last response');
            const r = await playSeq(lastResponseSeq);
            if (r === 'cancelled' || state === 'ENDED') return;
            backToListening('after replay');
        };

        // 戻り時間を書く（callback_info と recall_at＝再コールの日時）。読めなければ callback_info だけ
        const saveCallback = async (callbackInfo, transcript, result = null, recallAt = undefined) => {
            const at = recallAt !== undefined ? recallAt : parseRecallAt([callbackInfo, transcript].filter(Boolean).join('。'), new Date());
            const patch = {};
            if (callbackInfo || transcript) patch.callback_info = callbackInfo || transcript;
            if (at) patch.recall_at = at.toISOString();
            if (!Object.keys(patch).length && !result) return;
            await mergeSessionMetadata(callSid, patch, result);
        };

        // 不在の流れの入口＝4本そろった声セットで、待機中でない時だけ。流せたら true（呼び手は今の流れへ進まない）
        //   待機中（「少々お待ちください」→ 戻ってきて「不在でした」）も入る＝待機を出てから聞く。1通話に1回だけ
        const startAbsentFlow = async () => {
            if (absentStage || absentAsked || !ABSENT_KEYS.every((k) => cfg?.clips?.has(k))) return false;
            absentAsked = true;
            if (waitCtx) leaveWait('absent');
            consecutiveEmpty = 0;
            state = 'PLAYING';
            disableVad('absent: ask return time');
            const r = await playClip('absent_ask');
            if (r === 'missing') { console.error('[absent] ask clip unavailable; falling back'); return false; }
            if (r !== 'done' || state === 'ENDED') return true;
            absentStage = 'asked';
            logDecision({ event: 'turn', step: 'absent', action: 'ask_return_time' });
            backToListening('absent: asked');
            return true;
        };
        // 不在の段を抜ける言葉＝取次・待たせる・本人の名乗り（抜けた後は今の判定へ）。
        //   否定（いません・不在）や日時が一緒にある答え（「担当の者は16時に戻ります」）は段の答えとして扱う
        //   区切り（句読点・逆接）ごとに見る＝「担当は不在ですが、別の担当に代わりますので少々お待ちください」は抜ける
        const absentEscape = (transcript) => (transcript || '').split(/[、。，．,.！!？?]|けど|けれど|ですが|ますが/).some((seg) => {
            if (!seg.trim() || NEGATIVE_RE.test(seg) || parseRecallAt(seg, new Date())) return false;
            return hasSufficientTransferEvidence(seg)
                || !!(ts && (firstMatch(seg, ts.wait_phrases) || firstMatch(seg, ts.transfer_phrases) || (ts.v2 && matchHandover(seg, ts))))
                || /少々お待ち|お待ちください|代わります|替わります|変わります/.test(seg);
        });
        // 不在の段の答え（AI を待たない）。結果と再コールの日時は声を流す前に書く
        const handleAbsentReply = async (transcript, stale = () => false) => {
            const stage = absentStage;
            const r = classifyAbsentReply(transcript, stage, new Date());
            console.log(`[absent] stage=${stage} reply=${r.kind}${r.recallAt ? ` at=${r.recallAt.toISOString()}` : ''}`);
            logDecision({ event: 'turn', step: 'absent', transcript, action: `${stage}:${r.kind}` });
            consecutiveEmpty = 0;
            const finish = async (clipKey, result, recallAt) => {
                absentStage = null;
                await saveCallback(null, transcript, result, recallAt || null);
                // 書いている間に切れた・時間切れ・取次・続きの言葉で追い越された＝声も終話も古い判定からはしない
                if (aborted || state === 'ENDED' || transferCommitted || stale()) return;
                state = 'PLAYING';
                disableVad(`absent: ${result}`);
                const pr = await playClip(clipKey);
                if (pr === 'cancelled' && state === 'ENDED') return;
                await endCallWithFarewell(result);
            };
            if (r.kind === 'reject') return finish('sorry_disturb', 'rejected', null);
            if (stage === 'asked' && r.kind === 'time') return finish('absent_time_ack', 'callback_scheduled', r.recallAt);
            if (stage === 'asked') {
                state = 'PLAYING';
                disableVad('absent: propose');
                const pr = await playClip('absent_propose');
                if (pr === 'missing') return finish('sorry_disturb', 'not_available', null);
                if (pr !== 'done' || state === 'ENDED') return;
                absentStage = 'proposed';
                backToListening('absent: proposed');
                return;
            }
            if (r.kind === 'yes') return finish('absent_close', 'callback_scheduled', r.recallAt);
            return finish('absent_close', 'not_available', null);
        };

        const actOnDecision = async (d, intentDef, decision, meta) => {
            console.log(`[decide] step=${d.step} action=${d.action}${d.gate ? ` gate=${d.gate}` : ''}${meta.inWait ? ' (waiting)' : ''}`);
            logDecision({
                event: 'turn', state_before: meta.stateBefore, transcript: meta.transcript, forced_split: meta.forced,
                step: d.step, haiku_intent: decision?.intent ?? null, gate: d.gate ?? null,
                matched_phrase: d.matched ?? null, action: d.action, in_wait: meta.inWait,
            });
            if (state === 'ENDED') return;
            if (d.gate && String(d.gate).startsWith('words')) announcedAt = Date.now(); // 受付の言葉を聞いた（保留音の「言葉の後」）

            if (d.action === 'transfer_fast') { await commitTransfer('handover'); return; }
            if (d.action === 'continue_wait') { continueWait(); return; }
            if (d.action === 'wait_enter') { enterWait(); return; } // つなぎの「はい」はこの発話の処理で流れた＝足さない
            if (d.action === 'reprompt') { await repromptOrEnd(); return; }
            if (d.action === 'realtime') { await fallbackToAgent('no scripted answer'); return; }
            // 版7.2 ⑦＝あいさつ・お礼だけ＝何も流さず続きを聞く（つなぎの「はい」はこの発話の処理で流れた）
            if (d.action === 'listen') { resumeListening(true); return; }

            if (d.action === 'transfer') {
                leaveWait('transfer'); // 「おつなぎします」の最中に待機の期限で切らない
                const tIntent = intentDef?.is_transfer ? intentDef : cfg.intents.find((i) => i.is_transfer);
                if (!tIntent?.audio_key || !cfg.clips.has(tIntent.audio_key)) {
                    console.error('[intent] transfer has no playable clip');
                    await fallbackToAgent('no playable clip');
                    return;
                }
                await commitTransfer('transfer', { clipKey: tIntent.audio_key });
                return;
            }

            // 不在＝戻りの時間を聞く流れ（4本がそろった声セットだけ・辞去や終話より前）
            if (intentDef?.name === 'not_available' && await startAbsentFlow()) return;
            // intent（否定＝切る）／answer（答えて聞く・待機中は待機を続ける）
            if (!intentDef?.audio_key || !cfg.clips.has(intentDef.audio_key)) {
                console.error(`[intent] "${intentDef?.name}" has no playable clip`);
                if (meta.inWait) { continueWait(); return; }
                // 切る意図（断り・不在・折り返し）は声が無くても切る＝CM へつながない（codex レビュー）
                if (intentDef?.end_call) { await endCallWithFarewell(intentDef.end_reason || 'rejected'); return; }
                await fallbackToAgent('no playable clip');
                return;
            }
            const looped = waitCtx ? false : recordClaudeDecision(intentDef.audio_key);
            consecutiveEmpty = 0;
            // 戻り時間（「16時頃戻ります」）は声を流す前に書く（相手が声の途中で切っても残る）
            if (intentDef.wants_callback_info) {
                await saveCallback(decision?.callback_info, meta.transcript);
                if (aborted || state === 'ENDED' || transferCommitted || (meta.stale && meta.stale())) return; // 書いている間に終わった・追い越された
            }
            state = 'PLAYING';
            disableVad('playing response');
            const played = await playClip(intentDef.audio_key);
            if (looped) { await endCallWithFarewell('loop_detected'); return; }
            if (intentDef.end_call) { await endCallWithFarewell(intentDef.end_reason || 'rejected'); return; }
            // 流した後に CM へ（資料送付＝送付先は CM が伺う・2026-10-07）
            if (intentDef.then_agent && state === 'PLAYING') { await fallbackToAgent(`then_agent (${intentDef.name})`); return; }
            // 版7.2＝待たせる言い回しつきの質問に答えた後（段ごと）＝緩いは取次／ふつう・締めるは待機（既に待機中なら期限はそのまま）
            // 答えの声が流れ切らなかった（取得の失敗・割り込み）・その間に終わった／取次済み／新しい発話に追い越された＝後続へ進まない
            if ((d.action === 'answer_then_transfer' || d.action === 'answer_then_wait')
                && (played !== 'done' || aborted || transferCommitted || (meta.stale && meta.stale()))) {
                if (played === 'missing' && state === 'PLAYING' && !aborted && !transferCommitted) {
                    // 声が無かった＝答えられない＝待機の外は CM へ（待機中は待ち続ける）＝通常の「声が無い」と同じ扱い
                    if (meta.inWait) { continueWait(); return; }
                    await fallbackToAgent('no playable clip');
                }
                return;
            }
            if (d.action === 'answer_then_transfer' && state === 'PLAYING') {
                const tIntent = cfg.intents.find((i) => i.is_transfer);
                await commitTransfer('words', { clipKey: tIntent?.audio_key && cfg.clips.has(tIntent.audio_key) ? tIntent.audio_key : null });
                return;
            }
            if (d.action === 'answer_then_wait' && state === 'PLAYING') {
                if (waitCtx) resumeListening(true); else enterWait(); // 待機中＝期限を作り直さない（enterWait は deadline を新しくする）
                return;
            }
            if (state === 'PLAYING') resumeListening(true);
        };

        // -----------------------------------------------------------------
        // After a user utterance: filler + Whisper + Claude + action
        // -----------------------------------------------------------------
        //   heldTranscript＝言いかけの待ちが期限切れ＝文字起こしをやり直さず、その文で判定だけ続ける（もう言いかけ判定はしない）
        const handleUserUtterance = async (mulawAudio, { forced = false, heldTranscript = null, early = null } = {}) => {
            // 処理の間に閉じた発話＝最新の1つだけ持ち越す（待機を続ける・待機に入る時に回す＝§1-d）
            if (state === 'PROCESSING' && (waitCtx || captureWhileProcessing)) {
                pendingUtterance = { audio: mulawAudio, forced };
                return;
            }
            if (state !== 'LISTENING') return; // PLAYING／PROCESSING／ENDED／REALTIME／INITIAL は受けない
            if (carryAudio) {
                early = null; // 先に始めた文字起こしは切れ端を含まない
                mulawAudio = Buffer.concat([carryAudio, mulawAudio]);
                carryAudio = null;
                console.log(`[merge] joined with the previous fragment (${mulawAudio.length} bytes)`);
            }
            const turn = ++turnSeq;
            liveTurn = turn;
            // 処理中に相手の続きが始まると liveTurn が変わる＝この判定は以後なにもしない（つないだ発話の判定に任せる）
            const stale = () => liveTurn !== turn;
            const inWait = !!waitCtx;
            const stateBefore = state;
            state = 'PROCESSING';
            // 待機中と、6秒で区切った発話（設定が在る通話）は VAD を止めない＝処理している間の声も受け続ける（持ち越し）。
            // 短い切れ端（「あ」「えー」＝話した分が0.5秒ほど）も止めない＝続きが来たら判定を捨ててつなぎ直す。
            // それ以外（文になっている発話）は今までどおり止める＝直後の保留音で判定を捨てない。
            // 応答を流す時は disableVad で捨てる（自分の声の最中の取りこぼしは今と同じ）
            mergeTurn = null;
            if (ts && (inWait || forced)) {
                captureWhileProcessing = true;
            } else if (mulawAudio.length <= MERGE_MAX_FRAGMENT_BYTES) {
                captureWhileProcessing = true;
                mergeTurn = { turn, audio: mulawAudio };
            } else {
                disableVad('processing utterance');
            }
            const t0 = Date.now();
            thanksSaidAt = 0; // 前の発話の相づちを持ち越さない（「もう一度」の流し直しに効かせない＝監査 2026-10-10）
            console.log(`▶ State: PROCESSING (${mulawAudio.length} bytes captured)`);

            // Start Whisper immediately so STT runs during the human-pause
            // window — the overall response latency stays roughly the same
            // even though the filler is delayed.
            if (early) console.log('[stt] using the early transcription (started at 0.3s of silence)');
            const whisperPromise = heldTranscript != null ? Promise.resolve(heldTranscript) : early ? early.promise : transcribeWhisper(mulawAudio, cfg.transcriptionPrompt).catch((err) => {
                console.error('Whisper error:', err);
                return null;
            });

            // Hold the filler clip for HUMAN_PAUSE_MS after silence-end so
            // the caller's last word does not get stepped on. Without this
            // pause the agent fires "はい" the instant VAD flips, which
            // sounds robotic and impatient.
            // Rotate through the tenant's filler clips so it doesn't sound robotic.
            // 待機中はつなぎの「はい」を流さない（保留音の切れ目ごとに「はい」と言わない＝§1-e）
            const fillerKeys = inWait ? [] : (cfg?.fillerKeys || []);
            const fillerKey = fillerKeys.length ? fillerKeys[haiPatternIndex % fillerKeys.length] : null;
            haiPatternIndex++;
            const startFiller = (delayMs, text) => new Promise((resolve) =>
                setTimeout(resolve, delayMs)
            ).then(async () => {
                if (state === 'ENDED' || !fillerKey || transferCommitted || stale()) return;
                // 相づち＝基本は「ありがとうございます」・問いかけ／否定の語／相づちだけには「はい」（声セットに無ければ「はい」）
                const key = cfg?.thanksKey && chooseAizuchi(text) === 'thanks' ? cfg.thanksKey : fillerKey;
                const r = await playAudio(key);
                if (key === cfg?.thanksKey && r === 'done' && !stale() && state !== 'ENDED') thanksSaidAt = Date.now(); // 次の発話が始まっていたら持ち越さない（監査 2026-10-10）
                return r;
            }).catch((err) => console.error('Filler playback error:', err));
            // 「はい」は全部の通話で中身を聞いてから決める（版6 は v2 だけだった）＝担当者本人の名乗り・言いかけ・「もう一度」には流さない
            //   （一度送った音は止められない＝言いかけで黙るには先に流さないしかない・2026-10-08 森さん FB／codex 監査）
            let fillerPromise = null;
            console.log(`[parallel] Whisper started; filler ${fillerKey || '(none)'} decided after STT`);

            const transcript = await whisperPromise;
            console.log(`[timing] Whisper done in ${Date.now() - t0}ms`);
            if (stale()) return;
            if (state === 'ENDED' || transferCommitted) return;

            // 言いかけ・つなぎ言葉だけ＝返さずに持って続きを聞く（期限＝文字起こしの後 INCOMPLETE_WAIT_MS）。
            //   待機中・6秒で区切った発話・期限切れで戻った文（heldTranscript）は対象外
            if (transcript && !inWait && !forced && heldTranscript == null && isIncompleteUtterance(transcript)) {
                holdIncomplete(turn, mulawAudio, transcript);
                return;
            }

            // 期限まで続きの来なかったつなぎ言葉だけ（「あのー」）＝「はい」も AI も通さずに聞き返す
            if (heldTranscript != null && isFillerWordsOnly(transcript)) {
                saveTranscript('user', transcript);
                console.log('[held] filler only; reprompting');
                await repromptOrEnd();
                return;
            }

            const fast = transcript && ts?.v2 ? decideFastHandover({ transcript, ts }) : null;
            const repeatAsk = !!transcript && !inWait && !fast && isRepeatRequest(transcript);
            fillerPromise = (fast || repeatAsk) ? Promise.resolve() : startFiller(Math.max(0, HUMAN_PAUSE_MS - (Date.now() - t0)), transcript);

            if (!transcript) {
                if (inWait) {
                    logDecision({ event: 'wait_continue', state_before: stateBefore, forced_split: forced, step: '1', action: 'continue_wait' });
                    continueWait();
                    return;
                }
                // Whisper heard nothing usable — re-prompt (or end if we've
                // already asked too many times).
                console.log('Empty transcript — re-prompting');
                await fillerPromise;
                if (state === 'ENDED' || stale()) return;
                await repromptOrEnd();
                return;
            }

            // 相手の発話はログに出さない（call_transcripts にだけ残す・レビュー D1）
            console.log(`User said (${transcript.length} chars)`);
            lastUserTranscript = transcript;
            lastSpeechAt = Date.now();
            saveTranscript('user', transcript);

            // -----------------------------------------------------------------
            // D — Voicemail detection. Hang up immediately without farewell so
            // we don't leave a goodbye recording on the prospect's voicemail.
            // -----------------------------------------------------------------
            const voicemailHit = cfg.voicemailPatterns.find((p) => transcript.includes(p));
            if (voicemailHit) {
                console.log(`[voicemail] detected pattern "${voicemailHit}"; hanging up without farewell`);
                await endCallWithFarewell('voicemail', { playFarewell: false });
                return;
            }

            // -----------------------------------------------------------------
            // E — User-explicit hang-up keywords. Skip Claude entirely; just
            // play the farewell and close.
            // -----------------------------------------------------------------
            const hangupHit = cfg.hangupPatterns.find((p) => transcript.includes(p));
            if (hangupHit) {
                console.log(`[user_hangup] detected keyword "${hangupHit}"; playing farewell`);
                // Let the filler "はい" land first so it doesn't get clipped.
                await fillerPromise;
                if (stale()) return;
                await endCallWithFarewell('user_hangup');
                return;
            }

            // 「もう一度」＝直前の返答を流し直す（同じ発話の繰り返しの数には入れない・2回まで・3回目は聞き返し）
            if (repeatAsk) {
                await fillerPromise;
                if (state === 'ENDED' || stale()) return;
                await replayLastResponse();
                return;
            }

            // -----------------------------------------------------------------
            // B-2 — Loop detection on the caller's side (same utterance over
            // and over). Triggers before we even call Claude, since asking
            // Claude again would just produce the same response.
            // -----------------------------------------------------------------
            // 待機中は数えない（保留音の雑音が同じ文字起こしになる＝§1-e）
            // 捨てた切れ端は同じ発話の繰り返しの数から外す＝続きが始まった瞬間に外す（つないだ発話の判定より先＝codex レビュー）
            const staleTurn = stale;
            if (!inWait) lastRecorded = { turn, text: transcript };
            // 版7.2 ⑦＝あいさつ・お礼・相づちだけ（「はい」の応酬）は同じ発話の繰り返しに数えない＝listen で聞き続ける間に切らない
            if (!inWait && !isCourtesyOnly(transcript) && recordUserUtterance(transcript)) {
                await fillerPromise;
                if (staleTurn()) return;
                await endCallWithFarewell('loop_detected');
                return;
            }

            const turnMeta = { transcript, inWait, forced, stateBefore, stale: staleTurn };
            // 版6＝担当者本人の名乗りは Haiku を待たずに取次（「はい」も取次の声も流さない）
            if (fast) {
                await actOnDecision(fast, null, null, turnMeta);
                return;
            }
            // 版7.2 step 3q＝社名・名前・宛先・用件を明示に聞かれた＝Haiku を待たずに答える（答える声が在る時だけ・不在の段の途中でも答えて段を保つ）
            const asked = ts ? decideAskedQuestion({ transcript, ts }) : null;
            const askedDef = asked ? cfg.intentByName.get(asked.intent) : null;
            if (asked && askedDef?.audio_key && cfg.clips.has(askedDef.audio_key)) {
                await fillerPromise;
                if (state === 'ENDED' || staleTurn()) return;
                await actOnDecision(asked, askedDef, null, turnMeta);
                return;
            }
            // 不在の流れの途中＝取次・待たせる言葉が無ければ、段の答えとして AI を待たずに決める
            if (absentStage && !inWait) {
                if (!absentEscape(transcript)) {
                    await fillerPromise;
                    if (state === 'ENDED' || staleTurn()) return;
                    await handleAbsentReply(transcript, staleTurn);
                    return;
                }
                console.log(`[absent] left stage ${absentStage}: transfer/wait words`);
                absentStage = null;
            }
            // 手順3＝待機中の相づちだけは Haiku の前に決める（設定が在る通話だけ＝§1-f）
            if (ts) {
                const pre = decideBeforeClassifier({ transcript, ts, inWait });
                if (pre) {
                    await fillerPromise;
                    if (state === 'ENDED' || staleTurn()) return;
                    await actOnDecision(pre, null, null, turnMeta);
                    return;
                }
            }

            const claudeT0 = Date.now();
            const decision = await classifyWithClaude(transcript, {
                company: callParams?.company,
                contact: callParams?.contact,
                afterHold: inWait,
                validIntents: classifierIntentNames(cfg.intents, ts),
            }, cfg.classifierPrompt);
            console.log(
                `[timing] Claude done in ${Date.now() - claudeT0}ms (total ${Date.now() - t0}ms): ` +
                    `intent=${decision.intent ?? '(none)'}${decision.callback_info ? ' callback_info=(set)' : ''}`
            );
            if (staleTurn()) return;

            // -----------------------------------------------------------------
            // C-1 — Claude API failure. classifyWithClaude already retries
            // 3× internally on 529 overload before returning classifier_error.
            // If we still got an error, end the call rather than fall back to
            // Realtime (Realtime would likely fail too if Anthropic is down).
            // -----------------------------------------------------------------
            if (decision.reason === 'classifier_error') {
                console.log('[claude] classifier_error after retries; ending call');
                await fillerPromise;
                if (staleTurn()) return;
                await endCallWithFarewell('error_limit');
                return;
            }

            // Filler must complete before we play the real response.
            await fillerPromise;
            if (state === 'ENDED' || staleTurn()) return;

            // 設定が在る通話＝新しい判定順（§1-f）。無い通話は下の今の流れ
            if (ts) {
                const intentDef = cfg.intentByName.get(decision.intent) || null;
                const d = (ts.v2 ? decideAfterClassifierV2 : decideAfterClassifier)({ transcript, intentName: decision.intent, intentDef, ts, inWait });
                await actOnDecision(d, intentDef, decision, turnMeta);
                return;
            }

            // The server owns the behaviour — Claude only returns the intent
            // name. Look it up in the tenant's playbook.
            const intent = cfg.intentByName.get(decision.intent);
            if (!intent) {
                console.log(`Unknown intent "${decision.intent}"`);
                await fallbackToAgent('unknown intent');
                return;
            }
            // 不在＝戻りの時間を聞く流れ（4本がそろった声セットだけ）
            if (intent.name === 'not_available' && await startAbsentFlow()) return;

            // 聞き返しの回数を0に戻すのは、実際に応答の声を流す・自由会話へ渡す時だけ（段0）。
            // 以前は関門の前で戻していた＝関門で何度拒否しても毎回「1回目」で、聞き返しが終わらなかった。

            if (intent.action === 'reprompt') {
                // Transcribed, but gibberish/unintelligible — ask to repeat
                // instead of escalating to the live model.
                await repromptOrEnd();
                return;
            }
            if (intent.action === 'openai_realtime') {
                await fallbackToAgent('no scripted answer');
                return;
            }

            // action === 'play_audio'
            // 取次の証拠の関門は声の有無より先（声が欠けた取次で関門を迂回しない＝codex レビュー）
            if (intent.is_transfer && !hasSufficientTransferEvidence(transcript)) {
                console.log(
                    `[transfer-guard] blocked transfer on insufficient evidence ` +
                        `(${transcript.length} chars); reprompting instead`
                );
                await repromptOrEnd();
                return;
            }
            if (!intent.audio_key || !cfg.clips.has(intent.audio_key)) {
                console.error(`[intent] "${intent.name}" has no playable clip`);
                if (intent.end_call) { await endCallWithFarewell(intent.end_reason || 'rejected'); return; }
                await fallbackToAgent('no playable clip');
                return;
            }

            // ---------------------------------------------------------------
            // DETERMINISTIC TRANSFER GUARD (finding #12). Even if Claude said
            // "transfer", refuse to hand off on naked filler / acknowledgements
            // or when there's no explicit transfer-request / responsible-person
            // evidence in the transcript. Reprompt instead — far cheaper to ask
            // again than to wrongly connect a human to a non-decision-maker.
            // (classifier_error already ends the call above, so a classifier
            // failure never reaches here as a transfer = defaults to NON-
            // transfer.)
            // ---------------------------------------------------------------
            if (intent.is_transfer && !hasSufficientTransferEvidence(transcript)) {
                console.log(
                    `[transfer-guard] blocked transfer on insufficient evidence ` +
                        `(${transcript.length} chars); reprompting instead`
                );
                await repromptOrEnd();
                return;
            }

            // B-1 — Loop detection on Claude's decisions. Record FIRST so we
            // still play the current clip before ending.
            const looped = recordClaudeDecision(intent.audio_key);

            consecutiveEmpty = 0;
            if (intent.wants_callback_info) {
                await saveCallback(decision.callback_info, transcript);
                if (aborted || state === 'ENDED' || transferCommitted || staleTurn()) return; // 書いている間に終わった・追い越された
            }
            state = 'PLAYING';
            disableVad('playing response');
            await playClip(intent.audio_key);

            if (intent.is_transfer) {
                // 「おつなぎします」の最中に切れた・こちらが切った＝取次へ進まない（段0）
                if (aborted || state === 'ENDED') return;
                // Transfer flow skips farewell — handleTransfer writes
                // result='transferred' itself.
                await handleTransfer();
                if (timeoutInterval) {
                    clearInterval(timeoutInterval);
                    timeoutInterval = null;
                }
                return;
            }

            // callback_info（「16時頃戻ります」）は声を流す前に saveCallback で書いた

            if (looped) {
                await endCallWithFarewell('loop_detected');
                return;
            }

            if (intent.end_call) {
                await endCallWithFarewell(intent.end_reason || 'rejected');
                return;
            }
            // 流した後に CM へ（資料送付＝送付先は CM が伺う・2026-10-07）
            if (intent.then_agent && state === 'PLAYING') {
                await fallbackToAgent(`then_agent (${intent.name})`);
                return;
            }

            if (state === 'PLAYING') {
                state = 'LISTENING';
                // Reset silence clock — assistant just finished talking.
                lastSpeechAt = Date.now();
                enableVadDelayed(POST_PLAYBACK_DELAY_MS, 'after response');
            }
        };

        // -----------------------------------------------------------------
        // 台本で答えられない時＝CM へつなぐ（2026-10-06 Tom「困ったらcmに接続」・森さん「AIが喋り続けるが一番不信感は出そう」→ Tom「fallbackのgptやめるか」）
        // 💥 森さんへの試しの電話＝自由会話（GPT）が無音・雑音に返し続けて「死ぬほど暴走」した。以前の自由会話は下の switchToRealtime（呼び手なし＝戻す時の控え）
        // -----------------------------------------------------------------
        const fallbackToAgent = async (why) => {
            consecutiveEmpty = 0;
            // 第一声の留守電の判定がまだ＝その結果を待つ（留守電へ CM をつながない＝codex レビュー）
            if (answerCheckPromise) {
                await answerCheckPromise;
                if (aborted || state === 'ENDED') return;
            }
            console.log(`[fallback] ${why} → CM（自由会話は使わない）`);
            await commitTransfer('fallback');
        };

        // -----------------------------------------------------------------
        // OpenAI Realtime fallback（2026-10-06 から呼び手なし）
        // -----------------------------------------------------------------
        // eslint-disable-next-line no-unused-vars
        const switchToRealtime = async () => {
            console.log('▶ Switching to OpenAI Realtime mode');
            state = 'REALTIME';
            realtimeOpened = false;

            try {
                realtimeWs = new WebSocket(
                    'wss://api.openai.com/v1/realtime?model=gpt-realtime-2',
                    {
                        headers: {
                            Authorization: `Bearer ${OPENAI_API_KEY}`,
                        },
                    }
                );
            } catch (err) {
                console.error('[realtime] WebSocket construction failed:', err);
                await endCallWithFarewell('error_limit');
                return;
            }

            const rtWs = realtimeWs; // capture so handlers can detect teardown

            rtWs.on('open', () => {
                // Guard: if the call ended (or this socket was torn down /
                // replaced) while we were still CONNECTING, don't start
                // streaming into a dead call — just drop the upstream.
                if (state === 'ENDED' || realtimeWs !== rtWs) {
                    console.log('[realtime] opened after call end/teardown; closing upstream');
                    try { rtWs.removeAllListeners(); } catch (_) {}
                    try { rtWs.terminate(); } catch (_) {}
                    return;
                }
                realtimeOpened = true;
                console.log('Realtime WS opened');
                const company =
                    callParams?.company && callParams.company !== 'unknown'
                        ? callParams.company
                        : '不明';
                const contact =
                    callParams?.contact && callParams.contact !== 'unknown'
                        ? callParams.contact
                        : '不明';

                const sessionUpdate = {
                    type: 'session.update',
                    session: {
                        type: 'realtime',
                        instructions: `${cfg.realtimeSystemMessage}

【今回の架電情報】会社: ${company} / 担当者: ${contact}
【直前のお客様の発言】${lastUserTranscript || '（未取得）'}`,
                        output_modalities: ['audio'],
                        audio: {
                            input: {
                                // Twilio media streams are G.711 μ-law (8kHz).
                                format: { type: 'audio/pcmu' },
                                turn_detection: { type: 'server_vad' },
                                // 🔴 Realtime セッション内は gpt-transcribe でなく gpt-live-transcribe が現行推奨
                                //    （ファイル文字起こし側とはモデルが別＝上の formData と揃えない）
                                transcription: { model: 'gpt-live-transcribe' },
                            },
                            output: {
                                format: { type: 'audio/pcmu' },
                                voice: cfg.voice,
                            },
                        },
                    },
                };
                rtWs.send(JSON.stringify(sessionUpdate));

                // Seed conversation with the most recent user message so
                // Realtime answers it immediately.
                if (lastUserTranscript) {
                    rtWs.send(
                        JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'message',
                                role: 'user',
                                content: [
                                    { type: 'input_text', text: lastUserTranscript },
                                ],
                            },
                        })
                    );
                    rtWs.send(JSON.stringify({ type: 'response.create' }));
                }
            });

            rtWs.on('message', (data) => {
                // Guard: ignore anything that arrives after the call ended or
                // this socket was torn down/replaced.
                if (state === 'ENDED' || realtimeWs !== rtWs) return;
                try {
                    const response = JSON.parse(data);

                    if (response.type === 'response.output_audio.delta' && response.delta) {
                        sendMedia(response.delta);
                        return;
                    }

                    if (response.type === 'response.done') {
                        const output = response.response?.output || [];
                        output.forEach((item) => {
                            if (item?.type === 'message' && item?.role === 'assistant') {
                                item.content?.forEach((c) => {
                                    if (c.type === 'output_audio' && c.transcript) {
                                        saveTranscript('assistant', c.transcript);
                                    } else if (c.type === 'output_text' && c.text) {
                                        saveTranscript('assistant', c.text);
                                    }
                                });
                            }
                        });
                        return;
                    }

                    if (
                        response.type ===
                            'conversation.item.input_audio_transcription.completed' &&
                        response.transcript
                    ) {
                        saveTranscript('user', response.transcript);
                        return;
                    }

                    if (response.type === 'error') {
                        console.error('Realtime error event:', response);
                    }
                } catch (err) {
                    console.error('Realtime message parse error:', err);
                }
            });

            // C-2 — Realtime connection failure. If the WS errors or closes
            // before we ever saw 'open', treat it as a connection failure
            // and end the call gracefully instead of leaving the caller in
            // silence. Post-open errors/close are non-fatal (logged only).
            rtWs.on('error', (err) => {
                console.error('Realtime WS error:', err);
                // Ignore errors from a torn-down/replaced socket.
                if (realtimeWs !== rtWs) return;
                if (!realtimeOpened && state === 'REALTIME') {
                    console.log('[realtime] never opened; treating as connection failure');
                    endCallWithFarewell('error_limit').catch((e) =>
                        console.error('[realtime] error-recovery end failed:', e)
                    );
                }
            });
            rtWs.on('close', () => {
                console.log('Realtime WS closed');
                // Ignore close from a torn-down/replaced socket.
                if (realtimeWs !== rtWs) return;
                if (!realtimeOpened && state === 'REALTIME') {
                    console.log('[realtime] closed before open; treating as connection failure');
                    endCallWithFarewell('error_limit').catch((e) =>
                        console.error('[realtime] close-recovery end failed:', e)
                    );
                }
            });
        };

        // -----------------------------------------------------------------
        // Inbound audio frame (~20ms from Twilio)
        // -----------------------------------------------------------------
        const processInboundFrame = (base64Payload) => {
            if (state === 'REALTIME') {
                if (realtimeWs?.readyState === WebSocket.OPEN) {
                    realtimeWs.send(
                        JSON.stringify({
                            type: 'input_audio_buffer.append',
                            audio: base64Payload,
                        })
                    );
                }
                return;
            }

            // 版6＝保留音の検知（発話の VAD とは別）。聞いている間と処理中だけ数え、こちらが話している間・あいさつ前は数え直す
            if (ts?.v2 && !transferCommitted && callStartTime && Date.now() - callStartTime >= CALL_START_GRACE_MS
                && (state === 'LISTENING' || state === 'PROCESSING') && playbackActive === 0 && Date.now() >= holdQuietUntil) {
                holdTick(Buffer.from(base64Payload, 'base64'));
            } else if (holdRun) {
                holdRun = null;
            }

            // While we are speaking (or in any non-listening state) we
            // intentionally discard everything: no interruption, no VAD.
            // 例外＝待機中・6秒で区切った発話の処理の間（何も流していないので、その間の声を捨てない＝§1-d）
            // 例外2＝あいさつ前に相手の第一声を待っている間（AWAIT_ANSWER）
            if (state !== 'LISTENING' && state !== 'AWAIT_ANSWER' && !(state === 'PROCESSING' && (waitCtx || captureWhileProcessing))) return;

            // Within the call-start grace window / post-playback delay we
            // also discard inbound audio so spurious noise (e.g. Twilio's
            // trial preamble) cannot trigger a capture.
            if (!vadEnabled) return;

            const mulaw = Buffer.from(base64Payload, 'base64');
            const rms = calculateRms(mulaw);
            const isLoud = rms > VAD_RMS_THRESHOLD;

            if (isLoud) {
                speechFrames++;
                silenceFrames = 0;
                dropEarly(); // 黙りの途中で声が戻った＝先に始めた文字起こしは使わない
                if (!speechActive && speechFrames >= SPEECH_START_FRAMES) {
                    speechActive = true;
                    speechStartedAt = Date.now();
                    // Seed with the pre-roll (frames just before VAD tripped)
                    // so a soft onset like "どう…" isn't clipped. The current
                    // frame is appended below.
                    speechChunks = preRoll.slice();
                    if (liveStt) { liveStt.start(Buffer.concat(speechChunks)); liveFor = speechChunks; }
                    // Refresh silence clock as soon as we detect speech —
                    // we don't need to wait for the transcript to confirm
                    // the caller is engaged.
                    lastSpeechAt = Date.now();
                    console.log(`[vad] speech start (rms=${rms.toFixed(0)}, preroll=${speechChunks.length}f)`);
                    // 言いかけの続きが始まった＝持っていた音を頭につないで、閉じた後に文字起こしからやり直す
                    if (held && state === 'LISTENING' && !waitCtx) {
                        if (heldTimer) { clearTimeout(heldTimer); heldTimer = null; }
                        carryAudio = held.audio; // 持っていた音は前の切れ端も含む（handleUserUtterance でつないだ後の音）
                        held = null;
                        console.log(`[held] caller continued; will re-judge with the previous ${carryAudio.length} bytes`);
                    }
                    // 処理中に相手の続きが始まった＝その判定は捨てて、閉じた後に前の切れ端とつないで判定し直す
                    if (state === 'PROCESSING' && !waitCtx && mergeTurn && mergeTurn.turn === liveTurn) {
                        carryAudio = mergeTurn.audio;
                        if (adoptedEarly) { adoptedEarly.cancelled = true; adoptedEarly = null; } // 捨てた判定の文字起こしは要らない
                        if (lastRecorded?.turn === mergeTurn.turn) {
                            const i = recentUserUtterances.lastIndexOf(lastRecorded.text);
                            if (i >= 0) recentUserUtterances.splice(i, 1);
                            lastRecorded = null;
                        }
                        mergeTurn = null;
                        liveTurn = 0;
                        currentPlaybackToken = ++markCounter; // 読み込み中のつなぎの「はい」を止める（送り終えた分はそのまま流れる）
                        captureWhileProcessing = false;
                        state = 'LISTENING';
                        console.log(`[merge] caller continued while processing; re-judging with the previous ${carryAudio.length} bytes`);
                    }
                }
            } else {
                speechFrames = 0;
                silenceFrames++;
                if (earlyStt && rms > earlyStt.maxRms) earlyStt.maxRms = rms;
                if (earlyStt && earlyStt.maxRms >= EARLY_STT_QUIET_RMS) dropEarly(); // 小声が来た＝使わないと決まった（codex 監査）
                if (speechActive && silenceFrames === EARLY_STT_FRAMES && rms < EARLY_STT_QUIET_RMS && state === 'LISTENING' && !carryAudio && !held) {
                    const audio = Buffer.concat(speechChunks);
                    if (audio.length >= MIN_UTTERANCE_BYTES) {
                        // 流している文字起こしを区切る（使えなければファイルの文字起こしに戻す）
                        const live = liveStt && liveFor === speechChunks ? liveStt.commit() : Promise.resolve({ ok: false });
                        liveFor = null;
                        const t = Date.now();
                        const mine = {
                            chunks: speechChunks,
                            maxRms: rms, // この枠は音に入っていない＝判定にだけ入れる
                            cancelled: false,
                            promise: live.then((r) => {
                                if (r.ok && r.text) { console.log(`[live-stt] done in ${Date.now() - t}ms after commit`); return r.text; }
                                // 捨てた先の結果・終わった通話のためにファイルの文字起こしを走らせない（codex 監査）
                                if (mine.cancelled || aborted || state === 'ENDED') return null;
                                return transcribeWhisper(audio, cfg.transcriptionPrompt);
                            }).catch((err) => {
                                console.error('Whisper error (early):', err);
                                return null;
                            }),
                        };
                        earlyStt = mine;
                    }
                }
                if (speechActive && silenceFrames >= SILENCE_END_FRAMES) {
                    speechActive = false;
                    const utterance = Buffer.concat(speechChunks);
                    const early = earlyStt && earlyStt.chunks === speechChunks && earlyStt.maxRms < EARLY_STT_QUIET_RMS && state === 'LISTENING' && !carryAudio ? earlyStt : null;
                    if (earlyStt && !early) console.log(`[stt] early transcription dropped (maxRms=${earlyStt.maxRms.toFixed(0)})`);
                    if (early) { earlyStt = null; adoptedEarly = early; } else dropEarly();
                    speechChunks = [];
                    console.log(`[vad] speech end (${utterance.length} bytes)`);
                    if (state === 'AWAIT_ANSWER') {
                        // 電話を取った時の「ププッ」（約440Hz の澄んだ短い音）は第一声にしない＝続きを待つ（無言なら 2.5秒であいさつ）。
                        //   短い「はい」は声＝今どおり第一声（Tom「ププっに特化できないの？」2026-10-10）
                        //   💥 2026-10-10 試しの架電＝取った瞬間のププッで名乗り、Tom「先に自己紹介してたよ」
                        const beep = pickupBeepOf(utterance);
                        if (beep.seconds < ANSWER_BEEP_MAX_S && beep.ratio >= ANSWER_BEEP_MIN_RATIO) {
                            console.log(`[answer] ignored the pickup beep (${beep.seconds.toFixed(2)}s, tone=${beep.ratio.toFixed(2)})`);
                        } else {
                            // 相手の第一声（「はい、◯◯です」・録音の案内）＝判定はせず、記録だけ残してあいさつへ
                            greetAfterAnswer('answered');
                            checkAnswerUtterance(utterance);
                        }
                    } else if (utterance.length >= MIN_UTTERANCE_BYTES || carryAudio) {
                        handleUserUtterance(utterance, { early }).catch((err) =>
                            console.error('handleUserUtterance error:', err)
                        );
                    } else {
                        console.log(`Skipping short utterance: ${utterance.length} bytes`);
                    }
                }
            }

            // Maintain the rolling pre-roll (every frame while listening).
            preRoll.push(mulaw);
            if (preRoll.length > PREROLL_FRAMES) preRoll.shift();

            if (speechActive) { speechChunks.push(mulaw); if (liveFor === speechChunks) liveStt?.append(mulaw); }

            // 設定が在る通話だけ＝1発話の上限 6秒。超えたら区切って文字起こしへ回し、末尾1秒を次の頭に重ねる
            // （「少々お待ちください」の直後に保留音が切れ目なく続くと発話が閉じない＝§1-d）
            if (ts && speechActive && speechChunks.length >= MAX_UTTERANCE_FRAMES) {
                const utterance = Buffer.concat(speechChunks);
                dropEarly(); // 区切った発話はファイルの文字起こしで読む＝先に始めた分は捨てる
                speechChunks = speechChunks.slice(-SPLIT_OVERLAP_FRAMES);
                if (liveStt) { liveStt.start(Buffer.concat(speechChunks)); liveFor = speechChunks; }
                console.log(`[vad] forced split (${utterance.length} bytes; carrying ${speechChunks.length}f)`);
                handleUserUtterance(utterance, { forced: true }).catch((err) =>
                    console.error('handleUserUtterance error:', err)
                );
            }
        };

        // -----------------------------------------------------------------
        // Twilio events
        // -----------------------------------------------------------------
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'connected':
                        console.log('Twilio: connected');
                        break;
                    case 'start':
                        // SECURITY/PII: never log the full data.start payload —
                        // customParameters carries the one-time stream_token (a
                        // bearer credential) plus phone/company/contact/tenant
                        // (PII). Log only non-sensitive identifiers.
                        console.log(
                            `[start event] streamSid=${data.start.streamSid} callSid=${data.start.callSid ?? '(none)'}`
                        );
                        callParams = data.start.customParameters || {};
                        // The WS upgrade itself is unauthenticated; only the
                        // one-time token minted by /incoming-call (which IS
                        // Twilio-signature-checked) proves this stream is ours.
                        if (!consumeStreamToken(callParams.stream_token)) {
                            console.error('[start event] invalid or expired stream_token; closing WS');
                            releaseUnauthSlot();
                            clearPreAuth();
                            connection.close();
                            break;
                        }
                        // Authenticated: stop counting this socket against the
                        // unauthenticated cap and cancel the pre-auth timeout.
                        authenticated = true;
                        releaseUnauthSlot();
                        clearPreAuth();
                        delete callParams.stream_token;
                        streamSid = data.start.streamSid;
                        callSid = data.start.callSid || null;
                        callParams.callSid = callSid;
                        callStartTime = Date.now();
                        vadEnabled = false;
                        haiPatternIndex = 0;

                        // Reset all call-termination tracking for this call
                        callStartAt = Date.now();
                        lastSpeechAt = Date.now();
                        recentClaudeDecisions = [];
                        recentUserUtterances = [];
                        endReason = null;
                        realtimeOpened = false;
                        lastPlayedAudioKey = null;

                        // Start the timeout poll. checkTimeouts handles the
                        // ENDED guard, but clear any stale interval just in
                        // case (defensive — start should only fire once).
                        if (timeoutInterval) clearInterval(timeoutInterval);
                        timeoutInterval = setInterval(checkTimeouts, TIMEOUT_CHECK_INTERVAL_MS);
                        console.log(
                            `[timeout] poll started: silence=${SILENCE_TIMEOUT_MS / 1000}s ` +
                                `duration=${CALL_DURATION_TIMEOUT_MS / 1000}s ` +
                                `interval=${TIMEOUT_CHECK_INTERVAL_MS / 1000}s`
                        );
                        console.log(
                            `[start event] extracted streamSid=${streamSid} callSid=${callSid} ` +
                                `(callSid type=${typeof data.start.callSid}, present=${'callSid' in data.start})`
                        );
                        if (!callSid) {
                            console.error(
                                '[start event] WARNING: callSid is null/missing — transcripts will not save. ' +
                                    `Available keys on data.start: ${Object.keys(data.start).join(', ')}`
                            );
                        }
                        // Minimal, redacted identifiers only — no stream_token,
                        // no phone/company/contact PII.
                        const redactPhone = (p) =>
                            p && p.length > 4 ? `***${p.slice(-4)}` : (p ? '***' : '');
                        console.log(
                            `Twilio: start ${streamSid} (VAD muted for first ${CALL_START_GRACE_MS}ms) ` +
                                `tenant=${callParams.tenant_id || '(none)'} ` +
                                `phone=${redactPhone(callParams.phone)} ` +
                                `agent=${redactPhone(callParams.agent_phone)}`
                        );
                        // Load the tenant's playbook, then greet. Without a
                        // playbook there's nothing to say, so end gracefully.
                        // 声セットは架電した CM の性別で選ぶ（Tom 2026-10-05）＝CM の居ない通話は性別なし
                        // 性別は発信時に載せた operator_gender を使う（DB の往復をあいさつの前に挟まない）。無い時だけ引く
                        // 取次のつまみ（transfer_settings）も並行で読む＝行が無い・読めなければ今の挙動（家＝~/sente/sfav_transfer_tuning_plan.md §1-b）
                        // 読んでいる間から相手の第一声を聞く（あいさつは読み終えてから＝answerReady）
                        awaitAnswer();
                        Promise.all([
                            (callParams.operator_gender
                                ? Promise.resolve(parseVoiceGender(callParams.operator_gender))
                                : operatorGender(callParams.operator_id || null))
                                .then((gender) => loadPlaybook(callParams.tenant_id, callParams.project_id || null, gender))
                                // 名前で名乗る声セットだけ CM の名前の音をのせる（作り済みを引くだけ＝関門で作ってある）
                                .then(async (pb) => (pb?.clips?.has('name_lead') && callParams.operator_id
                                    ? withCmName(pb, await ensureCmNameAudio(callParams.operator_id))
                                    : pb)),
                            // あいさつを待たせない＝1.5秒で読めなければ今の挙動
                            Promise.race([
                                loadTransferSettings(callParams.tenant_id, callParams.project_id || null),
                                new Promise((r) => setTimeout(() => r({ ts: null, error: new Error('timeout') }), TRANSFER_SETTINGS_LOAD_TIMEOUT_MS)),
                            ]).catch((err) => ({ ts: null, error: err })),
                        ])
                            .then(([loaded, settings]) => {
                                if (!loaded) {
                                    console.error(
                                        `[start] no playbook for tenant ${callParams.tenant_id || '(none)'}; ending`
                                    );
                                    return endCallWithFarewell('error_limit');
                                }
                                if (aborted || state === 'ENDED') return;
                                if (settings?.error) {
                                    tsFallback = true;
                                    logDecision({ event: 'fallback', action: String(settings.error.message || settings.error).slice(0, 200) });
                                }
                                if (settings?.ts) {
                                    ts = settings.ts;
                                    // 声セットのキャッシュは他の通話と共有＝この通話用に複製してプロンプトと語彙ヒントだけ差し替える
                                    cfg = {
                                        ...loaded,
                                        classifierPrompt: buildClassifierPrompt(loaded, ts),
                                        transcriptionPrompt: buildTranscriptionPrompt(loaded.companyName, loaded.intents, ts),
                                    };
                                    console.log(`[transfer-settings] ${ts.scope} v${ts.version} ${ts.level ? `level=${ts.level}` : `on_wait=${ts.on_wait}`}`);
                                } else {
                                    cfg = loaded;
                                }
                                // 切り札＝環境変数 LIVE_STT=0 で今までのファイルの文字起こしだけに戻す
                                if (process.env.LIVE_STT !== '0' && !liveStt) liveStt = createLiveStt(cfg.transcriptionPrompt);
                                return answerReady();
                            })
                            .catch((err) => {
                                console.error('[start] playbook load / greeting failed:', err);
                                endCallWithFarewell('error_limit').catch(() => {});
                            });
                        break;
                    case 'media':
                        processInboundFrame(data.media.payload);
                        break;
                    case 'mark': {
                        const name = data.mark?.name;
                        if (name && pendingMarks.has(name)) {
                            const resolve = pendingMarks.get(name);
                            pendingMarks.delete(name);
                            resolve();
                        }
                        break;
                    }
                    case 'stop':
                        console.log('Twilio: stop');
                        // 通話が終わった＝この後の保留音・発話の判定から取次へ進まない（取次の切り替え中・後は正常な終わり＝codex レビュー）
                        if (transferPhase !== 'committing' && transferPhase !== 'committed') aborted = true;
                        break;
                    default:
                        console.log('Twilio: unhandled event', data.event);
                }
            } catch (err) {
                console.error('Twilio message parse error:', err);
            }
        });

        connection.on('close', () => {
            console.log(`Twilio WS closed (endReason=${endReason || 'n/a'})`);
            // 取次が Twilio を <Enqueue> へ切り替えた時の切断は正常（段0）＝それ以外は通話が終わった
            if (transferPhase !== 'committing' && transferPhase !== 'committed') aborted = true;
            clearAnswerTimers();
            dropHeld('closed');
            if (liveStt) { liveStt.close(); liveStt = null; liveFor = null; }
            state = 'ENDED';
            currentPlaybackToken = null;
            // If the socket closed before authenticating, free its unauth slot
            // and cancel the pre-auth timer.
            releaseUnauthSlot();
            clearPreAuth();
            // Release any playback awaiting a mark — Twilio will never send
            // marks after the socket closes, and a stuck `await playAudio()`
            // would otherwise hang endCallWithFarewell forever and skip the
            // call_sessions result save.
            for (const resolve of pendingMarks.values()) resolve();
            pendingMarks.clear();
            disableVad('connection closed');
            if (timeoutInterval) {
                clearInterval(timeoutInterval);
                timeoutInterval = null;
            }
            // Tear down the Realtime WS regardless of state. Finding #9: a
            // CONNECTING socket (not yet OPEN) would otherwise open *after* the
            // Twilio call ended and leak — keep streaming media into a dead
            // call. terminate() handles CONNECTING; removing listeners stops
            // the open/message/error/close handlers firing post-teardown.
            teardownRealtime();
        });

        // Forcefully drop the Realtime upstream and stop its handlers running
        // after the call has ended. Safe to call multiple times.
        function teardownRealtime() {
            const ws = realtimeWs;
            if (!ws) return;
            realtimeWs = null;
            try { ws.removeAllListeners(); } catch (_) {}
            try {
                // terminate() works for both CONNECTING and OPEN; close() is a
                // no-op while CONNECTING, so prefer terminate to avoid a leak.
                ws.terminate();
            } catch (_) {
                try { ws.close(); } catch (_) {}
            }
        }

        connection.on('error', (err) => {
            console.error('Twilio WS error:', err);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server listening on port ${PORT}`);
});
