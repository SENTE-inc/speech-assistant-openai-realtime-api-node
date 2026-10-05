// 取次の判定（純関数）＝エンジン index.js と試験 scripts/transfer-bench/ が同じ物を使う。
// 家＝~/sente/sfav_transfer_tuning_plan.md（§1-c・1-f）。
// 🔴 設定（transfer_settings の行＝ts）が無い通話は「今の挙動」＝buildClassifierPrompt(cfg, null)・
//    hasSufficientTransferEvidence(transcript) は 2026-10-05 までの本番と1字も変えない。
import { createHash } from 'node:crypto';

// =====================================================================
// 今の関門（設定が無い通話で使う）＝2026-10-05 までの本番と同じ
// =====================================================================

// Naked filler / acknowledgements that must NEVER, on their own, trigger a
// transfer. Compared after stripping punctuation/whitespace.
export const TRANSFER_FILLER_ONLY = new Set([
    'はい', 'はいはい', 'ええ', 'うん', 'もしもし', 'おまたせ', 'お待たせ',
    'おまたせしました', 'お待たせしました', 'すいません', 'すみません',
    'どうも', 'はいもしもし', 'はいどうも', 'えっと', 'あの', 'はーい',
]);

// Phrases that DO constitute explicit transfer / responsible-person evidence.
// Kept in sync with the transfer intent triggers in INTENT_TEMPLATE plus the
// "I am the person in charge" forms.
export const TRANSFER_EVIDENCE_PATTERNS = [
    'お繋ぎ', 'おつなぎ', 'お繋ぎします', 'お繋ぎいたします',
    '代わります', '代わり', '替わります', '担当に代わ', '担当者に代わ',
    // 文字起こしは「代わります」を「変わります」と書くことがある（2026-09-11 実架電「はい、今変わります」）
    '変わります', '担当に変わ', '担当者に変わ',
    '担当です', '担当の', '私が担当', '責任者', '私が責任者',
    '代表です', '私が代表', '代表の', '社長です', '社長の',
    '本人です', '私です', '私が', '詳しく聞かせて', '詳しく聞きたい',
    '興味があります', '興味あります', '聞かせてください', '聞きます',
];

export function normalizeForTransferGuard(s) {
    return (s || '')
        .replace(/[\s、。，．！？!?・…ー「」『』（）()【】〜~]/g, '')
        .trim();
}

// Returns true only when the transcript carries explicit transfer evidence and
// is not just filler. Used as a hard gate before handleTransfer().
export function hasSufficientTransferEvidence(transcript) {
    const norm = normalizeForTransferGuard(transcript);
    // Too short to be a meaningful "put me through / I'm the person" statement.
    if (norm.length < 4) return false;
    // Pure filler / acknowledgement — never a transfer on its own.
    if (TRANSFER_FILLER_ONLY.has(norm)) return false;
    // Require at least one explicit evidence phrase in the ORIGINAL transcript
    // (so punctuation inside a phrase doesn't matter much, but we keep the
    // original to allow natural matching).
    const hay = transcript || '';
    return TRANSFER_EVIDENCE_PATTERNS.some((p) => hay.includes(p));
}

// =====================================================================
// プロンプト（ts＝設定が在る時だけ wait の意図と判断文を足す）
// =====================================================================

