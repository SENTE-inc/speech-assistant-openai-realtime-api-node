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

// Convert MP3 buffer -> mulaw 8kHz mono by spawning ffmpeg directly.
// We MUST write to a temp file rather than stdin, because the MP3 demuxer
// needs to seek over ID3v2/VBR headers — which fails on a pipe with
// "Failed to read frame size: Could not seek to N. pipe:0: Invalid argument".
function convertMp3ToMulaw(mp3Buffer, label = '') {
    return new Promise((resolve, reject) => {
        if (!mp3Buffer || mp3Buffer.length === 0) {
            return reject(new Error(`[ffmpeg ${label}] input mp3 buffer is empty`));
        }

        let tmpDir;
        let tmpFile;
        try {
            tmpDir = mkdtempSync(join(tmpdir(), 'mp3conv-'));
            tmpFile = join(tmpDir, 'in.mp3');
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
    const path = cfg.audioBasePath ? `${cfg.audioBasePath}/${clip.filename}` : clip.filename;
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
const playbookCache = new Map(); // tenantId -> { cfg, loadedAt }

// Build the Claude classifier prompt from a playbook's intents.
function buildClassifierPrompt(cfg) {
    const lines = cfg.intents.map((i) => {
        const ex = Array.isArray(i.triggers) ? i.triggers.join(' / ') : '';
        return `- ${i.name}: ${ex}`;
    });
    return `あなたは営業電話の応対判断AIです。${cfg.companyName}の担当者として、` +
        `会話の直近の発言から最も当てはまる意図(intent)を1つだけ選んでください。\n\n` +
        `【意図の一覧（name: 該当する発言の例）】\n${lines.join('\n')}\n\n` +
        `判断のポイント:\n` +
        `- 聞き取れない・意味をなさない発話は "reprompt"。\n` +
        `- 意味は通じるが上記に当てはまらない発言は "openai_realtime"。\n` +
        `- 戻り時間など日時情報があれば callback_info に原文のまま記録。\n\n` +
        `必ず次のJSONのみを返してください（説明文は不要）:\n` +
        `{ "intent": "<上記nameのいずれか>", "callback_info": "<日時情報があれば。無ければ省略>" }`;
}

async function loadPlaybook(tenantId) {
    if (!tenantId) return null;
    const cached = playbookCache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < PLAYBOOK_TTL_MS) return cached.cfg;

    const { data: pb, error: pbErr } = await supabase
        .from('call_playbooks')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .is('campaign_id', null)
        .maybeSingle();
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

    // Vocabulary hint for STT — biases gpt-4o-transcribe toward this tenant's
    // expected phrases so homophones (e.g. 代表/対象) resolve correctly.
    // Capped well under the model's ~244-token prompt budget.
    const vocab = [...new Set(intents.flatMap((i) => (Array.isArray(i.triggers) ? i.triggers : [])))].join('、');
    cfg.transcriptionPrompt =
        `日本語の法人向け営業電話です。会社名は${pb.company_name}。想定される発言: ${vocab}`.slice(0, 240);

    playbookCache.set(tenantId, { cfg, loadedAt: Date.now() });

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

async function transcribeWhisper(mulawBuffer, prompt) {
    const wav = mulawToWav(mulawBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'gpt-4o-transcribe');
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
        return null;
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

    const userMessage = contextLine
        ? `[文脈] ${contextLine}\n[発話] ${transcript}`
        : transcript;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const message = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 200,
                system: [
                    {
                        type: 'text',
                        text: prompt,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: [
                    { role: 'user', content: userMessage },
                    { role: 'assistant', content: '{' },
                ],
            });

            const raw = '{' + (message.content[0]?.text || '');
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start < 0 || end < 0) throw new Error('No JSON found');
            const parsed = JSON.parse(raw.slice(start, end + 1));
            if (!parsed.intent) throw new Error('Missing intent');
            return parsed;
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
// Twilio REST: hand off the live call to a human agent
// =====================================================================

async function transferCall(callSid, agentPhone) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured');
    }
    const url =
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const twiml = `<Response><Dial>${agentPhone}</Dial></Response>`;

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
    console.log(`✓ Call transferred to ${agentPhone} (callSid=${callSid})`);
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
        console.log(`[lock] transfer blocked for ${key} (held by ${existing.callSid})`);
        return false;
    }
    transferLocks.set(key, { lockedAt: now, callSid });
    console.log(`[lock] transfer acquired for ${key} by ${callSid}`);
    return true;
}

function releaseTransferLock(tenantId, agentPhone) {
    const key = `${tenantId}:${agentPhone}`;
    transferLocks.delete(key);
    console.log(`[lock] transfer released for ${key}`);
}

// =====================================================================
// Fastify app
// =====================================================================

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async (_req, reply) => {
    reply.send({
        message: 'Twilio Media Stream Server (hybrid: recordings + realtime fallback)',
    });
});

