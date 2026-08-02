# 01 環境構築と初回起動

<p align="center">
  <a href="../01-getting-started.md">简体中文</a> · <a href="../en/01-getting-started.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="README.md">📚 開発者ドキュメント TOP</a> · <b>← 前のページ：なし</b> · <a href="02-architecture.md">次のページ：02 アーキテクチャ →</a>
</p>

---

このページでは、まっさらな環境から「Bot がグループ内で正常に動作する」状態までを最短手順で案内します。各手順の設計上の理由は [02 アーキテクチャ概要](02-architecture.md) を参照してください。

## 前提条件

- **`/proc` を読み取れる Linux**：インスタンスロックは `/proc/<pid>/stat` と boot ID に依存します。ほかのプラットフォームでは fail-closed で起動を拒否します。
- **Bun 1.3+**：`curl -fsSL https://bun.sh/install | bash` でインストールします。すべてのスクリプト、テスト、実行環境は Bun を使用し、Node.js は不要です。
- **Telegram Bot Token**：[@BotFather](https://t.me/BotFather) で `/newbot` を実行して作成します。
- **任意：Gemini API Key**：[Google AI Studio](https://aistudio.google.com/) から取得します。`/ai_chat` の AI 雑談を使う場合だけ必要です。
- **任意：DeepSeek API Key**：[DeepSeek プラットフォーム](https://platform.deepseek.com/) から取得します。`/ad_detect` の広告検出を使う場合だけ必要です。Gemini の鍵とは責務が重ならず、互いに fallback しません。
- **任意：Google Cloud サービスアカウント JSON**：`/ja_copy` の日本語翻訳を使う場合だけ必要で、プロジェクトルートに `g-auth.json` として保存します。欠落や破損時は `/ja_copy` がこのファイルを名指しして拒否し、自動 copy の ja 変換は通常の copy に退化します。いずれかのチャットで `/ja_copy enable` が有効なままなら起動を拒否します。

## インストール

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
cp -r config_example config
```

## `.env` の設定

プロジェクトが読む環境変数は次の 5 つだけで、未記載のスイッチはありません。変数名は担当する機能を先頭に付けており（`AI_CHAT_` / `AD_DETECT_`）、欠けた鍵はその機能だけを止めます。資格情報と identity に関する 4 項目は [`packages/infra/config.ts`](../../packages/infra/config.ts) が解析します。`COPY_NINJIA_DATA_ROOT` は実行時パス定数が確定する前に反映する必要があるため、[`packages/consts/paths.ts`](../../packages/consts/paths.ts) が先に読み取ります。

- **`TELEGRAM_BOT_TOKEN`**（必須）
  - BotFather が発行した token。
- **`AI_CHAT_GEMINI_API_KEY`**（空でも可）
  - AI 雑談の返信生成・画像理解・記憶圧縮専用の Gemini API キー。空の場合は
    AI Worker が起動せず、`/ai_chat enable`、`/query_mood`、`/switch_mood` は拒否されます。
    ディスク上の AI 記憶はそのまま保持し、ほかの機能は通常どおり動作します。
- **`AD_DETECT_DEEPSEEK_API_KEY`**（空でも可）
  - OpenAI 互換の `/ad_detect` 判定に使う DeepSeek API キー。空の場合は
    `/ad_detect enable` が拒否され、ほかの機能はそのまま動作します。
- **`SUPER_ADMIN_USER_ID`**（必須）
  - スーパー管理者を表す 1 つの十進ユーザー ID。すべての command permission を
    持ち、`/init`、`/batch_kick`、`/permission` の変更操作、`/white`、`/send` は
    このユーザーだけが使えます。allowlist identity は `/permission query` で自身の
    permission を照会し、`/permission help` で説明を確認できます。
- **`COPY_NINJIA_DATA_ROOT`**（空でも可）
  - 実行時データのルート。空の場合はプロジェクトルートに保存します。詳細は
    [07 運用とトラブルシューティング](07-operations.md#データルート) を参照してください。

日本語翻訳を使う場合は、サービスアカウントキーをプロジェクトルートの `g-auth.json` に保存します。`.env` と `g-auth.json` はどちらも `.gitignore` の対象です。

## プロジェクト側の設定ファイル

`config/` は deployment 固有の設定ディレクトリで、Git の追跡対象外です。初回だけ `config_example/` からコピーし、その後は `config/` だけを編集してください。example ディレクトリは実行時設定ではありません。

- **[`prompt/persona.md`](../../prompt/persona.md)**
  - **内容**：AI チャットの基本ペルソナ。
  - **検証**：プレーンテキスト、schema なし。
- **`config/whitelist.json`**（[example](../../config_example/whitelist.json)）
  - **内容**：ユーザー／チャンネル allowlist と個別 permission。membership 自体も
    copy cooldown 免除、Bot 認証の代行保証、自動処分からの保護を与えます。
  - **検証**：
    [`packages/config/whitelist.ts`](../../packages/config/whitelist.ts)。network
    接続前に厳密ロードし、欠落・破損時は起動を拒否します。
- **`config/blocklist.json`**（[example](../../config_example/blocklist.json)）
  - **内容**：deployment が手動管理する静的ユーザー／チャンネル blocklist ID。
  - **検証**：
    [`packages/config/blocklist.ts`](../../packages/config/blocklist.ts)。network
    接続前に厳密ロードし、動的な `memory/` layer と結合します。
- **`config/stickers.json`**（[example](../../config_example/stickers.json)）
  - **内容**：AI が使えるスタンプパック、最大 5 個。
  - **検証**：[`packages/config/stickers.ts`](../../packages/config/stickers.ts)。
- **`config/reactions.json`**（[example](../../config_example/reactions.json)）
  - **内容**：AI が使える絵文字リアクション。
  - **検証**：[`packages/config/reactions.ts`](../../packages/config/reactions.ts)。
- **`config/mood.json`**（[example](../../config_example/mood.json)）
  - **内容**：ムードの文面、重み、天気・時間帯の倍率。
  - **検証**：[`packages/config/mood.ts`](../../packages/config/mood.ts)。重みは正の整数で、
    合計がちょうど 100 でなければなりません。
- **`config/ad_samples.json`**（[example](../../config_example/ad_samples.json)）
  - **内容**：広告検出の判定基準となる例文。ファイル自体が文字列配列です。
  - **検証**：
    [`packages/config/adSamples.ts`](../../packages/config/adSamples.ts)。空文字と重複は
    不可、最大 500 件です。

`whitelist.json` と `blocklist.json` は global security boundary なので、network 接続や Worker 起動より前に厳密ロードします。残り 4 つの JSON は feature ごとに遅延検証します。壊れたスタンプ設定 1 つのために copy、抽選、入室認証、blocklist まで同時に停止させないためです。`/ai_chat enable` は前 3 つの optional file、`/ad_detect enable` は `ad_samples.json`、`/ja_copy enable` は `g-auth.json` を読み、読めなければ対応する toggle だけを拒否します。結果は process 単位で cache されるため、修復後は再起動が必要です。

### 2.1.0 からのアップグレード

旧 process を停止し、`config/` 全体を先に backup してください。3.0.0 以降、この directory は Git の追跡対象外になるため、worktree を更新すると旧 release が追跡していた 4 file は削除されます。更新後、backup から `stickers.json`、`reactions.json`、`mood.json`、`ad_samples.json` を戻し、`config_example/` から `whitelist.json` と `blocklist.json` を追加します。

旧 `.env` の `PRIVILEGED_USERS_ID` にある各 ID を `whitelist.json` の key へ手動移行し、その環境変数を削除します。copy cooldown 免除、Bot 認証の代行保証、自動処分からの保護だけが必要なら値は空 object `{}` で構いません。旧 `/block` と `/unblock` の能力を維持するには `"isCanBlock": true` と `"isCanUnBlock": true` を明示し、その他は必要な permission だけ有効にします。allowlist identity は `/permission help` で全 key と説明を確認し、`/permission query` で default 適用後の自身の完全な permission を照会できます。`/white` と `/permission` の変更操作はこの file を atomic rewrite するため、runtime user には `config/` directory の write permission が必要です。その他の設定は read-only のままで構いません。

**例外として、機能が有効なままの場合は従来どおり起動を拒否します。** `state.json` の `true` は管理者が明確に有効化したものであり、これを黙って「何もしない」状態に格下げすると、グループからは Bot がある再起動を境に雑談・広告検出・翻訳をやめたようにしか見えません。そこで起動時に一度だけ照合します。いずれかのチャットで有効なままの任意機能は、資格情報と設定が揃っていなければならず、欠けていればチャット id と欠落項目を示して起動を拒否します（[`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts) を参照）。対処は前提を復旧するか、取り除く前に `/ai_chat disable`、`/ad_detect disable`、`/ja_copy disable` を実行することです。

## Telegram 側の設定（BotFather とグループ）

1. `/setprivacy` で Privacy Mode を無効にします。有効なままだと通常のグループメッセージを取得できず、copy と AI メモリが機能しません。
2. Bot をグループに追加し、メッセージ削除、メンバーの BAN、グループ管理の管理者権限を与えます。参加認証と Anti-Raid は必要な権限がある場合だけ動作します。
3. `/setinline` で Inline Mode を有効にします。運勢抽選の `@Bot 所求事項` に必要です。
4. `/setinlinefeedback` を 100% に設定します。`chosen_inline_result` が抽選結果の確認と永続化の主経路で、メッセージ内の署名付き receipt は補助確認経路です。

## 初回起動

```bash
bun run check     # 規約 + ESLint + tsc + 全ソースカバレッジ。最初に環境が正常か確認
bun run start     # ロングポーリングを開始
```

起動に成功したら、`SUPER_ADMIN_USER_ID` が対象グループで次を実行します。

```text
/init enable      # グループの業務処理入口を有効化。未初期化グループの通常 update はゲートウェイで破棄されます
/ai_chat enable   # 任意：このグループの AI チャットを有効化
/ad_detect enable # 任意：広告検出を有効化。Bot がこのグループの管理者のときだけ実際に発火します
```

## 動作確認

- 誰かのメッセージに返信して `/copy` を送ると、Bot がそのユーザーの copy とアバター同期を開始します。
- エラーが発生すると `logs/` にログファイルが作られます。エラーがなければ空のままの場合があります。`state.json` は最初の正式な状態変更後に作成されます。
- `Ctrl+C` で停止すると、入口の quiesce、各キューの drain、状態の flush を行ってから正常終了します。

データルートの事前検査、`bot.lock`、state 検証による起動失敗は意図的な fail-fast です。[07 運用とトラブルシューティング](07-operations.md#起動失敗の調査) に従って対応してください。

---

<div align="center">

**← 前のページ：なし** · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#01-環境構築と初回起動) · [次のページ：02 アーキテクチャ →](02-architecture.md)

</div>
