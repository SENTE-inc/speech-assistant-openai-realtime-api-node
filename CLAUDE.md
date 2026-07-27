<!--
役割 = このリポを触った時だけ自動ロードされる地雷リスト。
ドメインの正は ~/sales-forge/README.md ＋ ~/sales-forge/CLAUDE.md。
-->

# speech-assistant — 架電エージェント本体（Twilio × OpenAI Realtime）

**ドメインは Sales Forge**（`~/sales-forge/CLAUDE.md` の規約が効く）。基盤は SENTE アカウント上（GitHub `SENTE-inc`／Railway／Supabase SENTE org の `outbound call`）だが、**SENTE 本業とはドメインが別**。

## 🔴 外向き（ここが最大の地雷）
- **実行すると実際に電話が鳴る。**テストのつもりの1本も外部への発信。**架電は毎回 Tom の明示 GO。**
- 顧客への自動送信・自動架電の常設化はしない。出口は社内に返す。
- **日本の電話番号は Twilio の Regulatory Bundle（本人確認書類）が通らないと取れない。**番号が無いのは実装の欠陥ではない。

## 🔴 リポの状態
- remote＝`git@github.com:SENTE-inc/speech-assistant-openai-realtime-api-node.git`。**現在のブランチは `main` ではない**（`feat/operator-voice-sets` 等）。push 先を確認してから push する。
- 同じリポの **worktree が別ディレクトリにある**（`~/speech-assistant-...-voicepreview-wt`）。片方で切ったブランチはもう片方でチェックアウトできない。
- 秘匿値はリポに無い（`.env.example` のみ）。**本番の値は Railway の環境変数**＝ローカルの `.env` を正だと思わない。

## 🔴 語彙
- UI 上の呼び名は「**録音**」。コード内の概念名と客向けの表示が食い違うので、Tom や客に説明する時は UI の語で話す。
- ホストは **Railway**（n8n は載せない）。デプロイは Tom の GO。
- アクセス制御まわりで迷ったら、ダッシュボード側（`~/outbound-dashboard/`）は **Google のテストユーザーではなく Supabase の `user_profiles`** が正。
