// 取次の判定の試験に使う物＝意図の行（本番の「既存の架電先」の声セットと同じ形・2026-10-05 に DB から写した）と、
// SF の会社の既定に入れる設定（DB 140 の後に入れる行と同じ中身＝seed-sf-default.sql と揃える）。
// 家＝~/sente/sfav_transfer_tuning_plan.md §1-h

export const INTENTS = [
    { name: 'transfer', action: 'play_audio', audio_key: 'transfer_success', is_transfer: true, end_call: false },
    { name: 'reason', action: 'play_audio', audio_key: 'reason', is_transfer: false, end_call: false },
    { name: 'company', action: 'play_audio', audio_key: 'company', is_transfer: false, end_call: false },
    { name: 'who', action: 'play_audio', audio_key: 'company', is_transfer: false, end_call: false },
    { name: 'appointment', action: 'play_audio', audio_key: 'appointment', is_transfer: false, end_call: false },
    { name: 'callback_request', action: 'play_audio', audio_key: 'callback_request', is_transfer: false, end_call: false },
    { name: 'callback_scheduled', action: 'play_audio', audio_key: 'callback_request', is_transfer: false, end_call: true, end_reason: 'callback_scheduled', wants_callback_info: true },
    { name: 'not_available', action: 'play_audio', audio_key: 'sorry_disturb', is_transfer: false, end_call: true, end_reason: 'not_available' },
    { name: 'rejected', action: 'play_audio', audio_key: 'sorry_disturb', is_transfer: false, end_call: true, end_reason: 'rejected' },
    { name: 'reprompt', action: 'reprompt', audio_key: null, is_transfer: false, end_call: false },
    { name: 'openai_realtime', action: 'openai_realtime', audio_key: null, is_transfer: false, end_call: false },
];
export const INTENT_BY_NAME = new Map(INTENTS.map((i) => [i.name, i]));

export const SF_DEFAULT = {
    id: '00000000-0000-0000-0000-000000000000',
    scope: 'tenant',
    version: 1,
    transfer_phrases: [
        'お繋ぎ', 'おつなぎ', '代わります', '替わります', '変わります',
        '担当に代わ', '担当者に代わ', '担当に変わ', '担当者に変わ',
        '代わりました', '替わりました', '変わりました',
        '担当です', '私が担当', '担当の', '責任者', '代表です', '私が代表', '代表の',
        '社長です', '社長の', '店長の', 'オーナーの', '本人です', '私です', '私で大丈夫',
        '詳しく聞かせて', '詳しく聞きたい', '興味があります', '興味あります', '聞かせてください', 'お伺いします',
    ],
    block_phrases: ['代わりに伝え', '代わりに承', '代わりにご用件', '代わりにお伺い', '代わりにお聞き'],
    wait_phrases: ['少々お待ち', 'お待ちください', 'お待ちいただけ', 'ちょっと待って', '確認します', '呼んできます', '今呼びます', '呼びますので'],
    on_wait: 'wait',
    wait_max_seconds: 90,
    after_wait_strict: true,
};
