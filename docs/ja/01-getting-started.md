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
- **Gemini API Key**：[Google AI Studio](https://aistudio.google.com/) から取得します。
- **任意：Google Cloud サービスアカウント JSON**：`/ja_copy` の日本語翻訳を使う場合だけ必要です。

## インストール

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
```

## `.env` の設定

プロジェクトが読む環境変数は次の 5 つだけで、未記載のスイッチはありません。資格情報と権限に関する 4 項目は [`packages/infra/config.ts`](../../packages/infra/config.ts) が解析します。`COPY_NINJIA_DATA_ROOT` は実行時パス定数が確定する前に反映する必要があるため、[`packages/consts/paths.ts`](../../packages/consts/paths.ts) が先に読み取ります。

| 変数 | 必須 | 説明 |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | BotFather が発行した token |
| `GEMINI_API_KEY` | ✅ | Gemini API キー |
| `SUPER_ADMIN_USER_ID` | ✅ | スーパー管理者を表す 1 つの十進ユーザー ID。`/init`、`/ai_chat`、`/switch_mood`、`/send` などはこのユーザーだけを認識します |
| `PRIVILEGED_USERS_ID` | 空でも可 | カンマ区切りの許可ユーザー。copy のクールダウン免除、`/kick` の使用、ほかの Bot の認証保証が可能です |
| `COPY_NINJIA_DATA_ROOT` | 空でも可 | 実行時データのルート。空の場合はプロジェクトルートに保存します。詳細は [07 運用とトラブルシューティング](07-operations.md#データルート) を参照してください |

日本語翻訳を使う場合は、サービスアカウントキーをプロジェクトルートの `g-auth.json` に保存します。`.env` と `g-auth.json` はどちらも `.gitignore` の対象です。

## プロジェクト側の設定ファイル

| ファイル | 内容 | 検証 |
| :--- | :--- | :--- |
| [`prompt/persona.md`](../../prompt/persona.md) | AI チャットの基本ペルソナ | プレーンテキスト、schema なし |
| [`config/stickers.json`](../../config/stickers.json) | AI が使えるスタンプパック、最大 5 個 | [`packages/config/stickers.ts`](../../packages/config/stickers.ts) |
| [`config/reactions.json`](../../config/reactions.json) | AI が使える絵文字リアクション | [`packages/config/reactions.ts`](../../packages/config/reactions.ts) |
| [`config/mood.json`](../../config/mood.json) | ムードの文面、重み、天気・時間帯の倍率 | [`packages/config/mood.ts`](../../packages/config/mood.ts)。重みは正の整数で、合計がちょうど 100 でなければなりません |

3 つの JSON はすべて厳密な schema 検証を受け、起動時のネットワーク接続より前に事前読み込みされます。設定が不正なら該当フィールドを示して起動を拒否し、不完全な状態では実行しません。

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
