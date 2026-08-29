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
  <a href="#pure-ai-development"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6_/_Opus_5-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-2893_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-97.20%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

メッセージの復唱と人格模倣は表面にすぎません。その下では、複数の Worker が、障害復旧、上限付きキャッシュ、競合対策を備えたグループチャット自動化システムを支えています。

---

🧬 [純 AI 開発](#pure-ai-development) • ✨ [機能](#features) • 🎮 [コマンドと権限](#commands-and-permissions) • 🚀 [クイックスタート](#quick-start) • 📚 [開発者ドキュメント](conntent-table.md)

</div>

---

<a id="pure-ai-development"></a>

## 🧬 純 AI 開発

このリポジトリの production コード、テストケース、そして README 自体も、すべて AI が書いています。人間はコードを書きませんが、決して席を外してはいません。アーキテクチャを設計し、すべてのコミットを AI と共同でレビューします。

<table width="100%">
<tr><th width="18%" align="left">工程</th><th width="32%" align="left">担当者</th><th width="50%" align="left">役割</th></tr>
<tr><td>📐&nbsp;設計</td><td><b>Asashishi</b>（本プロジェクト唯一の人間）</td><td>システム境界、Worker 分割、永続化・復元戦略の決定</td></tr>
<tr><td>⌨️&nbsp;実装</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>100% の production コード、テスト、ドキュメントを作成</td></tr>
<tr><td>🧾&nbsp;レ&#8288;ビ&#8288;ュ&#8288;ー</td><td><b>Asashishi</b> × AI</td><td>全コミットを人間と AI が共同レビューしたうえで取り込み</td></tr>
<tr><td>🔬&nbsp;監査</td><td><b>Fable 5</b> · <b>GPT-5.6（Sol）</b> · <b>Opus 5</b> 等の先端モデル</td><td>リポジトリ全体の交差レビューを重ね、指摘項目を堅牢化コミットへ即時還元</td></tr>
<tr><td>🛰️&nbsp;安&#8288;全&#8288;演&#8288;習</td><td>同上の先端モデル群</td><td>クラッシュ復元・競合・悪意ある入力・資源枯渇などのシナリオ演習をすべて通過</td></tr>
</table>

レビューは一回限りの儀式ではありません。毎回のコミットレビュー、先端モデルによるリポジトリ全体の監査、安全演習から得た知見を、新たな制約としてコードへ反映しています。

### 🧪 プロジェクト品質

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../pictures/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../../pictures/coverage_light.svg">
    <img alt="bun run test:coverage — 2893 件のテストが全て成功 / テストファイル 294 件 / expect() 呼び出し 96,561 回 / 関数カバレッジ 96.37% / 行カバレッジ 97.20%" src="../../pictures/coverage_light.svg" width="780">
  </picture>
</p>

ベンチマークの計測値（コールド/ホットパス · 総スループットと総 I/O · エンドツーエンドのチェーン遅延）は **[📊 09 パフォーマンスベンチマーク](09-performance.md)** にあります。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="features"></a>

## ✨ 機能

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 高精度な復唱</b></p>
  <p>ユーザーやチャンネルを指定してメッセージを復唱します。そのまま、反転、「nya~」追加、日本語翻訳の 4 モードに対応します。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 アバター盗用</b></p>
  <p><code>/copy</code> でアバターを自動同期。<code>/steal_icon</code> で copy 状態に入らずアバターのみ複製も可能。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI チャット</b></p>
  <p>ペルソナに基づく自律行動。発言、スタンプ、リアクション、画像生成、作曲はすべてツールで、そのラウンドで何をいくつどの順に行うかはモデル自身が決めます。画像・楽曲ツールは、メンバーが Bot を直接 @ または返信したラウンドだけ、設定済み capability に従って公開されます。モデル層は差し替え可能な provider です。<code>config/agent.json</code> の各 capability が <code>google</code> か <code>openai</code> を自分で宣言し、capability 間の継承も実行時の failover もありません。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ マルチモーダル & 創作</b></p>
  <p>画像、動くスタンプ、GIF フレーム、そして音声メッセージ（逐語で文字起こしして文脈に取り込み）を理解し、要求に応じて新規画像生成や既存素材の編集を実行。Gemini 側ではリクエストに応じてボーカル入りの 1 曲を書き上げ、カバー画像ごとグループへ投稿します。</p>
</td>
<td align="left" valign="top">
  <p><b>🔎 リアルタイム事実確認</b></p>
  <p>provider 側のサーバー検索や東京の天気などのツールに接続。固定ルールにより、変化する事実は先に検索し、結果を記憶より優先し、根拠が足りなければ不確実だと明示します。Gemini は検索後の後続ツールラウンドで低い sampling temperature を使います。</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 コンテキスト記憶</b></p>
  <p>上限付きの逐語コンテキストと複数ラウンドの圧縮要約を保持し、多層の返信チェーンを追跡します。アトミックな永続化により確実に復元できます。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🎭 気分と人間らしさ</b></p>
  <p>グループの気分は 2〜4 時間ごとに再抽選され、東京の天気と時間帯で重み付けされます。発言前には文字数に応じた入力の間を挟み、たまにタイプミスして直します。</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ 参加認証</b></p>
  <p>新規メンバーに 3 分間のボタン認証。人間は本人だけがクリックでき、Bot アカウントに限り許可リストのユーザーが代理認証できます。招待者を特定できる非匿名管理者からの招待と、連携ディスカッショングループでの活動は免除されます。グループごとに既定で無効で、<code>/antiraid enable</code> で有効化します。</p>
</td>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>参加頻度を監視し、閾値に達するとグループへの招待を停止して異常な参加者を処置します。再起動後も状態を復元できます。参加認証と <code>/antiraid</code> という 1 つのスイッチを共用します。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>📮 広告検出</b></p>
  <p>送信者ごとにメッセージ列へまとめて継続的に送信し、設定した広告検出 model が判定。protected identity 以外が命中した場合は <code>/block</code> と同じ処分を行います。</p>
</td>
<td align="left" valign="top">
  <p><b>🎲 今日のおみくじ</b></p>
  <p>Inline Mode による決定論的なくじ引きです。日ごとに切り替わる HMAC 署名鍵により、再起動後も状態と署名レシートの一貫性を保ちます。</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 複数グループ連携</b></p>
  <p><code>/block</code> 一つで管理下の全グループから同期 BAN し、id を永続ブロックリストへ記録。以降は監視中のどのグループに入室しても即 kick され、新たに管理者になったグループも自動で掃除します。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>💬 chat Q&amp;A</b></p>
  <p><code>/set_qa</code> は form を開き、開いた本人が「問題:」「回答:」の 2 通で質問と回答を登録します（chat ごとに最大 15 件、回答には <code>```json</code> block も入れられます）。一字一句同じ質問が来れば AI を介さず即答し、登録文と字面が異なる言い回しだけを model の 2 つの照会 tool に委ねます。</p>
</td>
<td align="left" valign="top"></td>
<td align="left" valign="top"></td>
</tr>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="commands-and-permissions"></a>

## 🎮 コマンドと権限

コマンドは 4 段階です：**グループメンバー**（Copy 系、アクションコマンド、静音モード、`/bot_status` など）、**ホワイトリストの権限キー**（`/mute`、`/gag`、`/block`、各機能スイッチ）、**`SUPER_ADMIN_USER_ID` 専用**（`/init`、`/white`、`/permission`、`/batch_kick`）、そして個人チャットでのみ動作する `/send`。

Copy の対象はグローバルに 1 つだけで、`/copy` 系はコマンドを実行したグループで 1 通ずつ復唱しアイコンも同期します。`/luck_challenge` は Inline Mode、中国語のアクションコマンド（`/咬`、`/揪住`）は事前登録不要です。

完全なコマンド表、権限の読み方、コマンドごとの挙動は **[📖 08 コマンドと挙動リファレンス](08-commands.md)** にあります。

<p align="right"><sub><a href="#copy-ninjia">⬆️ トップへ戻る</a></sub></p>

<a id="quick-start"></a>

## 🚀 クイックスタート

必要なものは Linux（`/proc` が読めること。他の OS ではインスタンスロックが fail closed になります）、Bun 1.4+、Bot Token、スーパー管理者のユーザー ID です。有効化する AI 機能ごとにその provider の API Key が要り、`/ja_copy` には Google Cloud サービスアカウント JSON も必要です。ハードウェアの目安は [07 運用とトラブルシュート](07-operations.md#ハードウェアの目安) を参照してください。

ワンショット install（足りないものを導入し、設定を尋ねてそのまま起動）：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

順に 4 つ行います。環境の準備（`git`/`curl`/`unzip` の補完、Bun の導入、`bun install`）、**GitHub の
Latest Release** を `./copy_ninjia` へ clone、Telegram と AI 設定の対話的な入力、そして空の identity
database 作成と systemd unit の登録・起動。入れるのは `master` HEAD ではなく公開済み release です。
tag は実行時に `releases/latest` へ問い合わせ、取得できなければその場で失敗します（`master` へ黙って
フォールバックしません）。既存の設定は上書きせず、既存の systemd unit は上書き前に確認するため、再実行
しても安全です。すでに clone 済みなら repository root で `bash install.sh` を実行すれば clone を飛ばし、
その work tree の checkout はそのまま残します。ソースが release アーカイブの展開（ソースはあるが `.git`
が無い）の場合は、その場に git repository を作り、現在のファイルと一致する tag に `HEAD` を向けるので、
以後 git で更新できます。この作成は work tree のファイルを一切書かず、deployment データを object store に
取り込むこともありません。

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

Copy Ninjia のアーキテクチャ概要、モジュールマップ、実行時の正式な不変条件、テストフロー、運用マニュアルは、**[開発者ドキュメント TOP](conntent-table.md)** にまとめています：

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
