// 取次の状態の流れのシミュレータ＝エンジン（index.js）を手元で起動し、外（Supabase・Anthropic・OpenAI・Twilio）を
// 偽物のサーバに向け、Twilio の Media Stream の代わりに合成音を流す。電話は鳴らない・本番の DB は触らない。
// 走らせ方＝`node scripts/transfer-bench/sim/run.mjs [場面の名前…]`（失敗があれば非ゼロで終わる）。
// 家＝~/sente/sfav_transfer_tuning_plan.md §1-i（状態の試験）。
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { INTENTS, SF_DEFAULT, levelRow } from '../fixtures.mjs';
import { TRANSFER_LEVELS } from '../../../transfer-logic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FAKE_PORT = 5198;
const ENGINE_PORT = 5199;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const AUTH_TOKEN = 'sim-auth-token';
const TENANT = '11111111-1111-1111-1111-111111111111';
// 設定のキャッシュ（60秒）は テナント×プロジェクト＝場面ごとにプロジェクトを変えて、前の場面の設定を持ち越さない
let PROJECT = '22222222-2222-2222-2222-222222222222';
const OPERATOR = '33333333-3333-3333-3333-333333333333';
const AGENT = '44444444-4444-4444-4444-444444444444';

// ---------------------------------------------------------------------
// 音（8kHz μ-law・20ms＝160バイト）
// ---------------------------------------------------------------------
function linearToMulaw(sample) {
    const BIAS = 0x84, CLIP = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
// 発話は区間ごとに違う高さの音（SPEECH_HZ[k]）＝偽物の文字起こしが、届いた音の中身からどの台詞かを当てる
// （時刻で当てると、声が捨てられても台詞が返ってしまう＝2026-10-05 codex レビュー）
const SPEECH_HZ = [500, 800, 1100, 1400, 1700, 2000, 2300, 2600];
const MUSIC_HZ = 3500;
let phase = 0;
function frame(kind, k = 0) {
    const b = Buffer.alloc(160);
    for (let i = 0; i < 160; i++) {
        let s = 0;
        const tt = phase / 8000;
        if (kind === 'speech') s = Math.sin(2 * Math.PI * SPEECH_HZ[k] * tt) * 9000 + (Math.random() * 2 - 1) * 800;
        if (kind === 'music') s = Math.sin(2 * Math.PI * MUSIC_HZ * tt) * 9000;
        phase++;
        b[i] = linearToMulaw(Math.round(s));
    }
    return b.toString('base64');
}
// 届いた WAV（16bit・8kHz）を20msごとに見て、どの発話の高さが鳴っているかを数える
function goertzel(samples, from, n, hz) {
    const w = 2 * Math.PI * hz / 8000, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const s0 = samples[from + i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
}
function detectSegments(wav) {
    const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length - ((wav.length - 44) % 2)));
    const counts = new Map();
    const order = [];
    for (let from = 0; from + 160 <= pcm.length; from += 160) {
        let best = -1, bestP = 0, total = 0;
        for (let k = 0; k < SPEECH_HZ.length; k++) {
            const pw = goertzel(pcm, from, 160, SPEECH_HZ[k]);
            total += pw;
            if (pw > bestP) { bestP = pw; best = k; }
        }
        const music = goertzel(pcm, from, 160, MUSIC_HZ);
        if (best >= 0 && bestP > 1e9 && bestP > music * 4) {
            counts.set(best, (counts.get(best) || 0) + 1);
            if (!order.includes(best)) order.push(best);
        }
    }
    return { counts, order };
}
// 声のファイル（偽物の Storage が返す）＝0.3秒の小さな音の WAV
function clipWav() {
    const n = 2400, pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 500), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
    h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}
const WAV = clipWav();

// ---------------------------------------------------------------------
// 偽物のサーバ（場面ごとに sc を差し替える）
// ---------------------------------------------------------------------
let sc = null;          // 今の場面
let events = [];        // 偽物が受けた書き込み・呼び出し
const CLIPS = [
    ['greeting', 'greeting'], ['hai', 'filler'], ['pardon', 'pardon'], ['farewell', 'farewell'],
    ['transfer_success', 'response'], ['reason', 'response'], ['company', 'response'],
    ['appointment', 'response'], ['callback_request', 'response'], ['sorry_disturb', 'response'],
].map(([key, clip_type], i) => ({ id: `clip-${i}`, key, clip_type, filename: `${key}.mp3`, text: key, active: true, audio_ready: true, sort_order: i }));
// 名前で名乗る声セット（2026-10-07）＝name_lead と受付の答え2本・資料送付は流した後に CM へ
const NAME_CLIPS = ['name_lead', 'addressee', 'send_material']
    .map((key, i) => ({ id: `clip-n${i}`, key, clip_type: 'response', filename: `${key}.mp3`, text: key, active: true, audio_ready: true, sort_order: 20 + i }));
// 不在の流れの4本（2026-10-08）＝absentSet の場面だけ
const ABSENT_SET = ['absent_ask', 'absent_time_ack', 'absent_propose', 'absent_close']
    .map((key, i) => ({ id: `clip-a${i}`, key, clip_type: 'response', filename: `${key}.mp3`, text: key, active: true, audio_ready: true, sort_order: 30 + i }));
const NAME_INTENTS = [
    { name: 'addressee', action: 'play_audio', audio_key: 'addressee', is_transfer: false, end_call: false },
    { name: 'material_request', action: 'play_audio', audio_key: 'send_material', is_transfer: false, end_call: false, then_agent: true },
];

const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

function restRows(table) {
    if (table === 'call_playbooks') return [{ id: 'pb-1', tenant_id: TENANT, project_id: PROJECT, is_active: true, company_name: 'テスト株式会社', voice: 'shimmer', audio_base_path: 'sim', voice_gender: 'male' }];
    if (table === 'audio_clips') return [...CLIPS, ...(sc.nameSet ? NAME_CLIPS : []), ...(sc.absentSet ? ABSENT_SET : [])];
    if (table === 'call_intents') return [...INTENTS, ...(sc.nameSet ? NAME_INTENTS : [])].map((i, n) => ({ ...i, triggers: [i.name], sort_order: n + 1, active: true }));
    if (table === 'transfer_settings') return sc.settings ? [{ ...sc.settings, tenant_id: TENANT, project_id: null }] : [];
    if (table === 'user_profiles') {
        return [{ id: OPERATOR, tenant_id: TENANT, gender: 'male', spoken_name: 'じんぼ', spoken_name_audio_path: 'sim/_names/op.mp3', spoken_name_audio_key: 'NO5A3b3sSzDyJQF7MiNS|じんぼ' }];
    }
    if (table === 'call_sessions') return [{ id: '55555555-5555-5555-5555-555555555555' }];
    return [];
}

