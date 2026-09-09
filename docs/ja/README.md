<div align="center">

<p><a href="../../README.md">简体中文</a> · <a href="../en/README.md">English</a> · <b>日本語</b></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/banner_light.jpg">
  <img alt="Copy Ninjia バナー" src="../../pictures/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="アバターをクリックしてサンプル Bot を開く"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia サンプル Bot のアバター"></a>
  Copy Ninjia
</h1>

<p><sub>アバターをクリックすると、サンプル Bot に移動できます：<a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/tagline_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/tagline_ja_light.svg">
  <img alt="アバターを盗み、メッセージを真似し、画像を見て、グループを守り、真顔で悪口まで言う Telegram グループチャット Bot" src="../../pictures/tagline_ja_light.svg" width="820">
</picture>

**本番コード、テスト、ドキュメントをすべて AI が書く純 AI 開発プロジェクト** — 人間はアーキテクチャを設計し、AI と共同で全コミットをレビュー

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.4+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Database-SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
  <a href="https://platform.openai.com/docs/"><img src="../../pictures/openai_badge.svg" alt="OpenAI"></a>
</p>

<p align="center">
  <a href="#pure-ai-development"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#pure-ai-development"><img src="https://img.shields.io/badge/Audits-Fable--5.1_/_Gpt--6--astra-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-3865_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-97.7%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="../../LICENSES/LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

メッセージの復唱と人格模倣は表面にすぎません。その下では、複数の Worker が、障害復旧、上限付きキャッシュ、競合対策を備えたグループチャット自動化システムを支えています。

---

