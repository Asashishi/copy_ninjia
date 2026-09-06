<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/tagline_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/tagline_ja_light.svg">
  <img alt="Copy Ninjia Tagline" src="../../pictures/tagline_ja_light.svg" width="820">
</picture>

# 📚 Copy Ninjia 開発者ドキュメント

<p align="center">
  <a href="../cn/content-table.md">简体中文</a> · <a href="../en/content-table.md">English</a> · <b>日本語</b> · <a href="README.md">🏠 日本語 README</a>
</p>

開発者向けマルチページガイド：環境構築、アーキテクチャ設計、コーディング規約から機能拡張・運用保守まで網羅。

</div>

---

## 🧭 開発者クイックナビゲーション

| シナリオ | おすすめパス | 直接リンク |
| :--- | :--- | :---: |
| 🚀 **初回実行** | 依存関係、deployment 設定、Telegram API 権限および初回起動 | [📖 01 環境構築](01-getting-started.md) |
| 🏗️ **アーキテクチャ理解** | メインスレッドと 3 つの Worker モデル、メッセージ処理のライフサイクルと復元 | [📖 02 アーキテクチャ](02-architecture.md) |
| 🗺️ **コード検索** | モジュール役割分担、ソース構造マップおよび配置規約 | [📖 03 ディレクトリマップ](03-directory-map.md) |
| ⚡ **不変条件** | モジュール横断の正式な制約、並行性保護と状態規約 | [📖 04 正式な不変条件](04-invariants.md) |
| 🧪 **開発とテスト** | `bun run check` 品質ゲート、テスト隔離機構とカバレッジ | [📖 05 開発フロー](05-dev-workflow.md) |
| 🛠️ **機能の追加・変更** | コマンド追加、パラメータ調整、AI ツール追加および schema 変更のレシピ | [📖 06 変更レシピ](06-modification-guide.md) |
| 🛡️ **本番運用** | systemd デプロイ、ハードウェアの目安、`COPY_NINJIA_DATA_ROOT`、バックアップと障害対応 | [📖 07 運用マニュアル](07-operations.md) |
| 🎮 **コマンドを調べる** | 全コマンド、権限の読み方、挙動の詳細（ルート README には概要だけ） | [📖 08 コマンドリファレンス](08-commands.md) |
| 📊 **計測値を見る** | コールド/ホットパス、総スループットと総 I/O、エンドツーエンドのチェーン遅延のリリースベンチマーク | [📖 09 パフォーマンス](09-performance.md) |

---

## 📑 ページ一覧と概要

1. **[01 環境構築と初回実行](01-getting-started.md)**
   - 依存関係（Bun 1.4.2 / Linux / Bot Token / AI provider API Key）
   - `config/telegram.json` など deployment 設定の必須項目
   - Telegram BotFather 設定（Privacy Mode / 管理者権限 / Inline Mode）
   - 初回起動と `/init enable` のハンドシェイク

2. **[02 アーキテクチャ概要](02-architecture.md)**
   - 1 つのメインスレッド + 3 つの Worker（AI / Anti-Raid / Disk I/O）によるマルチスレッド構成
   - Telegram update の受信から検証・振り分け・応答までの流れ
   - 起動シーケンスおよび Flush Barrier による安全な停止手順

3. **[03 ディレクトリマップとコード配置](03-directory-map.md)**
   - `packages/` 下の各サブドメインの明確な責務境界
   - コード配置の意思決定ツリー（定数、型、キャッシュ、状態遷移、Worker）
   - 後方互換エントリーポイントの集約ルール

4. **[04 実行時の正式な不変条件](04-invariants.md)**
   - モジュール間・ライフサイクル間の正式な制約（コード内 `@see` 注釈のリンク先）
   - 起動と import の境界：起動順序、任意の資格情報の縮退、データルート、送信リクエストとメッセージの安全性
   - Worker と状態の所有権：スレッドの帰属、状態機械の contract、AI チャットの実行時、参加認証と終端処置、連投ミュートと自身の権限キャッシュ
   - 永続化：永続化と snapshot の contract、グループ状態と `chat_states`、ブロックリストと広告検出、確認境界と停止、ファイル権限

5. **[05 開発フローと品質ゲート](05-dev-workflow.md)**
   - `bun run check` 5 段階検証パイプライン：規約チェック + Lint + Typecheck + カバレッジ付き全テスト + hot path gate
   - テスト隔離機構と一時データサンドボックス
   - コミット規約とリリース前の障害注入テスト `bun run test:fault-injection`

6. **[06 よくある変更レシピ](06-modification-guide.md)**
   - レシピ 1：Telegram スラッシュコマンドの追加
   - レシピ 2：システム定数やタイムアウトの調整
   - レシピ 3：AI カスタムツールの拡張
   - レシピ 4：設定 schema または永続化データ構造の変更（手動移行戦略）
   - 非目標：i18n はやらない。言語を変えるなら fork

7. **[07 運用と障害対応](07-operations.md)**
   - デプロイ形態とハードウェアの目安表（デプロイ規模別）
   - `COPY_NINJIA_DATA_ROOT` ディレクトリ機能チェック（fsync / hard link / rename）
   - バックアップと復元（`memory/luck/receipt-secret.json` 鍵の一貫性）
   - よくある起動失敗と `bot.lock` のトラブルシューティング

8. **[08 コマンドと挙動リファレンス](08-commands.md)**
   - Copy モードと対象の指定方法
   - 全コマンドの権限段階（権限キー / スーパー管理者 / グループメンバー）
   - `/gag`、`/block`、`/batch_kick`、広告検出、参加認証などの挙動の詳細

9. **[09 パフォーマンスベンチマーク](09-performance.md)**
   - `bun run perf:full` の 6 セクションの計測対象：コールドスタート、本番ホットパス、エンドツーエンドの永続化チェーン、SQLite とメインスレッドキャッシュ、コンテナとアルゴリズム、参加ログ容量線
   - 各項目を独立 3 ラウンド実行し、平均・最小・最大・変動係数を報告
   - 1 ラウンドあたりの総スループット、総 I/O、モックデータルートの使用量

---

## 📝 ドキュメント保守規約

- **3 言語同期**：中国語版は `docs/cn/`、英語版は `docs/en/`、日本語版は `docs/ja/` に配置。構成や数値変更時は 3 言語を同時に更新。
- **一元管理**：モジュール横断の制約は [04 正式な不変条件](04-invariants.md) でのみ保守し、他のドキュメントからはリンクで参照します。
- **定数参照**：数値の信頼できる唯一の情報源は `packages/consts/` です。ドキュメントでは数値の直接記述を避け、定数名を記載します。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/footer_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/footer_ja_light.svg">
  <img alt="Copy Ninjia Footer" src="../../pictures/footer_ja_light.svg" width="750">
</picture>

</div>
