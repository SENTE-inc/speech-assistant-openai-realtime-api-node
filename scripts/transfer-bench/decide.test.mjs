// 取次の判定の試験（モデルは呼ばない＝Haiku の答えを固定して、その後の判定を見る）。
// 走らせ方＝`node --test scripts/transfer-bench/`（失敗すれば非ゼロで終わる）。
// 家＝~/sente/sfav_transfer_tuning_plan.md §1-f・1-i。
// 例ごとに「最終の動作」を決める（取次か待機なら合格、にしない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decideBeforeClassifier, decideAfterClassifier, hasSufficientTransferEvidence,
    buildClassifierPrompt, buildTranscriptionPrompt, settingsHash,
} from '../../transfer-logic.js';
import { INTENT_BY_NAME, INTENTS, SF_DEFAULT } from './fixtures.mjs';

const decide = (transcript, haiku, { ts = SF_DEFAULT, inWait = false } = {}) => {
    const pre = decideBeforeClassifier({ transcript, ts, inWait });
    if (pre) return pre.action;
    return decideAfterClassifier({
        transcript, intentName: haiku, intentDef: INTENT_BY_NAME.get(haiku) || null, ts, inWait,
    }).action;
};

// [発話, Haiku の答え, 待機の外での最終の動作（on_wait=wait）]
// intent＝その意図の声を流して切る（否定）／answer＝答えて聞く
const OUTSIDE_WAIT = [
    // 本人・取次の明言 → 取次
    ['担当者に代わります。', 'transfer', 'transfer'],
    ['はい、今変わります。', 'transfer', 'transfer'],
    ['担当の者にお繋ぎいたします。', 'transfer', 'transfer'],
    ['私が担当ですが。', 'transfer', 'transfer'],
    ['はい、私が代表の山田です。', 'transfer', 'transfer'],
    ['責任者の佐藤に代わりますね。', 'transfer', 'transfer'],
    ['社長ですけど、どういったお話ですか。', 'transfer', 'transfer'],
    ['あ、私で大丈夫ですよ。お伺いします。', 'transfer', 'transfer'],
    ['店長の田中ですが。', 'transfer', 'transfer'],
    ['はい、お電話代わりました、山田です。', 'transfer', 'transfer'],
    ['あーはいはい、じゃあ代わりますね。', 'transfer', 'transfer'],
    // これから呼ぶ・待たせる → 待機（Haiku が transfer でも wait でも、迷って realtime でも）
    ['お繋ぎしますので少々お待ちください。', 'transfer', 'wait_enter'],
    ['担当に代わりますので少々お待ちください。', 'transfer', 'wait_enter'],
    ['オーナーいますので、ちょっと呼んできます。', 'transfer', 'wait_enter'],
    ['ちょっとお待ちくださいね、今呼びます。', 'transfer', 'wait_enter'],
    ['少々お待ちください。', 'transfer', 'wait_enter'],
    ['少々お待ちください。', 'wait', 'wait_enter'],
    ['少々お待ちください。', 'openai_realtime', 'wait_enter'],
    ['少々お待ちいただけますか。', 'wait', 'wait_enter'],
    ['お待ちください。', 'transfer', 'wait_enter'],
    ['確認しますので少々お待ちください。', 'wait', 'wait_enter'],
    ['ちょっと待ってくださいね。', 'wait', 'wait_enter'],
    ['少々お待ちくださいませ。', 'reprompt', 'wait_enter'],
    // 相づち・聞き取れない → 聞き返し
    ['あ。', 'reprompt', 'reprompt'],
    ['はい。', 'transfer', 'reprompt'],
    ['もしもし。', 'reprompt', 'reprompt'],
    ['お待たせしました。', 'transfer', 'reprompt'],
    ['すみません、もう一度お願いします。', 'reprompt', 'reprompt'],
    ['ご視聴ありがとうございました。', 'reprompt', 'reprompt'],
    ['♪', 'reprompt', 'reprompt'],
    ['(音楽)', 'reprompt', 'reprompt'],
    // 質問 → 答える
    ['どのようなご用件でしょうか。', 'reason', 'answer'],
    ['どちらの会社様ですか。', 'company', 'answer'],
    ['アポイントはございますか。', 'appointment', 'answer'],
    ['折り返しお電話させましょうか。', 'callback_request', 'answer'],
    ['確認しますので、ご用件を教えてください。', 'reason', 'answer'],
    // 不在・断り → 切る（待たせる言い回しや引き継ぎの言い回しが混ざっていても否定が勝つ）
    ['担当者は本日不在にしております。', 'not_available', 'intent'],
    ['担当は外出中で、夕方には戻ります。', 'callback_scheduled', 'intent'],
    ['あいにく担当の者が席を外しておりまして。', 'not_available', 'intent'],
    ['そういうのは結構です。', 'rejected', 'intent'],
    ['間に合ってますので。', 'rejected', 'intent'],
    ['営業のお電話はお断りしております。', 'rejected', 'intent'],
    ['代表は今いないんですよ。', 'not_available', 'intent'],
    ['社長は出張中です。', 'not_available', 'intent'],
    ['お断りしますので少々お待ちください。', 'rejected', 'intent'],
    ['担当者はいません、代わりに伝えます。', 'not_available', 'intent'],
    ['お電話代わりましたが、お断りします。', 'rejected', 'intent'],
    // 取次にしない（Haiku が取次と言っても関門で止める）
    ['代わりに伝えておきます。', 'transfer', 'reprompt'],
    ['私がですか？', 'transfer', 'reprompt'],
    ['私が受付です。', 'transfer', 'reprompt'],
    // 当てはまらない → 自由会話（今どおり）
    ['担当者がわからないんですけど。', 'openai_realtime', 'realtime'],
    ['私ではわかりかねます。', 'openai_realtime', 'realtime'],
    ['資料をメールで送ってもらえますか。', 'openai_realtime', 'realtime'],
];

