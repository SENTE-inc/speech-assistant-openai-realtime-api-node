// 相づち「はい」→「ありがとうございます」（2026-10-10 Tom「本番にgo」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAizuchi, thanksRestText, thanksConfig, thanksClipFilename } from '../../transfer-logic.js';

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
