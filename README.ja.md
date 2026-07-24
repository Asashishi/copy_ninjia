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

**コードの 100% を AI が書いた純 AI 開発プロジェクト** — 人間はアーキテクチャを設計し、AI と共同で全コミットをレビュー

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.3+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
</p>

<p align="center">
  <a href="#pure-ai-development"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#pure-ai-development"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/ja/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-794_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/ja/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-95.78%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

メッセージの copy と人格模倣は表面にすぎません。その下には、複数 Worker、復元機能、上限付き cache、競合対策を備えたグループチャット自動化システムがあります。

---

🧬 [純 AI 開発](#pure-ai-development) • ✨ [機能](#features) • 🎭 [Copy モード](#copy-modes) • 🎮 [コマンドと権限](#commands-and-permissions) • 🚀 [クイックスタート](#quick-start) • 📚 [開発者ドキュメント](docs/ja/README.md)

</div>

---

<a id="pure-ai-development"></a>

## 🧬 純 AI 開発

このリポジトリの production コード、テストケース、そして README 自体も、すべて AI が書いています。人間はコードを書きませんが、決して席を外してはいません。アーキテクチャを設計し、すべてのコミットを AI と共同でレビューします。

<table width="100%">
<tr><th width="14%" align="left">工程</th><th width="32%" align="left">担当者</th><th width="54%" align="left">実績</th></tr>
<tr><td>📐&nbsp;設計</td><td><b>Asashishi</b>（本プロジェクト唯一の人間）</td><td>システム境界、Worker 分割、永続化・復元戦略の決定</td></tr>
<tr><td>⌨️&nbsp;実装</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>100% の production コード、テスト、ドキュメントを作成</td></tr>
<tr><td>🧾&nbsp;レビュー</td><td><b>Asashishi</b> × AI</td><td>全コミットを人間と AI が共同レビューしたうえで取り込み</td></tr>
<tr><td>🔬&nbsp;監査</td><td><b>Fable 5</b> · <b>GPT-5.6（Sol）</b> 等の先端モデル</td><td>リポジトリ全体の交差レビューを重ね、指摘項目を堅牢化コミットへ即時還元</td></tr>
<tr><td>🛰️&nbsp;安全演習</td><td>同上の先端モデル群</td><td>クラッシュ復元・競合・悪意ある入力・資源枯渇などのシナリオ演習をすべて通過</td></tr>
</table>

レビューは一回限りの儀式ではありません。毎回のコミットレビューと先端モデルによる全倉監査の結論が、新しい制約条件としてコードへ回流しています。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="features"></a>

## ✨ 機能

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 高精度な復唱</b></p>
  <p>ユーザーやチャンネルを固定してメッセージを真似します。通常、反転、「nya~」追加、日本語翻訳の 4 モードに対応。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 アバター盗用</b></p>
  <p><code>/copy</code> でアバターを自動同期。<code>/steal_icon</code> で copy 状態に入らずアバターのみ複製も可能。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI チャット</b></p>
  <p>Gemini ペルソナに基づく応答。リアルタイム検索やツール呼び出しを統合し、テキスト/スタンプ/リアクションを処理。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ マルチモーダル & 画像生成</b></p>
  <p>画像、動くスタンプ、GIF フレームを理解し、要求に応じて新規画像生成や既存素材の編集を実行。</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 コンテキスト記憶</b></p>
  <p>75〜150 件の文脈と要約圧縮を保持。多層の返信チェーンを追跡し、アトミック永続化により信頼高く復元。</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ 参加認証</b></p>
  <p>新規メンバーに 90 秒のボタン認証を提供。ホワイトリストによる代行承認や非匿名管理者の招待免除に対応。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>参加頻度を監視し、閾値を超えると招待を自動ロックして不審者を処置。再起動後も無縫に状態を復元。</p>
</td>
<td align="left" valign="top">
  <p><b>🎲 今日のおみくじ</b></p>
  <p>Inline Mode による決定論的くじ引き。日次ハッシュ鍵により、再起動後も状態と署名レシートの一貫性を保持。</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 複数グループ連携</b></p>
  <p><code>/kick</code> コマンドで Bot が管理者である全グループから対象を同期 BAN し、統合防衛線を形成。</p>
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
| `/r_copy` | 書素クラスタ単位でテキストを反転 |
| `/nya_copy` | テキストの末尾に「nya~」を追加 |
| `/ja_copy` | Google Cloud Translate で日本語翻訳してから復唱 |
| `/steal_icon` | アバターのみコピー |
| `/stop_copy` | グローバル copy 状態を停止 |

対象は「メッセージへの返信」または `@username` で指定します。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="commands-and-permissions"></a>

## 🎮 コマンドと権限

<table width="100%">
<tr><th width="26%" align="left">コマンド</th><th width="19%" align="center">権限</th><th width="55%" align="left">説明</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">メンバー</td><td>各 copy モードを開始</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">メンバー</td><td>現在のグローバル copy を停止</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">メンバー</td><td>アバターのみ取得</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">メンバー</td><td>自発的発言を N 分間停止（既定 3 分）</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">メンバー</td><td>静寂モードを早期解除</td></tr>
<tr><td><code>/kick</code></td><td align="center"><code>PRIVILEGED_USERS_ID</code></td><td>全管理グループで対象を永久 BAN</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>このグループの AI チャットを切り替え</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>AI 有効グループの気分を即時再抽選して応答</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>日本語翻訳機能を切り替え（既定 OFF）</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>業務処理入口を切り替え</td></tr>
<tr><td><code>/send &lt;group_id&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code> (PM限定)</td><td>Bot との DM から指定グループへの転送を開始/終了</td></tr>
</table>

> [!TIP]
> `/luck_challenge` は斜杠コマンドを消費しません。任意のチャットで `@Botのユーザー名 [お願い]` を入力して Inline Mode を使用します。BotFather で Inline Mode を有効にし、`/setinlinefeedback` を 100% に設定することをお勧めします。

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="quick-start"></a>

## 🚀 クイックスタート

### 1. 環境

- Linux（読み取り可能な `/proc` が必要）
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
<tr><td>推奨本番（1000-3000 人規模 15 アクティブ群）</td><td>4 vCPU / 4 GB RAM / ローカル SSD</td><td>—</td></tr>
<tr><td>全群 AI 有効かつ画像・スタンプ多数</td><td>4 vCPU / 8 GB RAM</td><td>メディア処理と Base64 符号化に十分な余裕を確保</td></tr>
</table>

</details>

### 2. インストール

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
```

### 3. 設定

[`.env.example`](.env.example) にしたがって `.env` を記入します。`TELEGRAM_BOT_TOKEN`、`GEMINI_API_KEY`、`SUPER_ADMIN_USER_ID` は必須です。

日本語翻訳を使用する場合は、サービスアカウントキーを `g-auth.json` としてプロジェクトルートに保存します。

Telegram 側の設定：
1. BotFather で Bot Privacy Mode を OFF にする。
2. グループで Bot に管理者権限（削除、BAN、管理）を付与する。
3. Inline Mode を有効にする。
4. inline feedback を 100% に設定する。

### 4. 起動と確認

```bash
bun run check     # ESLint + TypeScript 厳格検査 + 全テスト
bun run start     # ロングポーリング起動
```

グループ追加後、`SUPER_ADMIN_USER_ID` がグループ内で以下を実行します：

```text
/init enable
/ai_chat enable
```

<p align="right"><sub><a href="#copy-ninjia">⬆️ ページ上部へ</a></sub></p>

<a id="development"></a>

## 📚 開発者ドキュメントとアーキテクチャガイド

Copy Ninjia の詳細なアーキテクチャ概要、モジュールマップ、実行時権威的不変条件、テストフロー、運用マニュアルは、すべて **[開発者ドキュメント TOP](docs/ja/README.md)** にまとめています：

| トピック | 内容と概要 | 直達リンク |
| :--- | :--- | :---: |
| 🏗️ **アーキテクチャ** | メインスレッド + 3 Worker トポロジー、メッセージ処理と起動・停止順序 | [📖 02 アーキテクチャ](docs/ja/02-architecture.md) |
| 🗺️ **ソースコード案内** | `src/` 13 サブモジュールの役割分担とコード配置ツリー | [📖 03 ディレクトリマップ](docs/ja/03-directory-map.md) |
| ⚡ **権威的不変条件** | モジュール間状態隔離、並行上限、アトミック保存契約 | [📖 04 権威的不変条件](docs/ja/04-invariants.md) |
| 🧪 **開発とテスト** | `bun run check` 品質ゲート、テスト環境隔離と障害注入スイート | [📖 05 開発フロー](docs/ja/05-dev-workflow.md) |
| 🛠️ **変更レシピ** | コマンド追加、パラメータ調整、AI ツール追加、Schema 移行手順 | [📖 06 変更レシピ](docs/ja/06-modification-guide.md) |
| 🛡️ **運用マニュアル** | systemd デプロイ、`COPY_NINJIA_DATA_ROOT`、バックアップと排障 | [📖 07 運用マニュアル](docs/ja/07-operations.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/footer_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/footer_ja_light.svg">
  <img alt="Copy Ninjia — 単に真似をするだけでなく、チャット現場を丸ごと盗んで演じ直す。" src="docs/assets/footer_ja_light.svg" width="750">
</picture>

*人間は 1 行もコードを書きませんが、決して舞台を降りませんでした。設計図を描いた後も、すべてのコミットを AI と共同でレビューしています。*

</div>
