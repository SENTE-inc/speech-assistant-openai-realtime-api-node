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
        const triggers = ts && i.is_transfer ? (ts.v2 ? [...ts.handover_phrases, ...ts.transfer_phrases] : ts.transfer_phrases) : i.triggers;
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
    const groups = intents.map((i) => (ts && i.is_transfer ? (ts.v2 ? ts.handover_phrases : ts.transfer_phrases) : i.triggers));
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
    // 版6＝つながない言い回しが相づちにも効く（codex レビュー 9）
    if (ts.v2 && firstMatch(transcript, ts.block_phrases)) return null;
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
        // 版6（DB 142）＝場面ごとの選び方。on_words が空なら v2=false＝段1の on_wait で動く
        v2: !!row.on_words,
        on_words: row.on_words || null,
        on_hold_without_words: row.on_hold_without_words !== false,
        on_handover: row.on_handover !== false,
        hold_music_seconds: row.hold_music_seconds || 4,
        hold_music_record_only: row.hold_music_record_only !== false,
        handover_phrases: row.handover_phrases || [],
    };
}

export function settingsHash(ts) {
    const body = JSON.stringify({
        transfer_phrases: ts.transfer_phrases, block_phrases: ts.block_phrases, wait_phrases: ts.wait_phrases,
        on_wait: ts.on_wait, wait_max_seconds: ts.wait_max_seconds, after_wait_strict: ts.after_wait_strict,
        // 版6の項目は v2 の行だけ hash に入れる（段1の行の hash は変えない）
        ...(ts.v2 ? {
            on_words: ts.on_words, on_hold_without_words: ts.on_hold_without_words, on_handover: ts.on_handover,
            hold_music_seconds: ts.hold_music_seconds, hold_music_record_only: ts.hold_music_record_only,
            handover_phrases: ts.handover_phrases,
        } : {}),
    });
    return createHash('sha256').update(body).digest('hex');
}

// =====================================================================
// 版6（DB 142）＝森さんが場面ごとに選ぶ取次（家＝~/sente/sfav_transfer_tuning_plan.md §3-0・3-1）
// =====================================================================

// 否定（不在・断り・打ち消し）の言葉＝名乗りの最速の道でも、これが一緒にあれば決めない（Haiku に回す）
export const NEGATIVE_RE = /いません|おりません|いない|おらず|不在|外出|席を外|出張|休み|結構|けっこう|お断り|断って|必要(が)?(ありません|ない)|不要|間に合って|いりません|興味(が|は)?(ない|ありません)|受け付けて|ではありません|ではない|じゃない|じゃありません|違います|ちがいます/;
// 質問・受付・第三者の話＝名乗りではない（最速の道に乗せない）
const NOT_SELF_RE = /[?？]|ですか|ますか|でしょうか|ましたか|受付|の者|の方|別の/;

