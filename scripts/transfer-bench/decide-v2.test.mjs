// 版6（DB 142）の判定の試験＝森さんが場面ごとに選ぶ取次（家＝~/sente/sfav_transfer_tuning_plan.md §3-0）。
// 例ごとに最終の動作を決める。Haiku の答えは固定（モデルは呼ばない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decideBeforeClassifier, decideFastHandover, decideAfterClassifierV2, decideHold, isWordless, normalizeSettings, settingsHash,
} from '../../transfer-logic.js';
import { INTENT_BY_NAME, V2_DEFAULT, SF_DEFAULT } from './fixtures.mjs';

const decide = (text, haiku, { ts = V2_DEFAULT, inWait = false } = {}) => {
    const fast = decideFastHandover({ transcript: text, ts });
    if (fast) return fast.action;
    const pre = decideBeforeClassifier({ transcript: text, ts, inWait });
    if (pre) return pre.action;
    return decideAfterClassifierV2({ transcript: text, intentName: haiku, intentDef: INTENT_BY_NAME.get(haiku) || null, ts, inWait }).action;
};
const withWords = (on_words) => ({ ...V2_DEFAULT, on_words });

// [発話, Haiku, 受付の言葉の選び方ごとの期待（transfer／hold／wait）]
const WORDS = [
    ['少々お待ちください。', 'wait', ['transfer', 'wait_enter', 'wait_enter']],
    ['少々お待ちください。', 'transfer', ['transfer', 'wait_enter', 'wait_enter']],
    ['担当に代わりますので少々お待ちください。', 'transfer', ['transfer', 'wait_enter', 'wait_enter']],
    ['担当の者にお繋ぎいたします。', 'transfer', ['transfer', 'wait_enter', 'wait_enter']],
    ['オーナーいますので、ちょっと呼んできます。', 'transfer', ['transfer', 'wait_enter', 'wait_enter']],
    ['少々お待ちくださいませ。', 'reprompt', ['transfer', 'wait_enter', 'wait_enter']],
];
for (const [text, haiku, wants] of WORDS) {
    ['transfer', 'hold', 'wait'].forEach((w, i) => {
        test(`受付の言葉「${text}」(Haiku=${haiku}) × ${w} → ${wants[i]}`, () => {
            assert.equal(decide(text, haiku, { ts: withWords(w) }), wants[i]);
        });
    });
}

// 担当者本人の名乗り＝Haiku を待たない最速の道（すべての選び方で）
const HANDOVER = [
    'はい、私が担当ですが。', 'はい、お電話代わりました、山田です。', 'あ、お電話変わりました、山田です。',
    '店長の田中ですが。', '担当です。資料を確認しますので少々お待ちください。', 'はい、私が代表の山田です。',
];
for (const text of HANDOVER) {
    for (const w of ['transfer', 'hold', 'wait']) {
        test(`本人の名乗り「${text}」× ${w} → transfer_fast（Haiku 前）`, () => {
            assert.equal(decideFastHandover({ transcript: text, ts: withWords(w) })?.action, 'transfer_fast');
        });
    }
}
test('名乗りをすぐつながない設定＝最速の道を使わず、Haiku が transfer でもつながない', () => {
    const ts = { ...V2_DEFAULT, on_handover: false };
    assert.equal(decideFastHandover({ transcript: 'はい、私が担当ですが。', ts }), null);
    assert.equal(decide('はい、私が担当ですが。', 'transfer', { ts }), 'reprompt');
});

// 名乗りに見えても最速の道に乗せない（Haiku の判定へ）
const NOT_FAST = [
    ['社長の田中は不在です。', 'not_available', 'intent'],
    ['担当です、でも結構です。', 'rejected', 'intent'],
    ['担当の者にお繋ぎいたします。', 'transfer', 'wait_enter'],
    ['代表の者に代わりますので少々お待ちください。', 'transfer', 'wait_enter'],
    ['受付の田中です。', 'openai_realtime', 'realtime'],
    ['私が受付です。', 'transfer', 'reprompt'],
    ['代わりに伝えておきます。', 'transfer', 'reprompt'],
];
for (const [text, haiku, want] of NOT_FAST) {
    test(`名乗りではない「${text}」(Haiku=${haiku}) → ${want}`, () => {
        assert.equal(decideFastHandover({ transcript: text, ts: V2_DEFAULT }), null);
        assert.equal(decide(text, haiku), want);
    });
}