const fake = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const u = new URL(req.url, FAKE);
    const p = u.pathname;
    try {
        if (p.startsWith('/rest/v1/rpc/')) {
            const fn = p.slice('/rest/v1/rpc/'.length);
            events.push({ t: 'rpc', fn, args: JSON.parse(body.toString() || '{}') });
            if (fn === 'claim_agent_for_handoff') return json(res, 200, AGENT);
            return json(res, 200, null);
        }
        if (p.startsWith('/rest/v1/')) {
            const table = p.slice('/rest/v1/'.length);
            if (req.method === 'GET') {
                if (table === 'transfer_settings' && sc.settingsError) return json(res, 404, { code: '42P01', message: 'relation "public.transfer_settings" does not exist' });
                const rows = restRows(table);
                if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
                    if (rows.length === 1) return json(res, 200, rows[0]);
                    return json(res, 406, { code: 'PGRST116', details: 'The result contains 0 rows', message: 'JSON object requested, multiple (or no) rows returned' });
                }
                return json(res, 200, rows);
            }
            const payload = body.length ? JSON.parse(body.toString()) : null;
            events.push({ t: req.method, table, payload, query: u.search });
            if (req.method === 'POST') return json(res, 201, Array.isArray(payload) ? payload : [payload]);
            return json(res, 200, []);
        }
        if (p.startsWith('/storage/v1/object/')) {
            res.writeHead(200, { 'Content-Type': 'audio/wav' });
            return res.end(WAV);
        }
        if (p === '/anthropic/v1/messages') {
            const msg = JSON.parse(body.toString());
            const content = msg.messages[0].content;
            const transcript = content.includes('[発話] ') ? content.split('[発話] ').pop() : content;
            const afterHold = content.includes('[状況] 保留の後');
            const intent = sc.haiku(transcript, afterHold);
            events.push({ t: 'haiku', transcript, afterHold, intent });
            if (sc.haikuDelayMs) await new Promise((r) => setTimeout(r, sc.haikuDelayMs));
            // 本番の送り方（Haiku 5.5＝prefill なし・思考切り）でない要求は 400 にする＝送り方の後戻りを試験で捕まえる
            const last = msg.messages[msg.messages.length - 1];
            if (msg.model !== 'claude-haiku-5-5' || last.role !== 'user' || msg.thinking?.type !== 'disabled') {
                events.push({ t: 'haiku_bad_request', model: msg.model, lastRole: last.role, thinking: msg.thinking });
                return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'sim: not the Haiku 5.5 request shape' } });
            }
            return json(res, 200, {
                id: 'msg_sim', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
                content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: `{"intent": "${intent}"}` }], stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            });
        }
        if (p === '/openai/v1/audio/transcriptions') {
            if (sc.sttFail) { events.push({ t: 'stt', fail: true }); return json(res, 500, { error: { message: 'sim stt failure' } }); }
            const text = sc.sttFromAudio(body);
            events.push({ t: 'stt', text, bytes: body.length });
            if (sc.sttDelayMs) await new Promise((r) => setTimeout(r, sc.sttDelayMs));
            return json(res, 200, { text });
        }
        if (p.startsWith('/twilio/')) {
            const form = Object.fromEntries(new URLSearchParams(body.toString()));
            events.push({ t: 'twilio', path: p, form });
            if (p.endsWith('/Calls.json')) return json(res, 201, { sid: 'CAagentleg' });
            if (sc.onTwilioUpdate) await sc.onTwilioUpdate(form);
            return json(res, 200, { sid: 'CAsim' });
        }
        json(res, 404, { message: `sim: no route ${req.method} ${p}` });
    } catch (err) {
        console.error('[fake] error', err);
        json(res, 500, { message: String(err) });
    }
});