export function buildClassifierPrompt(cfg, ts = null) {
    const lines = cfg.intents.map((i) => {
        const triggers = ts && i.is_transfer ? ts.transfer_phrases : i.triggers;
        const ex = Array.isArray(triggers) ? triggers.join(' / ') : '';
        return `- ${i.name}: ${ex}`;
    });
    if (ts) lines.push(`- wait: ${(ts.wait_phrases || []).join(' / ')}`);
    const waitRule = ts
        ? `- wait（待たせる）は、相手が「少々お待ちください」「確認します」「呼んできます」など、こちらを待たせる・誰かを呼びに行く発言をした場合に選ぶ。断り・不在・質問が含まれていればそちらを優先する。「お電話代わりました」など、もう引き継がれて本人が出ている場合は wait ではない。\n` +
          `- [状況] に「保留の後」とある時は、受付に保留にされた後に電話に出た人の発言。\n`
        : '';
    return `あなたは営業電話の応対判断AIです。${cfg.companyName}の担当者として、` +
        `会話の直近の発言から最も当てはまる意図(intent)を1つだけ選んでください。\n\n` +
        `【意図の一覧（name: 該当する発言の例）】\n${lines.join('\n')}\n\n` +
        `判断のポイント:\n` +
        `- transfer（取次）は最も慎重に判断する。相手が「自分が担当者／責任者だ」と明確に名乗った、担当者本人が電話口に出て前向きに話を聞く姿勢を示した、または「お繋ぎします／代わります」と取り次ぎを明言した場合のみ選ぶ。単なる相槌・あいさつ・聞き返し（例:「はい」だけ／「すいません」／「お待たせ」／「もしもし」）や曖昧な発話では絶対に transfer を選ばない。\n` +
        `- 担当者がいない・不在を示す発言（「いません」「不在」「外出中」「席を外している」等）は not_available（戻り時間が明示されていれば callback_scheduled）。transfer ではない。\n` +
        waitRule +
        `- transfer かどうか確信が持てない場合は transfer を選ばない（聞き取れていなければ reprompt、意味は通じるが当てはまらなければ openai_realtime）。\n` +
        `- 聞き取れない・意味をなさない発話は "reprompt"。\n` +
        `- 意味は通じるが上記に当てはまらない発言は "openai_realtime"。\n` +
        `- 戻り時間など日時情報があれば callback_info に原文のまま記録。\n\n` +
        `必ず次のJSONのみを返してください（説明文は不要）:\n` +
        `{ "intent": "<上記nameのいずれか>", "callback_info": "<日時情報があれば。無ければ省略>" }`;
}

// Vocabulary hint for STT — biases gpt-transcribe toward this tenant's
// expected phrases so homophones (e.g. 代表/対象) resolve correctly.
// Sample a couple of triggers per intent so the hint stays balanced across
// outcomes (the transfer list would otherwise dominate and get truncated).
export function buildTranscriptionPrompt(companyName, intents, ts = null) {
    const groups = intents.map((i) => (ts && i.is_transfer ? ts.transfer_phrases : i.triggers));
    if (ts) groups.push(ts.wait_phrases);
    const vocab = [...new Set(groups.flatMap((g) => (Array.isArray(g) ? g.slice(0, 2) : [])))].join('、');
    return `日本語の法人向け営業電話です。会社名は${companyName}。想定される発言: ${vocab}`.slice(0, 240);
}

// =====================================================================
// 設定が在る通話の判定（§1-f）
// =====================================================================

// もう引き継がれて本人が出ている＝「待たせる」の言い回しが混ざっていても待機にしない
// 例＝「お電話代わりました」「担当の山田です」「担当です。確認しますので少々お待ちください」
export const HANDOVER_DONE_RE =
    /(代|替|変)わりました|(担当|責任者|代表|店長|オーナー|社長)(者)?の.{1,8}です|私が(担当|責任者|代表)|(担当|責任者|代表|店長|社長|本人|私)(者)?です/;

export function firstMatch(text, phrases) {
    const hay = text || '';
    for (const p of phrases || []) {
        if (p && hay.includes(p)) return p;
    }
    return null;
}

export function isFillerOnly(transcript) {
    return TRANSFER_FILLER_ONLY.has(normalizeForTransferGuard(transcript));
}

// 取次の関門（設定あり）＝block → 短い・相づちだけ → transfer_phrases
export function transferGate(transcript, ts) {
    const blocked = firstMatch(transcript, ts.block_phrases);
    if (blocked) return { pass: false, gate: 'block', matched: blocked };
    const norm = normalizeForTransferGuard(transcript);
    if (norm.length < 4 || TRANSFER_FILLER_ONLY.has(norm)) return { pass: false, gate: 'filler', matched: null };
    const hit = firstMatch(transcript, ts.transfer_phrases);
    if (hit) return { pass: true, gate: 'phrase', matched: hit };
    return { pass: false, gate: 'no_evidence', matched: null };
}