// 否定・質問は選び方に関係なく今どおり
for (const w of ['transfer', 'hold', 'wait']) {
    test(`否定と質問は固定（${w}）`, () => {
        const ts = withWords(w);
        assert.equal(decide('お断りしますので少々お待ちください。', 'rejected', { ts }), 'intent');
        assert.equal(decide('担当者はいません、代わりに伝えます。', 'not_available', { ts }), 'intent');
        assert.equal(decide('確認しますので、ご用件を教えてください。', 'reason', { ts }), 'answer');
        assert.equal(decide('どちらの会社様ですか。', 'company', { ts }), 'answer');
    });
}

// 待機中
test('待機中＝相づちは「はい／もしもし」の設定どおり・名乗りはすぐ・保留の空耳は待つ', () => {
    assert.equal(decide('はい。', 'reprompt', { inWait: true }), 'continue_wait');
    assert.equal(decide('もしもし。', 'reprompt', { ts: { ...V2_DEFAULT, after_wait_strict: false }, inWait: true }), 'transfer');
    assert.equal(decide('お電話代わりました、山田です。', 'transfer', { inWait: true }), 'transfer_fast');
    assert.equal(decide('ご視聴ありがとうございました。', 'openai_realtime', { inWait: true }), 'continue_wait');
    assert.equal(decide('申し訳ありません、担当は不在でした。', 'not_available', { inWait: true }), 'intent');
});

// 前向き（関門）
test('前向きの発話は今の関門で取次（声あり）', () => {
    assert.equal(decide('詳しく聞かせてください。', 'transfer'), 'transfer');
});

// 保留音の判定
test('保留音＝受付の言葉の後か・言葉なしかで設定どおり', () => {
    assert.deepEqual(decideHold({ ts: withWords('hold'), announced: true }).transfer, true);
    assert.deepEqual(decideHold({ ts: withWords('wait'), announced: true }).transfer, false);
    assert.deepEqual(decideHold({ ts: withWords('transfer'), announced: true }).transfer, false);
    assert.deepEqual(decideHold({ ts: V2_DEFAULT, announced: false }).transfer, true);
    assert.deepEqual(decideHold({ ts: { ...V2_DEFAULT, on_hold_without_words: false }, announced: false }).transfer, false);
    assert.deepEqual(decideHold({ ts: SF_DEFAULT, announced: false }).transfer, false); // v1 の行は保留音で取次しない
});
test('言葉なしの判定＝空と音楽の空耳だけ', () => {
    for (const s of ['', null, 'ご視聴ありがとうございました。', '♪', '(音楽)']) assert.equal(isWordless(s), true, String(s));
    for (const s of ['少々お待ちください。', '担当者をお呼びしております。', 'もしもし']) assert.equal(isWordless(s), false, s);
});
test('DB の行 → v2 の正規化（on_words が空なら v1）と hash', () => {
    const v1 = normalizeSettings({ id: 'a', on_wait: 'wait', transfer_phrases: [], block_phrases: [], wait_phrases: [], wait_max_seconds: 90, after_wait_strict: true, version: 1 });
    assert.equal(v1.v2, false);
    const v2 = normalizeSettings({ id: 'a', on_wait: 'wait', on_words: 'hold', hold_music_seconds: 6, hold_music_record_only: true, handover_phrases: ['私が担当'], transfer_phrases: [], block_phrases: [], wait_phrases: [], wait_max_seconds: 90, after_wait_strict: true, version: 1 });
    assert.equal(v2.v2, true);
    assert.equal(v2.hold_music_seconds, 6);
    assert.notEqual(settingsHash(v2), settingsHash({ ...v2, on_words: 'wait' }));
    assert.equal(settingsHash(v1), settingsHash({ ...v1, on_words: 'wait' })); // v1 の hash は版6の項目で変わらない
});
