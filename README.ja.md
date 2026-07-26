<div align="center">

<p><a href="README.md">简体中文</a> · <a href="README.en.md">English</a> · <b>日本語</b></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner_light.jpg">
  <img alt="Copy Ninjia バナー" src="docs/assets/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia Bot のアバター"></a>
  Copy Ninjia
</h1>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tagline_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tagline_ja_light.svg">
  <img alt="アバターを盗み、メッセージを真似し、画像を見て、グループを守り、真顔で悪口まで言う Telegram グループチャット Bot" src="docs/assets/tagline_ja_light.svg" width="820">
</picture>

**本番コード、テスト、ドキュメントをすべて AI が書く純 AI 開発プロジェクト** — 人間はアーキテクチャを設計し、AI と共同で全コミットをレビュー

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.3+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
</p>

<p align="center">
  <a href="#pure-ai-development"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#pure-ai-development"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6_/_Opus_5-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/ja/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-1032_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/ja/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-96.46%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

メッセージの復唱と人格模倣は表面にすぎません。その下では、複数の Worker が、障害復旧、上限付きキャッシュ、競合対策を備えたグループチャット自動化システムを支えています。

---

🧬 [純 AI 開発](#pure-ai-development) • ✨ [機能](#features) • 🎭 [Copy モード](#copy-modes) • 🎮 [コマンドと権限](#commands-and-permissions) • 🚀 [クイックスタート](#quick-start) • 📚 [開発者ドキュメント](docs/ja/README.md)

</div>

---

<a id="pure-ai-development"></a>

## 🧬 純 AI 開発

このリポジトリの production コード、テストケース、そして README 自体も、すべて AI が書いています。人間はコードを書きませんが、決して席を外してはいません。アーキテクチャを設計し、すべてのコミットを AI と共同でレビューします。

<table width="100%">
<tr><th width="14%" align="left">工程</th><th width="32%" align="left">担当者</th><th width="54%" align="left">役割</th></tr>
<tr><td>📐&nbsp;設計</td><td><b>Asashishi</b>（本プロジェクト唯一の人間）</td><td>システム境界、Worker 分割、永続化・復元戦略の決定</td></tr>
<tr><td>⌨️&nbsp;実装</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>100% の production コード、テスト、ドキュメントを作成</td></tr>
<tr><td>🧾&nbsp;レビュー</td><td><b>Asashishi</b> × AI</td><td>全コミットを人間と AI が共同レビューしたうえで取り込み</td></tr>
<tr><td>🔬&nbsp;監査</td><td><b>Fable 5</b> · <b>GPT-5.6（Sol）</b> · <b>Opus 5</b> 等の先端モデル</td><td>リポジトリ全体の交差レビューを重ね、指摘項目を堅牢化コミットへ即時還元</td></tr>
<tr><td>🛰️&nbsp;安全演習</td><td>同上の先端モデル群</td><td>クラッシュ復元・競合・悪意ある入力・資源枯渇などのシナリオ演習をすべて通過</td></tr>
</table>

レビューは一回限りの儀式ではありません。毎回のコミットレビュー、先端モデルによるリポジトリ全体の監査、安全演習から得た知見を、新たな制約としてコードへ反映しています。

### 🧪 プロジェクト品質

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/coverage_light.svg">
    <img alt="bun run test:coverage — 1032 件のテストが全て成功 / テストファイル 132 件 / expect() 呼び出し 8,870 回 / 関数カバレッジ 94.44% / 行カバレッジ 96.46%" src="docs/assets/coverage_light.svg" width="780">
  </picture>
</p>

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
  <p>Gemini ペルソナに基づいて応答します。リアルタイム検索やツール呼び出しを統合し、テキスト、スタンプ、リアクションを処理します。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ マルチモーダル & 画像生成</b></p>
  <p>画像、動くスタンプ、GIF フレームを理解し、要求に応じて新規画像生成や既存素材の編集を実行。</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 コンテキスト記憶</b></p>
  <p>上限付きの逐語コンテキストと複数ラウンドの圧縮要約を保持し、多層の返信チェーンを追跡します。アトミックな永続化により確実に復元できます。</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ 参加認証</b></p>
  <p>新規メンバーに 90 秒のボタン認証を提供します。人間は本人だけがクリックでき、Bot アカウントに限り許可リストのユーザーが代理認証できます。招待者を特定できる非匿名管理者からの招待と、連携ディスカッショングループでの活動は免除されます。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>参加頻度を監視し、閾値に達するとグループへの招待を停止して異常な参加者を処置します。再起動後も状態を復元できます。</p>
</td>
<td align="left" valign="top">
  <p><b>🎲 今日のおみくじ</b></p>
  <p>Inline Mode による決定論的なくじ引きです。日ごとに切り替わる HMAC 署名鍵により、再起動後も状態と署名レシートの一貫性を保ちます。</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 複数グループ連携</b></p>
  <p><code>/block</code> コマンドで Bot が管理者である全グループから対象を同期 BAN し、さらに id を永続ブロックリストへ記録。以降は監視中のどのグループに入室しても即 kick され、あるグループで「管理者権限がある」と「初期化済み」が揃った瞬間には（どちらが先でも）、すでに在室しているリスト該当者もまとめて掃除します。こうして統合防衛線を形成します。</p>
</td>
</tr>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="copy-modes"></a>

## 🎭 Copy モード

copy 対象はグローバルで唯一です。1 つのインスタンスは同時に 1 つの対象にしか「変身」できませんが、copy 自体はコマンドを実行したグループでのみ発生します。`/stop_copy` は任意のグループから停止できます。

| コマンド | 挙動 |
| :---: | :--- |
| `/copy` | メッセージをそのまま復唱 |
| `/r_copy` | 書記素クラスタ単位でテキストを反転 |
| `/nya_copy` | テキストの末尾に「nya~」を追加 |
| `/ja_copy` | Google Cloud Translate で日本語翻訳してから復唱 |
| `/steal_icon` | アバターのみコピー |
| `/stop_copy` | グローバル copy 状態を停止 |

対象は「メッセージへの返信」または `@username` で指定します。ユーザー名での検索には、Bot がそのアカウントを以前に観測している必要があります。改名、ユーザー名の削除、ユーザー名の再割り当てが行われると、古い別名は直ちに無効になります。匿名管理者が現在のグループとして発言した場合、そのグループ自体が copy 対象となるため、グループのアバターを取得してその「外見」を再現できます。`/block` は現在のグループをメンバー対象として扱うことを拒否します。`/block` のような破壊的操作では、過去のユーザー名に頼らず対象メッセージへの返信を優先してください。一般ユーザーの copy 系コマンドには 5 分間のグローバル cooldown があり、`PRIVILEGED_USERS_ID` の許可リストは対象外です。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="commands-and-permissions"></a>

## 🎮 コマンドと権限

<table width="100%">
<tr><th width="26%" align="left">コマンド</th><th width="19%" align="center">権限</th><th width="55%" align="left">説明</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">メンバー</td><td>各 copy モードを開始</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">メンバー</td><td>現在のグローバル copy を停止</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">メンバー</td><td>アバターのみ取得</td></tr>
<tr><td><code>/&lt;漢字 1~2 文字&gt;</code></td><td align="center">メンバー</td><td>アクションコマンド。<code>/咬</code> や <code>/贴贴</code> で「実行者 咬了 対象！」と応答。名前は first_name last_name 形式で、公開ユーザー名があればプロフィールへリンク</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">メンバー</td><td>自発的発言を N 分間停止（既定 3 分）</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">メンバー</td><td>静寂モードを早期解除</td></tr>
<tr><td><code>/block</code></td><td align="center"><code>PRIVILEGED_USERS_ID</code></td><td>ブロックリスト登録：永続的に記録し、全管理グループで BAN。以降は監視中のグループに入室しても即 kick</td></tr>
<tr><td><code>/unblock</code> <code>/unblock … all</code></td><td align="center"><code>PRIVILEGED_USERS_ID</code><br>（<code>all</code> は <code>SUPER_ADMIN_USER_ID</code> のみ）</td><td>ブロックリストから id を削除（リスト全体をファイルへ原子的に書き直し）。以降の入室で即 kick されなくなります。既定では各グループの BAN はそのまま。<code>all</code> を付けると全管理グループで BAN も解除します</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>このグループの AI チャットを切り替え</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>AI 有効グループの気分を即時再抽選して応答</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>日本語翻訳機能を切り替え（既定 OFF）</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>このグループの主要処理ゲートを切り替え</td></tr>
<tr><td><code>/send &lt;group_id&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code>（PM 限定）</td><td>Bot との個人チャットから指定グループへの転送セッションを開始/終了</td></tr>
</table>

`/send` は開始前に対象へ到達できるか確認します。転送中に対象へ到達できなくなった場合はセッションを終了し、スーパー管理者へ通知します。転送状態は `state.json` に保存され、再起動後も復元されます。このコマンドは Telegram のコマンドメニューには表示されず、グループ内や他のユーザーから呼び出されても応答しません。

> [!TIP]
> 漢字 1~2 文字のアクションコマンド（`/咬`、`/贴贴` など）は事前登録が不要で、どの漢字でも使えます。対象の指定方法は他のコマンドと同じで、返信または `@username` です。Telegram のコマンド名は ASCII（ラテン文字・数字・アンダースコア）のみのため、コマンドメニューにも補完にも現れません。メニューにはプレースホルダー項目 `/x` だけを置いています。コマンド名の `x` がその変数であり、任意の漢字 1~2 文字に置き換えることを示します。実行しても何も起こらず、通常メッセージとして AI/copy pipeline へ流れることもないよう意図的に握り潰します。`/咬人人` のような 3 文字以上はアクションコマンドとして扱わず、通常のメッセージ処理へ流します。登録不要で誰でも自由に作れるため、グローバルな sliding window 制限があり、グループ・ユーザーを合算して 90 秒あたり最大 450 回まで応答します。超過分は通知なしで黙って破棄されます。

> [!TIP]
> `/luck_challenge` はスラッシュコマンドではありません。任意のチャットで `@Botのユーザー名 [お願い]` と入力して Inline Mode を使用します。BotFather で Inline Mode を有効にし、`/setinlinefeedback` を 100% に設定することをお勧めします。Inline query にはグローバルな sliding window 制限があり、応答は 90 秒あたり最大 300 回です。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="quick-start"></a>

## 🚀 クイックスタート

### 1. 環境

- Linux（読み取り可能な `/proc` が必要。ほかのプラットフォームではインスタンスロックが fail closed）
- Bun 1.3+
- Telegram Bot Token
- Gemini API Key
- Google Cloud サービスアカウント JSON（`/ja_copy` 使用時のみ）

<details>
<summary><b>📦 ハードウェア構成の目安</b>（展開して表示）</summary>

<table width="100%">
<tr><th width="33%" align="left">規模</th><th width="26%" align="left">推奨スペック</th><th width="41%" align="left">備考</th></tr>
<tr><td>入門（低アクティブ、テキスト中心）</td><td>2 vCPU / 2 GB RAM / ローカル SSD</td><td>動作可能ですがメディアピーク時は CPU 競合が発生します</td></tr>
<tr><td>軽量本番（テキスト中心）</td><td>4 vCPU / 2 GB RAM / ローカル SSD</td><td>2 GB はメディア処理ピーク時のメモリ確保に適しません</td></tr>
<tr><td>推奨本番（1,000〜3,000 人規模のアクティブグループ約 15 個）</td><td>4 vCPU / 4 GB RAM / ローカル SSD</td><td>—</td></tr>
<tr><td>全群 AI 有効かつ画像・スタンプ多数</td><td>4 vCPU / 8 GB RAM</td><td>メディア処理と Base64 符号化に十分な余裕を確保</td></tr>
</table>

単一インスタンスでは、上記規模のアクティブグループを約 15 個以内に抑えることを推奨します。主な制約は総メンバー数ではなく、単一の Telegram Bot API、Gemini の quota、実際のメッセージ/メディア流量です。

</details>

### 2. インストール

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
```

### 3. 設定

[`.env.example`](.env.example) にしたがって `.env` を記入します。`TELEGRAM_BOT_TOKEN`、`GEMINI_API_KEY`、10 進数のユーザー ID を 1 つ指定する `SUPER_ADMIN_USER_ID` は必須です。`PRIVILEGED_USERS_ID` は空でも構いません。複数の ID は半角カンマで区切ります。

`COPY_NINJIA_DATA_ROOT` を指定すると、実行時データを別のルートへ配置できます。設定時は `state.json`、`bot.lock`、`logs/`、`memory/` がそのディレクトリから派生します。ペルソナ、スタンプ、リアクション、気分の設定と `g-auth.json` は引き続きプロジェクトルートから読み込みます。未指定の場合、実行時データはプロジェクトルートに置かれます。

日本語翻訳を使用する場合は、サービスアカウントキーを `g-auth.json` としてプロジェクトルートに保存します。`.env` と `g-auth.json` はどちらも `.gitignore` の対象です。

Telegram 側の設定：

1. BotFather で Bot Privacy Mode を OFF にする。
2. グループで Bot に管理者権限（削除、BAN、管理）を付与する。
3. Inline Mode を有効にする。
4. inline feedback を 100% に設定する。

### 4. 起動と確認

```bash
bun run check     # プロジェクト規約 + ESLint + TypeScript 厳格検査 + coverage test
bun run start     # ロングポーリング起動
```

Bot を初めてグループに追加した後、`SUPER_ADMIN_USER_ID` がグループ内で以下を実行します：

```text
/init enable
/ai_chat enable
```

> **言語について**：ユーザー向けの文言は簡体中国語のみで、本リポジトリは i18n を維持しません。応答は断片の連結で組み立てつつ Telegram `entities` のオフセットを算出しており、`/咬` のような中国語アクションコマンドは中国語の字形自体に依存しているため、語彙表では受け止められません。別の言語が必要な場合は fork して自分で書き換えてください（production コードに中国語の文字列リテラルが 52 ファイルへ約 525 箇所、ほかに `prompt/persona.md` と `config/*.json`）。理由と手順は [06 変更レシピ](docs/ja/06-modification-guide.md) にあります。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="development"></a>

## 📚 開発者ドキュメントとアーキテクチャガイド

Copy Ninjia のアーキテクチャ概要、モジュールマップ、実行時の正式な不変条件、テストフロー、運用マニュアルは、**[開発者ドキュメント TOP](docs/ja/README.md)** にまとめています：

| トピック | 内容と概要 | リンク |
| :--- | :--- | :---: |
| 🏗️ **アーキテクチャ** | メインスレッド + 3 Worker トポロジー、メッセージ処理と起動・停止順序 | [📖 02 アーキテクチャ](docs/ja/02-architecture.md) |
| 🗺️ **ソースコード案内** | `packages/` 各サブドメインの役割分担とコード配置ツリー | [📖 03 ディレクトリマップ](docs/ja/03-directory-map.md) |
| ⚡ **権威的不変条件** | モジュール間状態隔離、並行上限、アトミック保存契約 | [📖 04 権威的不変条件](docs/ja/04-invariants.md) |
| 🧪 **開発とテスト** | `bun run check` 品質ゲート、テスト環境隔離と障害注入スイート | [📖 05 開発フロー](docs/ja/05-dev-workflow.md) |
| 🛠️ **変更レシピ** | コマンド追加、パラメータ調整、AI ツール追加、schema 移行手順 | [📖 06 変更レシピ](docs/ja/06-modification-guide.md) |
| 🛡️ **運用マニュアル** | systemd デプロイ、`COPY_NINJIA_DATA_ROOT`、バックアップとトラブルシューティング | [📖 07 運用マニュアル](docs/ja/07-operations.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/footer_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/footer_ja_light.svg">
  <img alt="Copy Ninjia — 単に真似をするだけでなく、チャット現場を丸ごと盗んで演じ直す。" src="docs/assets/footer_ja_light.svg" width="750">
</picture>

*人間は 1 行もコードを書きませんが、決して舞台を降りませんでした。設計図を描いた後も、すべてのコミットを AI と共同でレビューしています。*

</div>
