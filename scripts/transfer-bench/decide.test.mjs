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
import { INTENT_BY_NAME, INTENTS, SF_DEFAULT, OUTSIDE_WAIT, IN_WAIT } from './fixtures.mjs';

const decide = (transcript, haiku, { ts = SF_DEFAULT, inWait = false } = {}) => {
    const pre = decideBeforeClassifier({ transcript, ts, inWait });
    if (pre) return pre.action;
    return decideAfterClassifier({
        transcript, intentName: haiku, intentDef: INTENT_BY_NAME.get(haiku) || null, ts, inWait,
    }).action;
};

for (const [text, haiku, want] of OUTSIDE_WAIT) {
    test(`待機の外: 「${text}」(Haiku=${haiku}) → ${want}`, () => {
        assert.equal(decide(text, haiku), want);
    });
}

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
