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
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-3817_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-97.65%25-2ea44f?style=flat-square" alt="Coverage"></a>
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
    <img alt="bun run test:coverage — 3817 件のテストが全て成功 / テストファイル 357 件 / expect() 呼び出し 157,155 回 / 関数カバレッジ 97.39% / 行カバレッジ 97.65%" src="../../pictures/coverage_light.svg" width="780">
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
  <p>ユーザーやチャンネルを指定して、そのまま・反転・「nya~」追加で 1 件ずつ復唱し、アバターも同期します。復唱対象は全体で同時に 1 つだけで、コマンドを打った群で復唱します。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 多言語翻訳</b></p>
  <p>復唱とは独立した <code>/translate</code> の群ごと session です。各群で最大 5 人を対象にでき、日本語・簡体字中国語・米国英語・ウクライナ語・ロシア語へそれぞれ翻訳します（英語は Google の地域翻訳 model を使用）。扱うのは文字のみ——同一言語・記号のみ・entity 付きの message はそのままコピーし、API 失敗時もそのままコピーします。媒体と caption は送りません。各群で既定は無効、<code>/translate enable</code> で有効化、<code>list</code> で一覧、<code>stop</code> で群全体または指定した 1 人を停止します。session は <code>state.json</code> に永続化され、再起動後も継続します。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 アバター盗用</b></p>
  <p><code>/copy</code> は対象のアバターを自動同期します。<code>/icon steal</code> なら復唱を開始せずアバターだけコピーします。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🤖 AI チャット</b></p>
  <p>人格に基づき自律的に判断します：発言・sticker・リアクション・画像生成・作曲はすべて tool で、その turn で何をいくつどの順で行うかは model が決めます。画像生成と作曲の tool は、群のメンバーが直接 @ するか bot に返信したときだけ、設定された capability に応じて開放されます。model 層は差し替え可能な provider で、<code>config/agent.json</code> が capability ごとに <code>google</code> か <code>openai</code> を宣言します。capability 間で継承はせず、実行時の failover も行いません。</p>
</td>
<td align="left" valign="top">
  <p><b>👁️ マルチモーダル &amp; 創作</b></p>
  <p>画像・動く sticker・GIF フレーム・音声 message（文字起こしして context へ）を認識し、必要に応じて新しい画像を生成したり既存素材を編集したりします。Gemini 側ではリクエストに応じてボーカル入りの楽曲を 1 曲書き上げ、ジャケットと一緒に群へ投稿できます。</p>
</td>
<td align="left" valign="top">
  <p><b>🔎 リアルタイム事実確認</b></p>
  <p>provider の server side web 検索や東京の天気などの tool に接続します。固定の確認 rule により、時事的な事実はまず検索し、結果を記憶より優先し、根拠が不十分なら不確実だと明示します。Gemini は確認済みの後続 tool turn でより低い sampling temperature を使います。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🧠 コンテキスト記憶</b></p>
  <p>有界の逐語 context と複数 round の圧縮要約を継続的に維持し、返信関係・転送元・正確な引用を保持します。atomic な書き込みにより確実に復元します。</p>
</td>
<td align="left" valign="top">
  <p><b>🎭 気分と人間らしさ</b></p>
  <p>群の気分は 2〜4 時間ごとにランダムで切り替わり、重みは東京の天気と時間帯の影響を受けます。発言前は文字数に応じて入力の間を再現し、たまに打ち間違えてから訂正します。</p>
</td>
<td align="left" valign="top">
  <p><b>💒 グループ内抽選</b></p>
  <p><code>/wed</code> は初期化済みの群でメンバーを 1 人ランダムに選び、アバターと確認・引き直し・解除の button を表示します。使えるのは個人 identity のみで、チャンネル名義や bot は利用できません。1 人につき 1 群で結果を 1 つ保持し、もう一度実行すると引き直します。発言済みメンバー ID は 1 群あたり最大 15 万件まで <code>memory/wed/&lt;chatId&gt;.json</code> へまとめて書き込むため、再起動後も候補は復元されます（結果 session は memory 上のみ）。深夜メンテナンスでメンバー集合を再点検します。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🛡️ 参加認証</b></p>
  <p>新規メンバーには 3 分の button 認証を出します。「私は良民です」は本人だけが押せ、「承認」はその群の非匿名 admin だけが代理で押せます（bot account にはこの経路しかありません）。帰属が確認できる非匿名 admin による招待と、連携チャンネルのコメント欄での活動は免除されます。各群で既定は無効、<code>/antiraid enable</code> で有効化します。</p>
</td>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>参加頻度を監視し、閾値に達したら群の招待を閉じて異常な参加メンバーを処理します。再起動後も状態を復元でき、参加認証と <code>/antiraid</code> という 1 つの switch を共有します。</p>
</td>
<td align="left" valign="top">
  <p><b>📮 広告検出</b></p>
  <p>送信者ごとに message を束ねて継続的に判定へ送り、設定した広告検出 model が判断します。保護対象でない identity が該当した場合は <code>/block</code> と同じ権限で処理し、発生した群に BAN 理由を通知します。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🎲 今日のおみくじ</b></p>
  <p>Inline Mode による決定的な抽選です。日ごとに rotate する HMAC 署名鍵により、再起動後も状態と署名付きの receipt が一致します。</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 複数グループ連携</b></p>
  <p><code>/block</code> 一つで管理下の全群を横断して BAN し、永続 blocklist に書き込みます。以後どの監視対象の群に入っても即 kick され、新しく管理下に入った群も自動で洗い直します。</p>
</td>
<td align="left" valign="top">
  <p><b>💬 chat Q&amp;A</b></p>
  <p><code>/qa set</code> で form を開き、実行者が「問題:」「回答:」の 2 通の message で Q&amp;A を登録します。1 群あたり最大 15 件で、回答には <code>```json</code> code block をそのまま入れられます。一字一句同じ質問が来れば AI を通さず直接答え、意味は近いが字面が異なる質問だけ model の 2 つの照会 tool に委ねます。</p>
</td>
</tr>
</table>

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
