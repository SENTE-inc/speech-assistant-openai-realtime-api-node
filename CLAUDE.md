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
- remote＝`git@github.com:SENTE-inc/speech-assistant-openai-realtime-api-node.git`。**ブランチは `main`**（2026-07-31 実測・作業ツリーはクリーン）。⚠過去に `feat/operator-voice-sets` 等で作業していた時期があるので、**push 前に `git branch --show-current` を確認する**習慣は残す。
- 🗑**worktree は無い**（2026-07-31 実測＝`git worktree list` は本体1つだけ。`~/speech-assistant-...-voicepreview-wt` は 2026-07-27 の棚卸しで撤去済）。**再び worktree を切ったら「片方で切ったブランチはもう片方でチェックアウトできない」に注意。**
- 秘匿値はリポに無い（`.env.example` のみ）。**本番の値は Railway の環境変数**＝ローカルの `.env` を正だと思わない。

## 🔴 語彙
- UI 上の呼び名は「**録音**」。コード内の概念名と客向けの表示が食い違うので、Tom や客に説明する時は UI の語で話す。
- ホストは **Railway**（n8n は載せない）。デプロイは Tom の GO。
- アクセス制御まわりで迷ったら、ダッシュボード側（`~/outbound-dashboard/`）は **Google のテストユーザーではなく Supabase の `user_profiles`** が正。
