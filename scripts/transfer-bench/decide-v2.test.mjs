// 版6〜7（DB 142）の判定の試験＝取次の判定と、森さんが選ぶ3段階（家＝~/sente/sfav_transfer_tuning_plan.md の「版7」）。
// 例ごとに最終の動作を決める。Haiku の答えは固定（モデルは呼ばない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decideBeforeClassifier, decideFastHandover, decideAfterClassifierV2, decideHold, isWordless, normalizeSettings, settingsHash,
} from '../../transfer-logic.js';
import { INTENT_BY_NAME, V2_DEFAULT, SF_DEFAULT, levelRow } from './fixtures.mjs';

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
test('DB の行 → 正規化（level が空なら段1）と hash', () => {
    const v1 = normalizeSettings({ id: 'a', on_wait: 'wait', transfer_phrases: [], block_phrases: [], wait_phrases: [], wait_max_seconds: 90, after_wait_strict: true, version: 1 });
    assert.equal(v1.v2, false);
    const n = normalizeSettings(levelRow('normal'));
    assert.equal(n.v2, true);
    assert.equal(n.hold_music_record_only, false);
    assert.equal(normalizeSettings({ ...levelRow('normal'), level: 'unknown', on_wait: 'wait' }).v2, false); // 知らない段は段1で動く
    assert.notEqual(settingsHash(n), settingsHash(normalizeSettings(levelRow('strict'))));
    assert.equal(settingsHash(v1), settingsHash({ ...v1, on_words: 'wait' })); // 段1の hash は版7の項目で変わらない
});

// 版7＝3段階（Tom 2026-10-06）
test('3段階＝緩いは言葉ですぐ・ふつうは保留音で・締めるは言葉の後の保留音だけ', () => {
    const [loose, normal, strict] = ['loose', 'normal', 'strict'].map((l) => normalizeSettings(levelRow(l)));
    assert.equal(decide('少々お待ちください。', 'wait', { ts: loose }), 'transfer');
    assert.equal(decide('少々お待ちください。', 'wait', { ts: normal }), 'wait_enter');
    assert.equal(decide('少々お待ちください。', 'wait', { ts: strict }), 'wait_enter');
    for (const ts of [loose, normal, strict]) assert.equal(decideHold({ ts, announced: true }).transfer, ts !== loose);
    assert.equal(decideHold({ ts: loose, announced: false }).transfer, true);
    assert.equal(decideHold({ ts: normal, announced: false }).transfer, true);
    assert.equal(decideHold({ ts: strict, announced: false }).transfer, false);
    assert.ok(loose.hold_music_seconds < normal.hold_music_seconds && normal.hold_music_seconds < strict.hold_music_seconds);
    // 保留明けの「はい」だけ＝緩いはつなぐ・ほかはつながない
    assert.equal(decide('はい。', 'reprompt', { ts: loose, inWait: true }), 'transfer');
    assert.notEqual(decide('はい。', 'reprompt', { ts: strict, inWait: true }), 'transfer');
});

// ===== codex レビュー（2026-10-05 夜）の反例 =====
const NOT_SELF = [
    '私が担当ではありません。',
    'お電話代わりましたが、営業電話は受け付けていないです。',
    '担当者は今いないです。私は担当ですけど営業は不要です。',
    'こちらは受付担当です。',
    '代表の番号です。',
    '担当の者は別の人です。',
    'お電話が変わりましたか？',
    '担当です。どちらの会社ですか。',
    '担当の者にお繋ぎいたします。',
];
for (const text of NOT_SELF) {
    test(`最速の道に乗せない「${text}」`, () => {
        assert.equal(decideFastHandover({ transcript: text, ts: V2_DEFAULT }), null);
    });
    test(`Haiku が transfer と言っても名乗りで最速にしない「${text}」`, () => {
        assert.notEqual(decide(text, 'transfer'), 'transfer_fast');
    });
}
test('森さんが名乗りの句を消したら効かない（固定の判定を持たない）', () => {
    const ts = { ...V2_DEFAULT, handover_phrases: [] };
    assert.equal(decideFastHandover({ transcript: 'はい、私が担当ですが。', ts }), null);
    const ts2 = { ...V2_DEFAULT, handover_phrases: V2_DEFAULT.handover_phrases.filter((p) => !p.includes('代わりました') && !p.includes('変わりました') && !p.includes('替わりました')) };
    assert.equal(decideFastHandover({ transcript: 'お電話代わりました、山田です。', ts: ts2 }), null);
});
test('＊の言い回し＝名前は通す・者／番号／人は通さない', () => {
    assert.equal(decideFastHandover({ transcript: '担当の山田です。', ts: V2_DEFAULT })?.action, 'transfer_fast');
    assert.equal(decideFastHandover({ transcript: 'オーナーの佐藤ですけど。', ts: V2_DEFAULT })?.action, 'transfer_fast');
    assert.equal(decideFastHandover({ transcript: '担当の者です。', ts: V2_DEFAULT }), null);
});
test('待機中の相づちにも「つながない言い回し」が効く', () => {
    const ts = { ...V2_DEFAULT, after_wait_strict: false, block_phrases: ['はい'] };
    assert.notEqual(decide('はい。', 'reprompt', { ts, inWait: true }), 'transfer');
});
test('DB 142 で移した行（受付の予告は待たせる言い方へ）＝「担当者に代わります」で保留音を待つ', () => {
    // 141 の SENTE の行に 142 の update を当てた形
    const migrated = { ...V2_DEFAULT, transfer_phrases: ['詳しく聞かせて', '詳しく聞きたい', '興味があります', '興味あります', '聞かせてください'] };
    assert.equal(decide('担当者に代わります。', 'transfer', { ts: migrated }), 'wait_enter');
    assert.equal(decide('担当の者にお繋ぎいたします。', 'transfer', { ts: migrated }), 'wait_enter');
});

