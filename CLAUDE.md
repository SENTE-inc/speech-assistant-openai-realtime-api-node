<!--
役割 = このリポを触った時だけ自動ロードされる地雷リスト。
ドメインの正は ~/sente/sente_aivoice_canonical.md。
-->

# speech-assistant — 架電エージェント本体（Twilio × OpenAI Realtime）

**ドメインは SENTE。家は `~/sente/sente_aivoice_canonical.md`。**基盤も SENTE（GitHub `SENTE-inc`／Railway／Supabase SENTE org の `outbound call`）。
🔴 **架電の実体は `~/sente/` に在る**（設計・WF・契約・金額とも）。**Sales Forge は「月¥33,000 を払う客」1社**で、`~/sales-forge/` を開いても架電の実体は見つからない〔2026-08-02 移管〕。⚠ **SENTE 本業（取込／請求／原価／ダッシュ）とも別プロダクト**＝データも entity も混ぜない。

## 🔴 外向き（ここが最大の地雷）
- **実行すると実際に電話が鳴る。**テストのつもりの1本も外部への発信。**架電は毎回 Tom の明示 GO。**
- 顧客への自動送信・自動架電の常設化はしない。出口は社内に返す。
- **JP の 050番号は取得済み**＝`+81 50-1785-7330`（Bundle `twilio-approved`・2026-09-08 承認／🔬2026-09-10 に Twilio API で再確認）。**「番号が無い」を前提に話を組まない。**

## 🔴 リポの状態
- remote＝`git@github.com:SENTE-inc/speech-assistant-openai-realtime-api-node.git`。**push 前に `git branch --show-current` を確認する**＝`feat/operator-voice-sets` のような作業ブランチに居ることがある。
- 🗑**worktree は無い**（2026-07-31 実測＝`git worktree list` は本体1つだけ。`~/speech-assistant-...-voicepreview-wt` は 2026-07-27 の棚卸しで撤去済）。**再び worktree を切ったら「片方で切ったブランチはもう片方でチェックアウトできない」に注意。**
- 秘匿値はリポに無い（`.env.example` のみ）。**本番の値は Railway の環境変数**＝ローカルの `.env` を正だと思わない。`OPENAI_API_KEY` は `outbound call project` の専用鍵（keychain `openai-api-key-aivoice`）＝ログに `Whisper error: 401 … invalid_organization` が出たらこの鍵を疑う（症状＝受付が何を言っても聞き返す）。
- **本番へ出す＝GitHub の `main` への push**（Railway が `main` を自動デプロイ）＝作業ブランチを早送りで `main` へ。
- **取次の判定を触る前**＝言い回しは2か所（台本の `call_intents.triggers` と `TRANSFER_EVIDENCE_PATTERNS`）で、足す時は両方／自由会話（`switchToRealtime`）は片道＝取次に戻らない。家＝`~/sente/sfav_operator_voice_sets_spec.md` の罠・AI Voice の家 §3-3「🚀」④。
- 作業の先端ブランチと本番への出し方＝家の §3-3「🚀 本番への出し方」（ここに焼かない）。
- 🔴🔴 **声のファイルは名前と中身の形式が一致しない**＝`call-audio` の名前は全部 `.mp3` だが、`sente` の肉声の中身は m4a（先頭 `ftyp`）。ffmpeg に渡す形式は `detectAudioFormat`（先頭バイト＝mp3／wav／mp4）で決める。**形式を絞る変更は、使用中の全クリップの先頭バイトを数えてから出す**（mp3／wav だけにすると肉声が全部無音になる）。家＝`~/sente/sfav_operator_voice_sets_spec.md` の罠。
- 🔴🔴 **env の名前は、コードが読む側で確かめる。**発信の From＝**プロジェクトの番号（`phone_numbers`・`feat/phone-numbers` 以降）→ 無ければ `TWILIO_FROM_NUMBER`（`index.js`・2026-09-10 に 050 を設定）→ それも無ければハードコードの米国番号 `+1 831-273-4595`**。⚠ **Railway には別名の `TWILIO_PHONE_NUMBER` も残っているが、どこからも読まれていない**＝「Railway に番号の env が在る」を根拠に From が正しいと判断しない。⚠ **From はログに出ない**＝効いたかは **env の在否＋デプロイ成功＋コードが読む名前**の3点で判定する。
- ⚠ **番号の `VoiceUrl` は発信に効かない**＝`placeOutboundCall` が Twilio に `Url` を毎回明示して渡すため。`VoiceUrl` が効くのは**折り返しの着信**だけ（050 は現在 未設定）。
- 🔴🔴 **`VoiceUrl` を `/incoming-call` に向けない。**`/incoming-call` は**発信専用の入口**で、`tenant_id` を query string でしか受け取らない。折り返しの着信には query が無いので `loadPlaybook('')` が `null` → `endCallWithFarewell('error_limit')`＝**かけてきた相手を「それでは失礼いたします」で切る。**着信は取次の作り直し（`~/sente/sente_aivoice_canonical.md` §3-2）の側で設計する。⚠ **米国番号 `+1 831-273-4595` は既にこの形で `/incoming-call` に向いている**（そちらに折り返す人はいないので実害は未観測）。

## 🔴 語彙
- UI 上の呼び名は「**録音**」。コード内の概念名と客向けの表示が食い違うので、Tom や客に説明する時は UI の語で話す。
- ホストは **Railway**（n8n は載せない）。デプロイは Tom の GO。
- アクセス制御まわりで迷ったら、ダッシュボード側（`~/outbound-dashboard/`）は **Google のテストユーザーではなく Supabase の `user_profiles`** が正。
