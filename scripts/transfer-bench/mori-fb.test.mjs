// 2026-10-08 森さんの FB の判定（言いかけ・もう一度・不在の段の答え・戻り時間）。家＝~/sente/sente_aivoice_canonical.md §3「📐 実装の計画 v3」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIncompleteUtterance, isFillerWordsOnly, isRepeatRequest, classifyAbsentReply, parseRecallAt, retryIntervalFor } from '../../transfer-logic.js';

// 2026-10-08（木）19:00 JST
const NOW = new Date('2026-10-08T10:00:00Z');
const jst = (d) => (d ? new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : null);

const INCOMPLETE = [
    ['今、営業の責任者のもの。', true],          // 実物（1本目）
    ['あの、今営業の担当の者が席外して。', true], // 実物＝「て」で終わる＝1.5秒待ってから判定
    ['あのー', true], ['えっと、', true], ['あ、', true], ['えーと', true],
    ['ええ', false], ['はい', false], ['担当の者です。', false], ['社長は？', false],
    ['少々お待ちください。', false], ['結構です。', false], ['担当者は本日外出しております。', false],
];
for (const [t, want] of INCOMPLETE) test(`言いかけ「${t}」→ ${want}`, () => assert.equal(isIncompleteUtterance(t), want));
test('つなぎ言葉だけ', () => {
    assert.equal(isFillerWordsOnly('あのー、えっと'), true);
    assert.equal(isFillerWordsOnly('ええ'), false);
    assert.equal(isFillerWordsOnly('はい'), false);
});

const REPEAT = [
    ['すいません、もう一度。', true],               // 実物（2本目）
    ['もう一回お願いします', true], ['聞こえませんでした', true], ['なんておっしゃいました？', true],
    ['もう一度御社名とお名前を伺っても。', false],  // 実物＝AI が社名の答えを返した
    ['ご要件もう一回お伺いしてもよろしいですか。', false], // 実物＝AI が用件の答えを返した
    ['聞こえますか', false], ['はい', false],
];
for (const [t, want] of REPEAT) test(`もう一度「${t}」→ ${want}`, () => assert.equal(isRepeatRequest(t), want));

const RECALL = [
    ['15時ごろ戻ります', '2026-10-09 15:00'],     // 今日の15時は過ぎた＝明日
    ['16時には戻ります。', '2026-10-09 16:00'],
    ['3時頃', '2026-10-09 15:00'],                // 「3時」＝営業の時間＝15時
    ['十五時半', '2026-10-09 15:30'], ['１６時', '2026-10-09 16:00'], ['3時10分', '2026-10-09 15:10'],
    ['明日の午後', '2026-10-09 13:00'], ['明日には戻ります', '2026-10-09 10:00'], ['夕方', '2026-10-09 17:00'],
    ['30分くらいで戻ります', '2026-10-08 19:30'], ['30分ちょっとで戻ります', '2026-10-08 19:30'],
    ['16時ではなく17時', '2026-10-09 17:00'],     // 訂正＝後ろ
    ['明日の午後は困りますが、明後日なら大丈夫', '2026-10-10 10:00'], // 否定の区切りは採らない
    ['金曜', '2026-10-09 10:00'], ['木曜', '2026-10-15 10:00'], ['来週の月曜の10時半', '2026-10-12 10:30'],
    ['午後は戻りません', null], ['分からないです', null], ['後ほど', null],
];
for (const [t, want] of RECALL) test(`戻り時間「${t}」→ ${want}`, () => assert.equal(jst(parseRecallAt(t, NOW)), want));
// 前の区切りの日・午後を後ろの時刻へ引き継ぐ（codex 差分レビュー）＝基準は 10:00 JST
const NOW10 = new Date('2026-10-08T01:00:00Z');
for (const [t, want] of [['明日、16時に戻ります', '2026-10-09 16:00'], ['明日の午後、3時です', '2026-10-09 15:00'], ['16時に戻ります', '2026-10-08 16:00'], ['明日は休みです', null]]) {
    test(`戻り時間（10時）「${t}」→ ${want}`, () => assert.equal(jst(parseRecallAt(t, NOW10)), want));
}
test('戻り時間＝JST の日付の境目（23:30 JST の「明日の10時」）', () => {
    assert.equal(jst(parseRecallAt('明日の10時', new Date('2026-12-31T14:30:00Z'))), '2027-01-01 10:00');
});

const ABSENT = [
    ['asked', '16時には戻ると思います', 'time', '2026-10-09 16:00'],
    ['asked', 'ちょっと分からないですね', 'unknown', null],
    ['asked', '明日は分からないです', 'unknown', null],
    ['asked', 'うーん', 'unknown', null],
    ['asked', '結構です', 'reject', null],
    ['proposed', 'はい、大丈夫です', 'yes', '2026-10-09 13:00'],
    ['proposed', 'はい', 'yes', '2026-10-09 13:00'],
    ['proposed', 'はい、明後日なら大丈夫です', 'yes', '2026-10-10 10:00'], // 別の日時が先（codex 監査）
    ['proposed', '明日の午後は困りますが、明後日なら', 'yes', '2026-10-10 10:00'],
    ['proposed', '明日はちょっと', 'no', null],
    ['proposed', '明日はちょっと無理です。', 'no', null],
    ['proposed', 'うーん', 'no', null],
    // 否定・問い返しは了承にしない（codex 差分レビュー）
    ['proposed', '明日は休みです', 'no', null],
    ['proposed', '明日の午後は戻ってきません', 'no', null],
    ['proposed', '明日の午後ですか、分かりません', 'no', null],
    ['proposed', '明日の午後は、不在です', 'no', null],
    ['proposed', '明日の午後で大丈夫です', 'yes', '2026-10-09 13:00'],
];
for (const [stage, t, kind, at] of ABSENT) {
    test(`不在の段 ${stage}「${t}」→ ${kind} ${at ?? ''}`, () => {
        const r = classifyAbsentReply(t, stage, NOW);
        assert.equal(r.kind, kind);
        assert.equal(jst(r.recallAt || null), at);
    });
}

test('再コールの間隔＝決めた日時まで／無い・過ぎた時は既定', () => {
    assert.equal(retryIntervalFor(new Date(NOW.getTime() + 3600e3).toISOString(), NOW, 24), '3600 seconds');
    assert.equal(retryIntervalFor(null, NOW, 24), '24 hours');
    assert.equal(retryIntervalFor(new Date(NOW.getTime() - 60e3).toISOString(), NOW, 24), '24 hours');
    assert.equal(retryIntervalFor('not a date', NOW, 24), '24 hours');
    assert.equal(retryIntervalFor(new Date(NOW.getTime() + 30e3).toISOString(), NOW, 24), '30 seconds'); // 未来なら短くても間隔
});
