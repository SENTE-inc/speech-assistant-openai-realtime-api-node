// 取次の判定に使うモデルの比較＝本物のモデルに聞いて、エンジンと同じ判定順（transfer-logic.js）を通した「最終の動作」が
// 期待と合うかと、速さを測る。電話は鳴らない（文字だけ）。費用は1周で数セント。
// 走らせ方＝`ANTHROPIC_API_KEY=… OPENAI_API_KEY=… [CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=…] node scripts/transfer-bench/model-bench.mjs [回数]`
//   Cloudflare の鍵が在る時だけ Jev（typesafe/jev）と Clef（@cf/cloudflare/clef・clef-flash）も測る（Workers AI の System One 形）。
// 家＝~/sente/sfav_transfer_tuning_plan.md・~/.claude/projects/-Users-tom/memory/reference_anthropic_model_inventory.md「判定専用AI Jev」
import {
    buildClassifierPrompt, decideBeforeClassifier, decideAfterClassifier,
} from '../../transfer-logic.js';
import { INTENTS, INTENT_BY_NAME, SF_DEFAULT, OUTSIDE_WAIT, IN_WAIT } from './fixtures.mjs';

const ROUNDS = Number(process.argv[2] || 2);
const AK = process.env.ANTHROPIC_API_KEY;
const OK = process.env.OPENAI_API_KEY;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
// Vercel の AI Gateway（SENTE のチーム）の鍵＝在れば Jev（typesafe-ai/jev）と、Gateway が出している判定専用モデルを全部測る
const GW_KEY = process.env.AI_GATEWAY_API_KEY;

// 本番の声セットと同じ例文（「既存の架電先」の雛形）＋SF の会社の既定の設定でプロンプトを組む
const TRIGGERS = {
    transfer: SF_DEFAULT.transfer_phrases,
    reason: ['どのようなご用件', '何のご用件', 'どういったご提案'],
    company: ['どちらの会社', 'どこの会社', '会社名は'],
    who: ['どなた様', 'お名前は', '担当者のお名前'],
    appointment: ['アポイントは', 'お約束は', 'ご予約は'],
    callback_request: ['折り返しましょうか', '後ほど', 'またかけ直して'],
    callback_scheduled: ['夕方には戻ります', '16時頃戻ります', '明日には戻ります', '担当者は不在だが戻り時間が明示されている'],
    not_available: ['本日不在', '外出中で戻り未定', '只今不在', 'いません（戻り時間不明）'],
    rejected: ['必要ありません', '結構です', '間に合っています', 'すでに他社と契約', 'お断りします', '興味ないです', 'いりません'],
    reprompt: ['雑音', '咳', 'もごもご', '語として成立しない音', '文字起こしの失敗'],
    openai_realtime: ['意味は通じるが上記に無い質問・発言', '雑談', '反論'],
};
const cfg = { companyName: '株式会社セールス・フォージ', intents: INTENTS.map((i) => ({ ...i, triggers: TRIGGERS[i.name] })) };
const PROMPT = buildClassifierPrompt(cfg, SF_DEFAULT);
const NAMES = [...INTENTS.map((i) => i.name), 'wait'];
const userMessage = (text, afterHold) =>
    `${afterHold ? '[状況] 保留の後に電話に出た人の発言\n' : ''}[文脈] 架電先会社: 株式会社テスト\n[発話] ${text}`;