// 手順3＝Haiku の前に決める物（待機中の相づちだけ）。決めない時は null
export function decideBeforeClassifier({ transcript, ts, inWait }) {
    if (!inWait || !isFillerOnly(transcript)) return null;
    return ts.after_wait_strict
        ? { step: '3', action: 'continue_wait', gate: 'filler_strict', matched: null }
        : { step: '3', action: 'transfer', gate: 'filler_after_wait', matched: null };
}

const WAITISH_FALLBACK_ACTIONS = new Set(['reprompt', 'openai_realtime']);

// 手順5〜9＝Haiku の答え（intentName・intentDef＝call_intents の行。wait は行が無い）から最終の動作を決める
// action: intent（その意図の声を流す・end_call なら切る）／answer（答えを流して聞く・待機中は待機を続ける）／
//         wait_enter／continue_wait／transfer／reprompt／realtime
export function decideAfterClassifier({ transcript, intentName, intentDef, ts, inWait }) {
    // 5 否定が勝つ
    if (intentDef?.end_call) return { step: '5', action: 'intent' };
    // 6 質問に答える（折り返しの申し出も同じ＝答えて聞く）
    if (intentDef && !intentDef.is_transfer && intentDef.audio_key
        && !WAITISH_FALLBACK_ACTIONS.has(intentDef.action)) {
        return { step: '6', action: 'answer' };
    }
    // 7 待たせる＝Haiku が wait、または Haiku が transfer で待たせる言い回しに当たる（本人が出ている時は除く）。
    //   Haiku が迷った（reprompt・自由会話・未知）時に言い回しだけで待たせるのは「待つ」設定の時だけ＝
    //   「すぐ取次」の設定で、Haiku が取次と言っていない発話を言い回しだけで取次にしない
    const waitHit = firstMatch(transcript, ts.wait_phrases);
    const handoverDone = HANDOVER_DONE_RE.test(transcript || '');
    const strongWait = intentName === 'wait' || (waitHit && !handoverDone && intentDef?.is_transfer);
    const weakWait = waitHit && !handoverDone && ts.on_wait === 'wait'
        && (!intentDef || WAITISH_FALLBACK_ACTIONS.has(intentDef.action));
    if (strongWait || weakWait) {
        const matched = waitHit;
        if (ts.on_wait === 'wait') return { step: '7', action: inWait ? 'continue_wait' : 'wait_enter', matched };
        if (ts.on_wait === 'transfer') return { step: '7', action: 'transfer', gate: 'on_wait_transfer', matched };
        return { step: '7', action: inWait ? 'continue_wait' : 'reprompt', matched };
    }
    // 8 取次＝関門
    if (intentDef?.is_transfer) {
        const g = transferGate(transcript, ts);
        if (g.pass) return { step: '8', action: 'transfer', gate: g.gate, matched: g.matched };
        return { step: '8', action: inWait ? 'continue_wait' : 'reprompt', gate: g.gate, matched: g.matched };
    }
    // 9 それ以外
    if (inWait) return { step: '9', action: 'continue_wait' };
    if (intentDef?.action === 'reprompt') return { step: '9', action: 'reprompt' };
    return { step: '9', action: 'realtime' };
}

// =====================================================================
// 設定の行 → 判定に使う形・中身の hash
// =====================================================================

export function normalizeSettings(row) {
    if (!row) return null;
    return {
        id: row.id,
        scope: row.project_id ? 'project' : 'tenant',
        version: row.version,
        transfer_phrases: row.transfer_phrases || [],
        block_phrases: row.block_phrases || [],
        wait_phrases: row.wait_phrases || [],
        on_wait: row.on_wait,
        wait_max_seconds: row.wait_max_seconds,
        after_wait_strict: !!row.after_wait_strict,
    };
}

export function settingsHash(ts) {
    const body = JSON.stringify({
        transfer_phrases: ts.transfer_phrases, block_phrases: ts.block_phrases, wait_phrases: ts.wait_phrases,
        on_wait: ts.on_wait, wait_max_seconds: ts.wait_max_seconds, after_wait_strict: ts.after_wait_strict,
    });
    return createHash('sha256').update(body).digest('hex');
}
