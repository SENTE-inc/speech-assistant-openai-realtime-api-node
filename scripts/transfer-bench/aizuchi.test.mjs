// 相づち（2026-10-11 Tom「〜ですか？→ありがとうございます／〜です→承知しました！かしこまりました！」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAizuchi, aizuchiPrefixOf, aizuchiConfig, thanksClipFilename, aizuchiFilename, AIZUCHI_CLIPS, pickupBeepToneRatio } from '../../transfer-logic.js';

const THANKS = ['どちら様でしょうか', 'ご用件は何でしょう', 'お待ちいただけますか', '戻り次第かけ直させましょうか', 'どういったご用件ですか', 'はい？',
    '既に取引とかってあったりしますかね。', 'はい', 'ええ', 'そうですね', 'どうも', '承知しました。', 'わかりました。', 'かしこまりました。',
    'お世話になっております', 'ありがとうございます', 'よろしくお願いします'];
const ACK = ['少々お待ちください', 'すいません、少々お待ちください', 'かしこまりました、おつなぎします', 'お電話代わりました、田中です', '確認してまいります',
    '十五時には戻るでしょう', '何時でも大丈夫です', '対応できます。', '担当は不在です', '本日は外出しております', '結構です',
    '営業のお電話はお断りしております', 'お名前をお願いします。', 'ご用件をお聞かせください。', '今は対応できません。', '存じ上げません。', 'あ、今席を外しております。'];
const NONE = ['', 'あの', 'えっと', 'もしもし', 'あのー、', 'えー', 'ええと'];
for (const t of THANKS) test(`「${t}」→ ありがとうございます`, () => assert.equal(chooseAizuchi(t), 'thanks'));
for (const t of ACK) test(`「${t}」→ 承知しました／かしこまりました`, () => assert.equal(chooseAizuchi(t), 'ack'));
for (const t of NONE) test(`「${t}」→ 流さない`, () => assert.equal(chooseAizuchi(t), 'none'));

test('頭を落とした方', () => {
    assert.deepEqual(aizuchiPrefixOf('ありがとうございます。よろしくお願いいたします。'), { kind: 'thanks', rest: 'よろしくお願いいたします。' });
    assert.deepEqual(aizuchiPrefixOf('ありがとうございます！ちなみに'), { kind: 'thanks', rest: 'ちなみに' });
    assert.deepEqual(aizuchiPrefixOf('承知致しました。そうしましたら、資料を'), { kind: 'ack', rest: 'そうしましたら、資料を' });
    assert.deepEqual(aizuchiPrefixOf('かしこまりました！'), { kind: 'ack', rest: '' });
    assert.equal(aizuchiPrefixOf('お時間をいただきありがとうございました。'), null);
});

const V = 'voiceA';
const clip = (key, text, source = 'elevenlabs', clip_type = 'response') => [key, { key, text, source, clip_type, audio_ready: true, filename: `${key}.mp3` }];
const made = (key, text, voice = V) => [key, { key, text, source: 'elevenlabs', audio_ready: true, clip_type: 'response', filename: thanksClipFilename(key, text, voice) }];
const base = (src = 'elevenlabs') => [clip('16a_hai', 'はい。', src, 'filler'), clip('transfer_success', 'ありがとうございます。よろしくお願いいたします。', src),
    clip('send_material', '承知致しました。そうしましたら、送付先を伺えますか？', src), clip('farewell', '失礼いたします。', src)];
const three = () => AIZUCHI_CLIPS.map((a) => [a.key, { key: a.key, text: a.text, source: 'elevenlabs', audio_ready: true, clip_type: 'response', filename: aizuchiFilename(a, V) }]);
const full = (src) => new Map([...base(src), ...three(), made('transfer_success__rest', 'よろしくお願いいたします。'), made('send_material__rest', 'そうしましたら、送付先を伺えますか？')]);
test('揃った時だけ使う', () => {
    assert.equal(aizuchiConfig(new Map(base()), V).aizuchi, null); // 相づちが無い
    assert.equal(aizuchiConfig(new Map([...base(), ...three()]), V).aizuchi, null); // 頭を落とした方が無い
    const c = aizuchiConfig(full(), V);
    assert.deepEqual(c.aizuchi, { thanks: 'aizuchi_thanks', ack: ['aizuchi_shouchi', 'aizuchi_kashikomari'] });
    assert.deepEqual(c.aizuchiRest.get('transfer_success'), { kind: 'thanks', restKey: 'transfer_success__rest' });
    assert.deepEqual(c.aizuchiRest.get('send_material'), { kind: 'ack', restKey: 'send_material__rest' });
});
test('台本の文が変わった・声が変わった・肉声が混じる・1本欠けた → 使わない', () => {
    const changed = full(); changed.set('transfer_success', { ...changed.get('transfer_success'), text: 'ありがとうございます。お願いします。' });
    assert.equal(aizuchiConfig(changed, V).aizuchi, null);
    assert.equal(aizuchiConfig(full(), 'voiceB').aizuchi, null);
    assert.equal(aizuchiConfig(full('recorded'), V).aizuchi, null);
    assert.equal(aizuchiConfig(full(), null).aizuchi, null);
    const notReady = full(); notReady.set('aizuchi_shouchi', { ...notReady.get('aizuchi_shouchi'), audio_ready: false });
    assert.equal(aizuchiConfig(notReady, V).aizuchi, null);
    const missing = full(); missing.delete('aizuchi_kashikomari');
    assert.equal(aizuchiConfig(missing, V).aizuchi, null);
});

// 電話を取った瞬間の「ププッ」（約440Hz の澄んだ音）と声を見分ける（録音の実測＝ププッ 0.88・短い「はい」0.11・声 0.01）
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

test('対象の台本の音が揃っていない → 使わない（codex 監査）', () => {
    const notReady = full(); notReady.set('send_material', { ...notReady.get('send_material'), audio_ready: false });
    assert.equal(aizuchiConfig(notReady, V).aizuchi, null);
});
