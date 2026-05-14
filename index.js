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

const AUDIO_BASE_URL =
    'https://lgrnhlhhesjpcztxqnia.supabase.co/storage/v1/object/public/call-audio/';

const AUDIO_FILES = {
    greeting: '01_greeting.mp3',
    greeting_with_name: '02_greeting_with_name.mp3',
    greeting_no_name: '03_greeting_no_name.mp3',
    reason: '04_reason.mp3',
    company: '05_company.mp3',
    who: '06_who.mp3',
    appointment: '07_appointment.mp3',
    not_available: '08_not_available.mp3',
    transfer_success: '09_transfer_success.mp3',
    pitch_start: '10_pitch_start.mp3',
    callback_request: '11_callback_request.mp3',
    when_callback: '12_when_callback.mp3',
    callback_confirm: '13_callback_confirm.mp3',
    thanks: '14_thanks.mp3',
    sorry_disturb: '15_sorry_disturb.mp3',
    kashikomarimashita: '17_kashikomarimashita.mp3',
    soudesuka: '18_soudesuka.mp3',
    shoshomachi: '19_shoshomachi.mp3',
    arigatou: '20_arigatou.mp3',
};

// Filler clips played while we wait for STT + classifier. Rotated per
// utterance so the agent does not always say the same thing.
const HAI_PATTERNS = [
    '16a_hai.mp3',   // 「はい。」
    '16b_hai.mp3',   // 「あっ、はい。」
    '16c_hai.mp3',   // 「そうですね。」
];
let haiPatternIndex = 0; // reset on each new Twilio call (start event)

// Transcript text persisted to Supabase when a clip is played
const AUDIO_TEXTS = {
    greeting: 'お世話になっております。株式会社SENTEと申します。',
    greeting_with_name: '〇〇様はいらっしゃいますでしょうか？',
    greeting_no_name: '御社のご担当者様はいらっしゃいますでしょうか？',
    reason: 'Uber Eatsの売上改善に関するご提案でございます。',
    company: '株式会社SENTEと申します。',
    who: '私、SENTEの営業担当と申します。',
    appointment: 'アポイントはございませんが、少々お時間いただけますでしょうか。',
    not_available: 'さようでございますか。いつ頃お戻りになりますでしょうか？',
    transfer_success: 'ありがとうございます。少々お時間よろしいでしょうか？',
    pitch_start: '実は、Uber Eatsを導入されている飲食店様の売上を改善するご提案でご連絡いたしました。',
    callback_request: 'では、改めてご連絡いたします。',
    when_callback: 'いつ頃お時間をいただけますでしょうか？',
    callback_confirm: '承知いたしました。それでは改めてご連絡いたします。',
    thanks: 'ありがとうございました。失礼いたします。',
    sorry_disturb: 'お時間をいただきありがとうございました。失礼いたします。',
    '16a_hai.mp3': 'はい。',
    '16b_hai.mp3': 'あっ、はい。',
    '16c_hai.mp3': 'そうですね。',
    kashikomarimashita: 'かしこまりました。',
    soudesuka: 'さようでございますか。',
    shoshomachi: '少々お待ちくださいませ。',
    arigatou: 'ありがとうございます。',
};

// audio_key values that should terminate the call after playback
const END_CALL_KEYS = new Set(['thanks', 'sorry_disturb']);

const audioCache = new Map(); // audio_key -> mulaw Buffer

