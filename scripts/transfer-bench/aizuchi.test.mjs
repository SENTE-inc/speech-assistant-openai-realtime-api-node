// 相づち「はい」→「ありがとうございます」（2026-10-10 Tom「本番にgo」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAizuchi, thanksRestText, thanksConfig, thanksClipFilename, pickupBeepToneRatio } from '../../transfer-logic.js';

const THANKS = ['少々お待ちください', 'お世話になっております', 'すいません、少々お待ちください', 'かしこまりました、おつなぎします',
    'お電話代わりました、田中です', '確認してまいります', 'ありがとうございます', '十五時には戻るでしょう', '何時でも大丈夫です', 'よろしくお願いします', '対応できます。', 'かしこまりました、おつなぎします'];
const HAI = ['どちら様でしょうか', 'ご用件は何でしょう', 'お待ちいただけますか', '担当は不在です', '本日は外出しております', '結構です',
    '営業のお電話はお断りしております', 'はい', 'ええ', 'はい？', 'そうですね', '', '戻り次第かけ直させましょうか', 'どういったご用件ですか',
    'お名前をお願いします。', 'ご用件をお聞かせください。', '今は対応できません。', '存じ上げません。', 'どうも', '承知しました。', 'わかりました。', 'かしこまりました。'];
for (const t of THANKS) test(`「${t}」→ ありがとうございます`, () => assert.equal(chooseAizuchi(t), 'thanks'));
for (const t of HAI) test(`「${t}」→ はい`, () => assert.equal(chooseAizuchi(t), 'hai'));

test('頭を落とした方', () => {
    assert.equal(thanksRestText('ありがとうございます。よろしくお願いいたします。'), 'よろしくお願いいたします。');
    assert.equal(thanksRestText('ありがとうございます！ちなみに'), 'ちなみに');
    assert.equal(thanksRestText('承知いたしました。ありがとうございます。'), null);
    assert.equal(thanksRestText('ありがとうございます。'), '');
});

const V = 'voiceA';
const clip = (key, text, source = 'elevenlabs', clip_type = 'response') => [key, { key, text, source, clip_type, filename: `${key}.mp3` }];
const made = (key, text, voice = V) => [key, { key, text, source: 'elevenlabs', audio_ready: true, clip_type: 'response', filename: thanksClipFilename(key, text, voice) }];
const base = (src = 'elevenlabs') => [clip('16a_hai', 'はい。', src, 'filler'), clip('transfer_success', 'ありがとうございます。よろしくお願いいたします。', src), clip('farewell', '失礼いたします。', src)];
const full = (src) => new Map([...base(src), made('aizuchi_thanks', 'ありがとうございます。'), made('transfer_success__rest', 'よろしくお願いいたします。')]);
test('揃った時だけ使う', () => {
    assert.equal(thanksConfig(new Map(base()), V).thanksKey, null); // 「ありがとうございます」が無い
    assert.equal(thanksConfig(new Map([...base(), made('aizuchi_thanks', 'ありがとうございます。')]), V).thanksKey, null); // 頭を落とした方が無い
    const c = thanksConfig(full(), V);
    assert.equal(c.thanksKey, 'aizuchi_thanks');
    assert.equal(c.thanksRestKey.get('transfer_success'), 'transfer_success__rest');
});
test('台本の文が変わった・声が変わった・肉声が混じる → 使わない', () => {
    const changed = full(); changed.set('transfer_success', { ...changed.get('transfer_success'), text: 'ありがとうございます。お願いします。' });
    assert.equal(thanksConfig(changed, V).thanksKey, null);
    assert.equal(thanksConfig(full(), 'voiceB').thanksKey, null);
    assert.equal(thanksConfig(full('recorded'), V).thanksKey, null);
    assert.equal(thanksConfig(full(), null).thanksKey, null);
    const notReady = full(); notReady.set('aizuchi_thanks', { ...notReady.get('aizuchi_thanks'), audio_ready: false });
    assert.equal(thanksConfig(notReady, V).thanksKey, null);
});

// 電話を取った瞬間の「ププッ」（約440Hz の澄んだ音）と声を見分ける（録音の実測＝ププッ 0.54〜0.55・声 0.00〜0.01）
test('pickupBeepToneRatio: 440Hz の澄んだ音は高い・倍音の多い声らしい音と雑音は低い', () => {
    const n = 960; // 0.12秒
    const tone = Array.from({ length: n }, (_, i) => Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / 8000)));
    const voice = Array.from({ length: n }, (_, i) => {
        let s = 0;
        for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * 140 * h * i / 8000 + h) * 3000 / h;
        return Math.round(s + (Math.random() * 2 - 1) * 1500);
    });
    const noise = Array.from({ length: n }, () => Math.round((Math.random() * 2 - 1) * 6000));
    assert.ok(pickupBeepToneRatio(tone) > 0.8, `tone=${pickupBeepToneRatio(tone)}`);
    assert.ok(pickupBeepToneRatio(voice) < 0.3, `voice=${pickupBeepToneRatio(voice)}`);
    assert.ok(pickupBeepToneRatio(noise) < 0.3, `noise=${pickupBeepToneRatio(noise)}`);
    assert.equal(pickupBeepToneRatio([]), 0);
});