// ---------------------------------------------------------------------
// モデル（どれも intent の名前を1つ返す）
// ---------------------------------------------------------------------
async function haiku(text, afterHold, model = 'claude-haiku-4-5-20251001', schema = true) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': AK, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
            model, max_tokens: 200,
            system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral' } }],
            // Haiku 5.5 は先頭埋め（prefill）を 400 で弾く＝JSON の形を指定して返させる・思考は切る
            ...(model.includes('haiku-4-5') ? { messages: [{ role: 'user', content: userMessage(text, afterHold) }, { role: 'assistant', content: '{' }] }
                : !schema ? { messages: [{ role: 'user', content: userMessage(text, afterHold) }], thinking: { type: 'disabled' } }
                : model.includes('haiku-4-5')
                ? { messages: [{ role: 'user', content: userMessage(text, afterHold) }, { role: 'assistant', content: '{' }] }
                : { messages: [{ role: 'user', content: userMessage(text, afterHold) }], thinking: { type: 'disabled' },
                    output_config: { format: { type: 'json_schema', schema: {
                        type: 'object', additionalProperties: false, required: ['intent', 'callback_info'],
                        properties: { intent: { type: 'string', enum: NAMES }, callback_info: { type: 'string' } } } } } }),
        }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
    const t0 = j.content?.find((c) => c.type === 'text')?.text || '';
    const raw = t0.trimStart().startsWith('{') ? t0 : '{' + t0;
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).intent;
}

async function luna(text, afterHold, effort) {
    const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OK}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-5.6-luna', reasoning: { effort }, instructions: PROMPT, input: userMessage(text, afterHold),
            max_output_tokens: 2000,
            text: { format: { type: 'json_schema', name: 'intent', strict: true, schema: {
                type: 'object', additionalProperties: false, required: ['intent', 'callback_info'],
                properties: { intent: { type: 'string', enum: NAMES }, callback_info: { type: 'string' } },
            } } },
        }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
    let txt = '';
    for (const o of j.output || []) if (o.type === 'message') for (const c of o.content) if (c.type === 'output_text') txt += c.text;
    return JSON.parse(txt).intent;
}

// System One（Jev・Clef）＝意図を choice で1つ選ばせる。criteria は意図ごとの説明＝プロンプトの例文と同じ物
const CRITERIA = Object.fromEntries(NAMES.map((n) => [n,
    n === 'wait' ? `相手がこちらを待たせる・誰かを呼びに行く（例: ${SF_DEFAULT.wait_phrases.join(' / ')}）。断り・不在・質問が含まれていればそちらを優先。「お電話代わりました」など本人が出ている時は選ばない`
        : n === 'transfer' ? `本人が名乗った・取次を明言した・本人が前向きに聞く姿勢を示した（例: ${TRIGGERS.transfer.slice(0, 12).join(' / ')}）。相づちだけ（はい・もしもし・お待たせ）では選ばない`
            : `例: ${TRIGGERS[n].join(' / ')}`]));
