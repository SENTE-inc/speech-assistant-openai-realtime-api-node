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

// Haiku が返してよい intent の名前＝プロンプトに載せた物だけ（監査 Low 6）。
// 台本の call_intents の name ＋ 設定が在る時の wait ＋ プロンプトの判断文が名指しする reprompt／openai_realtime。
export const PROMPT_FALLBACK_INTENTS = ['reprompt', 'openai_realtime'];
export function classifierIntentNames(intents, ts = null) {
    const names = new Set(PROMPT_FALLBACK_INTENTS);
    for (const i of intents || []) if (i?.name) names.add(i.name);
    if (ts) names.add('wait');
    return names;
}

// Haiku の答え（JSON を読んだ物）を、エンジンが使ってよい形に絞る。
// 一覧に無い intent・文字列でない intent は null にする＝呼び手の「知らない intent」の道
// （設定なし＝fallbackToAgent・設定あり＝decideAfterClassifier の intentDef=null）へ行く。
// callback_info は文字列だけ残す（DB にテキストとして書くだけ）。
export function sanitizeClassifierResult(parsed, validNames) {
    const intent = typeof parsed?.intent === 'string' ? parsed.intent.trim() : '';
    const out = {};
    if (typeof parsed?.callback_info === 'string' && parsed.callback_info.trim()) {
        out.callback_info = parsed.callback_info.slice(0, 500);
    }
    if (intent && (!validNames || validNames.has(intent))) {
        out.intent = intent;
    } else {
        out.intent = null;
        out.reason = 'invalid_intent';
        out.raw_intent = String(parsed?.intent ?? '').slice(0, 64);
    }
    return out;
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

// 版7（DB 142）＝森さんは「緩い／ふつう／締める」を1つ選ぶだけ（Tom 2026-10-06「どれくらいの取次か森が編集できるように」）。
//   各段の中身はここ1か所（画面にも DB にも持たない）。家＝~/sente/sfav_transfer_tuning_plan.md の「版7」
//   on_words＝受付が「少々お待ち」「担当に代わります」と言った時：transfer＝すぐつなぐ／hold＝その後の保留音でつなぐ
//   on_hold_without_words＝受付が何も言わずに保留音にした時につなぐか／hold_music_seconds＝保留音とみなす長さ
export const TRANSFER_LEVELS = {
    loose: { on_words: 'transfer', on_hold_without_words: true, hold_music_seconds: 2, after_wait_strict: false },
    normal: { on_words: 'hold', on_hold_without_words: true, hold_music_seconds: 3, after_wait_strict: true },
    strict: { on_words: 'hold', on_hold_without_words: false, hold_music_seconds: 6, after_wait_strict: true },
};
export const LEVEL_PHRASES = {
    handover_phrases: ['私が担当', '担当です', '担当者です', '担当者の＊です', '代わりました', '替わりました', '変わりました', '代表です', '私が代表', '社長です', '店長です', '責任者です', '本人です', '私で大丈夫', '担当の＊です', '代表の＊です', '社長の＊です', '店長の＊です', '責任者の＊です', 'オーナーの＊です'],
    transfer_phrases: ['詳しく聞かせて', '詳しく聞きたい', '興味があります', '興味あります', '聞かせてください'],
    wait_phrases: ['少々お待ち', 'お待ちください', 'お待ちいただけ', 'ちょっと待って', '確認します', '呼んできます', '今呼びます', '呼びますので', '担当に代わ', '担当者に代わ', 'お繋ぎ', 'おつなぎ', '代わります', '替わります', '変わります'],
    block_phrases: ['代わりに伝え', '代わりに承', '代わりにご用件', '代わりにお伺い', '代わりにお聞き'],
    // 本人の確かめ句＝Haiku が transfer と言った時だけ、関門（step 8s）で取次の裏付けにする。句だけでは取次にしない＝最速の道（handover_phrases）には入れない。
    // 版6で名乗り（最速）と前向きに割った時、旧関門の「私です」等の確かめが消えた＝それを戻す（2026-10-10 SF の録音 465本の流し直し＝~/sente/sfav_transfer_tuning_plan.md「版7.1」）
    self_confirm_phrases: ['私です', '私でございます', 'わたくしでございます', '私になります', '私でいい', '私で大丈夫', '僕で大丈夫', '私が担当', '私担当'],
};

export function normalizeSettings(row) {
    if (!row) return null;
    const base = {
        id: row.id,
        scope: row.project_id ? 'project' : 'tenant',
        version: row.version,
        wait_max_seconds: row.wait_max_seconds || 90,
    };
    const preset = TRANSFER_LEVELS[row.level];
    if (preset) {
        return {
            ...base,
            level: row.level,
            v2: true,
            on_wait: 'transfer',
            on_handover: true,
            hold_music_record_only: false,
            ...LEVEL_PHRASES,
            ...preset,
        };
    }
    // level が空の行＝段1（DB 140）の on_wait で動く（戻し口）
    return {
        ...base,
        transfer_phrases: row.transfer_phrases || [],
        block_phrases: row.block_phrases || [],
        wait_phrases: row.wait_phrases || [],
        on_wait: row.on_wait,
        after_wait_strict: !!row.after_wait_strict,
        v2: false,
    };
}

export function settingsHash(ts) {
    const body = JSON.stringify({
        transfer_phrases: ts.transfer_phrases, block_phrases: ts.block_phrases, wait_phrases: ts.wait_phrases,
        on_wait: ts.on_wait, wait_max_seconds: ts.wait_max_seconds, after_wait_strict: ts.after_wait_strict,
        // 版7の項目は v2 の行だけ hash に入れる（段1の行の hash は変えない）
        ...(ts.v2 ? {
            level: ts.level, on_words: ts.on_words, on_hold_without_words: ts.on_hold_without_words, on_handover: ts.on_handover,
            hold_music_seconds: ts.hold_music_seconds, hold_music_record_only: ts.hold_music_record_only,
            handover_phrases: ts.handover_phrases, self_confirm_phrases: ts.self_confirm_phrases,
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

// 確かめ句を本人の名乗りとして使わない時＝①受付・第三者の語 ②代わりに受ける・呼ぶ・伝える説明（「担当を呼ぶのは私ですけど」「私ですが、担当へ伝えます」）
//   ③句を含む節が疑問形（「私でいいですか」「私が担当なんですか」「私です？」「私でいいのか判断がつきますか」）。
//   節＝句の後ろから、次の区切り（、。！!？? の手前・「けど／けれど」の手前・「です／ます／ございます／だ」の直後の「が」の手前）まで。
//   句がどこか1か所でも疑問形なら使わない（安全側）。「私ですけど、どういったご用件でしょうか」「僕で大丈夫ですがどういったご用件ですか」＝使う
const SELF_CONFIRM_NOT_SELF_RE = /受付|の者|別の|呼ぶ|呼び|呼んで|伝え|取り次|取次|おつなぎ|お繋ぎ|代わりに|かわりに/;
const SELF_CONFIRM_CLAUSE_END_RE = /けれど|けど|(?:^|です|ます|ございます|だ)が|[、。，．！!？?]/;
export function isSelfConfirmQuestion(transcript, phrases) {
    const t = String(transcript || '').replace(/\s+/g, ' ');
    if (SELF_CONFIRM_NOT_SELF_RE.test(t)) return true;
    for (const p of [].concat(phrases || [])) {
        if (!p) continue;
        for (let i = t.indexOf(p); i >= 0; i = t.indexOf(p, i + 1)) {
            const rest = t.slice(i + p.length);
            const m = SELF_CONFIRM_CLAUSE_END_RE.exec(rest);
            const clause = m ? rest.slice(0, m.index + (m[0].endsWith('が') ? m[0].length - 1 : 0)) : rest;
            const end = m ? m[0] : '';
            if (/[？?]/.test(end) || /か\s*$/.test(clause)) return true;
        }
    }
    return false;
}

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
    // 本人の確かめ句（Haiku が transfer の時だけ）＝否定・つながない句・句を含む節の疑問形（「私ですか」「私でいいですか」）・受付や第三者の語があれば使わない。
    //   4字未満の規則（transferGate）より先に見る＝「私です」は3字。名乗りの後に用件を聞く「私ですけど、どういったご用件でしょうか」は通す
    if (intentDef?.is_transfer && !blocked) {
        const sc = matchPhrases(transcript, ts.self_confirm_phrases);
        if (sc && !NEGATIVE_RE.test(transcript || '') && !isSelfConfirmQuestion(transcript, ts.self_confirm_phrases)) {
            return { step: '8s', action: 'transfer', gate: 'self_confirm', matched: sc };
        }
    }
    // 前向き（「詳しく聞かせてください」等）＝今の関門
    if (intentDef?.is_transfer) {
        const g = transferGate(transcript, ts);
        if (g.pass) return { step: '8', action: 'transfer', gate: g.gate, matched: g.matched };
        return { step: '8', action: inWait ? 'continue_wait' : 'reprompt', gate: g.gate, matched: g.matched };
    }
    if (inWait) {
        // ⑥ 版7.2＝待機中の答えの無い質問は CM へ（Haiku が否定・質問の答え・待たせるを返した物は上で決まっている）
        if (isUnansweredQuestionInWait(transcript)) return { step: '9q', action: 'realtime', gate: 'question_in_wait' };
        return { step: '9', action: 'continue_wait' };
    }
    // ⑦ 版7.2＝あいさつ・お礼・相づちだけ＝CM へつながず、つなぎの「はい」を返して続きを聞く
    if (isCourtesyOnly(transcript)) return { step: '9c', action: 'listen', gate: 'courtesy' };
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


// =====================================================================
// 2026-10-08 森さんの FB（家＝~/sente/sente_aivoice_canonical.md §3「📐 実装の計画 v3」）
// =====================================================================

// 句読点・空白・伸ばし棒を除いた形（判定用）
const stripForJudge = (s) => String(s || '').replace(/[\s、。，．,.！!・…「」『』（）()〜~ー]/g, '');
const hasQuestionMark = (s) => /[?？]/.test(String(s || ''));

// つなぎ言葉だけ（「あのー」「えっと」）＝これには返さず続きを聞く。「ええ」は肯定なので外す
const FILLER_WORDS_RE = /^(?:あのう?|ええ?っと|ええ?と|えっとですね|あのですね|え|あ|その|まあ|ん|んと|うんと)+$/;
export function isFillerWordsOnly(transcript) {
    const n = stripForJudge(transcript).replace(/[?？]/g, '');
    if (!n || n === 'ええ' || hasQuestionMark(transcript)) return false;
    return FILLER_WORDS_RE.test(n);
}

// 言いかけ（文が終わっていない）＝助詞・接続で終わる／「〜の者」「〜のもの」「〜の方」で終わり「です・ます」が無い。
// 問いかけ（？付き）は言いかけにしない（「社長は？」に1.5秒待たない）
const INCOMPLETE_TAIL_RE = /(?:の|が|は|を|に|て|で|と|けど|けれど|から|ので|って|の者|のもの|の方)$/;
export function isIncompleteUtterance(transcript) {
    if (hasQuestionMark(transcript)) return false;
    if (isFillerWordsOnly(transcript)) return true;
    const n = stripForJudge(transcript);
    if (n.length < 2) return false;
    return INCOMPLETE_TAIL_RE.test(n);
}

// 「もう一度」（何をかを言っていない物だけ）＝直前の返答を流し直す。「御社名をもう一度」は AI へ（社名の答えがある）
const REPEAT_RE = /もう(?:一|いち)度|もう(?:一|いっ)回|もういっぺん|聞こえ(?:ませ|な|づら|にく)|聞き取れ|(?:なんて|何て)(?:おっしゃ|言)/;
const REPEAT_TARGET_RE = /社名|会社|御社|名前|お名|用件|要件|ご用|番号|部署|どちら|どなた|何の/;
export function isRepeatRequest(transcript) {
    const t = String(transcript || '');
    return REPEAT_RE.test(t) && !REPEAT_TARGET_RE.test(t);
}

// ---------------------------------------------------------------------
// 戻り時間（JST）＝相手の言葉から再コールの日時を作る。読めなければ null
// ---------------------------------------------------------------------
const KANJI_NUM = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiToNumber(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (!/^[〇零一二三四五六七八九十]+$/.test(s)) return NaN;
    if (!s.includes('十')) return [...s].reduce((n, c) => n * 10 + KANJI_NUM[c], 0);
    const [a, b] = s.split('十');
    return (a ? KANJI_NUM[a] : 1) * 10 + (b ? KANJI_NUM[b] : 0);
}
const toHalfWidth = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const NUM = '(\\d{1,2}|[〇零一二三四五六七八九十]{1,3})';
// 否定・都合が悪い＝この区切りの時刻は採らない
const RECALL_NEG_RE = /休み|不在|外出|戻ってきませ|戻ってこな|戻れな|いらっしゃらな|はちょっと|ちょっと(?:難|無理|厳|都合)|戻らな|戻りませ|戻ってこな|いな(?:い|く)|いませ|おりませ|おらず|困|難し|無理|だめ|ダメ|厳し|都合が悪|分から|わから|未定|不明/;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// JST の暦（年・月・日・曜日・時・分）を now から作る
function jstParts(now) {
    const d = new Date(now.getTime() + 9 * 3600 * 1000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
// JST の (年, 月, 日+dayOffset, 時, 分) → UTC の Date
function jstDate(p, dayOffset, h, mi) {
    return new Date(Date.UTC(p.y, p.m, p.d + dayOffset, h - 9, mi));
}

function parseSegment(seg, now, ctx = {}) {
    const p = jstParts(now);
    // 相対（◯分後・◯時間後・◯分ほどで）
    let m = seg.match(new RegExp(`${NUM}分(?:後|ほど|くらい|ぐらい|程|ちょっと|で)`));
    if (m && !new RegExp(`${NUM}時${NUM}分`).test(seg)) {
        const n = kanjiToNumber(m[1]);
        if (n > 0 && n <= 180) return new Date(now.getTime() + n * 60000);
    }
    m = seg.match(new RegExp(`${NUM}時間(?:後|ほど|くらい|ぐらい|程)`));
    if (m) {
        const n = kanjiToNumber(m[1]);
        if (n > 0 && n <= 12) return new Date(now.getTime() + n * 3600000);
    }
    // 日
    let day = null;
    if (/明後日|あさって/.test(seg)) day = 2;
    else if (/明日|あした|あす/.test(seg)) day = 1;
    else if (/今日|本日|きょう/.test(seg)) day = 0;
    else {
        const w = seg.match(/([日月火水木金土])曜/);
        if (w) {
            const target = WEEKDAYS.indexOf(w[1]);
            if (/来週/.test(seg)) {
                const toNextMon = ((8 - p.wd) % 7) || 7; // 来週の月曜まで
                day = toNextMon + ((target + 6) % 7);
            } else {
                day = ((target - p.wd + 7) % 7) || 7; // 今日と同じ曜日＝来週
            }
        }
    }
    // 時刻
    let h = null, mi = 0;
    m = seg.match(new RegExp(`${NUM}時(?:(半)|${NUM}分)?`));
    if (m) {
        h = kanjiToNumber(m[1]);
        if (m[2]) mi = 30;
        else if (m[3]) mi = kanjiToNumber(m[3]);
        if (Number.isNaN(h) || h > 23 || Number.isNaN(mi) || mi > 59) return null;
        if ((/午後|夕方|夜/.test(seg) || (ctx.pm && !/午前|朝/.test(seg))) && h < 12) h += 12;
        else if (!/午前|朝/.test(seg) && h >= 1 && h <= 7) h += 12; // 「3時」＝営業の時間なら15時
    } else if (/夕方/.test(seg)) h = 17;
    else if (/お昼|昼(?:頃|ごろ|過ぎ|すぎ|には|に)/.test(seg)) h = 13;
    else if (/午後/.test(seg)) h = 13;
    else if (/午前中|朝/.test(seg)) h = 10;
    if (day == null && ctx.day != null && h != null) day = ctx.day; // 「明日、16時に」＝前の区切りの日を引き継ぐ
    if (h == null && day == null) return null;
    if (h == null) h = 10;
    if (day != null) return jstDate(p, day, h, mi);
    // 日を言っていない＝今日のその時刻（過ぎていれば明日）
    const today = jstDate(p, 0, h, mi);
    return today.getTime() > now.getTime() ? today : jstDate(p, 1, h, mi);
}

// 区切り（句読点・逆接・「ではなく」）ごとに読み、否定の付かない区切りのうち最後に読めた日時を採る。
//   前の区切りで言った日（明日・明後日・曜日）と午後は、後ろの時刻へ引き継ぐ（「明日、16時に戻ります」＝明日16時）
const RECALL_SPLIT_RE = /[、。，．,.！!？?]|けど|けれど|ではなく|じゃなくて|じゃなく|ですが|ますが/;
function dayOf(seg, now) {
    const d = parseSegment(seg.replace(/\d|[〇零一二三四五六七八九十]+時|時/g, ''), now);
    return d ? Math.round((Date.UTC(...jstYmd(d)) - Date.UTC(...jstYmd(now))) / 86400000) : null;
}
function jstYmd(d) { const p = jstParts(d); return [p.y, p.m, p.d]; }
export function recallCandidates(text, now = new Date()) {
    const segs = toHalfWidth(text).split(RECALL_SPLIT_RE).map((x) => x.trim()).filter(Boolean);
    const out = [];
    const ctx = {};
    for (const seg of segs) {
        if (RECALL_NEG_RE.test(seg)) continue;
        const at = parseSegment(seg, now, ctx);
        if (/明後日|あさって|明日|あした|あす|今日|本日|きょう|曜/.test(seg)) ctx.day = dayOf(seg, now);
        if (/午後|夕方/.test(seg)) ctx.pm = true;
        if (at) out.push({ at, seg });
    }
    return out;
}
export function parseRecallAt(text, now = new Date()) {
    const c = recallCandidates(text, now);
    return c.length ? c[c.length - 1].at : null;
}

// 不在の段の答え（AI を待たない）
//   asked（戻りの時間を聞いた）→ reject／time（recallAt）／unknown
//   proposed（「明日の午後は」と出した）→ yes（recallAt＝言われた別の日時か明日13:00）／no
const ABSENT_REJECT_RE = /結構|必要(?:が)?(?:ありません|ない)|いりません|要りません|お断り|断って|興味(?:が|は)?(?:ない|ありません)|間に合って|かけてこない|電話しないで/;
const ABSENT_UNKNOWN_RE = /分から|わから|わかんな|未定|不明|決まって(?:い)?な|何とも|なんとも|聞いてな|把握/;
const ABSENT_NO_RE = /ちょっと|いや|不在|外出|戻ってきませ|戻ってこな|いえ|難し|厳し|無理|だめ|ダメ|困|都合が悪|いな(?:い|く)|いませ|おりませ|休み|戻らな|分から|わから/;
const ABSENT_AFFIRM_SEG_RE = /なら|大丈夫|いい|構いません|かまいません|お願い|空いて/;
const ABSENT_YES_RE = /はい|ええ|大丈夫|いいですよ|構いません|かまいません|お願いします|どうぞ|了解|承知|わかりました|分かりました|オッケー|OK|ok/;
export function classifyAbsentReply(transcript, stage, now = new Date()) {
    const t = String(transcript || '');
    if (ABSENT_REJECT_RE.test(t)) return { kind: 'reject' };
    if (stage === 'asked') {
        if (ABSENT_UNKNOWN_RE.test(t)) return { kind: 'unknown' };
        const at = parseRecallAt(t, now);
        return at ? { kind: 'time', recallAt: at } : { kind: 'unknown' };
    }
    // proposed＝読めた日時の区切りごとに、その日時への肯定かを見る（「はい、明後日なら大丈夫です」＝明後日・
    //   「明日の午後ですか、分かりません」「明日は休みです」＝了承ではない）
    const neg = ABSENT_NO_RE.test(t);
    const cands = recallCandidates(t, now).filter((c) => !/ですか|ますか|でしょうか/.test(c.seg));
    const affirmed = cands.filter((c) => !neg || ABSENT_AFFIRM_SEG_RE.test(c.seg));
    if (affirmed.length) return { kind: 'yes', recallAt: affirmed[affirmed.length - 1].at };
    if (neg || /ですか|ますか|でしょうか|[?？]/.test(t)) return { kind: 'no' };
    if (ABSENT_YES_RE.test(t)) return { kind: 'yes', recallAt: parseRecallAt('明日の午後', now) };
    return { kind: 'no' };
}

// apply_call_outcome に渡す再コールの間隔（DB の now()＋この間隔）。決めた日時が無い・過ぎた時は既定
export function retryIntervalFor(recallAtIso, now = new Date(), defaultHours = 24) {
    const at = recallAtIso ? Date.parse(recallAtIso) : NaN;
    if (!Number.isFinite(at)) return `${defaultHours} hours`;
    const sec = Math.round((at - now.getTime()) / 1000);
    if (sec <= 0) return `${defaultHours} hours`;
    return `${sec} seconds`;
}

// =====================================================================
// 版7.2（2026-10-10）＝受付からの質問の取りこぼし（家＝~/sente/sfav_transfer_tuning_plan.md「版7.2」）
// =====================================================================

// step 3q＝社名・名前・宛先・用件を「頼む語」つきで明示に聞かれたら、Haiku を待たずにその答えを流す。
//   断り・不在・名乗り・確かめ句・つながない句・番号や部署の質問・複数の対象が混ざる発言は決めない（Haiku へ）。
//   同じ発言に待たせる言い回しが在れば、段ごとに答えの後を決める＝緩い（on_words=transfer）は取次／ふつう・締めるは待機。
//   呼び手は、返した intent の声が再生できる時だけ使う（声の無い声セットは Haiku の道へ）。
const ASK_RE = /よろし|お聞き|お聞かせ|お伺い|伺|教え|ですか|でしょうか|ますか|お願い|いただ|頂|ちょうだい|頂戴|もう(?:一|いち)度|もう(?:一|いっ)回|もういっぺん/;
const ASK_ADDRESSEE_RE = /担当(?:者)?(?:の方)?の(?:お)?名前|どなた(?:様)?(?:宛|あて|に|を)|誰(?:宛|あて)|宛(?:先|名)|どちら様(?:宛|あて)|どの者|どなたをお呼び/;
const ASK_COMPANY_RE = /社名|会社名|御社名|会社(?:の)?(?:お)?名前|お名前|名前|どちら様|どなた|どちらの会社|どこの会社|お名乗り/;
const ASK_REASON_RE = /ご?用件|要件|ご用|どういった(?:お|ご)?(?:話|内容|件)|どのような(?:お|ご)?(?:話|内容|件)/;
const ASK_HAIKU_RE = /番号|部署|メール|住所|ファックス|FAX|何時|いつ/;
// 自動音声の案内（録音のお知らせ・番号の案内）＝人の質問ではない
const IVR_RE = /録音(?:させて|して|され|いた|を)|番を押|プッシュ|ガイダンス|ただいま電話に出ること/;
// 3q で答えない＝既に聞いた・承った（「ご用件は伺っております」）／漢字・読み方・綴り（名乗りの声では答えられない）
const ASK_NOT_QUESTION_RE = /(?:伺|聞い|お聞きし|承)って(?:おり|い|ます)|漢字|読み|字は|綴り|スペル/;
// 3q の「待たせる言葉」＝段の wait_phrases に加えて丁寧形（「確認いたします」「確認してまいります」）も拾う（段の言い回しとプロンプトは変えない）
const ASK_WAIT_EXTRA_RE = /確認(?:いた|致)します|確認してまいります|確認して参ります|お調べします|お調べいたします/;
// お詫び（「すいません」の中の「いません」）を否定に数えない＝新しい規則だけ（既存の NEGATIVE_RE の使い手は変えない）
const APOLOGY_RE = /す[いみ]ません|申し訳(?:ござい|あり)ません|恐れ入ります/g;
const negativeIgnoringApology = (t) => NEGATIVE_RE.test(String(t || '').replace(APOLOGY_RE, ''));
export function decideAskedQuestion({ transcript, ts }) {
    if (!ts?.v2) return null;
    const t = String(transcript || '');
    if (!ASK_RE.test(t)) return null;
    if (negativeIgnoringApology(t) || ASK_HAIKU_RE.test(t) || IVR_RE.test(t) || ASK_NOT_QUESTION_RE.test(t)) return null;
    if (firstMatch(t, ts.block_phrases) || matchHandover(t, ts) || matchPhrases(t, ts.self_confirm_phrases)) return null;
    // 聞かれた物＝頼む語と同じ文（。！？で区切った1文）の中に在る対象だけ数える。宛先の語を抜いた残りでこちらの社名・名前を見る（「お名前と担当者のお名前」＝2つ＝Haiku へ）
    const hits = new Set();
    for (const sent of t.split(/[。！!？?]/)) {
        if (!sent || !ASK_RE.test(sent)) continue;
        if (ASK_ADDRESSEE_RE.test(sent)) hits.add('addressee');
        if (ASK_COMPANY_RE.test(sent.replace(new RegExp(ASK_ADDRESSEE_RE.source, 'g'), ''))) hits.add('company');
        if (ASK_REASON_RE.test(sent)) hits.add('reason');
    }
    if (hits.size !== 1) return null;
    const [intent] = hits;
    const waitHit = firstMatch(t, ts.wait_phrases) || (t.match(ASK_WAIT_EXTRA_RE) || [])[0] || null;
    if (!waitHit) return { step: '3q', action: 'answer', intent, gate: 'asked', matched: null };
    return ts.on_words === 'transfer'
        ? { step: '3q', action: 'answer_then_transfer', intent, gate: 'words_asked', matched: waitHit }
        : { step: '3q', action: 'answer_then_wait', intent, gate: 'words_asked', matched: waitHit };
}

// ⑥ 待機中に答えの無い質問をされた（Haiku が聞き返し・自由会話・未知）＝黙らず CM へ（待機の外の「答えられない→CM」と揃える）。
//   質問の形・4字以上・否定の語なし・保留音の空耳でない時だけ（2026-10-10 Tom「繋いじゃおう」）
const QUESTION_FORM_RE = /[？?]|か[。\s]*$|でしょうか|ですか|ますか/;
export function isUnansweredQuestionInWait(transcript) {
    const t = String(transcript || '');
    // 否定の語が在っても CM へ＝Haiku が不在・断りと取れなかった問いかけ（「担当は席を外していますが、いかがいたしましょうか」）は CM が受ける（Tom「繋いじゃおう」・監査 2026-10-10）
    return QUESTION_FORM_RE.test(t) && normalizeForTransferGuard(t).length >= 4 && !isWordless(t);
}

// ⑦ 版7.2＝あいさつ・お礼・相づちだけの発言（「お世話になっております」「ありがとうございます」「かしこまりました」）で CM へつながない。
//   Haiku が自由会話・聞き返し・未知を返した時だけ使う（待機の外）＝つなぎの「はい」を返して続きを聞く（action='listen'）。
//   2026-10-06 の試しの架電で「ありがとうございます。」が2回とも CM へ（call_turn_decisions）・録音の流し直しで「答えが無い→CM」157件のうち72件
const COURTESY_RE = /(?:いつも)?(?:大変)?(?:お)?世話に(?:なって)?(?:おります|います|なっております|なっています|なります|なりました)|お久しぶり(?:です|になります|でございます)|そうですね|なるほど|分かります|わかります|お世話様です|(?:お電話)?(?:誠に|どうも)?ありがとうございます|ありがとうございました|お疲れ様です|お疲れさまです|おつかれさまです|おはようございます|こんにちは|こんばんは|よろしくお願い(?:いた|致)?します|よろしくお願いします|失礼(?:いた|致)?します|かしこまりました|承知(?:いた|致)?しました|承知しました|わかりました|分かりました|恐れ入ります|どうも|はいはい|はい|ええ|ああ|あ|えっと|あの|うん/g;
export function isCourtesyOnly(transcript) {
    const raw = String(transcript || '');
    if (/[？?]/.test(raw)) return false; // 「はい？」「あ？」＝聞き返し＝相づちでない
    // 録音のお知らせ（「この通話は品質向上のため録音させていただきます」）＝この後に人が出る＝お知らせの文を除いた残りが空かあいさつだけなら聞き続ける。
    //   番号を選ぶ案内（CM が番号を押す）・問いかけ（「録音してもよろしいでしょうか」）が在れば使わない（監査 2026-10-10）
    if (RECORDING_NOTICE_RE.test(raw)) {
        if (IVR_MENU_RE.test(raw) || /でしょうか|ですか|ますか|よろしい/.test(raw)) return false;
        const rest = raw.split(/[。！!\n]/).filter((sent) => !RECORDING_NOTICE_RE.test(sent)).join('');
        const r = normalizeForTransferGuard(rest);
        return !r || r.replace(COURTESY_RE, '').length === 0;
    }
    const t = normalizeForTransferGuard(raw);
    if (!t) return false;
    return t.replace(COURTESY_RE, '').length === 0;
}

// 録音のお知らせ（人が出る前に流れる）と、番号を選ぶ案内（CM が番号を押して進める＝録音 465本で人の CM が番号を押して本人まで行った通話が 11）を分ける（2026-10-10）
const RECORDING_NOTICE_RE = /録音させて(?:いただ|頂)|録音いたし|録音しており|録音しています|録音します|録音されます|通話内容を録音/;
const IVR_MENU_RE = /番号|ボタン|プッシュ|ダイヤル|メニュー|お選びください|ガイダンスに従|音声案内|[0-9０-９一二三四五六七八九十]\s*(?:番)?\s*を\s*(?:押|選)|番を押/;

// 相づちの言葉（2026-10-11 Tom「〜ですか？→ありがとうございます／〜です→承知しました！かしこまりました！／はいは得意じゃなさそう／全部相槌ってよりかは返事って感じ」）
//   返す値＝'thanks'（問いかけ・相づちだけの返事「はい」「そうです」）｜'ack'（それ以外＝〜です・お願いします・不在・断り）｜'none'（言葉が無い・つなぎ言葉・「もしもし」だけ）。
//   声セットに3本が揃わなければ呼び出し側で今までどおり「はい」（肉声の声セット）
const AIZUCHI_QUESTION_RE = /[?？]|か[。\s]*$|ですか|ますか|でしょうか|ましたか|(?:何|なん)でしょう|どちら様|どなた|どういった|どのような|いかが|何の|なんの|ません[かけ]/;
const AIZUCHI_YES_ONLY_RE = /^(?:はい|ええ|うん|はいはい|そうですね|そうです|なるほど|どうも|承知(?:いた|致)?しました|わかりました|分かりました|かしこまりました)+$/;
const AIZUCHI_FILLER_ONLY_RE = /^(?:あ|ああ|えっと|えー|あの|あのー|もしもし)+$/;
export function chooseAizuchi(transcript) {
    const raw = String(transcript || '');
    if (!normalizeForTransferGuard(raw)) return 'none';
    const bare = stripForJudge(raw);
    if (!bare || AIZUCHI_FILLER_ONLY_RE.test(bare) || isFillerWordsOnly(raw)) return 'none'; // 「えー」「ええと」も（codex 監査）
    if (AIZUCHI_YES_ONLY_RE.test(bare)) return 'thanks';
    if (isCourtesyOnly(raw)) return 'thanks'; // あいさつ・お礼だけ（「お世話になっております」）に「承知しました」は合わない
    if (AIZUCHI_QUESTION_RE.test(raw)) return 'thanks';
    return 'ack';
}

// 相づちの音（ElevenLabs の声で作る）。ack は2本を交互に使う
//   tts＝ElevenLabs に渡す文（読み方の指定つき）。text は画面と DB の文。
//   ⚠ 本番は eleven_v4（Railway の env）＝見本も v4 で作る。v3 は指定つきの「承知」を中国語読み（チョンジ）にし、ひらがなで渡すと「招致」の高低（しょ↘うち）になる（Tom が聞き分けた・2026-10-11）＝v4・漢字で渡す。
//   ⚠ 1回ごとに読み方が揺れる＝Tom が聞いて選んだテイクを、このファイル名で先に置く（エンジンはファイル名が合えば作り直さない）
export const AIZUCHI_CLIPS = [
    // 3本とも「明るく」の指定を外す（2026-10-11 Tom「かしこまりましたと承知しましただけやたら元気で温度感が変」「ありがとうございます！！だけバカに明るいやつ残ってるよ」＝周りの台本と揃える）
    { key: 'aizuchi_thanks', text: 'ありがとうございます！', tts: 'ありがとうございます！', kind: 'thanks' },
    { key: 'aizuchi_shouchi', text: '承知しました！', tts: '承知しました！', kind: 'ack' },
    { key: 'aizuchi_kashikomari', text: 'かしこまりました！', tts: 'かしこまりました！', kind: 'ack' },
];
// 相づちの音のファイル名は読み方の指定も含める（指定を変えたら作り直す）
export const aizuchiFilename = (a, voiceId) => thanksClipFilename(a.key, `${a.text}\n${a.tts}`, voiceId);
const AIZUCHI_KEYS = new Set(AIZUCHI_CLIPS.map((c) => c.key));
// 台本の頭が相づちと同じ言葉＝同じ発話で相づちを言った直後は頭を落とした方（<key>__rest）を流す（二重に言わない）
const AIZUCHI_PREFIX = [
    { kind: 'thanks', re: /^ありがとうございます[。、！!]?\s*/ },
    { kind: 'ack', re: /^(?:承知(?:いた|致)?しました|かしこまりました)[。、！!]?\s*/ },
];
// 名乗りの1本に名前まで入っている（「…の森と申します。」）＝後ろに CM の名前をつながない
//   （2026-10-11 Tom「セールスフォージの森です 川上です」＝録音の名乗りに名前が入った声セットで二重に名乗った）
export function leadNamesItself(text) {
    return /(?:と申します|でございます)[。！!]?\s*$/.test(String(text || '').trim());
}

// 戻りの時間が分かった（callback_scheduled）＝もう一度時間を聞かず「そのお時間に改めて」で受ける
//   （2026-10-11 Tom「最後にいつ担当者がいるか2回聞かれた」＝既定の意図の声が callback_request のままだった）
export function intentClipKey(intent, hasClip) {
    if (intent?.name === 'callback_scheduled' && hasClip('absent_time_ack')) return 'absent_time_ack';
    return intent?.audio_key || null;
}

export function aizuchiPrefixOf(text) {
    const t = String(text || '');
    for (const p of AIZUCHI_PREFIX) if (p.re.test(t)) return { kind: p.kind, rest: t.replace(p.re, '') };
    return null;
}
export const restKeyOf = (key) => `${key}__rest`;
// 作った音のファイル名＝文と声で決まる（文か声が変わったら別の名前＝作り直しの印）
export function thanksClipFilename(key, text, voiceId) {
    return `t_${key}_${createHash('sha256').update(`${voiceId}\n${text}`).digest('hex').slice(0, 8)}.mp3`;
}
export function aizuchiTargets(clips) {
    return [...clips.values()].filter((c) => !AIZUCHI_KEYS.has(c.key) && !c.key.endsWith('__rest') && aizuchiPrefixOf(c.text) != null);
}
// 使えるか＝相づち3本・対象の台本・作った音の全部が ElevenLabs の声で、作った音が今の文と声の物（肉声・別の声と混ぜない＝監査 2026-10-10）
//   返す値＝{ aizuchi: { thanks, ack: [..] } | null, aizuchiRest: Map(台本の key → { kind, restKey｜'' }) }
export function aizuchiConfig(clips, voiceId) {
    const off = { aizuchi: null, aizuchiRest: new Map() };
    const el = (c) => c?.source === 'elevenlabs';
    const made = (c, text) => el(c) && c.audio_ready === true && c.text === text && c.filename === thanksClipFilename(c.key, text, voiceId);
    const madeAizuchi = (a) => { const c = clips.get(a.key); return el(c) && c.audio_ready === true && c.text === a.text && c.filename === aizuchiFilename(a, voiceId); };
    if (!voiceId || !AIZUCHI_CLIPS.every(madeAizuchi)) return off;
    const fillers = [...clips.values()].filter((c) => c.clip_type === 'filler');
    if (!fillers.length || !fillers.every(el)) return off;
    const map = new Map();
    for (const c of aizuchiTargets(clips)) {
        if (!el(c) || c.audio_ready !== true) return off;
        const { kind, rest } = aizuchiPrefixOf(c.text);
        if (!rest.trim()) { map.set(c.key, { kind, restKey: '' }); continue; }
        if (!made(clips.get(restKeyOf(c.key)), rest)) return off;
        map.set(c.key, { kind, restKey: restKeyOf(c.key) });
    }
    return {
        aizuchi: { thanks: 'aizuchi_thanks', ack: AIZUCHI_CLIPS.filter((a) => a.kind === 'ack').map((a) => a.key) },
        aizuchiRest: map,
    };
}
export const isAizuchiKey = (key) => AIZUCHI_KEYS.has(key);

// 電話を取った瞬間の「ププッ」（試しの架電の録音10本すべての相手側の頭に在る 約440Hz・0.05秒×2）を見分ける。
//   samples＝8kHz の PCM（声の線を越えた枠だけ）。400〜500Hz の1本の音にエネルギーが集まっている割合（0〜1）を返す（録音のププッ 0.88・「はい」0.11）。
//   声（「はい」）は倍音と子音で広がる＝低い／ププッは澄んだ音＝1 に近い
export function pickupBeepToneRatio(samples, sampleRate = 8000) {
    // 20ms ごとに測って音の大きさで重みをつけて平均する（2回の「プッ」の間で波がずれても下がらない）
    const F = 160;
    let num = 0, den = 0;
    for (let off = 0; off + F <= samples.length; off += F) {
        let total = 0;
        for (let i = off; i < off + F; i++) total += samples[i] * samples[i];
        if (total === 0) continue;
        let best = 0;
        for (let hz = 400; hz <= 500; hz += 10) {
            const w = (2 * Math.PI * hz) / sampleRate;
            const c = 2 * Math.cos(w);
            let s1 = 0, s2 = 0;
            for (let i = off; i < off + F; i++) { const s0 = samples[i] + c * s1 - s2; s2 = s1; s1 = s0; }
            best = Math.max(best, s1 * s1 + s2 * s2 - c * s1 * s2); // |X(hz)|^2
        }
        // 純音なら 2·|X|^2/(F·total) ≈ 1
        num += Math.min(1, (2 * best) / (F * total)) * total;
        den += total;
    }
    return den ? num / den : 0;
}