🧬 [純 AI 開発](#pure-ai-development) • ✨ [機能](#features) • 🎮 [コマンドと権限](#commands-and-permissions) • 🚀 [クイックスタート](#quick-start) • 📚 [開発者ドキュメント](content-table.md)

</div>

---

<a id="pure-ai-development"></a>

## 🧬 純 AI 開発

このリポジトリの production コード、テストケース、そして README 自体も、すべて AI が書いています。人間はコードを書きませんが、決して席を外してはいません。アーキテクチャを設計し、すべてのコミットを AI と共同でレビューします。

<table width="100%">
<tr><th width="18%" align="left">工程</th><th width="32%" align="left">担当者</th><th width="50%" align="left">役割</th></tr>
<tr><td>📐&nbsp;設計</td><td><b>Asashishi</b></td><td>システム境界、Worker 分割、永続化・復元戦略の決定</td></tr>
<tr><td>⌨️&nbsp;実装</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>100% の production コード、テスト、ドキュメントを作成</td></tr>
<tr><td>🧾&nbsp;レ&#8288;ビ&#8288;ュ&#8288;ー</td><td><b>Asashishi</b> × AI</td><td>全コミットを人間と AI が共同レビューしたうえで取り込み</td></tr>
<tr><td>🔬&nbsp;監査</td><td><b>Fable-5.1</b> · <b>Gpt-6-astra</b> 等の先端モデル</td><td>リポジトリ全体の交差レビューを重ね、指摘項目を堅牢化コミットへ即時還元</td></tr>
<tr><td>🛰️&nbsp;安&#8288;全&#8288;演&#8288;習</td><td>同上の先端モデル群</td><td>クラッシュ復元・競合・悪意ある入力・資源枯渇などのシナリオ演習をすべて通過</td></tr>
</table>

レビューは一回限りの儀式ではありません。毎回のコミットレビュー、先端モデルによるリポジトリ全体の監査、安全演習から得た知見を、新たな制約としてコードへ反映しています。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

## 🧪 プロジェクト品質

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../pictures/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../../pictures/coverage_light.svg">
    <img alt="bun run test:coverage — 3865 件のテストが全て成功 / テストファイル 363 件 / expect() 呼び出し 157,287 回 / 関数カバレッジ 97.54% / 行カバレッジ 97.7%" src="../../pictures/coverage_light.svg" width="780">
  </picture>
</p>

ベンチマークの計測値（コールド/ホットパス · 総スループットと総 I/O · エンドツーエンドのチェーン遅延）は **[📊 09 パフォーマンスベンチマーク](09-performance.md)** にあります。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="features"></a>

## ✨ 機能

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 高精度な復唱</b><br>
  <sub>対象を 1 つ固定し、その発言を 1 件ずつ復唱してアバターも同期。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 多言語翻訳</b><br>
  <sub>群ごとに翻訳 session を開き、以後の発言を 5 言語へ翻訳。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 アバター盗用</b><br>
  <sub>復唱は始めず、相手のアバターだけを自分に写します。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI チャット</b><br>
  <sub>話すかどうかも何の tool を使うかも人格が自分で決めます。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>👁️ マルチモーダル &amp; 創作</b><br>
  <sub>画像と音声を理解し、画像や楽曲を作って群へ返します。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🔎 リアルタイム事実確認</b><br>
  <sub>事実が要るときは web 検索や天気 tool を自分で呼びます。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🧠 コンテキスト記憶</b><br>
  <sub>逐語 context を保ち、溢れた分は圧縮要約にして引き継ぎます。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🎭 気分と人間らしさ</b><br>
  <sub>気分が時間で切り替わり、入力中の間を置いてから返します。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💒 グループ内抽選</b><br>
  <sub>発言したことのあるメンバーを 1 人選び、アバターを表示。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🛡️ 参加認証</b><br>
  <sub>新規メンバーは制限時間内に button を押さないと退出させます。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🚨 Anti-Raid</b><br>
  <sub>参加頻度が異常なら私密モードへ切り替え、招待権限を回収。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>📮 広告検出</b><br>
  <sub>連続する message を束ねて判定し、広告なら即削除して処理。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🎲 今日のおみくじ</b><br>
  <sub>Inline Mode で抽選し、同じ人の同じ日は結果が変わりません。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 複数グループ連携</b><br>
  <sub>1 つの command で、管理下の複数の群を横断して BAN します。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💬 chat Q&amp;A</b><br>
  <sub>登録済みの質問に当たれば、AI を通さずそのまま答えます。</sub></p>
</td>
</tr>
</table>

各機能の挙動・設定・境界は **[📚 開発者ドキュメント](content-table.md)** を参照してください。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="commands-and-permissions"></a>

## 🎮 コマンドと権限

コマンドは 4 段階です：**グループメンバー**（Copy 系、アクションコマンド、静音モード、`/bot_status` など）、**ホワイトリストの権限キー**（`/mute`、`/gag`、`/block`、各機能スイッチ）、**`SUPER_ADMIN_USER_ID` 専用**（`/init`、`/white`、`/permission`、`/batch_kick`）、そして個人チャットでのみ動作する `/send`。

Copy の対象はグローバルに 1 つだけで、`/copy` 系はコマンドを実行したグループで 1 通ずつ復唱しアイコンも同期します。`/luck_challenge` は Inline Mode、中国語のアクションコマンド（`/咬`、`/揪住`）は事前登録不要です。

`/wed` は初期化済みグループの個人アカウントに対応し、ランダムな相手のアイコンと確認・変更・削除ボタンを表示します。各グループは発言済みメンバー ID を最大 15 万件保持し、実際の増減をまとめて `memory/wed/<chatId>.json` に保存して再起動時に復元します。結果のセッションはメモリ内だけに保持します。コマンドとボタンは全体で同時 32 件まで処理し、共通の出力キューと 429 待機を使います。

完全なコマンド表、権限の読み方、コマンドごとの挙動は **[📖 08 コマンドと挙動リファレンス](08-commands.md)** にあります。

<p align="right"><sub><a href="#copy-ninjia">⬆️ トップへ戻る</a></sub></p>

<a id="quick-start"></a>

## 🚀 クイックスタート

必要なものは Linux（`/proc` が読めること。他の OS ではインスタンスロックが fail closed になります）、Bun 1.4.2、Bot Token、スーパー管理者のユーザー ID です。有効化する AI 機能ごとにその provider の API Key が要り、`/translate` には Google Cloud サービスアカウント JSON も必要です。ハードウェアの目安は [07 運用とトラブルシュート](07-operations.md#ハードウェアの目安) を参照してください。

ワンショット install（足りないものを導入し、設定を尋ねてそのまま起動）：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

installer は **GitHub Latest Release** を取得して対象 tree 自身の script に処理を渡し、既存 tree の checkout は保持します。指定された Bun 版と lock 済み依存関係を確認し、Telegram・AI の設定入力と、不足する身分 database の初期化を行います。既存設定は明示的な再入力時だけ、バックアップと検証を経て原子的に置換します。最後に systemd unit を登録または再利用して稼働を観察し、systemd が無い場合は前面実行します。ディレクトリ指定とバックアップ保持は [環境構築](01-getting-started.md) を参照してください。

手動 install：

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
cp -n config_example/*.json config/   # telegram.json の bot_token と super_admin_user_id を記入
bun run check                          # 規約 + ESLint + TypeScript 厳格チェック + カバレッジ + hot path gate
bun run start                          # ロングポーリング開始
```

手動 install の場合、初回起動の前に identity database の初期化と、BotFather 側での Privacy Mode
無効化・Inline Mode 有効化も必要です。設定項目の意味、必須の組み合わせ、厳格な検証ルールは
[`config_example/README/ja.md`](../../config_example/README/ja.md)、手順の全体（ランタイム data root、
素材の直リンク、移行コマンド）は [01 環境構築と初回起動](01-getting-started.md) にあります。

Bot をグループに追加したら、`SUPER_ADMIN_USER_ID` がそのグループで実行します：

```text
/init enable
/ai_chat enable
/antiraid enable
```

> **言語について**：ユーザー向けの文言は簡体字中国語のみで、リポジトリは i18n レイヤーを持ちません。
> 理由と変更方法は [06 変更レシピ](06-modification-guide.md) を参照してください。

<p align="right"><sub><a href="#copy-ninjia">⬆️ トップへ戻る</a></sub></p>

## 📚 開発者ドキュメントとアーキテクチャガイド

Copy Ninjia のアーキテクチャ概要、モジュールマップ、実行時の正式な不変条件、テストフロー、運用マニュアルは、**[開発者ドキュメント TOP](content-table.md)** にまとめています：

| トピック | 内容と概要 | リンク |
| :--- | :--- | :---: |
| 🏗️ **アーキテクチャ** | メインスレッド + 3 Worker トポロジー、メッセージ処理と起動・停止順序 | [📖 02 アーキテクチャ](02-architecture.md) |
| 🗺️ **ソースコード案内** | `packages/` 各サブドメインの役割分担とコード配置ツリー | [📖 03 ディレクトリマップ](03-directory-map.md) |
| ⚡ **権威的不変条件** | モジュール間状態隔離、並行上限、アトミック保存契約 | [📖 04 権威的不変条件](04-invariants.md) |
| 🧪 **開発とテスト** | `bun run check` 品質ゲート、テスト環境隔離と障害注入スイート | [📖 05 開発フロー](05-dev-workflow.md) |
| 🛠️ **変更レシピ** | コマンド追加、パラメータ調整、AI ツール追加、schema 移行手順 | [📖 06 変更レシピ](06-modification-guide.md) |
| 🛡️ **運用マニュアル** | systemd デプロイ、ハードウェアの目安、`COPY_NINJIA_DATA_ROOT`、バックアップとトラブルシューティング | [📖 07 運用マニュアル](07-operations.md) |
| 🎮 **コマンド** | 全コマンド、権限の読み方、挙動の詳細 | [📖 08 コマンドリファレンス](08-commands.md) |
| 📊 **パフォーマンス** | リリースごとに再計測するコールド/ホットパス、スループット、I/O、チェーン遅延 | [📖 09 パフォーマンス](09-performance.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/footer_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/footer_ja_light.svg">
  <img alt="Copy Ninjia — 単に真似をするだけでなく、チャット現場を丸ごと盗んで演じ直す。" src="../../pictures/footer_ja_light.svg" width="750">
</picture>

*人間は 1 行もコードを書きませんが、決して舞台を降りませんでした。設計図を描いた後も、すべてのコミットを AI と共同でレビューしています。*

</div>
