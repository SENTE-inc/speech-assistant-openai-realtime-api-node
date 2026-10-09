// Haiku の答えを台本の intent に絞る試験（監査 Low 6）。モデルは呼ばない。
// 一覧に無い intent は null＝呼び手の「知らない intent」の道（設定なし＝fallbackToAgent／設定あり＝intentDef=null）へ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifierIntentNames, sanitizeClassifierResult, decideAfterClassifier,
} from '../../transfer-logic.js';
import { INTENTS, SF_DEFAULT } from './fixtures.mjs';

const names = classifierIntentNames(INTENTS, null);
const namesTs = classifierIntentNames(INTENTS, SF_DEFAULT);

test('台本の intent はそのまま通す', () => {
    for (const i of INTENTS) {
        assert.deepEqual(sanitizeClassifierResult({ intent: i.name }, names), { intent: i.name });
    }
});

test('プロンプトが名指しする reprompt／openai_realtime は通す', () => {
    assert.equal(sanitizeClassifierResult({ intent: 'reprompt' }, names).intent, 'reprompt');
    assert.equal(sanitizeClassifierResult({ intent: 'openai_realtime' }, names).intent, 'openai_realtime');
});

test('wait は設定が在る通話だけ', () => {
    assert.equal(sanitizeClassifierResult({ intent: 'wait' }, names).intent, null);
    assert.equal(sanitizeClassifierResult({ intent: 'wait' }, namesTs).intent, 'wait');
});

test('一覧に無い・文字列でない intent は null（reason=invalid_intent）', () => {
    for (const bad of ['hangup_and_dial', 'TRANSFER', '__proto__', 42, { x: 1 }, ['transfer']]) {
        const r = sanitizeClassifierResult({ intent: bad }, names);
        assert.equal(r.intent, null, `intent=${JSON.stringify(bad)}`);
        assert.equal(r.reason, 'invalid_intent');
    }
});

test('余計な鍵は落とし、callback_info は文字列だけ残す', () => {
    const r = sanitizeClassifierResult({ intent: 'reason', callback_info: '16時頃', end_call: true, action: 'x' }, names);
    assert.deepEqual(r, { intent: 'reason', callback_info: '16時頃' });
    assert.equal(sanitizeClassifierResult({ intent: 'reason', callback_info: { a: 1 } }, names).callback_info, undefined);
});

test('設定が在る通話で知らない intent は取次にならない', () => {
    const r = sanitizeClassifierResult({ intent: 'transfer_now' }, namesTs);
    const d = decideAfterClassifier({ transcript: 'えーと', intentName: r.intent, intentDef: null, ts: SF_DEFAULT, inWait: false });
    assert.notEqual(d.action, 'transfer');
});