async function fetchMp3(filename) {
    const url = AUDIO_BASE_URL + filename;
    console.log(`[fetch] GET ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Fetch ${url} failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(
        `[fetch] ${filename} -> ${buf.length} bytes, content-type=${res.headers.get('content-type') || 'n/a'}`
    );
    if (buf.length === 0) {
        throw new Error(`Fetched MP3 is empty: ${filename}`);
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

async function getAudioBuffer(keyOrFilename) {
    // Accept either an AUDIO_FILES key (e.g. "greeting") or a raw filename
    // (e.g. "16a_hai.mp3"). Cache is keyed by filename so both paths share it.
    const filename = AUDIO_FILES[keyOrFilename] || keyOrFilename;
    if (audioCache.has(filename)) return audioCache.get(filename);

    const mp3 = await fetchMp3(filename);
    const mulaw = await convertMp3ToMulaw(mp3, filename);
    if (mulaw.length === 0) {
        throw new Error(`Converted mulaw is 0 bytes for ${filename}`);
    }
    audioCache.set(filename, mulaw);
    console.log(
        `[audio] ✓ cached ${filename}: mp3=${mp3.length} -> mulaw=${mulaw.length} bytes`
    );
    return mulaw;
}

// Preload everything in the background so first calls are responsive.
(async () => {
    const targets = [...Object.keys(AUDIO_FILES), ...HAI_PATTERNS];
    console.log(`[preload] starting preload for ${targets.length} audio files`);
    const results = await Promise.allSettled(targets.map((t) => getAudioBuffer(t)));
    let ok = 0;
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') ok++;
        else console.error(`[preload] ✗ ${targets[i]} failed:`, r.reason?.message || r.reason);
    });
    console.log(`[preload] done: ${ok}/${targets.length} loaded`);
})();

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

async function transcribeWhisper(mulawBuffer) {
    const wav = mulawToWav(mulawBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'gpt-4o-mini-transcribe');
    formData.append('language', 'ja');

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

const CLAUDE_SYSTEM_PROMPT = `あなたはB2B営業電話のAI判断エンジンです。
電話相手の発話文字起こしを受け取り、次に取るべきアクションをJSONのみで決定してください。

利用可能な音声キー（audio_key）と用途:
- reason: 用件を聞かれた（「ご用件は」「どのような件で」など）
- company: 会社名を聞かれた（「どちらの会社」「どこの」など）
- who: 担当者名・個人名を聞かれた（「どなた様」「お名前は」など）
- appointment: アポの有無を聞かれた（「アポイントはありますか」など）
- not_available: 担当者は不在（「不在」「外出中」「席を外している」など）
- transfer_success: 担当者に取り次いでもらえた（「お繋ぎします」「少々お待ち」など）
- pitch_start: ピッチ開始
- callback_request: 折り返しを提案された
- when_callback: いつ頃か聞く
- callback_confirm: 折り返し確認
- thanks: 終話（ありがとう系・「失礼します」など）
- sorry_disturb: 終話（お断り系・「結構です」「必要ありません」「間に合っています」など）
- kashikomarimashita: 「かしこまりました」
- soudesuka: 「さようでございますか」
- shoshomachi: 「少々お待ちくださいませ」
- arigatou: 「ありがとうございます」

判断ルール:
- 用件を聞かれた → action="play_audio", audio_key="reason"
- 会社名を聞かれた → audio_key="company"
- 担当者名を聞かれた → audio_key="who"
- アポの有無 → audio_key="appointment"
- 不在系 → audio_key="not_available"
- 取り次ぎ成功 → audio_key="transfer_success"
- 折り返し提案 → audio_key="callback_request"
- いつ頃か聞く → audio_key="when_callback"
- お断り・終話（「結構です」「必要ありません」等） → action="play_audio", audio_key="sorry_disturb" （これを再生後に通話終了）
- 「ありがとうございました」「失礼します」等の終話 → action="play_audio", audio_key="thanks" （これを再生後に通話終了）
- 上記で対応しきれない想定外の質問・複雑な質問・営業詳細を深掘りされた場合 → action="openai_realtime"

出力フォーマット（厳密にこのJSONのみ、前後に文字を付けない）:
{"action":"play_audio|openai_realtime|end_call","audio_key":"キー名 または null","reason":"判断理由"}`;

async function classifyWithClaude(transcript, ctx = {}) {
    try {
        const contextLine = [
            ctx.company ? `架電先会社: ${ctx.company}` : null,
            ctx.contact ? `担当者: ${ctx.contact}` : null,
        ]
            .filter(Boolean)
            .join(' / ');

        const userMessage = contextLine
            ? `[文脈] ${contextLine}\n[発話] ${transcript}`
            : transcript;

        const message = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: [
                {
                    type: 'text',
                    text: CLAUDE_SYSTEM_PROMPT,
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
        if (!parsed.action) throw new Error('Missing action');
        return parsed;
    } catch (err) {
        console.error('Claude classification error:', err);
        return {
            action: 'openai_realtime',
            audio_key: null,
            reason: 'classifier_error',
        };
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

fastify.all('/incoming-call', async (request, reply) => {
    const company = decodeURIComponent(request.query.company || 'unknown');
    const contact = decodeURIComponent(request.query.contact || 'unknown');
    const phone = decodeURIComponent(request.query.phone || 'unknown');
    const agent_phone = decodeURIComponent(request.query.agent_phone || '');
    const agent_name = decodeURIComponent(request.query.agent_name || '');

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="company" value="${company}" />
            <Parameter name="contact" value="${contact}" />
            <Parameter name="phone" value="${phone}" />
            <Parameter name="agent_phone" value="${agent_phone}" />
            <Parameter name="agent_name" value="${agent_name}" />
        </Stream>
    </Connect>
</Response>`;
    reply.type('text/xml').send(twiml);
});

// =====================================================================
// Per-call WebSocket handler
// =====================================================================

