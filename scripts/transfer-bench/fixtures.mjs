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

// 試験の例＝判定の試験（decide.test.mjs・Haiku の答えを固定）とモデルの比較（model-bench.mjs・本物のモデルに聞く）で共有
// [発話, Haiku の答え, 待機の外での最終の動作（on_wait=wait）]
// intent＝その意図の声を流して切る（否定）／answer＝答えて聞く
export const OUTSIDE_WAIT = [
    // 本人・取次の明言 → 取次
    ['担当者に代わります。', 'transfer', 'transfer'],
    ['はい、今変わります。', 'transfer', 'transfer'],
    ['担当の者にお繋ぎいたします。', 'transfer', 'transfer'],
    ['私が担当ですが。', 'transfer', 'transfer'],
    ['はい、私が代表の山田です。', 'transfer', 'transfer'],
    ['責任者の佐藤に代わりますね。', 'transfer', 'transfer'],
    ['社長ですけど、どういったお話ですか。', 'transfer', 'transfer'],
    ['あ、私で大丈夫ですよ。お伺いします。', 'transfer', 'transfer'],
    ['店長の田中ですが。', 'transfer', 'transfer'],
    ['はい、お電話代わりました、山田です。', 'transfer', 'transfer'],
    ['あーはいはい、じゃあ代わりますね。', 'transfer', 'transfer'],
    // これから呼ぶ・待たせる → 待機（Haiku が transfer でも wait でも、迷って realtime でも）
    ['お繋ぎしますので少々お待ちください。', 'transfer', 'wait_enter'],
    ['担当に代わりますので少々お待ちください。', 'transfer', 'wait_enter'],
    ['オーナーいますので、ちょっと呼んできます。', 'transfer', 'wait_enter'],
    ['ちょっとお待ちくださいね、今呼びます。', 'transfer', 'wait_enter'],
    ['少々お待ちください。', 'transfer', 'wait_enter'],
    ['少々お待ちください。', 'wait', 'wait_enter'],
    ['少々お待ちください。', 'openai_realtime', 'wait_enter'],
    ['少々お待ちいただけますか。', 'wait', 'wait_enter'],
    ['お待ちください。', 'transfer', 'wait_enter'],
    ['確認しますので少々お待ちください。', 'wait', 'wait_enter'],
    ['ちょっと待ってくださいね。', 'wait', 'wait_enter'],
    ['少々お待ちくださいませ。', 'reprompt', 'wait_enter'],
    // 相づち・聞き取れない → 聞き返し
    ['あ。', 'reprompt', 'reprompt'],
    ['はい。', 'transfer', 'reprompt'],
    ['もしもし。', 'reprompt', 'reprompt'],
    ['お待たせしました。', 'transfer', 'reprompt'],
    ['すみません、もう一度お願いします。', 'reprompt', 'reprompt'],
    ['ご視聴ありがとうございました。', 'reprompt', 'reprompt'],
    ['♪', 'reprompt', 'reprompt'],
    ['(音楽)', 'reprompt', 'reprompt'],
    // 質問 → 答える
    ['どのようなご用件でしょうか。', 'reason', 'answer'],
    ['どちらの会社様ですか。', 'company', 'answer'],
    ['アポイントはございますか。', 'appointment', 'answer'],
    ['折り返しお電話させましょうか。', 'callback_request', 'answer'],
    ['確認しますので、ご用件を教えてください。', 'reason', 'answer'],
    // 不在・断り → 切る（待たせる言い回しや引き継ぎの言い回しが混ざっていても否定が勝つ）
    ['担当者は本日不在にしております。', 'not_available', 'intent'],
    ['担当は外出中で、夕方には戻ります。', 'callback_scheduled', 'intent'],
    ['あいにく担当の者が席を外しておりまして。', 'not_available', 'intent'],
    ['そういうのは結構です。', 'rejected', 'intent'],
    ['間に合ってますので。', 'rejected', 'intent'],
    ['営業のお電話はお断りしております。', 'rejected', 'intent'],
    ['代表は今いないんですよ。', 'not_available', 'intent'],
    ['社長は出張中です。', 'not_available', 'intent'],
    ['お断りしますので少々お待ちください。', 'rejected', 'intent'],
    ['担当者はいません、代わりに伝えます。', 'not_available', 'intent'],
    ['お電話代わりましたが、お断りします。', 'rejected', 'intent'],
    // 取次にしない（Haiku が取次と言っても関門で止める）
    ['代わりに伝えておきます。', 'transfer', 'reprompt'],
    ['私がですか？', 'transfer', 'reprompt'],
    ['私が受付です。', 'transfer', 'reprompt'],
    // 当てはまらない → 自由会話（今どおり）
    ['担当者がわからないんですけど。', 'openai_realtime', 'realtime'],
    ['私ではわかりかねます。', 'openai_realtime', 'realtime'],
    ['資料をメールで送ってもらえますか。', 'openai_realtime', 'realtime'],
];

// [発話, Haiku の答え, 待機中の最終の動作（保留明けは締める＝after_wait_strict=true）]
export const IN_WAIT = [
    ['はい。', 'reprompt', 'continue_wait'],
    ['もしもし。', 'reprompt', 'continue_wait'],
    ['お待たせしました。', 'transfer', 'continue_wait'],
    ['はい、お電話代わりました、山田です。', 'transfer', 'transfer'],
    ['お待たせしました、担当の山田です。', 'transfer', 'transfer'],
    ['はい、私が担当ですが。', 'transfer', 'transfer'],
    ['少々お待ちください。', 'wait', 'continue_wait'],
    ['すみません、もう少々お待ちください。', 'transfer', 'continue_wait'],
    ['(音楽)', 'reprompt', 'continue_wait'],
    ['ご視聴ありがとうございました。', 'openai_realtime', 'continue_wait'],
    ['申し訳ありません、担当は不在でした。', 'not_available', 'intent'],
    ['やっぱり結構です。', 'rejected', 'intent'],
    ['すみません、ご用件をもう一度よろしいですか。', 'reason', 'answer'],
    ['代わりに伝えておきます。', 'transfer', 'continue_wait'],
    ['担当が戻りましたらお伝えします。', 'openai_realtime', 'continue_wait'],
];

// 版6（DB 142）の既定＝受付の言葉は「保留音が鳴ったらつなぐ」・言葉なしの保留音はつなぐ・本人の名乗りはすぐつなぐ・はい/もしもしはつながない
export const V2_DEFAULT = {
    ...SF_DEFAULT,
    id: '77777777-7777-7777-7777-777777777777',
    v2: true,
    on_wait: 'transfer',
    on_words: 'hold',
    on_hold_without_words: true,
    on_handover: true,
    hold_music_seconds: 4,
    hold_music_record_only: false,
    handover_phrases: ['私が担当', '担当です', '代わりました', '替わりました', '変わりました', '代表です', '私が代表', '社長です', '店長です', '責任者です', '本人です', '私で大丈夫', '担当の＊です', '代表の＊です', '社長の＊です', '店長の＊です', '責任者の＊です', 'オーナーの＊です'],
    transfer_phrases: ['詳しく聞かせて', '詳しく聞きたい', '興味があります', '興味あります', '聞かせてください'],
    wait_phrases: ['少々お待ち', 'お待ちください', 'お待ちいただけ', 'ちょっと待って', '確認します', '呼んできます', '今呼びます', '呼びますので', '担当に代わ', '担当者に代わ', 'お繋ぎ', 'おつなぎ', '代わります', '替わります', '変わります'],
};

