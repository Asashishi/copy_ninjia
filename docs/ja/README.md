<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/tagline_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../assets/tagline_ja_light.svg">
  <img alt="Copy Ninjia Tagline" src="../assets/tagline_ja_light.svg" width="760">
</picture>

# 📚 Copy Ninjia 開発者ドキュメント

<p align="center">
  <a href="../README.md">简体中文</a> · <a href="../en/README.md">English</a> · <b>日本語</b> · <a href="../../README.ja.md">🏠 ルート README</a>
</p>

開発者向けマルチページガイド：環境構築、アーキテクチャ設計、コーディング規約から機能拡張・運用保守まで網羅。

</div>

---

## 🧭 開発者クイックナビゲーション

| シナリオ | おすすめパス | 直達リンク |
| :--- | :--- | :---: |
| 🚀 **初回実行** | 依存関係、`.env` 設定、Telegram API 権限および初回起動 | [📖 01 環境構築](01-getting-started.md) |
| 🏗️ **アーキテクチャ理解** | メインスレッドと 3 つの Worker モデル、メッセージ生存期間と復元 | [📖 02 アーキテクチャ](02-architecture.md) |
| 🗺️ **コード検索** | モジュール役割分担、ソース構造マップおよび配置規約 | [📖 03 ディレクトリマップ](03-directory-map.md) |
| ⚡ **不変条件** | モジュール横断の権威的制約、並行性保護と状態規約 | [📖 04 権威的不変条件](04-invariants.md) |
| 🧪 **開発とテスト** | `bun run check` 品質ゲート、テスト隔離機構とカバー率 | [📖 05 開発フロー](05-dev-workflow.md) |
| 🛠️ **機能の追加・変更** | コマンド追加、パラメータ調整、AI ツール追加および Schema 変更のレシピ | [📖 06 変更レシピ](06-modification-guide.md) |
| 🛡️ **本番運用** | systemd デプロイ、`COPY_NINJIA_DATA_ROOT`、バックアップと障害対応 | [📖 07 運用マニュアル](07-operations.md) |

---

## 📑 ページ一覧と概要

1. **[01 環境構築と初回実行](01-getting-started.md)**
   - 依存関係（Bun 1.3+ / Linux / Bot Token / Gemini API Key）
   - `.env` 設定ファイルの必須項目
   - Telegram BotFather 設定（Privacy Mode / 管理者権限 / Inline Mode）
   - 初回起動と `/init enable` のハンドシェイク

2. **[02 アーキテクチャ概要](02-architecture.md)**
   - 1 つのメインスレッド + 3 つの Worker（AI / Anti-Raid / Disk I/O）プロセスモデル
   - Telegram Update の受信から検証・配送・応答までの旅路
   - 起動シーケンスおよび Flush Barrier による安全な停止手順

3. **[03 ディレクトリマップとコード配置](03-directory-map.md)**
   - `src/` 下の 13 サブドメインの明確な責務境界
   - コード配置の意思決定ツリー（定数、型、キャッシュ、状態遷移、Worker）
   - 後行互換エントリーポイントの集約ルール

4. **[04 実行時権威的不変条件](04-invariants.md)**
   - モジュール間・ライフサイクル間の権威的制約（コード内 `@see` 注釈のリンク先）
   - 状態隔離、並行制限、キャッシュ淘汰上限およびロック機構
   - アトミック永続化、Anti-Raid 認証状態マシンおよびおみくじ HMAC 鍵の一貫性

5. **[05 開発フローと品質ゲート](05-dev-workflow.md)**
   - `bun run check` 4 段階検証パイプライン：規約チェック + Lint + Typecheck + カバー率テスト
   - テスト隔離機構と一時データサンドボックス
   - コミット規約とリリース前の障害注入テスト `bun run test:fault-injection`

6. **[06 よくある変更レシピ](06-modification-guide.md)**
   - レシピ 1：Telegram スラッシュコマンドの追加
   - レシピ 2：システム定数やタイムアウトの調整
   - レシピ 3：Gemini AI カスタムツールの拡張
   - レシピ 4：設定 Schema または永続化データ構造の変更（手動移行戦略）

7. **[07 運用と障害対応](07-operations.md)**
   - 推奨ハードウェア構成とデプロイガイド
   - `COPY_NINJIA_DATA_ROOT` ディレクトリ機能チェック（fsync / hard link / rename）
   - バックアップと復元（`memory/luck/receipt-secret.json` 鍵の一貫性）
   - よくある起動失敗と `bot.lock` のトラブルシューティング

---

## 📝 ドキュメント保守規約

- **3 言語同期**：中国語版は `docs/`、英語版は `docs/en/`、日本語版は `docs/ja/` に配置。構成や数値変更時は 3 言語を同時に更新。
- **一元管理**：モジュール横断の制約は [04 権威的不変条件](04-invariants.md) でのみ保守し、他ドキュメントからはリンク参照。
- **定数参照**：数値の真実のソースは `src/consts/` です。ドキュメントでは数値の直接記述を避け定数名を記述。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/footer_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../assets/footer_ja_light.svg">
  <img alt="Copy Ninjia Footer" src="../assets/footer_ja_light.svg" width="720">
</picture>

</div>
