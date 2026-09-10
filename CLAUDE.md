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
- 秘匿値はリポに無い（`.env.example` のみ）。**本番の値は Railway の環境変数**＝ローカルの `.env` を正だと思わない。
- 🔴🔴 **env の名前は、コードが読む側で確かめる。**発信の From は **`TWILIO_FROM_NUMBER`**（`index.js`）だが、**Railway に在る変数は `TWILIO_PHONE_NUMBER`＝別名でどこからも読まれていない。**∴ 既定のハードコード**米国番号 `+1 831-273-4595` で発信し続けている**（🔬2026-09-10 実測）。**「Railway に番号の env が在る」を根拠に From が正しいと判断しない。**
- ⚠ **番号の `VoiceUrl` は発信に効かない**＝`placeOutboundCall` が Twilio に `Url` を毎回明示して渡すため。`VoiceUrl` が効くのは**折り返しの着信**だけ（050 は現在 未設定＝折り返しても繋がらない）。

## 🔴 語彙
- UI 上の呼び名は「**録音**」。コード内の概念名と客向けの表示が食い違うので、Tom や客に説明する時は UI の語で話す。
- ホストは **Railway**（n8n は載せない）。デプロイは Tom の GO。
- アクセス制御まわりで迷ったら、ダッシュボード側（`~/outbound-dashboard/`）は **Google のテストユーザーではなく Supabase の `user_profiles`** が正。