fastify.get('/health', async (request, reply) => {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
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

// Structural template. `key` is the contract with the dashboard setup form,
// which supplies the text for each key. Mirrors the proven demo/sente layout.
const CLIP_TEMPLATE = [
    { key: 'greeting',         clip_type: 'greeting', filename: '01_greeting.mp3',         sort_order: 1 },
    { key: 'reason',           clip_type: 'response', filename: '04_reason.mp3',           sort_order: 2 },
    { key: 'company',          clip_type: 'response', filename: '05_company.mp3',          sort_order: 3 },
    { key: 'who',              clip_type: 'response', filename: '06_who.mp3',              sort_order: 4 },
    { key: 'appointment',      clip_type: 'response', filename: '07_appointment.mp3',      sort_order: 5 },
    { key: 'transfer_success', clip_type: 'response', filename: '09_transfer_success.mp3', sort_order: 6 },
    { key: 'callback_request', clip_type: 'response', filename: '11_callback_request.mp3', sort_order: 7 },
    { key: 'sorry_disturb',    clip_type: 'response', filename: '15_sorry_disturb.mp3',    sort_order: 8, suppress_farewell: true },
    { key: '16a_hai',          clip_type: 'filler',   filename: '16a_hai.mp3',             sort_order: 9 },
    { key: '16b_hai',          clip_type: 'filler',   filename: '16b_hai.mp3',             sort_order: 10 },
    { key: '22a_pardon',       clip_type: 'pardon',   filename: '22a_pardon.mp3',          sort_order: 11 },
    { key: '22b_pardon',       clip_type: 'pardon',   filename: '22b_pardon.mp3',          sort_order: 12 },
    { key: 'farewell',         clip_type: 'farewell', filename: '21_farewell.mp3',         sort_order: 13 },
];

// Intent set + trigger phrases. Company-independent, so it's fixed here and
// not exposed in the dashboard form. audio_key references CLIP_TEMPLATE keys.
const INTENT_TEMPLATE = [
    { name: 'transfer', audio_key: 'transfer_success', is_transfer: true, sort_order: 1,
        triggers: ['お繋ぎします', '少々お待ち', '担当者に代わります', '私が担当です', '代表です', '私が代表です', '社長です', '興味があります', '詳しく聞かせてください', '担当に代わります', '前向きな反応・担当者本人が出た場合'] },
    { name: 'reason', audio_key: 'reason', sort_order: 2,
        triggers: ['どのようなご用件', '何のご用件', 'どういったご提案'] },
    { name: 'company', audio_key: 'company', sort_order: 3,
        triggers: ['どちらの会社', 'どこの会社', '会社名は'] },
    { name: 'who', audio_key: 'who', sort_order: 4,
        triggers: ['どなた様', 'お名前は', '担当者のお名前'] },
    { name: 'appointment', audio_key: 'appointment', sort_order: 5,
        triggers: ['アポイントは', 'お約束は', 'ご予約は'] },
    { name: 'callback_request', audio_key: 'callback_request', sort_order: 6,
        triggers: ['折り返しましょうか', '後ほど', 'またかけ直して'] },
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
    if (!PROVISION_SECRET || request.headers['x-provision-secret'] !== PROVISION_SECRET) {
        return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = request.body || {};
    const tenant_id = (body.tenant_id || '').trim();
    const company_name = (body.company_name || '').trim();
    const voice = (body.voice || 'shimmer').trim();
    const clipTexts = body.clip_texts && typeof body.clip_texts === 'object' ? body.clip_texts : {};
    if (!tenant_id || !company_name) {
        return reply.code(400).send({ error: 'tenant_id and company_name are required' });
    }

    // Resolve the tenant (and its slug, used as the storage folder).
    const { data: tenant, error: tErr } = await supabase
        .from('tenants').select('id, slug').eq('id', tenant_id).maybeSingle();
    if (tErr || !tenant) return reply.code(404).send({ error: 'tenant not found' });
    const base = (tenant.slug || '').trim();

    const realtimeSystemMessage =
        (typeof body.realtime_system_message === 'string' && body.realtime_system_message.trim()) ||
        `あなたはプロの営業アシスタントです。必ず日本語で話してください。\n${company_name}の担当者です。\n簡潔に丁寧に対応してください。`;

    // Find the tenant's active default playbook; update-in-place if it exists,
    // otherwise create one. Either way we rebuild its clips and intents.
    const { data: existing } = await supabase
        .from('call_playbooks').select('id')
        .eq('tenant_id', tenant_id).is('campaign_id', null).eq('is_active', true).maybeSingle();

    let playbookId;
    if (existing) {
        playbookId = existing.id;
        const { error: upErr } = await supabase.from('call_playbooks').update({
            company_name, voice, audio_base_path: base,
            realtime_system_message: realtimeSystemMessage, updated_at: new Date().toISOString(),
        }).eq('id', playbookId);
        if (upErr) return reply.code(500).send({ error: `playbook update failed: ${upErr.message}` });
        await supabase.from('audio_clips').delete().eq('playbook_id', playbookId);
        await supabase.from('call_intents').delete().eq('playbook_id', playbookId);
    } else {
        const { data: created, error: insErr } = await supabase.from('call_playbooks').insert({
            tenant_id, name: 'default', company_name, voice, audio_base_path: base,
            realtime_system_message: realtimeSystemMessage, is_active: true,
        }).select('id').single();
        if (insErr) return reply.code(500).send({ error: `playbook insert failed: ${insErr.message}` });
        playbookId = created.id;
    }

    // Build and insert clip + intent rows from the templates.
    const clipRows = CLIP_TEMPLATE.map((c) => ({
        playbook_id: playbookId, tenant_id, key: c.key, clip_type: c.clip_type,
        filename: c.filename, text: String(clipTexts[c.key] ?? '').trim(), source: 'tts',
        suppress_farewell: !!c.suppress_farewell, sort_order: c.sort_order, active: true,
    }));
    const { error: clipErr } = await supabase.from('audio_clips').insert(clipRows);
    if (clipErr) return reply.code(500).send({ error: `clips insert failed: ${clipErr.message}` });

    const intentRows = INTENT_TEMPLATE.map((i) => ({
        playbook_id: playbookId, tenant_id, name: i.name, action: i.action || 'play_audio',
        audio_key: i.audio_key, triggers: i.triggers, is_transfer: !!i.is_transfer,
        end_call: !!i.end_call, end_reason: i.end_reason ?? null,
        wants_callback_info: !!i.wants_callback_info, sort_order: i.sort_order, active: true,
    }));
    const { error: intErr } = await supabase.from('call_intents').insert(intentRows);
    if (intErr) return reply.code(500).send({ error: `intents insert failed: ${intErr.message}` });

    // Synthesize each clip with text and upload it. Empty-text clips are skipped.
    const results = [];
    for (const c of clipRows) {
        if (!c.text) { results.push({ key: c.key, status: 'skipped_no_text' }); continue; }
        const path = base ? `${base}/${c.filename}` : c.filename;
        try {
            const buf = await synthesizeClip(c.text, voice);
            const { error: upErr } = await supabase.storage
                .from(AUDIO_BUCKET).upload(path, buf, { contentType: 'audio/mpeg', upsert: true });
            if (upErr) throw new Error(upErr.message);
            results.push({ key: c.key, status: 'ok', bytes: buf.length });
        } catch (err) {
            results.push({ key: c.key, status: 'failed', error: err.message });
        }
    }

    // Bust the per-tenant playbook cache and this tenant's clip audio cache so
    // the next call picks up the new script immediately.
    playbookCache.delete(tenant_id);
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

// Delete recordings past their retention window: storage object first, then
// the metadata row. Runs opportunistically after each intake and via the
// secret-protected endpoint below (Railway sleeps, so no in-process timer).
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
    const url = `https://${request.headers.host}/recording-status`;
    if (!isValidTwilioSignature(url, params, request.headers['x-twilio-signature'])) {
        console.error('[recording] rejected callback with bad signature');
        return reply.code(403).send({ error: 'invalid signature' });
    }

    const { CallSid, RecordingSid, RecordingUrl, RecordingStatus, RecordingDuration } = params;
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
        const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
        const dl = await fetch(`${RecordingUrl}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
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
        return reply.send({ ok: true });
    } catch (err) {
        // The recording stays on Twilio (we delete only after success), so a
        // failed intake loses nothing — it can be re-fetched later.
        console.error('[recording] intake failed:', err);
        return reply.code(500).send({ error: String(err.message || err) });
    }
});

// Manual/cron purge trigger, protected like /provision-playbook.
fastify.post('/purge-recordings', async (request, reply) => {
    if (!PROVISION_SECRET || request.headers['x-provision-secret'] !== PROVISION_SECRET) {
        return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send(await purgeExpiredRecordings());
});

fastify.all('/incoming-call', async (request, reply) => {
    const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const company = escXml(decodeURIComponent(request.query.company || 'unknown'));
    const contact = escXml(decodeURIComponent(request.query.contact || 'unknown'));
    const phone = escXml(decodeURIComponent(request.query.phone || 'unknown'));
    const agent_phone = escXml(decodeURIComponent(request.query.agent_phone || ''));
    const agent_name = escXml(decodeURIComponent(request.query.agent_name || ''));
    const tenant_id = escXml(decodeURIComponent(request.query.tenant_id || ''));

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="company" value="${company}" />
            <Parameter name="contact" value="${contact}" />
            <Parameter name="phone" value="${phone}" />
            <Parameter name="agent_phone" value="${agent_phone}" />
            <Parameter name="agent_name" value="${agent_name}" />
            <Parameter name="tenant_id" value="${tenant_id}" />
        </Stream>
    </Connect>
</Response>`;
    reply.type('text/xml').send(twiml);
});

// =====================================================================
// Per-call WebSocket handler
// =====================================================================

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection /*, req */) => {
        console.log('▶ Twilio client connected');

        // Identity
        let streamSid = null;
        let callSid = null;
        let callParams = {};
        // Per-tenant playbook (script + clips + intents), loaded at 'start'.
        let cfg = null;

        // State machine
        // 'INITIAL' | 'PLAYING' | 'LISTENING' | 'PROCESSING' | 'REALTIME' | 'ENDED'
        let state = 'INITIAL';

        // Realtime fallback
        let realtimeWs = null;
        let lastUserTranscript = null;

        // Re-prompt tracking. consecutiveEmpty counts back-to-back utterances
        // we couldn't act on; it resets the moment we get a usable one.
        // pardonIndex rotates across the tenant's pardon clips.
        let consecutiveEmpty = 0;
        let pardonIndex = 0;

        // VAD
        const VAD_RMS_THRESHOLD = 2000;
        const SPEECH_START_FRAMES = 3;   // 3 consecutive frames (~60ms) required
        const SILENCE_END_FRAMES = 25;   // 25 frames * 20ms = 500ms of silence ends utterance
        const MIN_UTTERANCE_BYTES = 4000; // ~500ms of audio (8kHz mulaw)
        const CALL_START_GRACE_MS = 5000;  // ignore inbound audio for the first 5s (Twilio trial preamble)
        const POST_PLAYBACK_DELAY_MS = 800; // wait this long after a clip before re-arming VAD
        const HUMAN_PAUSE_MS = 600; // hold the filler clip for this long after silence-end so the caller's last word lands cleanly
        const PREROLL_FRAMES = 15;       // ~300ms kept before VAD confirms speech, so soft onsets aren't clipped
        let speechActive = false;
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
            speechActive = false;
            speechFrames = 0;
            silenceFrames = 0;
            speechChunks = [];
            preRoll = [];
        };

        const disableVad = (reason) => {
            if (vadEnableTimer) {
                clearTimeout(vadEnableTimer);
                vadEnableTimer = null;
            }
            if (vadEnabled) console.log(`[vad] disabled (${reason})`);
            vadEnabled = false;
            resetVadCapture();
        };

        const enableVadDelayed = (minDelayMs, reason) => {
            if (vadEnableTimer) clearTimeout(vadEnableTimer);
            const sinceStart = callStartTime ? Date.now() - callStartTime : 0;
            const remainingGrace = Math.max(0, CALL_START_GRACE_MS - sinceStart);
            const delay = Math.max(minDelayMs, remainingGrace);
            vadEnableTimer = setTimeout(() => {
                vadEnableTimer = null;
                if (state !== 'LISTENING') {
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
                    `contentLen=${trimmed?.length ?? 0} preview="${trimmed?.substring(0, 40) ?? ''}"`
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
                    supabase
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
                                    `[saveTranscript] ✓ INSERT OK session_id=${data.id} role=${role}: ${trimmed.substring(0, 60)}`
                                );
                            }
                        });
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
            const token = ++markCounter;
            currentPlaybackToken = token;

            const clip = cfg?.clips.get(key);
            if (!clip) {
                console.error(`[playAudio] unknown clip "${key}" for tenant ${cfg?.tenantId}`);
                return;
            }
            const loadT0 = Date.now();
            let mulaw;
            try {
                mulaw = await getAudioBuffer(cfg, key);
            } catch (err) {
                console.error(`Failed to load ${key}:`, err.message);
                return;
            }
            const loadMs = Date.now() - loadT0;
            if (currentPlaybackToken !== token) return; // Interrupted while loading

            console.log(`▶ Playing ${key} (${clip.filename}) load=${loadMs}ms size=${mulaw.length}B`);
            // Record what we just played so endCallWithFarewell can decide
            // whether to append the farewell clip or not.
            lastPlayedAudioKey = key;
            const chunkSize = 160; // 20ms at 8kHz mulaw
            for (let i = 0; i < mulaw.length; i += chunkSize) {
                if (currentPlaybackToken !== token) return;
                sendMedia(mulaw.subarray(i, i + chunkSize).toString('base64'));
            }

            const markName = `mark-${token}`;
            await new Promise((resolve) => {
                pendingMarks.set(markName, resolve);
                sendMark(markName);
            });

            console.log(`✓ Finished ${key}`);
            saveTranscript('assistant', clip.text || '');
        };

        // -----------------------------------------------------------------
        // Greeting flow (single clip)
        // -----------------------------------------------------------------
        const playGreeting = async () => {
            state = 'PLAYING';
            disableVad('playing greeting');
            if (cfg?.greetingKey) await playAudio(cfg.greetingKey);
            if (state !== 'PLAYING') return;

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
        const handleTransfer = async () => {
            disableVad('transferring');
            const tenantId = callParams?.tenant_id;
            const agentPhone = callParams?.agent_phone;
            const agentName = callParams?.agent_name;

            if (!callSid) {
                console.error('[transfer] callSid missing; cannot transfer');
                state = 'ENDED';
                return;
            }
            if (!tenantId || !agentPhone) {
                console.error(
                    `[transfer] missing tenant_id (${tenantId || 'none'}) or ` +
                        `agent_phone (${agentPhone || 'none'}); cannot transfer`
                );
                await endCallWithFarewell('error_limit');
                return;
            }

            if (!acquireTransferLock(tenantId, agentPhone, callSid)) {
                console.log(
                    `[transfer] agent ${agentPhone} already busy with another call; ` +
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
                `[transfer] handing off callSid=${callSid} to ${agentName || '(no name)'} <${agentPhone}>`
            );
            try {
                await transferCall(callSid, agentPhone);
            } catch (err) {
                console.error('[transfer] Twilio transfer failed:', err);
                releaseTransferLock(tenantId, agentPhone);
                await endCallWithFarewell('error_limit');
                return;
            }

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

            // Silence timeout only fires while we're actively waiting for
            // the caller. During PLAYING/PROCESSING/REALTIME the assistant
            // is busy and silence is expected.
            if (state === 'LISTENING' && silenceMs >= SILENCE_TIMEOUT_MS) {
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
        };

        // -----------------------------------------------------------------
        // After a user utterance: filler + Whisper + Claude + action
        // -----------------------------------------------------------------
        const handleUserUtterance = async (mulawAudio) => {
            if (state === 'PROCESSING' || state === 'ENDED' || state === 'REALTIME') return;
            state = 'PROCESSING';
            disableVad('processing utterance');
            const t0 = Date.now();
            console.log(`▶ State: PROCESSING (${mulawAudio.length} bytes captured)`);

            // Start Whisper immediately so STT runs during the human-pause
            // window — the overall response latency stays roughly the same
            // even though the filler is delayed.
            const whisperPromise = transcribeWhisper(mulawAudio, cfg.transcriptionPrompt).catch((err) => {
                console.error('Whisper error:', err);
                return null;
            });

            // Hold the filler clip for HUMAN_PAUSE_MS after silence-end so
            // the caller's last word does not get stepped on. Without this
            // pause the agent fires "はい" the instant VAD flips, which
            // sounds robotic and impatient.
            // Rotate through the tenant's filler clips so it doesn't sound robotic.
            const fillerKeys = cfg?.fillerKeys || [];
            const fillerKey = fillerKeys.length ? fillerKeys[haiPatternIndex % fillerKeys.length] : null;
            haiPatternIndex++;
            const fillerPromise = new Promise((resolve) =>
                setTimeout(resolve, HUMAN_PAUSE_MS)
            ).then(() => {
                if (state === 'ENDED' || !fillerKey) return;
                return playAudio(fillerKey);
            }).catch((err) => console.error('Filler playback error:', err));
            console.log(
                `[parallel] Whisper started; filler ${fillerKey || '(none)'} scheduled in ${HUMAN_PAUSE_MS}ms`
            );

            const transcript = await whisperPromise;
            console.log(`[timing] Whisper done in ${Date.now() - t0}ms`);

            if (!transcript) {
                // Whisper heard nothing usable — re-prompt (or end if we've
                // already asked too many times).
                console.log('Empty transcript — re-prompting');
                await fillerPromise;
                if (state === 'ENDED') return;
                await repromptOrEnd();
                return;
            }

            console.log(`User said: "${transcript}"`);
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
                await endCallWithFarewell('user_hangup');
                return;
            }

            // -----------------------------------------------------------------
            // B-2 — Loop detection on the caller's side (same utterance over
            // and over). Triggers before we even call Claude, since asking
            // Claude again would just produce the same response.
            // -----------------------------------------------------------------
            if (recordUserUtterance(transcript)) {
                await fillerPromise;
                await endCallWithFarewell('loop_detected');
                return;
            }

            const claudeT0 = Date.now();
            const decision = await classifyWithClaude(transcript, {
                company: callParams?.company,
                contact: callParams?.contact,
            }, cfg.classifierPrompt);
            console.log(
                `[timing] Claude done in ${Date.now() - claudeT0}ms (total ${Date.now() - t0}ms):`,
                decision
            );

            // -----------------------------------------------------------------
            // C-1 — Claude API failure. classifyWithClaude already retries
            // 3× internally on 529 overload before returning classifier_error.
            // If we still got an error, end the call rather than fall back to
            // Realtime (Realtime would likely fail too if Anthropic is down).
            // -----------------------------------------------------------------
            if (decision.reason === 'classifier_error') {
                console.log('[claude] classifier_error after retries; ending call');
                await fillerPromise;
                await endCallWithFarewell('error_limit');
                return;
            }

            // Filler must complete before we play the real response.
            await fillerPromise;
            if (state === 'ENDED') return;

            // The server owns the behaviour — Claude only returns the intent
            // name. Look it up in the tenant's playbook.
            const intent = cfg.intentByName.get(decision.intent);
            if (!intent) {
                console.log(`Unknown intent "${decision.intent}"; falling back to realtime`);
                await switchToRealtime();
                return;
            }

            // A usable decision means the caller got through — clear the
            // re-prompt miss counter. `reprompt` is itself a miss, so skip it.
            if (intent.action !== 'reprompt') consecutiveEmpty = 0;

            if (intent.action === 'reprompt') {
                // Transcribed, but gibberish/unintelligible — ask to repeat
                // instead of escalating to the live model.
                await repromptOrEnd();
                return;
            }
            if (intent.action === 'openai_realtime') {
                await switchToRealtime();
                return;
            }

            // action === 'play_audio'
            if (!intent.audio_key || !cfg.clips.has(intent.audio_key)) {
                console.error(`[intent] "${intent.name}" has no playable clip; falling back to realtime`);
                await switchToRealtime();
                return;
            }

            // B-1 — Loop detection on Claude's decisions. Record FIRST so we
            // still play the current clip before ending.
            const looped = recordClaudeDecision(intent.audio_key);

            state = 'PLAYING';
            disableVad('playing response');
            await playAudio(intent.audio_key);

            if (intent.is_transfer) {
                // Transfer flow skips farewell — handleTransfer writes
                // result='transferred' itself.
                await handleTransfer();
                if (timeoutInterval) {
                    clearInterval(timeoutInterval);
                    timeoutInterval = null;
                }
                return;
            }

            // Persist callback_info when the intent expects scheduling context
            // (e.g. "16時頃戻ります"). n8n's post-call analysis uses it.
            if (intent.wants_callback_info && decision.callback_info && callSid) {
                try {
                    const { error: cbErr } = await supabase
                        .from('call_sessions')
                        .update({ metadata: { callback_info: decision.callback_info } })
                        .eq('call_sid', callSid);
                    if (cbErr) console.error('[callback_info] save failed:', cbErr);
                    else console.log(`[callback_info] saved: ${decision.callback_info}`);
                } catch (err) {
                    console.error('[callback_info] threw:', err);
                }
            }

            if (looped) {
                await endCallWithFarewell('loop_detected');
                return;
            }

            if (intent.end_call) {
                await endCallWithFarewell(intent.end_reason || 'rejected');
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
        // OpenAI Realtime fallback
        // -----------------------------------------------------------------
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

            realtimeWs.on('open', () => {
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
                                transcription: { model: 'gpt-4o-transcribe' },
                            },
                            output: {
                                format: { type: 'audio/pcmu' },
                                voice: cfg.voice,
                            },
                        },
                    },
                };
                realtimeWs.send(JSON.stringify(sessionUpdate));

                // Seed conversation with the most recent user message so
                // Realtime answers it immediately.
                if (lastUserTranscript) {
                    realtimeWs.send(
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
                    realtimeWs.send(JSON.stringify({ type: 'response.create' }));
                }
            });

            realtimeWs.on('message', (data) => {
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
            realtimeWs.on('error', (err) => {
                console.error('Realtime WS error:', err);
                if (!realtimeOpened && state === 'REALTIME') {
                    console.log('[realtime] never opened; treating as connection failure');
                    endCallWithFarewell('error_limit').catch((e) =>
                        console.error('[realtime] error-recovery end failed:', e)
                    );
                }
            });
            realtimeWs.on('close', () => {
                console.log('Realtime WS closed');
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

            // While we are speaking (or in any non-listening state) we
            // intentionally discard everything: no interruption, no VAD.
            if (state !== 'LISTENING') return;

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
                if (!speechActive && speechFrames >= SPEECH_START_FRAMES) {
                    speechActive = true;
                    // Seed with the pre-roll (frames just before VAD tripped)
                    // so a soft onset like "どう…" isn't clipped. The current
                    // frame is appended below.
                    speechChunks = preRoll.slice();
                    // Refresh silence clock as soon as we detect speech —
                    // we don't need to wait for the transcript to confirm
                    // the caller is engaged.
                    lastSpeechAt = Date.now();
                    console.log(`[vad] speech start (rms=${rms.toFixed(0)}, preroll=${speechChunks.length}f)`);
                }
            } else {
                speechFrames = 0;
                silenceFrames++;
                if (speechActive && silenceFrames >= SILENCE_END_FRAMES) {
                    speechActive = false;
                    const utterance = Buffer.concat(speechChunks);
                    speechChunks = [];
                    console.log(`[vad] speech end (${utterance.length} bytes)`);
                    if (utterance.length >= MIN_UTTERANCE_BYTES) {
                        handleUserUtterance(utterance).catch((err) =>
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

            if (speechActive) speechChunks.push(mulaw);
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
                        console.log(
                            '[start event] full data.start payload:',
                            JSON.stringify(data.start, null, 2)
                        );
                        streamSid = data.start.streamSid;
                        callSid = data.start.callSid || null;
                        callParams = data.start.customParameters || {};
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
                        console.log(
                            `Twilio: start ${streamSid} (VAD muted for first ${CALL_START_GRACE_MS}ms) params:`,
                            callParams
                        );
                        // Load the tenant's playbook, then greet. Without a
                        // playbook there's nothing to say, so end gracefully.
                        loadPlaybook(callParams.tenant_id)
                            .then((loaded) => {
                                if (!loaded) {
                                    console.error(
                                        `[start] no playbook for tenant ${callParams.tenant_id || '(none)'}; ending`
                                    );
                                    return endCallWithFarewell('error_limit');
                                }
                                cfg = loaded;
                                return playGreeting();
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
            state = 'ENDED';
            currentPlaybackToken = null;
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
            if (realtimeWs?.readyState === WebSocket.OPEN) realtimeWs.close();
        });

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