// ---------------------------------------------------------------------
// エンジン
// ---------------------------------------------------------------------
let engine = null;
let engineLog = [];
function startEngine() {
    return new Promise((resolve, reject) => {
        engine = spawn(process.execPath, ['--import', path.join(HERE, 'loader.mjs'), 'index.js'], {
            cwd: ROOT,
            env: {
                ...process.env, PORT: String(ENGINE_PORT), SIM_FAKE_BASE: FAKE,
                SUPABASE_URL: FAKE, SUPABASE_SERVICE_KEY: 'sim-service-key', ANTHROPIC_API_KEY: 'sim', ANTHROPIC_BASE_URL: `${FAKE}/anthropic`,
                OPENAI_API_KEY: 'sim', TWILIO_ACCOUNT_SID: 'ACsim', TWILIO_AUTH_TOKEN: AUTH_TOKEN, PROVISION_SECRET: 'sim',
                TWILIO_FROM_NUMBER: '+815000000000', PUBLIC_BASE_URL: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const onData = (d) => {
            for (const line of d.toString().split('\n')) if (line.trim()) engineLog.push({ at: Date.now(), line });
        };
        engine.stdout.on('data', onData);
        engine.stderr.on('data', onData);
        engine.on('exit', (code) => { if (code) console.error(`[sim] engine exited ${code}`); });
        const t0 = Date.now();
        const poll = setInterval(() => {
            if (engineLog.some((l) => /Server listening on port/.test(l.line))) { clearInterval(poll); resolve(); }
            else if (Date.now() - t0 > 15000) { clearInterval(poll); reject(new Error('engine did not start:\n' + engineLog.map((l) => l.line).join('\n'))); }
        }, 100);
    });
}

// Twilio の署名つきで /incoming-call を叩いて、ストリームの合言葉をもらう
async function incomingCall() {
    const qs = new URLSearchParams({ company: 'テスト', contact: '', phone: '+810000000000', tenant_id: TENANT, project_id: PROJECT, operator_id: OPERATOR, operator_gender: 'male' });
    const pth = `/incoming-call?${qs}`;
    const host = `127.0.0.1:${ENGINE_PORT}`;
    const sig = crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(`https://${host}${pth}`, 'utf-8')).digest('base64');
    const res = await fetch(`http://${host}${pth}`, { method: 'POST', headers: { 'x-twilio-signature': sig, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    const xml = await res.text();
    const params = {};
    for (const m of xml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"/g)) params[m[1]] = m[2];
    if (!params.stream_token) throw new Error('no stream_token: ' + xml);
    return params;
}

// ---------------------------------------------------------------------
// 1つの場面を流す
// ---------------------------------------------------------------------
async function runScenario(s) {
    sc = s;
    events = [];
    PROJECT = crypto.randomUUID();
    const logStart = engineLog.length;
    const sttTexts = [];
    const t0 = Date.now() + 200;
    let cursor = 0;
    let k = 0;
    const segs = s.timeline.map((seg) => {
        const a = { ...seg, start: cursor, end: cursor + seg.ms, k: seg.kind === 'speech' ? k++ : null };
        cursor += seg.ms;
        return a;
    });
    // 発話ごとに、文字起こしへ届いたフレーム数（重ねた1秒は2回数える）
    const received = new Map();
    // 文字起こし＝届いた音に 200ms 以上鳴っている発話の台詞を、鳴った順につなげて返す（無ければ空）
    sc.sttFromAudio = (multipart) => {
        const i = multipart.indexOf(Buffer.from('RIFF'));
        if (i < 0) return '';
        const end = multipart.indexOf(Buffer.from('\r\n--'), i);
        const { counts, order } = detectSegments(multipart.subarray(i, end > 0 ? end : multipart.length));
        for (const [kk, n] of counts) received.set(kk, (received.get(kk) || 0) + n);
        const texts = order.filter((kk) => counts.get(kk) >= 10).map((kk) => segs.find((g) => g.k === kk)?.text).filter(Boolean);
        const text = texts.join('');
        if (text) sttTexts.push(text);
        return text;
    };

    const params = await incomingCall();
    const ws = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/media-stream`);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    let closed = false;
    ws.on('close', () => { closed = true; });
    const played = [];
    s.ws = ws;
    ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.event === 'mark') {
            const hold = s.holdMark && s.holdMark(m.mark.name, engineLog.slice(logStart));
            // 声のファイルは0.3秒＝流し終えた頃に mark を返す
            if (!hold) setTimeout(() => { if (!closed) ws.send(JSON.stringify({ event: 'mark', streamSid: 'MZsim', mark: m.mark })); }, 300);
        }
    });
    ws.send(JSON.stringify({ event: 'connected' }));
    ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZsim', callSid: 'CAsim', customParameters: params } }));

    // 音を 20ms ごとに流す（タイムラインが終わったら無音を流し続ける）
    await new Promise((r) => setTimeout(r, 200));
    const timer = setInterval(() => {
        if (closed) return;
        const now = Date.now() - t0;
        const seg = segs.find((g) => g.start <= now && now < g.end);
        try { ws.send(JSON.stringify({ event: 'media', streamSid: 'MZsim', media: { payload: frame(seg ? seg.kind : 'silence', seg?.k ?? 0) } })); } catch (_) {}
    }, 20);

    const deadline = Date.now() + s.maxMs;
    while (Date.now() < deadline && !closed && !(s.doneWhen && s.doneWhen(engineLog.slice(logStart), events))) {
        await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1500)); // 後始末の書き込みを待つ
    clearInterval(timer);
    try { ws.close(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
    const log = engineLog.slice(logStart).map((l) => ({ ...l, t: ((l.at - t0) / 1000).toFixed(1) }));
    // 発話ごとに、流したフレームのうち文字起こしへ届いた割合
    const coverage = segs.filter((g) => g.kind === 'speech').map((g) => ({ text: g.text, ratio: (received.get(g.k) || 0) / (g.ms / 20) }));
    return { log, events: events.slice(), sttTexts, coverage, elapsed: (Date.now() - t0) / 1000 };
}

// ---------------------------------------------------------------------
// 場面
// ---------------------------------------------------------------------
const lines = (r, re) => r.log.filter((l) => re.test(l.line));
const has = (r, re) => r.log.some((l) => re.test(l.line));
const resultsSaved = (r) => r.events.filter((e) => e.t === 'PATCH' && e.table === 'call_sessions').map((e) => e.payload?.result).filter(Boolean);
const decisions = (r) => r.events.filter((e) => e.t === 'POST' && e.table === 'call_turn_decisions').map((e) => e.payload);
// 指定した台詞の発話が、文字起こしに 8割以上届いたか（声を捨てていないか）
const covered = (r, text, min = 0.8) => { const c = r.coverage.find((x) => x.text === text); return c && c.ratio >= min ? null : `「${text}」が文字起こしに ${Math.round((c?.ratio || 0) * 100)}% しか届いていない`; };
const haikuFor = (map) => (t) => { for (const [k, v] of map) if (t.includes(k)) return v; return 'reprompt'; };
const SHORT = { ...SF_DEFAULT, id: '66666666-6666-6666-6666-666666666666', wait_max_seconds: 15 };

const V2 = (level = 'normal') => levelRow(level);
const holdLines = (r) => r.log.filter((l) => /\[hold\]/.test(l.line));
const holdEvents = (r) => decisions(r).filter((x) => x.event === 'hold_music');

const SCENARIOS = {
    // ===== 版6〜7（DB 142・森さんの3段階）=====
    // 受付が何も言わずに保留音 → 4秒＋で取次（声なし）
    v2_hold_without_words: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'music', ms: 14000 }],
        haiku: () => 'reprompt',
        maxMs: 30000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[hold\] music .* → transfer/)) errs.push('保留音で取次していない');
            if (!has(r, /committed \(hold, no clip\)/)) errs.push('取次の声を流した／取次の入口を通っていない');
            if (has(r, /Playing transfer_success/)) errs.push('保留中に取次の声を流した');
            if (!resultsSaved(r).includes('transferred')) errs.push(`結果が transferred でない: ${resultsSaved(r)}`);
            const rings = r.events.filter((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')).length;
            if (rings !== 1) errs.push(`CM を ${rings} 回呼んだ（1回のはず）`);
            const h = holdEvents(r).find((x) => x.action === 'transfer');
            if (!h || !(h.hold_seconds >= TRANSFER_LEVELS.normal.hold_music_seconds)) errs.push(`記録に保留音の秒数が無い: ${JSON.stringify(h)}`);
            return errs;
        },
    },
    // 「少々お待ちください」→ 保留音（受付の言葉は「保留音が鳴ったらつなぐ」）
    v2_words_then_hold: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '少々お待ちください。' }, { kind: 'music', ms: 16000 }],
        haiku: haikuFor([['少々お待ち', 'transfer']]),
        maxMs: 35000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[decide\] step=7 action=wait_enter gate=words_hold/)) errs.push('受付の言葉で待機に入っていない');
            if (!has(r, /\[hold\] music .* announced=true → transfer/)) errs.push('言葉の後の保留音で取次していない');
            if (has(r, /Playing transfer_success/)) errs.push('取次の声を流した');
            if (!resultsSaved(r).includes('transferred')) errs.push(`結果が transferred でない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 締める＝言葉なしの保留音ではつながず、本人が名乗ったらすぐ
    v7_strict_without_words: {
        settings: V2('strict'),
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'music', ms: 11000 },
            // 名乗りは聞き返しの後に置く（保留音の後の「はい」＋聞き返しの間に話した声はもともと捨てる＝話し終わりの間を 0.8秒にした 2026-10-08 に 1.2秒→3秒）
            { kind: 'silence', ms: 3000 }, { kind: 'speech', ms: 1800, text: 'お電話代わりました、山田です。' },
        ],
        haiku: haikuFor([['代わりました', 'transfer']]),
        maxMs: 35000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (has(r, /\[hold\] .* → transfer/)) errs.push('締めるなのに言葉なしの保留音で取次した');
            if (!has(r, /\[decide\] step=2h action=transfer_fast/)) errs.push('本人の名乗りで最速の取次になっていない');
            if (!resultsSaved(r).includes('transferred')) errs.push(`結果が transferred でない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 緩い＝「少々お待ちください」の時点で取次（保留音を待たない）
    v7_loose_words: {
        settings: V2('loose'),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '少々お待ちください。' }, { kind: 'silence', ms: 1000 }, { kind: 'music', ms: 8000 }],
        haiku: haikuFor([['少々お待ち', 'wait']]),
        maxMs: 26000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[decide\] step=7 action=transfer gate=words/)) errs.push('緩いなのに受付の言葉で取次していない');
            if (!resultsSaved(r).includes('transferred')) errs.push(`結果が transferred でない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 担当者本人の名乗り＝「はい」も取次の声も無しで、すぐ CM
    v2_fast_handover: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: 'はい、私が担当ですが。' }],
        haiku: () => 'transfer',
        maxMs: 20000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (has(r, /Playing hai /)) errs.push('「はい」を流した');
            if (has(r, /Playing transfer_success/)) errs.push('取次の声を流した');
            if (r.events.some((e) => e.t === 'haiku')) errs.push('Haiku を待った');
            if (!resultsSaved(r).includes('transferred')) errs.push(`結果が transferred でない: ${resultsSaved(r)}`);
            const end = r.log.find((l) => /\[vad\] speech end/.test(l.line));
            const enq = r.log.find((l) => /committed \(handover/.test(l.line));
            // 話し終わりの間（0.8秒・2026-10-08 森さん「返しが早い」）＋文字起こし＝1.8秒まで
            if (end && enq && enq.at - end.at > 1800) errs.push(`話し終わりから取次まで ${enq.at - end.at}ms（1.8秒を超えた）`);
            return errs;
        },
    },
    // 長く話し続ける人（言葉あり）＝保留音と取り違えない
    v2_long_speaker: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 9000, text: '今ちょっと担当がバタバタしておりまして、どういったご用件か先に伺ってもよろしいでしょうか。' }, { kind: 'silence', ms: 4000 }],
        haiku: () => 'reason',
        maxMs: 26000,
        check(r) {
            const errs = [];
            if (holdEvents(r).some((x) => x.action === 'transfer')) errs.push('話している人を保留音として取次した');
            if (!holdEvents(r).some((x) => x.action === 'has_words')) errs.push('言葉ありで外した記録が無い');
            return errs;
        },
    },
    // 文字起こしの失敗＝保留音の「言葉なし」に数えない
    v2_stt_failure: {
        settings: V2(),
        sttFail: true,
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'music', ms: 12000 }],
        haiku: () => 'reprompt',
        maxMs: 22000,
        check(r) {
            const errs = [];
            if (r.events.some((e) => e.t === 'twilio')) errs.push('文字起こしの失敗で取次した');
            if (!holdEvents(r).some((x) => x.action === 'stt_error')) errs.push('失敗の記録が無い');
            return errs;
        },
    },
    // 「少々お待ちください」の判定が遅い間に音楽の判定が先に返る＝締めるでも「言葉の後」として決める（追い越さない＝codex レビュー 4）
    v2_race_words_strict: {
        settings: V2('strict'),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '少々お待ちください。' }, { kind: 'silence', ms: 700 }, { kind: 'music', ms: 16000 }],
        haiku: haikuFor([['少々お待ち', 'wait']]),
        haikuDelayMs: 11000,
        maxMs: 35000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (holdEvents(r).some((x) => x.gate === 'hold_without_words_off')) errs.push('受付の言葉の判定を追い越して「言葉なし」で決めた');
            if (!holdEvents(r).some((x) => x.action === 'transfer' && x.gate === 'hold_after_words')) errs.push(`言葉の後の保留音で取次していない: ${JSON.stringify(holdEvents(r).map((x) => [x.action, x.gate]))}`);
            return errs;
        },
    },
    // 「担当者は不在です」の直後に音楽＝否定が勝つ（追い越さない）
    v2_negative_then_music: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '担当者は本日不在にしております。' }, { kind: 'music', ms: 10000 }],
        haiku: haikuFor([['不在', 'not_available']]),
        haikuDelayMs: 2500,
        maxMs: 26000,
        check(r) {
            const errs = [];
            if (r.events.some((e) => e.t === 'twilio')) errs.push('不在なのに取次した');
            if (!resultsSaved(r).includes('not_available')) errs.push(`不在で切っていない: ${resultsSaved(r)}`);
            return errs;
        },
    },

    // 本題＝「少々お待ちください」の直後に切れ目なく保留音 → 待機 → 保留明けの「お電話代わりました」で取次
    hold_then_transfer: {
        settings: SF_DEFAULT,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 1500, text: '少々お待ちください。' },
            { kind: 'music', ms: 14000 },
            // 保留音と名乗りの間＝話し終わりの間（0.8秒・2026-10-08）より長く置く（同じ長さだと保留音とつながって1発話になる＝取次はするが名乗りの後半を文字起こしに回さない）
            { kind: 'silence', ms: 1200 },
            { kind: 'speech', ms: 2000, text: 'お電話代わりました、山田です。' },
        ],
        haiku: haikuFor([['少々お待ち', 'transfer'], ['代わりました', 'transfer']]),
        maxMs: 40000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[vad\] forced split/)) errs.push('6秒の区切りが起きていない');
            if (!has(r, /\[decide\] step=7 action=wait_enter/)) errs.push('待機に入っていない');
            if (!has(r, /\[decide\] step=8 action=transfer.*\(waiting\)/)) errs.push('保留明けに取次していない');
            if (has(r, /Playing pardon/)) errs.push('聞き返しを流した');
            if (lines(r, /Playing hai /).length !== 1) errs.push(`つなぎの「はい」が ${lines(r, /Playing hai /).length} 回（1回のはず）`);
            if (!resultsSaved(r).includes('transferred')) errs.push(`結果が transferred でない: ${resultsSaved(r)}`);
            if (resultsSaved(r).includes('silence_timeout')) errs.push('無音切断で切った');
            if (!r.events.some((e) => e.t === 'twilio' && /Enqueue/.test(e.form?.Twiml || ''))) errs.push('保留（Enqueue）へ切り替えていない');
            const d = decisions(r);
            if (!d.some((x) => x.event === 'wait_enter')) errs.push('判定の記録に wait_enter が無い');
            if (!d.every((x) => x.settings_hash && x.settings_version === 1)) errs.push('判定の記録に設定の版・hash が無い');
            for (const tx of ['少々お待ちください。', 'お電話代わりました、山田です。']) { const e = covered(r, tx); if (e) errs.push(e); }
            return errs;
        },
    },
    // 6秒をまたぐ長い発話の直後に保留音（区切った後も処理の間の声を捨てない＝codex レビュー 2）
    long_utterance_then_hold: {
        settings: SF_DEFAULT,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 7500, text: '担当に代わりますので、少々お待ちください。' },
            { kind: 'music', ms: 9000 },
            { kind: 'silence', ms: 800 },
            { kind: 'speech', ms: 1800, text: 'お電話代わりました、山田です。' },
        ],
        haiku: haikuFor([['少々お待ち', 'transfer'], ['代わりました', 'transfer']]),
        sttDelayMs: 700,
        maxMs: 45000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[decide\] step=7 action=wait_enter/)) errs.push('待機に入っていない');
            for (const tx of ['担当に代わりますので、少々お待ちください。', 'お電話代わりました、山田です。']) { const e = covered(r, tx); if (e) errs.push(e); }
            if (!resultsSaved(r).includes('transferred')) errs.push(`取次していない: ${resultsSaved(r)}`);
            if (has(r, /Playing pardon/)) errs.push('聞き返しを流した');
            return errs;
        },
    },
    // 待機中に用件を聞かれて答え、その直後に担当者が出る（答えた後も聞き続ける＝codex レビュー 6）
    question_during_wait: {
        settings: SF_DEFAULT,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 1500, text: '少々お待ちください。' },
            { kind: 'music', ms: 7000 },
            { kind: 'silence', ms: 700 },
            { kind: 'speech', ms: 1500, text: 'すみません、ご用件をもう一度よろしいですか。' },
            { kind: 'silence', ms: 900 },
            { kind: 'music', ms: 4000 },
            { kind: 'silence', ms: 800 },
            { kind: 'speech', ms: 1800, text: 'お電話代わりました、山田です。' },
        ],
        haiku: haikuFor([['少々お待ち', 'wait'], ['ご用件', 'reason'], ['代わりました', 'transfer']]),
        sttDelayMs: 900,
        maxMs: 45000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[decide\] step=6 action=answer \(waiting\)/)) errs.push('待機中の質問に答えていない');
            if (!has(r, /Playing reason/)) errs.push('用件の声を流していない');
            if (!has(r, /\[decide\] step=8 action=transfer.*\(waiting\)/)) errs.push('答えた後の担当者で取次していない');
            const e = covered(r, 'お電話代わりました、山田です。'); if (e) errs.push(e);
            if (!resultsSaved(r).includes('transferred')) errs.push(`取次していない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 待機の期限＝保留が明けないまま 15秒で切る（30秒を待たない・結果は無音切断と同じ値）
    wait_timeout: {
        settings: SHORT,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 1500, text: '少々お待ちください。' },
            { kind: 'music', ms: 30000 },
        ],
        haiku: haikuFor([['少々お待ち', 'wait']]),
        maxMs: 40000,
        check(r) {
            const errs = [];
            if (!has(r, /\[wait\] entered \(max 15s\)/)) errs.push('待機に入っていない');
            if (!has(r, /\[timeout\] wait .* reached the limit/)) errs.push('待機の期限で切っていない');
            if (!resultsSaved(r).includes('silence_timeout')) errs.push(`結果が silence_timeout でない: ${resultsSaved(r)}`);
            const enter = r.log.find((l) => /\[wait\] entered/.test(l.line));
            const end = r.log.find((l) => /\[timeout\] wait/.test(l.line));
            if (enter && end) {
                const sec = (end.at - enter.at) / 1000;
                if (sec < 14 || sec > 22) errs.push(`期限までの秒数が ${sec.toFixed(1)}s（15〜20s のはず）`);
            }
            if (has(r, /Playing pardon/)) errs.push('聞き返しを流した');
            if (!decisions(r).some((x) => x.event === 'wait_timeout')) errs.push('判定の記録に wait_timeout が無い');
            return errs;
        },
    },
    // 設定の行が無い＝今の挙動（区切らない・待機しない・判定の記録を書かない）
    legacy_no_settings: {
        settings: null,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 1500, text: '少々お待ちください。' },
            { kind: 'music', ms: 40000 },
        ],
        haiku: haikuFor([['少々お待ち', 'transfer']]),
        maxMs: 45000,
        check(r) {
            const errs = [];
            if (has(r, /\[vad\] forced split|\[decide\]|\[wait\]/)) errs.push('設定が無いのに新しい挙動が動いた');
            if (decisions(r).length) errs.push('設定が無いのに判定の記録を書いた');
            if (!resultsSaved(r).includes('silence_timeout')) errs.push(`今の挙動（30秒の無音切断）になっていない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 表がまだ無い（DB 140 の前）＝今の挙動で動く
    legacy_table_missing: {
        settings: SF_DEFAULT,
        settingsError: true,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 1500, text: '担当者に代わります。' },
        ],
        haiku: haikuFor([['代わります', 'transfer']]),
        maxMs: 20000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[transfer-settings\] load failed/)) errs.push('表が無いことを拾っていない');
            if (has(r, /\[decide\]/)) errs.push('表が無いのに新しい判定が動いた');
            if (!resultsSaved(r).includes('transferred')) errs.push(`今の挙動の取次になっていない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 段0＝「おつなぎします」の最中に相手が切った → CM を確保しない・Twilio を切り替えない
    abort_during_transfer_clip: {
        settings: SF_DEFAULT,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 1500, text: '担当者に代わります。' },
        ],
        haiku: haikuFor([['代わります', 'transfer']]),
        // transfer_success の mark を返さず、0.5秒後に切る
        holdMark(name, log) {
            const last = [...log].reverse().find((l) => /▶ Playing /.test(l.line));
            if (last && /Playing transfer_success/.test(last.line)) {
                setTimeout(() => { try { this.ws.close(); } catch (_) {} }, 500);
                return true;
            }
            return false;
        },
        maxMs: 20000,
        check(r) {
            const errs = [];
            if (!has(r, /Playing transfer_success/)) errs.push('「おつなぎします」まで行っていない');
            if (r.events.some((e) => e.t === 'rpc' && e.fn === 'claim_agent_for_handoff')) errs.push('切れた後に CM を確保した');
            if (r.events.some((e) => e.t === 'twilio')) errs.push('切れた後に Twilio を切り替えた');
            if (resultsSaved(r).includes('transferred')) errs.push('切れたのに transferred を書いた');
            return errs;
        },
    },
    // 段0＝Twilio を切り替えている最中に WS が閉じた（正常な取次の切断）→ 取次はそのまま成立
    close_during_commit: {
        settings: SF_DEFAULT,
        timeline: [
            { kind: 'silence', ms: 6000 },
            { kind: 'speech', ms: 1500, text: '担当者に代わります。' },
        ],
        haiku: haikuFor([['代わります', 'transfer']]),
        async onTwilioUpdate(form) {
            if (/Enqueue/.test(form.Twiml || '')) {
                try { this.ws.close(); } catch (_) {}
                await new Promise((r) => setTimeout(r, 1500));
            }
        },
        maxMs: 20000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!resultsSaved(r).includes('transferred')) errs.push(`取次が成立していない: ${resultsSaved(r)}`);
            if (!r.events.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json'))) errs.push('CM を鳴らしていない');
            if (r.events.some((e) => e.t === 'rpc' && e.fn === 'set_agent_state')) errs.push('確保した CM を戻してしまった');
            return errs;
        },
    },
    // ===== 2026-10-06 試しの電話の直し（Tom go）=====
    // 相手が先に名乗る＝名乗りが終わってからあいさつ（名乗りの上に重ねない）
    answer_first: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 300 }, { kind: 'speech', ms: 1500, text: 'はい、テスト株式会社です。' }, { kind: 'silence', ms: 6000 }],
        haiku: () => 'reprompt',
        maxMs: 12000,
        doneWhen: (log) => log.some((l) => /✓ Finished greeting/.test(l.line)),
        check(r) {
            const errs = [];
            if (!has(r, /\[answer\] greeting after answered/)) errs.push('名乗りの終わりであいさつしていない');
            const end = r.log.findIndex((l) => /\[vad\] speech end/.test(l.line));
            const greet = r.log.findIndex((l) => /Playing greeting/.test(l.line));
            if (!(end >= 0 && greet > end)) errs.push('名乗りの途中であいさつを流した');
            if (!r.events.some((e) => e.t === 'POST' && e.table === 'call_transcripts' && e.payload?.role === 'user')) errs.push('名乗りの文字起こしを残していない');
            return errs;
        },
    },
    // 第一声が留守電の案内＝あいさつを止めて黙って切る（結果は voicemail）
    answer_voicemail: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 300 }, { kind: 'speech', ms: 2000, text: 'ただいま電話に出ることができません。' }, { kind: 'silence', ms: 6000 }],
        haiku: () => 'reprompt',
        maxMs: 12000,
        check(r) {
            const errs = [];
            if (!has(r, /\[voicemail\] first utterance matched/)) errs.push('第一声の留守電の案内を見つけていない');
            if (!resultsSaved(r).includes('voicemail')) errs.push(`結果が voicemail でない: ${resultsSaved(r)}`);
            if (has(r, /Playing farewell/)) errs.push('留守電に締めのあいさつを残した');
            return errs;
        },
    },
    // だれも話さない＝2.5秒であいさつ
    answer_quiet: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }],
        haiku: () => 'reprompt',
        maxMs: 8000,
        doneWhen: (log) => log.some((l) => /✓ Finished greeting/.test(l.line)),
        check(r) {
            const errs = [];
            if (!has(r, /\[answer\] greeting after quiet/)) errs.push('無言の時に 2.5秒であいさつしていない');
            return errs;
        },
    },
    // 「あ、」＋間＋「用件はなんですか？」＝切れ端の判定を捨てて、つないで判定（KWK の試しの電話）
    merge_fragment: {
        settings: V2(),
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 300, text: 'あ、' }, { kind: 'silence', ms: 900 },
            { kind: 'speech', ms: 1500, text: '用件はなんですか？' }, { kind: 'silence', ms: 6000 },
        ],
        haiku: haikuFor([['用件', 'reason']]),
        haikuDelayMs: 1200,
        maxMs: 20000,
        doneWhen: (log) => log.some((l) => /✓ Finished reason/.test(l.line)),
        check(r) {
            const errs = [];
            // 「あ、」はつなぎ言葉＝文字起こしの前に続きが来ればつなぎ直し（merge）、後なら言いかけの待ち（held）からつなぐ
            if (!has(r, /\[merge\] caller continued|\[held\] caller continued/)) errs.push('処理中の続きの言葉で判定を捨てていない');
            if (!r.sttTexts.includes('あ、用件はなんですか？')) errs.push(`つないだ発話を文字起こししていない: ${JSON.stringify(r.sttTexts)}`);
            if (!has(r, /Playing reason/)) errs.push('用件の答えを流していない');
            if (has(r, /Playing pardon/)) errs.push('聞き返しを流した');
            const e = covered(r, '用件はなんですか？'); if (e) errs.push(e);
            return errs;
        },
    },
    // ===== 2026-10-08 森さんの FB（家＝~/sente/sente_aivoice_canonical.md §3「📐 実装の計画 v3」）=====
    // 言いかけ（「〜の者が」）＝返さずに待ち、続きとつないで判定（実物＝「今、営業の責任者のもの。」で聞き返した）
    incomplete_then_rest: {
        settings: V2(),
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1400, text: '今、営業の責任者の者が' }, { kind: 'silence', ms: 1300 },
            { kind: 'speech', ms: 1500, text: '席を外しております。' }, { kind: 'silence', ms: 6000 },
        ],
        haiku: haikuFor([['席を外し', 'not_available']]),
        maxMs: 22000,
        check(r) {
            const errs = [];
            if (!has(r, /\[held\] incomplete utterance/)) errs.push('言いかけで待っていない');
            if (has(r, /Playing pardon/)) errs.push('聞き返しを流した');
            if (has(r, /Playing hai /) && lines(r, /Playing hai /).length > 1) errs.push('「はい」を2回流した');
            if (!r.sttTexts.includes('今、営業の責任者の者が席を外しております。')) errs.push(`つないだ発話を文字起こししていない: ${JSON.stringify(r.sttTexts)}`);
            if (!resultsSaved(r).includes('not_available')) errs.push(`結果が not_available でない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // つなぎ言葉だけで黙った＝1.5秒待ってから、文字起こしをやり直さずに判定（聞き返し）
    incomplete_timeout: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 700, text: 'えっと、' }, { kind: 'silence', ms: 8000 }],
        haiku: () => 'reason', // AI に回したら用件の答えになる＝回していないことを見る
        maxMs: 14000,
        doneWhen: (log) => log.some((l) => /✓ Finished pardon/.test(l.line)),
        check(r) {
            const errs = [];
            if (!has(r, /\[held\] no continuation/)) errs.push('期限で判定に戻っていない');
            if (r.events.filter((e) => e.t === 'stt' && e.text === 'えっと、').length !== 1) errs.push('同じ発話を2回文字起こしした');
            if (!has(r, /Playing pardon/)) errs.push('聞き返しを流していない');
            if (r.events.some((e) => e.t === 'haiku')) errs.push('つなぎ言葉だけを AI に回した');
            if (has(r, /Playing hai /)) errs.push('「はい」を流した');
            const end = r.log.find((l) => /\[vad\] speech end/.test(l.line));
            const pardon = r.log.find((l) => /Playing pardon/.test(l.line));
            if (end && pardon && pardon.at - end.at < 1500) errs.push(`待たずに返した（${pardon.at - end.at}ms）`);
            return errs;
        },
    },
    // 「もう一度」＝あいさつを名乗りから流し直す（聞き返しにしない・AI を待たない）
    repeat_greeting: {
        settings: V2(),
        nameSet: true,
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1200, text: 'すいません、もう一度。' }, { kind: 'silence', ms: 6000 }],
        haiku: () => 'reprompt',
        maxMs: 16000,
        doneWhen: (log) => log.filter((l) => /✓ Finished greeting/.test(l.line)).length >= 2,
        check(r) {
            const errs = [];
            if (has(r, /Playing pardon/)) errs.push('聞き返しを流した');
            if (r.events.some((e) => e.t === 'haiku')) errs.push('AI を待った');
            if (lines(r, /Playing name_lead/).length < 2) errs.push('名乗りから流し直していない');
            if (lines(r, /Playing greeting/).length < 2) errs.push('あいさつを流し直していない');
            if (has(r, /Playing hai /)) errs.push('「はい」を流した');
            return errs;
        },
    },
    // 不在 → 戻りの時間を聞く → 時刻を言われた＝そのお時間に → 折り返し予定・再コールの日時を記録
    absent_time: {
        settings: V2(),
        absentSet: true,
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '担当者は本日外出しております。' }, { kind: 'silence', ms: 5000 },
            { kind: 'speech', ms: 1300, text: '16時には戻ります。' }, { kind: 'silence', ms: 6000 },
        ],
        haiku: haikuFor([['外出', 'not_available']]),
        maxMs: 24000,
        check(r) {
            const errs = [];
            if (!has(r, /Playing absent_ask/)) errs.push('戻りの時間を聞いていない');
            if (!has(r, /Playing absent_time_ack/)) errs.push('「そのお時間に」を流していない');
            if (has(r, /Playing sorry_disturb/)) errs.push('辞去で切った');
            if (r.events.filter((e) => e.t === 'haiku').length !== 1) errs.push('段の答えで AI を待った');
            if (!resultsSaved(r).includes('callback_scheduled')) errs.push(`結果が callback_scheduled でない: ${resultsSaved(r)}`);
            const md = r.events.find((e) => e.t === 'PATCH' && e.table === 'call_sessions' && e.payload?.metadata?.recall_at);
            if (!md) errs.push('再コールの日時を書いていない');
            else if (!/T07:00:00/.test(md.payload.metadata.recall_at)) errs.push(`再コールの日時が16時（JST）でない: ${md.payload.metadata.recall_at}`);
            return errs;
        },
    },
    // 不在 → 分からない → 「明日の午後は」→ はい＝明日13時
    absent_unknown_yes: {
        settings: V2(),
        absentSet: true,
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '担当者は本日外出しております。' }, { kind: 'silence', ms: 5000 },
            { kind: 'speech', ms: 1300, text: 'ちょっと分からないです。' }, { kind: 'silence', ms: 4500 },
            { kind: 'speech', ms: 1000, text: 'はい、大丈夫です。' }, { kind: 'silence', ms: 6000 },
        ],
        haiku: haikuFor([['外出', 'not_available']]),
        maxMs: 30000,
        check(r) {
            const errs = [];
            for (const k of ['absent_ask', 'absent_propose', 'absent_close']) if (!has(r, new RegExp(`Playing ${k}`))) errs.push(`${k} を流していない`);
            if (!resultsSaved(r).includes('callback_scheduled')) errs.push(`結果が callback_scheduled でない: ${resultsSaved(r)}`);
            const md = r.events.find((e) => e.t === 'PATCH' && e.table === 'call_sessions' && e.payload?.metadata?.recall_at);
            if (!md || !/T04:00:00/.test(md.payload.metadata.recall_at)) errs.push(`再コールの日時が13時（JST）でない: ${md?.payload?.metadata?.recall_at}`);
            return errs;
        },
    },
    // 設定の無い通話でも同じ流れ＝分からない → 明日は無理＝不在で終話（再コールの日時は書かない）
    absent_unknown_no_legacy: {
        settings: null,
        absentSet: true,
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '担当者は本日外出しております。' }, { kind: 'silence', ms: 5000 },
            { kind: 'speech', ms: 1300, text: '分からないです。' }, { kind: 'silence', ms: 4500 },
            { kind: 'speech', ms: 1000, text: '明日はちょっと無理です。' }, { kind: 'silence', ms: 6000 },
        ],
        haiku: haikuFor([['外出', 'not_available']]),
        maxMs: 30000,
        check(r) {
            const errs = [];
            for (const k of ['absent_ask', 'absent_propose', 'absent_close']) if (!has(r, new RegExp(`Playing ${k}`))) errs.push(`${k} を流していない`);
            if (!resultsSaved(r).includes('not_available')) errs.push(`結果が not_available でない: ${resultsSaved(r)}`);
            if (r.events.some((e) => e.t === 'PATCH' && e.table === 'call_sessions' && e.payload?.metadata?.recall_at)) errs.push('NO なのに再コールの日時を書いた');
            return errs;
        },
    },
    // 戻りの時間を聞いている最中に「別の者に代わりますので少々お待ちください」＝段を抜けて待機へ
    absent_escape_to_wait: {
        settings: V2(),
        absentSet: true,
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '担当者は本日外出しております。' }, { kind: 'silence', ms: 5000 },
            { kind: 'speech', ms: 2200, text: '担当は不在ですが、別の者に代わりますので少々お待ちください。' }, { kind: 'silence', ms: 4000 },
        ],
        haiku: haikuFor([['少々お待ち', 'wait'], ['外出', 'not_available']]),
        maxMs: 26000,
        doneWhen: (log) => log.some((l) => /\[wait\] entered/.test(l.line)),
        check(r) {
            const errs = [];
            if (!has(r, /Playing absent_ask/)) errs.push('戻りの時間を聞いていない');
            if (!has(r, /\[absent\] left stage asked/)) errs.push('取次の言葉で段を抜けていない');
            if (!has(r, /\[wait\] entered/)) errs.push('待機に入っていない');
            if (has(r, /Playing absent_propose/)) errs.push('取次の言葉なのに明日の午後を出した');
            return errs;
        },
    },
    // 4本の無い声セット＝今までどおり辞去で終話
    absent_without_clips: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '担当者は本日外出しております。' }, { kind: 'silence', ms: 6000 }],
        haiku: haikuFor([['外出', 'not_available']]),
        maxMs: 16000,
        check(r) {
            const errs = [];
            if (has(r, /Playing absent_/)) errs.push('4本が無いのに不在の流れへ入った');
            if (!has(r, /Playing sorry_disturb/)) errs.push('辞去を流していない');
            if (!resultsSaved(r).includes('not_available')) errs.push(`結果が not_available でない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 待機中に「不在でした」＝待機を出て戻りの時間を聞く
    absent_in_wait: {
        settings: V2(),
        absentSet: true,
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '少々お待ちください。' }, { kind: 'silence', ms: 4000 },
            { kind: 'speech', ms: 1800, text: '申し訳ございません、担当は外出しておりまして。' }, { kind: 'silence', ms: 6000 },
        ],
        haiku: haikuFor([['少々お待ち', 'wait'], ['外出', 'not_available']]),
        maxMs: 22000,
        doneWhen: (log) => log.some((l) => /✓ Finished absent_ask/.test(l.line)),
        check(r) {
            const errs = [];
            if (!has(r, /\[wait\] entered/)) errs.push('待機に入っていない');
            if (!has(r, /Playing absent_ask/)) errs.push('待機の後の不在で戻りの時間を聞いていない');
            if (has(r, /Playing sorry_disturb/)) errs.push('辞去で切った');
            return errs;
        },
    },
    // 保留音の無い待機（森さんの携帯）＝黙って待ち、本人の名乗りで取次1回
    silent_wait_handover: {
        settings: V2(),
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '少々お待ちください。' }, { kind: 'silence', ms: 12000 },
            { kind: 'speech', ms: 1800, text: 'お電話代わりました、森です。' },
        ],
        haiku: haikuFor([['少々お待ち', 'wait'], ['代わりました', 'transfer']]),
        maxMs: 30000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[wait\] entered/)) errs.push('待機に入っていない');
            if (!has(r, /\[decide\] step=2h action=transfer_fast/)) errs.push('名乗りで最速の取次になっていない');
            if (lines(r, /\[transfer\] committed/).length !== 1) errs.push('取次が1回でない');
            if (has(r, /Playing pardon/)) errs.push('黙っている間に聞き返した');
            if (!resultsSaved(r).includes('transferred')) errs.push(`結果が transferred でない: ${resultsSaved(r)}`);
            return errs;
        },
    },
    // 台本で答えられない返事＝自由会話（GPT）へ行かず CM へ（Tom「困ったらcmに接続」）
    // ===== 2026-10-07 名前で名乗る（Tom「これでgo」）=====
    // あいさつ＝「◯◯の」→ CM の名前 → 用件〜取次の頼み
    name_greeting: {
        settings: V2(),
        nameSet: true,
        timeline: [{ kind: 'silence', ms: 6000 }],
        haiku: () => 'reprompt',
        maxMs: 10000,
        doneWhen: (log) => log.some((l) => /✓ Finished greeting/.test(l.line)),
        check(r) {
            const errs = [];
            const at = (re) => r.log.findIndex((l) => re.test(l.line));
            const a = at(/Playing name_lead/), b = at(/Playing cm_name/), c = at(/Playing greeting/);
            if (!(a >= 0 && b > a && c > b)) errs.push(`あいさつの順が違う: name_lead=${a} cm_name=${b} greeting=${c}`);
            return errs;
        },
    },
    // 「どちらの会社ですか」＝社名（〜の）の後に CM の名前
    name_company: {
        settings: V2(),
        nameSet: true,
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: 'どちらの会社ですか？' }, { kind: 'silence', ms: 6000 }],
        haiku: haikuFor([['会社', 'company']]),
        maxMs: 20000,
        doneWhen: (log) => log.filter((l) => /✓ Finished cm_name/.test(l.line)).length >= 2,
        check(r) {
            const errs = [];
            const i = r.log.findIndex((l) => /Playing company/.test(l.line));
            const j = r.log.findIndex((l, n) => n > i && /Playing cm_name/.test(l.line));
            if (!(i >= 0 && j > i)) errs.push('社名の答えの後に名前をつないでいない');
            return errs;
        },
    },
    // 「資料を送ってください」＝返事を流してから CM へ（送付先は CM が伺う）
    material_then_agent: {
        settings: V2(),
        nameSet: true,
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: '資料を送ってください。' }, { kind: 'silence', ms: 8000 }],
        haiku: haikuFor([['資料', 'material_request']]),
        maxMs: 20000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /Playing send_material/)) errs.push('資料送付の返事を流していない');
            if (!has(r, /\[fallback\] then_agent \(material_request\) → CM/)) errs.push('返事の後に CM へつないでいない');
            const rings = r.events.filter((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')).length;
            if (rings !== 1) errs.push(`CM を ${rings} 回呼んだ（1回のはず）`);
            return errs;
        },
    },
    fallback_to_agent: {
        settings: V2(),
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: 'えっと、それってどういう仕組みなんですか？' }, { kind: 'silence', ms: 8000 }],
        haiku: () => 'openai_realtime',
        maxMs: 20000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[fallback\] no scripted answer → CM/)) errs.push('答えられない返事で CM へつないでいない');
            if (has(r, /Switching to OpenAI Realtime/)) errs.push('自由会話へ入った');
            const rings = r.events.filter((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')).length;
            if (rings !== 1) errs.push(`CM を ${rings} 回呼んだ（1回のはず）`);
            return errs;
        },
    },
    fallback_to_agent_legacy: {
        settings: null,
        timeline: [{ kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 1500, text: 'えっと、それってどういう仕組みなんですか？' }, { kind: 'silence', ms: 8000 }],
        haiku: () => 'openai_realtime',
        maxMs: 20000,
        doneWhen: (log, ev) => ev.some((e) => e.t === 'twilio' && e.path.endsWith('/Calls.json')),
        check(r) {
            const errs = [];
            if (!has(r, /\[fallback\] no scripted answer → CM/)) errs.push('答えられない返事で CM へつないでいない');
            if (has(r, /Switching to OpenAI Realtime/)) errs.push('自由会話へ入った');
            return errs;
        },
    },
    // 同じ形を設定なしの通話で
    merge_fragment_legacy: {
        settings: null,
        timeline: [
            { kind: 'silence', ms: 6000 }, { kind: 'speech', ms: 300, text: 'あ、' }, { kind: 'silence', ms: 900 },
            { kind: 'speech', ms: 1500, text: '用件はなんですか？' }, { kind: 'silence', ms: 6000 },
        ],
        haiku: haikuFor([['用件', 'reason']]),
        haikuDelayMs: 1200,
        maxMs: 20000,
        doneWhen: (log) => log.some((l) => /✓ Finished reason/.test(l.line)),
        check(r) {
            const errs = [];
            // 「あ、」はつなぎ言葉＝文字起こしの前に続きが来ればつなぎ直し（merge）、後なら言いかけの待ち（held）からつなぐ
            if (!has(r, /\[merge\] caller continued|\[held\] caller continued/)) errs.push('処理中の続きの言葉で判定を捨てていない');
            if (!has(r, /Playing reason/)) errs.push('用件の答えを流していない');
            if (has(r, /Playing pardon/)) errs.push('聞き返しを流した');
            return errs;
        },
    },
    // 段0（設定なしでも）＝関門で取次を拒否した回も聞き返しの1回に数える → 3回目で切る
    legacy_gate_reject_counts: {
        settings: null,
        timeline: [
            { kind: 'silence', ms: 6000 },
            // 同じ言葉の繰り返しはループ検知が先に切る＝相づちを3種類にする
            { kind: 'speech', ms: 900, text: 'はい。' },
            { kind: 'silence', ms: 3000 },
            { kind: 'speech', ms: 900, text: 'もしもし。' },
            { kind: 'silence', ms: 3000 },
            { kind: 'speech', ms: 900, text: 'お待たせしました。' },
            { kind: 'silence', ms: 3000 },
        ],
        haiku: () => 'transfer',
        maxMs: 25000,
        check(r) {
            const errs = [];
            const blocked = lines(r, /\[transfer-guard\] blocked/).length;
            if (blocked !== 3) errs.push(`関門の拒否が ${blocked} 回（3回のはず）`);
            if (!has(r, /\[reprompt\] miss 3\/2/)) errs.push('3回目で数えていない（今は毎回 1 回目に戻っていた）');
            if (!resultsSaved(r).includes('silence_timeout')) errs.push(`3回目で切っていない: ${resultsSaved(r)}`);
            return errs;
        },
    },
};

// ---------------------------------------------------------------------
const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(SCENARIOS);
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
await startEngine();
let failed = 0;
for (const name of names) {
    const s = SCENARIOS[name];
    if (!s) { console.error(`unknown scenario ${name}`); failed++; continue; }
    const r = await runScenario(s);
    const errs = s.check(r);
    if (errs.length) {
        failed++;
        console.log(`✗ ${name}（${r.elapsed.toFixed(1)}s）`);
        for (const e of errs) console.log(`   - ${e}`);
        if (process.env.SIM_VERBOSE) for (const l of r.log) console.log(`     ${l.t}s ${l.line}`);
    } else {
        console.log(`✓ ${name}（${r.elapsed.toFixed(1)}s）`);
        if (process.env.SIM_VERBOSE === "all") for (const l of r.log) console.log(`     ${l.t}s ${l.line}`);
    }
}
engine.kill();
fake.close();
process.exit(failed ? 1 : 0);