const REALTIME_SYSTEM_MESSAGE = `あなたはプロの営業アシスタントです。必ず日本語で話してください。
Uber Eatsの売上改善の提案をしている株式会社SENTEの担当者です。
簡潔に丁寧に対応してください。`;

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection /*, req */) => {
        console.log('▶ Twilio client connected');

        // Identity
        let streamSid = null;
        let callSid = null;
        let callParams = {};

        // State machine
        // 'INITIAL' | 'PLAYING' | 'LISTENING' | 'PROCESSING' | 'REALTIME' | 'ENDED'
        let state = 'INITIAL';

        // Realtime fallback
        let realtimeWs = null;
        let lastUserTranscript = null;

        // VAD
        const VAD_RMS_THRESHOLD = 2000;
        const SPEECH_START_FRAMES = 3;   // 3 consecutive frames (~60ms) required
        const SILENCE_END_FRAMES = 25;   // 25 frames * 20ms = 500ms of silence ends utterance
        const MIN_UTTERANCE_BYTES = 4000; // ~500ms of audio (8kHz mulaw)
        const CALL_START_GRACE_MS = 5000;  // ignore inbound audio for the first 5s (Twilio trial preamble)
        const POST_PLAYBACK_DELAY_MS = 800; // wait this long after a clip before re-arming VAD
        let speechActive = false;
        let speechFrames = 0;
        let silenceFrames = 0;
        let speechChunks = [];
        let vadEnabled = false;
        let vadEnableTimer = null;
        let callStartTime = 0;

        const resetVadCapture = () => {
            speechActive = false;
            speechFrames = 0;
            silenceFrames = 0;
            speechChunks = [];
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
                .single()
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
        const playAudio = async (keyOrFilename) => {
            const token = ++markCounter;
            currentPlaybackToken = token;

            const filename = AUDIO_FILES[keyOrFilename] || keyOrFilename;
            const wasCached = audioCache.has(filename);
            const loadT0 = Date.now();
            let mulaw;
            try {
                mulaw = await getAudioBuffer(keyOrFilename);
            } catch (err) {
                console.error(`Failed to load ${keyOrFilename}:`, err);
                return;
            }
            const loadMs = Date.now() - loadT0;
            if (currentPlaybackToken !== token) return; // Interrupted while loading

            console.log(
                `▶ Playing ${keyOrFilename} (${filename}) cache=${wasCached ? 'HIT' : 'MISS'} ` +
                    `load=${loadMs}ms size=${mulaw.length}B`
            );
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

            console.log(`✓ Finished ${keyOrFilename}`);
            saveTranscript('assistant', AUDIO_TEXTS[keyOrFilename] || '');
        };

        // -----------------------------------------------------------------
        // Greeting flow (greeting → greeting_with_name or greeting_no_name)
        // -----------------------------------------------------------------
        const playGreeting = async () => {
            state = 'PLAYING';
            disableVad('playing greeting');
            await playAudio('greeting');
            if (state !== 'PLAYING') return;

            const contact = callParams?.contact;
            if (contact && contact !== 'unknown') {
                await playAudio('greeting_with_name');
            } else {
                await playAudio('greeting_no_name');
            }
            if (state !== 'PLAYING') return;

            state = 'LISTENING';
            console.log('▶ State: LISTENING');
            enableVadDelayed(POST_PLAYBACK_DELAY_MS, 'after greeting');
        };

        // -----------------------------------------------------------------
        // Hand off the live call to a human agent via Twilio Calls API.
        // Called after the transfer_success clip has finished playing.
        // -----------------------------------------------------------------
        const handleTransfer = async () => {
            state = 'ENDED';
            disableVad('transferring');
            const agentPhone = callParams?.agent_phone;
            const agentName = callParams?.agent_name;
            if (!callSid) {
                console.error('[transfer] callSid missing; cannot transfer');
                return;
            }
            if (!agentPhone) {
                console.error('[transfer] agent_phone missing in callParams; cannot transfer');
                return;
            }
            console.log(
                `[transfer] handing off callSid=${callSid} to ${agentName || '(no name)'} <${agentPhone}>`
            );
            try {
                await transferCall(callSid, agentPhone);
            } catch (err) {
                console.error('[transfer] Twilio transfer failed:', err);
                return;
            }
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
        // After a user utterance: filler + Whisper + Claude + action
        // -----------------------------------------------------------------
        const handleUserUtterance = async (mulawAudio) => {
            if (state === 'PROCESSING' || state === 'ENDED' || state === 'REALTIME') return;
            state = 'PROCESSING';
            disableVad('processing utterance');
            const t0 = Date.now();
            console.log(`▶ State: PROCESSING (${mulawAudio.length} bytes captured)`);

            // Kick off the filler clip and the Whisper request at the same
            // tick so they run concurrently. We do not await the filler — it
            // plays out while we are still talking to OpenAI and Claude.
            // Rotate through HAI_PATTERNS so the agent does not sound robotic.
            const fillerFilename = HAI_PATTERNS[haiPatternIndex % HAI_PATTERNS.length];
            haiPatternIndex++;
            const fillerPromise = playAudio(fillerFilename).catch((err) =>
                console.error('Filler playback error:', err)
            );
            const whisperPromise = transcribeWhisper(mulawAudio).catch((err) => {
                console.error('Whisper error:', err);
                return null;
            });
            console.log('[parallel] filler + Whisper started');

            const transcript = await whisperPromise;
            console.log(`[timing] Whisper done in ${Date.now() - t0}ms`);

            if (!transcript) {
                console.log('Empty transcript, returning to LISTENING');
                await fillerPromise;
                state = 'LISTENING';
                enableVadDelayed(POST_PLAYBACK_DELAY_MS, 'empty transcript');
                return;
            }

            console.log(`User said: "${transcript}"`);
            lastUserTranscript = transcript;
            saveTranscript('user', transcript);

            const claudeT0 = Date.now();
            const decision = await classifyWithClaude(transcript, {
                company: callParams?.company,
                contact: callParams?.contact,
            });
            console.log(
                `[timing] Claude done in ${Date.now() - claudeT0}ms (total ${Date.now() - t0}ms):`,
                decision
            );

            // Filler must complete before we play the real response.
            await fillerPromise;
            if (state === 'ENDED') return;

            if (decision.action === 'play_audio' && decision.audio_key && AUDIO_FILES[decision.audio_key]) {
                state = 'PLAYING';
                disableVad('playing response');
                await playAudio(decision.audio_key);

                if (decision.audio_key === 'transfer_success') {
                    await handleTransfer();
                } else if (END_CALL_KEYS.has(decision.audio_key)) {
                    state = 'ENDED';
                    console.log('▶ Call ended after farewell clip');
                    setTimeout(() => {
                        try { connection.close(); } catch (_) {}
                    }, 500);
                } else if (state === 'PLAYING') {
                    state = 'LISTENING';
                    enableVadDelayed(POST_PLAYBACK_DELAY_MS, 'after response');
                }
            } else if (decision.action === 'end_call') {
                state = 'PLAYING';
                disableVad('playing farewell');
                const farewell = decision.audio_key && AUDIO_FILES[decision.audio_key]
                    ? decision.audio_key
                    : 'thanks';
                await playAudio(farewell);
                state = 'ENDED';
                console.log('▶ Call ended by explicit end_call');
                setTimeout(() => {
                    try { connection.close(); } catch (_) {}
                }, 500);
            } else if (decision.action === 'openai_realtime') {
                await switchToRealtime();
            } else {
                console.log('Unknown decision, falling back to realtime');
                await switchToRealtime();
            }
        };

        // -----------------------------------------------------------------
        // OpenAI Realtime fallback
        // -----------------------------------------------------------------
        const switchToRealtime = async () => {
            console.log('▶ Switching to OpenAI Realtime mode');
            state = 'REALTIME';

            realtimeWs = new WebSocket(
                'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
                {
                    headers: {
                        Authorization: `Bearer ${OPENAI_API_KEY}`,
                        'OpenAI-Beta': 'realtime=v1',
                    },
                }
            );

            realtimeWs.on('open', () => {
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
                        turn_detection: { type: 'server_vad' },
                        input_audio_format: 'g711_ulaw',
                        output_audio_format: 'g711_ulaw',
                        voice: 'shimmer',
                        instructions: `${REALTIME_SYSTEM_MESSAGE}

【今回の架電情報】会社: ${company} / 担当者: ${contact}
【直前のお客様の発言】${lastUserTranscript || '（未取得）'}`,
                        modalities: ['text', 'audio'],
                        temperature: 0.8,
                        input_audio_transcription: { model: 'whisper-1' },
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

                    if (response.type === 'response.audio.delta' && response.delta) {
                        sendMedia(response.delta);
                        return;
                    }

                    if (response.type === 'response.done') {
                        const output = response.response?.output || [];
                        output.forEach((item) => {
                            if (item?.type === 'message' && item?.role === 'assistant') {
                                item.content?.forEach((c) => {
                                    if (c.type === 'audio' && c.transcript) {
                                        saveTranscript('assistant', c.transcript);
                                    } else if (c.type === 'text' && c.text) {
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

            realtimeWs.on('error', (err) => console.error('Realtime WS error:', err));
            realtimeWs.on('close', () => console.log('Realtime WS closed'));
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
                    speechChunks = [];
                    console.log(`[vad] speech start (rms=${rms.toFixed(0)})`);
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
                        playGreeting().catch((err) =>
                            console.error('Greeting flow error:', err)
                        );
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
            console.log('Twilio WS closed');
            state = 'ENDED';
            currentPlaybackToken = null;
            disableVad('connection closed');
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