async function systemOne(model, text, afterHold, via = 'cloudflare') {
    const url = via === 'gateway'
        ? 'https://ai-gateway.vercel.sh/typesafe/v1/systemone'
        : `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${via === 'gateway' ? GW_KEY : CF_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            ...(via === 'gateway' ? { model } : {}),
            state: `営業電話で、こちら（株式会社セールス・フォージ）が架電先の受付と話している。${afterHold ? '受付に保留にされた後、電話に出た人の発言。' : ''}相手の直近の発言:「${text}」`,
            questions: { intent: { type: 'choice', instructions: '相手の直近の発言に最も当てはまる意図を1つ選ぶ', criteria: CRITERIA } },
        }),
    });
    const j = await r.json();
    if (!r.ok || j.success === false) throw new Error(JSON.stringify(j).slice(0, 300));
    const res = j.result || j;
    return res.answers?.intent?.choice;
}

const ENGINES = {
    haiku: (t, w) => haiku(t, w),
    haiku55: (t, w) => haiku(t, w, 'claude-haiku-5-5'),
    haiku55_plain: (t, w) => haiku(t, w, 'claude-haiku-5-5', false),
    luna_none: (t, w) => luna(t, w, 'none'),
    luna_low: (t, w) => luna(t, w, 'low'),
};
if (GW_KEY) {
    // Gateway が出している判定のモデル（Jev 以外も＝例 Laya）を一覧から取る
    const r = await fetch('https://ai-gateway.vercel.sh/typesafe/v1/models', { headers: { Authorization: `Bearer ${GW_KEY}` } });
    const j = await r.json().catch(() => ({}));
    const ids = (j.data || j.models || []).map((m) => m.id || m).filter((x) => typeof x === 'string');
    console.log(`[gateway] evaluation models: ${ids.join(', ') || '(取れない＝Jev だけ測る)'}`);
    for (const id of ids.length ? ids : ['typesafe-ai/jev']) ENGINES[`gw:${id}`] = (t, w) => systemOne(id, t, w, 'gateway');
}
if (CF_ACCOUNT && CF_TOKEN) {
    ENGINES.jev = (t, w) => systemOne('typesafe/jev', t, w);
    ENGINES.clef = (t, w) => systemOne('@cf/cloudflare/clef', t, w);
    ENGINES.clef_flash = (t, w) => systemOne('@cf/cloudflare/clef-flash', t, w);
}

if (process.env.ENGINES) for (const k of Object.keys(ENGINES)) if (!process.env.ENGINES.split(',').includes(k)) delete ENGINES[k];

// ---------------------------------------------------------------------
const CASES = [
    ...OUTSIDE_WAIT.map(([text, , want]) => ({ text, want, inWait: false })),
    ...IN_WAIT.map(([text, , want]) => ({ text, want, inWait: true })),
];
// 同じ発話が複数の行に在る（Haiku の答えを変えて試す行）＝モデルの比較では1回にまとめる
const uniq = [...new Map(CASES.map((c) => [`${c.inWait}:${c.text}`, c])).values()];

const pct = (a, n) => `${a}/${n}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

const report = [];
for (const [name, ask] of Object.entries(ENGINES)) {
    let ok = 0, n = 0, errors = 0;
    const ms = [];
    const misses = new Map();
    const byKind = { transfer: [0, 0], wait: [0, 0], negative: [0, 0], other: [0, 0] };
    for (let round = 0; round < ROUNDS; round++) {
        for (const c of uniq) {
            const pre = decideBeforeClassifier({ transcript: c.text, ts: SF_DEFAULT, inWait: c.inWait });
            let action;
            if (pre) {
                action = pre.action; // 相づちだけ（待機中）はモデルに聞かない＝エンジンと同じ
            } else {
                const t0 = Date.now();
                let intent = null;
                try { intent = await ask(c.text, c.inWait); } catch (e) { errors++; intent = null; if (errors <= 2) console.error(`[${name}] ${e.message}`); }
                ms.push(Date.now() - t0);
                action = decideAfterClassifier({ transcript: c.text, intentName: intent, intentDef: INTENT_BY_NAME.get(intent) || null, ts: SF_DEFAULT, inWait: c.inWait }).action;
                if (action !== c.want) misses.set(`${c.inWait ? '[待機中] ' : ''}${c.text}`, `${intent}→${action}（期待 ${c.want}）`);
            }
            n++;
            const hit = action === c.want;
            if (hit) ok++;
            const kind = c.want === 'transfer' ? 'transfer' : (c.want === 'wait_enter' || c.want === 'continue_wait') ? 'wait'
                : c.want === 'intent' ? 'negative' : 'other';
            byKind[kind][1]++;
            if (hit) byKind[kind][0]++;
        }
    }
    // 一番怖い誤り＝取次でない発話が取次になる（CM に担当者でない人がつながる）
    report.push({ name, ok, n, errors, ms, misses, byKind });
    console.log(`${name}: 正解 ${pct(ok, n)}（取次 ${pct(...byKind.transfer)}・待機 ${pct(...byKind.wait)}・否定 ${pct(...byKind.negative)}・その他 ${pct(...byKind.other)}）` +
        ` 中央値 ${median(ms)}ms・p95 ${p95(ms)}ms${errors ? `・エラー ${errors}` : ''}`);
    for (const [k, v] of misses) console.log(`   ✗ ${k}: ${v}`);
}