// 担当者本人の言い方（森さんが画面で足す・消す）。「＊」は名前などの1〜8字（「担当の＊です」＝担当の山田です）。
// ＊には「者・人・方・番号」を入れない＝「担当の者は」「代表の番号です」を名乗りにしない
const WILD = '[^、。，．！？!?\\s者人方番号]{1,8}';
function phraseRe(p) {
    const esc = p.split(/[＊*]/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(esc.join(WILD));
}
export function matchPhrases(text, phrases) {
    const hay = text || '';
    for (const p of phrases || []) {
        if (!p) continue;
        if (/[＊*]/.test(p) ? phraseRe(p).test(hay) : hay.includes(p)) return p;
    }
    return null;
}

// 担当者本人の名乗り（版6）＝森さんの言い回しの一覧だけで決める（固定の判定は持たない＝消せば効かなくなる）
export function matchHandover(transcript, ts) {
    return matchPhrases(transcript, ts.handover_phrases);
}

// 本人が名乗った時の最速の道（Haiku を待たない・「はい」も取次の声も流さない＝Tom「早く取り次いで欲しい」）
// 否定・質問・受付や第三者の話・つながない言い回しが一緒にあれば決めない（Haiku に回す＝codex レビュー 2・3）
export function decideFastHandover({ transcript, ts }) {
    if (!ts?.v2 || !ts.on_handover) return null;
    const hit = matchHandover(transcript, ts);
    if (!hit) return null;
    const text = transcript || '';
    if (NEGATIVE_RE.test(text) || NOT_SELF_RE.test(text)) return null;
    if (firstMatch(text, ts.block_phrases)) return null;
    return { step: '2h', action: 'transfer_fast', gate: 'handover', matched: hit };
}

// Haiku の答えの後（v2）。action は decideAfterClassifier と同じ語＋ transfer_fast（声を流さず取次）
//   受付の言葉（待たせる・代わる）＝森さんの on_words：transfer＝すぐつなぐ／hold・wait＝待機（保留音か人を待つ）
export function decideAfterClassifierV2({ transcript, intentName, intentDef, ts, inWait }) {
    if (intentDef?.end_call) return { step: '5', action: 'intent' };
    if (intentDef && !intentDef.is_transfer && intentDef.audio_key
        && !WAITISH_FALLBACK_ACTIONS.has(intentDef.action)) {
        return { step: '6', action: 'answer' };
    }
    const blocked = firstMatch(transcript, ts.block_phrases);
    const handover = matchHandover(transcript, ts);
    void handover;
    // 本人の名乗り（Haiku が transfer の時）＝否定・質問・受付の話が混ざる物は名乗りにしない
    const selfOk = handover && !NEGATIVE_RE.test(transcript || '') && !NOT_SELF_RE.test(transcript || '');
    if (intentDef?.is_transfer && selfOk && !blocked) {
        if (ts.on_handover) return { step: '8h', action: 'transfer_fast', gate: 'handover', matched: handover };
        return { step: '8h', action: inWait ? 'continue_wait' : 'reprompt', gate: 'handover_off', matched: handover };
    }
    // 受付の言葉（待たせる・代わる）
    const waitHit = firstMatch(transcript, ts.wait_phrases);
    const words = !blocked && (intentName === 'wait'
        || (waitHit && (intentDef?.is_transfer || !intentDef || WAITISH_FALLBACK_ACTIONS.has(intentDef.action))));
    if (words) {
        if (ts.on_words === 'transfer') return { step: '7', action: 'transfer', gate: 'words', matched: waitHit };
        return { step: '7', action: inWait ? 'continue_wait' : 'wait_enter', gate: `words_${ts.on_words}`, matched: waitHit };
    }
    // 前向き（「詳しく聞かせてください」等）＝今の関門
    if (intentDef?.is_transfer) {
        const g = transferGate(transcript, ts);
        if (g.pass) return { step: '8', action: 'transfer', gate: g.gate, matched: g.matched };
        return { step: '8', action: inWait ? 'continue_wait' : 'reprompt', gate: g.gate, matched: g.matched };
    }
    if (inWait) return { step: '9', action: 'continue_wait' };
    if (intentDef?.action === 'reprompt') return { step: '9', action: 'reprompt' };
    return { step: '9', action: 'realtime' };
}

// 保留音の候補の文字起こし＝空か音楽の空耳なら「言葉なし」
export const MUSIC_HALLUCINATIONS = [
    'ご視聴ありがとうございました', 'ご清聴ありがとうございました', 'チャンネル登録', '♪', '(音楽)', '（音楽）',
    '[音楽]', '音楽', 'BGM', 'ありがとうございました', 'おやすみなさい',
];
export function isWordless(text) {
    const s = normalizeForTransferGuard(text);
    if (!s) return true;
    return MUSIC_HALLUCINATIONS.some((h) => s === normalizeForTransferGuard(h));
}

// 保留音を検知した時に取次するか（記録だけかは呼び出し側）
//   announced＝受付の言葉を聞いてから待つ上限の内＝on_words が hold の時だけ取次／言葉なし＝on_hold_without_words
export function decideHold({ ts, announced }) {
    if (!ts?.v2) return { transfer: false, reason: 'not_v2' };
    if (announced) return ts.on_words === 'hold'
        ? { transfer: true, reason: 'hold_after_words' }
        : { transfer: false, reason: `words_${ts.on_words}` };
    return ts.on_hold_without_words
        ? { transfer: true, reason: 'hold_without_words' }
        : { transfer: false, reason: 'hold_without_words_off' };
}

