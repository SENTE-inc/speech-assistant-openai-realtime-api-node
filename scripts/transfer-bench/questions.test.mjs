// 版7.2（2026-10-10）＝受付からの質問の取りこぼしの試験（家＝~/sente/sfav_transfer_tuning_plan.md「版7.2」）
// step 3q（社名・名前・宛先・用件を明示に聞かれたら答える）と ⑥（待機中の答えの無い質問は CM へ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decideAskedQuestion, isUnansweredQuestionInWait, decideAfterClassifierV2, decideFastHandover, normalizeSettings,
} from '../../transfer-logic.js';
import { INTENT_BY_NAME, levelRow } from './fixtures.mjs';

const L = Object.fromEntries(['loose', 'normal', 'strict'].map((l) => [l, normalizeSettings(levelRow(l))]));
const ask = (text, level = 'normal') => decideAskedQuestion({ transcript: text, ts: L[level] });

// 純粋な質問＝答える（待たせる言い回しが無い）
const ANSWER = [
    ['ごめんなさい、もう一度お名前いただいてよろしいですか', 'company'],
    ['会社名をもう一度お願いします', 'company'],
    ['会社名をもう一度', 'company'],                 // 「もう一度」も頼む語（監査 2026-10-10）
    ['すいません、どちら様でしょうか', 'company'],
    ['お名前をお伺いしてもよろしいでしょうか', 'company'],
    ['どういったご用件でしょうか', 'reason'],
    ['ご用件をお伺いしてもよろしいですか', 'reason'],
    ['担当者のお名前を教えていただけますか', 'addressee'], // 宛先＝こちらの名前ではない
    ['どなた宛てのお電話でしょうか', 'addressee'],
];
for (const [text, intent] of ANSWER) {
    for (const level of ['loose', 'normal', 'strict']) {
        test(`3q「${text}」× ${level} → answer ${intent}`, () => {
            const d = ask(text, level);
            assert.equal(d?.action, 'answer');
            assert.equal(d?.intent, intent);
        });
    }
}

// 待たせる言い回しつき＝段ごと（緩い＝答えて取次／ふつう・締める＝答えて待機）
const WITH_WAIT = [
    ['少々お待ちくださいませ。もう一度会社のお名前をよろしいでしょうか。', 'company'],
    ['確認いたしますので、お社名よろしいでしょうか', 'company'],
    ['今おつなぎできるか確認いたしますので会社名をお聞きしてもいいですか', 'company'],
];
for (const [text, intent] of WITH_WAIT) {
    test(`3q＋待たせる「${text}」× loose → answer_then_transfer`, () => {
        const d = ask(text, 'loose');
        assert.equal(d?.action, 'answer_then_transfer');
        assert.equal(d?.intent, intent);
    });
    for (const level of ['normal', 'strict']) {
        test(`3q＋待たせる「${text}」× ${level} → answer_then_wait`, () => {
            const d = ask(text, level);
            assert.equal(d?.action, 'answer_then_wait');
            assert.ok(String(d?.gate).startsWith('words'), '言葉の後の保留音として数える');
        });
    }
}

// 決めない（Haiku へ）＝断り・不在・名乗り・確かめ句・つながない句・番号や部署・複数の対象・頼む語なし・自動音声
const NOT_ASKED = [
    '営業はお断りです。どちらの会社ですか',
    '担当は不在です。会社名を教えてください',
    '担当の山田です。御社名を教えてください',
    'はい、私です。お名前をお願いします',
    '代わりにご用件を承りますので、お名前をお願いします',
    'お電話番号をお伺いしてもよろしいですか',
    'どちらの部署におつなぎしますか、お名前をお願いします',
    'お名前とご用件をお伺いしてもよろしいですか',
    '株式会社テストでございます',
    'この通話は品質向上のため録音させていただいております。会社名',
];
for (const text of NOT_ASKED) {
    test(`3q で決めない「${text}」`, () => {
        assert.equal(ask(text), null);
    });
}
test('名乗りの最速の道は 3q より先（担当の山田です＋御社名）', () => {
    assert.equal(decideFastHandover({ transcript: '担当の山田です。御社名を教えてください', ts: L.normal })?.action, 'transfer_fast');
});
test('設定の行が段1（v2 でない）なら 3q は動かない', () => {
    assert.equal(decideAskedQuestion({ transcript: 'どちら様でしょうか', ts: { v2: false } }), null);
});

// ⑥ 待機中の答えの無い質問＝CM へ（Tom 2026-10-10「繋いじゃおう」）
const after = (text, haiku, level = 'normal') =>
    decideAfterClassifierV2({ transcript: text, intentName: haiku, intentDef: INTENT_BY_NAME.get(haiku) || null, ts: L[level], inWait: true });