for (const [text, haiku, want] of OUTSIDE_WAIT) {
    test(`待機の外: 「${text}」(Haiku=${haiku}) → ${want}`, () => {
        assert.equal(decide(text, haiku), want);
    });
}

// [発話, Haiku の答え, 待機中の最終の動作（保留明けは締める＝after_wait_strict=true）]
const IN_WAIT = [
    ['はい。', 'reprompt', 'continue_wait'],
    ['もしもし。', 'reprompt', 'continue_wait'],
    ['お待たせしました。', 'transfer', 'continue_wait'],
    ['はい、お電話代わりました、山田です。', 'transfer', 'transfer'],
    ['お待たせしました、担当の山田です。', 'transfer', 'transfer'],
    ['はい、私が担当ですが。', 'transfer', 'transfer'],
    ['少々お待ちください。', 'wait', 'continue_wait'],
    ['すみません、もう少々お待ちください。', 'transfer', 'continue_wait'],
    ['(音楽)', 'reprompt', 'continue_wait'],
    ['ご視聴ありがとうございました。', 'openai_realtime', 'continue_wait'],
    ['申し訳ありません、担当は不在でした。', 'not_available', 'intent'],
    ['やっぱり結構です。', 'rejected', 'intent'],
    ['すみません、ご用件をもう一度よろしいですか。', 'reason', 'answer'],
    ['代わりに伝えておきます。', 'transfer', 'continue_wait'],
    ['担当が戻りましたらお伝えします。', 'openai_realtime', 'continue_wait'],
];

for (const [text, haiku, want] of IN_WAIT) {
    test(`待機中: 「${text}」(Haiku=${haiku}) → ${want}`, () => {
        assert.equal(decide(text, haiku, { inWait: true }), want);
    });
}

test('保留明けを緩める（after_wait_strict=false）＝相づちだけで取次', () => {
    const ts = { ...SF_DEFAULT, after_wait_strict: false };
    assert.equal(decide('はい。', 'reprompt', { ts, inWait: true }), 'transfer');
    assert.equal(decide('もしもし。', 'reprompt', { ts, inWait: true }), 'transfer');
    // 待機の外では緩めない
    assert.equal(decide('はい。', 'reprompt', { ts }), 'reprompt');
});

