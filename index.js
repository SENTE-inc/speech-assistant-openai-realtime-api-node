import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { PassThrough } from 'node:stream';
import { Blob } from 'node:buffer';

dotenv.config();

if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

const {
    OPENAI_API_KEY,
    ANTHROPIC_API_KEY,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
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
    hai: '16_hai.mp3',
    kashikomarimashita: '17_kashikomarimashita.mp3',
    soudesuka: '18_soudesuka.mp3',
    shoshomachi: '19_shoshomachi.mp3',
    arigatou: '20_arigatou.mp3',
};

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
    hai: 'はい。',
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

function convertMp3ToMulaw(mp3Buffer) {
    return new Promise((resolve, reject) => {
        const input = new PassThrough();
        input.end(mp3Buffer);
        const chunks = [];
        const stream = ffmpeg(input)
            .inputFormat('mp3')
            .audioFrequency(8000)
            .audioChannels(1)
            .format('mulaw')
            .on('error', reject)
            .pipe();
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

async function getAudioBuffer(key) {
    if (audioCache.has(key)) return audioCache.get(key);
    const filename = AUDIO_FILES[key];
    if (!filename) throw new Error(`Unknown audio key: ${key}`);
    const mp3 = await fetchMp3(filename);
    const mulaw = await convertMp3ToMulaw(mp3);
    audioCache.set(key, mulaw);
    console.log(`Cached ${key} (${filename}): ${mulaw.length} bytes mulaw`);
    return mulaw;
}

// Preload everything in the background so first calls are responsive.
(async () => {
    try {
        await Promise.all(Object.keys(AUDIO_FILES).map(getAudioBuffer));
        console.log('All audio files preloaded');
    } catch (err) {
        console.error('Audio preload error:', err);
    }
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
    formData.append('model', 'whisper-1');
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
            system: CLAUDE_SYSTEM_PROMPT,
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

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="company" value="${company}" />
            <Parameter name="contact" value="${contact}" />
            <Parameter name="phone" value="${phone}" />
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
        const VAD_RMS_THRESHOLD = 500;
        const SPEECH_START_FRAMES = 3;   // ~60ms of speech triggers start
        const SILENCE_END_FRAMES = 40;   // ~800ms of silence ends utterance
        const MIN_UTTERANCE_BYTES = 4000; // ~500ms of audio (8kHz mulaw)
        let speechActive = false;
        let speechFrames = 0;
        let silenceFrames = 0;
        let speechChunks = [];

        // Playback / mark tracking
        let markCounter = 0;
        let currentPlaybackToken = null;
        const pendingMarks = new Map(); // markName -> resolve()

        // -----------------------------------------------------------------
        // Supabase transcript persistence (preserved from previous version)
        // -----------------------------------------------------------------
        const saveTranscript = (role, content) => {
            if (!callSid || !content || !content.trim()) return;
            supabase
                .from('call_sessions')
                .select('id')
                .eq('call_sid', callSid)
                .single()
                .then(({ data, error }) => {
                    if (error || !data) {
                        console.error('Session lookup error:', error);
                        return;
                    }
                    supabase
                        .from('call_transcripts')
                        .insert({
                            session_id: data.id,
                            role,
                            content: content.trim(),
                        })
                        .then(({ error: insErr }) => {
                            if (insErr) console.error('Transcript save error:', insErr);
                            else console.log(`✓ Transcript [${role}]: ${content.trim().substring(0, 60)}`);
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

            let mulaw;
            try {
                mulaw = await getAudioBuffer(key);
            } catch (err) {
                console.error(`Failed to load ${key}:`, err);
                return;
            }
            if (currentPlaybackToken !== token) return; // Interrupted while loading

            console.log(`▶ Playing ${key} (${AUDIO_FILES[key]}, ${mulaw.length} bytes)`);
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
            saveTranscript('assistant', AUDIO_TEXTS[key] || '');
        };

        const interruptPlayback = () => {
            if (currentPlaybackToken === null) return;
            console.log('✗ Interrupting playback');
            currentPlaybackToken = null;
            clearTwilioBuffer();
            for (const [, resolve] of pendingMarks) resolve();
            pendingMarks.clear();
        };

        // -----------------------------------------------------------------
        // Greeting flow (greeting → greeting_with_name or greeting_no_name)
        // -----------------------------------------------------------------
        const playGreeting = async () => {
            state = 'PLAYING';
            await playAudio('greeting');
            if (state !== 'PLAYING') return; // interrupted

            const contact = callParams?.contact;
            if (contact && contact !== 'unknown') {
                await playAudio('greeting_with_name');
            } else {
                await playAudio('greeting_no_name');
            }
            if (state !== 'PLAYING') return;

            state = 'LISTENING';
            console.log('▶ State: LISTENING');
        };

        // -----------------------------------------------------------------
        // After a user utterance: filler + Whisper + Claude + action
        // -----------------------------------------------------------------
        const handleUserUtterance = async (mulawAudio) => {
            if (state === 'PROCESSING' || state === 'ENDED' || state === 'REALTIME') return;
            state = 'PROCESSING';
            console.log(`▶ State: PROCESSING (${mulawAudio.length} bytes captured)`);

            // Filler "はい" in parallel with Whisper+Claude
            const fillerPromise = playAudio('hai').catch((err) =>
                console.error('Filler playback error:', err)
            );

            let transcript = null;
            try {
                transcript = await transcribeWhisper(mulawAudio);
            } catch (err) {
                console.error('Whisper error:', err);
            }

            if (!transcript) {
                console.log('Empty transcript, returning to LISTENING');
                await fillerPromise;
                state = 'LISTENING';
                return;
            }

            console.log(`User said: "${transcript}"`);
            lastUserTranscript = transcript;
            saveTranscript('user', transcript);

            const decision = await classifyWithClaude(transcript, {
                company: callParams?.company,
                contact: callParams?.contact,
            });
            console.log('Claude decision:', decision);

            // Filler must complete before we play the real response.
            await fillerPromise;
            if (state === 'ENDED') return;

            if (decision.action === 'play_audio' && decision.audio_key && AUDIO_FILES[decision.audio_key]) {
                state = 'PLAYING';
                await playAudio(decision.audio_key);

                if (END_CALL_KEYS.has(decision.audio_key)) {
                    state = 'ENDED';
                    console.log('▶ Call ended after farewell clip');
                    setTimeout(() => {
                        try { connection.close(); } catch (_) {}
                    }, 500);
                } else if (state === 'PLAYING') {
                    state = 'LISTENING';
                }
            } else if (decision.action === 'end_call') {
                state = 'PLAYING';
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

            // VAD is only meaningful while we can react: LISTENING (start a
            // capture) or PLAYING (interrupt our own clip).
            if (state !== 'LISTENING' && state !== 'PLAYING') return;

            const mulaw = Buffer.from(base64Payload, 'base64');
            const rms = calculateRms(mulaw);
            const isLoud = rms > VAD_RMS_THRESHOLD;

            if (isLoud) {
                speechFrames++;
                silenceFrames = 0;
                if (!speechActive && speechFrames >= SPEECH_START_FRAMES) {
                    speechActive = true;
                    speechChunks = [];
                    if (state === 'PLAYING') {
                        interruptPlayback();
                        state = 'LISTENING';
                    }
                }
            } else {
                speechFrames = 0;
                silenceFrames++;
                if (speechActive && silenceFrames >= SILENCE_END_FRAMES) {
                    speechActive = false;
                    const utterance = Buffer.concat(speechChunks);
                    speechChunks = [];
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
                        streamSid = data.start.streamSid;
                        callSid = data.start.callSid || null;
                        callParams = data.start.customParameters || {};
                        callParams.callSid = callSid;
                        console.log('Twilio: start', streamSid, 'params:', callParams);
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