for (const level of ['loose', 'normal', 'strict']) {
    test(`⑥ 待機中「研修って社員向けという意味ですか？」(Haiku=openai_realtime) × ${level} → realtime（CM へ）`, () => {
        const d = after('研修って社員向けという意味ですか？', 'openai_realtime', level);
        assert.equal(d.action, 'realtime');
        assert.equal(d.gate, 'question_in_wait');
    });
}
const STAY = [
    ['はい', 'reprompt'],                                  // 相づち＝待つ
    ['担当は席を外していますが、いかがいたしましょうか', 'openai_realtime'], // 否定の語＝待つ（不在は不在の道）
    ['ご視聴ありがとうございました', 'reprompt'],           // 保留音の空耳
    ['そうですか', 'openai_realtime'],                       // 4字未満（記号を除く）でない＝質問の形
];
test('⑥ 待機中の相づち・否定・空耳は待つ', () => {
    assert.equal(after('はい', 'reprompt').action, 'continue_wait');
    assert.equal(after('担当は席を外していますが', 'openai_realtime').action, 'continue_wait'); // 問いかけでない＝待つ
    assert.equal(after('ご視聴ありがとうございました', 'reprompt').action, 'continue_wait');
});
test('⑥ 待機中でも Haiku が不在・断りなら切る道（step 5）が先', () => {
    assert.equal(after('担当は不在ですがいかがいたしましょうか', 'not_available').action, 'intent');
});
test('⑥ の判定（質問の形・4字以上・否定なし）', () => {
    assert.equal(isUnansweredQuestionInWait('ネイバーズですか？'), true);
    assert.equal(isUnansweredQuestionInWait('何？'), false);
    assert.equal(isUnansweredQuestionInWait('担当は席を外していますが、いかがいたしましょうか'), true); // 不在＋問いかけ＝CM（監査 2026-10-10）
});
void STAY;

// ⑦ あいさつ・お礼・相づちだけ＝CM へつながず聞き続ける（待機の外・Haiku が自由会話／聞き返し／未知の時）
const outside = (text, haiku, level = 'normal') =>
    decideAfterClassifierV2({ transcript: text, intentName: haiku, intentDef: INTENT_BY_NAME.get(haiku) || null, ts: L[level], inWait: false });
for (const text of ['お世話になっております', 'ありがとうございます。', 'はい、いつもお世話になっております。', 'かしこまりました', 'はい、お疲れ様です']) {
    for (const level of ['loose', 'normal', 'strict']) {
        test(`⑦「${text}」(Haiku=openai_realtime) × ${level} → listen`, () => {
            assert.equal(outside(text, 'openai_realtime', level).action, 'listen');
        });
    }
}
test('⑦ あいさつの後に中身があれば今どおり（答えが無い→CM）', () => {
    assert.equal(outside('お世話になりますシステムの件ですか', 'openai_realtime').action, 'realtime');
    assert.equal(outside('お電話ありがとうございます 株式会社テストでございます', 'openai_realtime').action, 'realtime');
});
test('⑦ Haiku が否定・質問の答え・待たせる・取次なら そちらが先', () => {
    assert.equal(outside('ありがとうございます、結構です', 'rejected').action, 'intent');
    assert.equal(outside('ありがとうございます。少々お待ちください', 'wait').action, 'wait_enter');
});

// 実装の監査（2026-10-10）の直し
test('3q 監査＝対象が2つ（こちらの名前と宛先）は決めない', () => {
    assert.equal(ask('お名前と担当者のお名前をお願いします'), null);
});
test('3q 監査＝既に聞いた・漢字は決めない', () => {
    assert.equal(ask('担当に伝えますのでよろしくお願いします。ご用件は伺っております'), null);
    assert.equal(ask('お名前の漢字を教えてください'), null);
});
test('3q 監査＝もういっぺん・お聞かせ・どなたですか を拾う／録音されます は自動音声', () => {
    assert.equal(ask('会社名をもういっぺん')?.intent, 'company');
    assert.equal(ask('会社名をお聞かせください')?.intent, 'company');
    assert.equal(ask('どなたですか')?.intent, 'company');
    assert.equal(ask('この通話は録音されます。会社名をお願いします'), null);
});
test('⑦ 監査＝「はい？」「あ？」は聞き返し＝listen にしない', () => {
    assert.notEqual(outside('はい？', 'reprompt').action, 'listen');
    assert.notEqual(outside('あ？', 'reprompt').action, 'listen');
});