test('on_wait の3つの値', () => {
    const waitT = { ...SF_DEFAULT, on_wait: 'transfer' };
    const waitR = { ...SF_DEFAULT, on_wait: 'reprompt' };
    // すぐ取次
    assert.equal(decide('少々お待ちください。', 'transfer', { ts: waitT }), 'transfer');
    assert.equal(decide('少々お待ちください。', 'wait', { ts: waitT }), 'transfer');
    // 今どおり聞き返す
    assert.equal(decide('少々お待ちください。', 'transfer', { ts: waitR }), 'reprompt');
    assert.equal(decide('少々お待ちください。', 'wait', { ts: waitR }), 'reprompt');
    // 否定はどの値でも切る
    for (const ts of [SF_DEFAULT, waitT, waitR]) {
        assert.equal(decide('お断りしますので少々お待ちください。', 'rejected', { ts }), 'intent');
    }
    // 本人の名乗りはどの値でも取次（待たせる言い回しが混ざっても）
    for (const ts of [SF_DEFAULT, waitT, waitR]) {
        assert.equal(decide('お電話代わりました、少々お待ちくださいね資料を出します。', 'transfer', { ts }), 'transfer');
        assert.equal(decide('担当です。資料を確認しますので少々お待ちください。', 'transfer', { ts }), 'transfer');
        assert.equal(decide('担当です。資料を確認しますので少々お待ちください。', 'transfer', { ts, inWait: true }), 'transfer');
    }
    // Haiku が取次と言っていない発話は、「すぐ取次」の設定でも言い回しだけで取次にしない（2026-10-05 codex レビュー）
    assert.equal(decide('確認しますので、資料をメールで送れますか。', 'openai_realtime', { ts: waitT }), 'realtime');
    assert.equal(decide('少々お待ちください。', 'reprompt', { ts: waitT }), 'reprompt');
    assert.equal(decide('少々お待ちください。', 'openai_realtime', { ts: waitR }), 'realtime');
});

test('空の句の配列＝その種類は無し（待たせる言い回しが無ければ今どおり関門へ）', () => {
    const ts = { ...SF_DEFAULT, wait_phrases: [] };
    assert.equal(decide('少々お待ちください。', 'transfer', { ts }), 'reprompt');
    assert.equal(decide('少々お待ちください。', 'wait', { ts }), 'wait_enter'); // Haiku が wait と言えば待つ
});

// ---------------------------------------------------------------------
// 設定が無い通話は今の挙動＝関門・プロンプト・語彙ヒントが 2026-10-05 までの本番と同じ
// ---------------------------------------------------------------------
test('今の関門（設定なし）は 2026-10-05 までの判定のまま', () => {
    // 今の本番の関門で通る／通らない物（2026-10-05 の46件の結果と同じ）
    assert.equal(hasSufficientTransferEvidence('担当者に代わります。'), true);
    assert.equal(hasSufficientTransferEvidence('代わりに伝えておきます。'), true); // 今の穴（素の「代わり」）＝設定なしでは変えない
    assert.equal(hasSufficientTransferEvidence('少々お待ちください。'), false);
    assert.equal(hasSufficientTransferEvidence('店長の田中ですが。'), false);
    assert.equal(hasSufficientTransferEvidence('はい。'), false);
});

test('設定なしのプロンプトに wait は出ない・設定ありには出る', () => {
    const cfg = { companyName: 'テスト', intents: INTENTS.map((i) => ({ ...i, triggers: [i.name] })) };
    const legacy = buildClassifierPrompt(cfg, null);
    assert.ok(!legacy.includes('- wait:'));
    assert.ok(!legacy.includes('保留の後'));
    const withTs = buildClassifierPrompt(cfg, SF_DEFAULT);
    assert.ok(withTs.includes('- wait: 少々お待ち'));
    assert.ok(withTs.includes(`- transfer: ${SF_DEFAULT.transfer_phrases.join(' / ')}`));
    const vocab = buildTranscriptionPrompt('テスト', cfg.intents, SF_DEFAULT);
    assert.ok(vocab.includes('少々お待ち'));
    assert.ok(vocab.length <= 240);
});

test('設定の hash は中身だけで決まる（id・版では変わらない）', () => {
    const a = settingsHash(SF_DEFAULT);
    assert.equal(a, settingsHash({ ...SF_DEFAULT, id: 'x', version: 9 }));
    assert.notEqual(a, settingsHash({ ...SF_DEFAULT, on_wait: 'transfer' }));
});
