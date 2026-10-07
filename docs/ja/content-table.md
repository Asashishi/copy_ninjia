<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/tagline_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/tagline_ja_light.svg">
  <img alt="Copy Ninjia Tagline" src="../../public/tagline_ja_light.svg" width="820">
</picture>

# 📚 Copy Ninjia 開発者ドキュメント

<p align="center">
  <a href="../cn/content-table.md">简体中文</a> · <a href="../en/content-table.md">English</a> · <b>日本語</b> · <a href="README.md">🏠 日本語 README</a>
</p>

開発者向けマルチページガイド：環境構築、アーキテクチャ設計、コーディング規約から機能拡張・運用保守まで網羅。

</div>

---

## 🧭 開発者クイックナビゲーション

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">シナリオ</th>
    <th width="44%" align="left">おすすめパス</th>
    <th width="32%" align="center">直接リンク</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🚀 <b>初回実行</b></nobr></td>
    <td>依存関係、deployment 設定、Telegram API 権限および初回起動</td>
    <td align="center"><nobr><a href="01-getting-started.md">📖 01 環境構築</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🏗️ <b>アーキテクチャ理解</b></nobr></td>
    <td>メインスレッドと 3 つの Worker モデル、メッセージ処理のライフサイクルと復元</td>
    <td align="center"><nobr><a href="02-architecture.md">📖 02 アーキテクチャ</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🗺️ <b>コード検索</b></nobr></td>
    <td>モジュール役割分担、ソース構造マップおよび配置規約</td>
    <td align="center"><nobr><a href="03-directory-map.md">📖 03 ディレクトリマップ</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>不変条件</b></nobr></td>
    <td>モジュール横断の正式な制約、並行性保護と状態規約</td>
    <td align="center"><nobr><a href="04-invariants.md">📖 04 正式な不変条件</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🧪 <b>開発とテスト</b></nobr></td>
    <td><code>bun run check</code> 品質ゲート、テスト隔離機構とカバレッジ</td>
    <td align="center"><nobr><a href="05-dev-workflow.md">📖 05 開発フロー</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛠️ <b>機能の追加・変更</b></nobr></td>
    <td>コマンド追加、パラメータ調整、AI ツール追加および schema 変更のレシピ</td>
    <td align="center"><nobr><a href="06-modification-guide.md">📖 06 変更レシピ</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>本番運用</b></nobr></td>
    <td>systemd デプロイ、ハードウェアの目安、<code>COPY_NINJIA_DATA_ROOT</code>、バックアップと障害対応</td>
    <td align="center"><nobr><a href="07-operations.md">📖 07 運用マニュアル</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>画像庫と定時タスク</b></nobr></td>
    <td>画像収集・内容重複判定・アルバム・定時ボイス・タイムゾーン・パス基準</td>
    <td align="center"><nobr><a href="08-images-and-cron.md">📖 08 画像ライブラリと定時タスク</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🎮 <b>コマンドを調べる</b></nobr></td>
    <td>全コマンド、権限の読み方、挙動の詳細（ルート README には概要だけ）</td>
    <td align="center"><nobr><a href="09-commands.md">📖 09 コマンドリファレンス</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>📊 <b>計測値を見る</b></nobr></td>
    <td>コールド/ホットパス、総スループットと総 I/O、エンドツーエンドのチェーン遅延のリリースベンチマーク</td>
    <td align="center"><nobr><a href="10-performance.md">📖 10 パフォーマンス</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>❓ <b>返信がないとき</b></nobr></td>
    <td>Bot が動いているのに反応しないときの確認リスト</td>
    <td align="center"><nobr><a href="11-faq.md">📖 11 よくある質問</a></nobr></td>
  </tr>
</tbody>
</table>

---

## 📑 ページ一覧と概要

1. **[01 環境構築と初回実行](01-getting-started.md)**
   - 依存関係（Bun 1.4.2 / Linux / Bot Token / AI provider API Key）
   - `install.sh` によるワンショットインストール（ソースまたはバイナリ配布版）と手動ソースインストール
   - `config/static/bot.json` など deployment 設定のフィールドと厳格な検証
   - Telegram BotFather 設定（Privacy Mode / 管理者権限 / Inline Mode / Bot-to-Bot）
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
   - `bun run check` 直列パイプライン：install script 構文 + install 隔離 + 規約チェック + Lint + Typecheck + カバレッジ付き全テスト + 固定 seed のランダム順全テスト + hot path gate
   - テスト隔離機構と一時データサンドボックス
   - コミット手順、障害注入テスト `bun run test:fault-injection` とリリース手順

6. **[06 よくある変更レシピ](06-modification-guide.md)**
   - Telegram スラッシュコマンド（漢字アクションコマンドを含む）の追加、応答へのリンクや書式の付与
   - 動作パラメータの調整、ペルソナと JSON 設定の変更、deployment JSON 設定の追加
   - AI ツール、任意の provider 能力、汎用 JSON API 呼び出しの追加
   - 実行時 cache の追加、Worker 間 protocol の変更
   - 永続化 schema の変更と SQLite table の追加（手動移行戦略）
   - 非目標：i18n はやらない。言語を変えるなら fork

7. **[07 運用と障害対応](07-operations.md)**
   - デプロイ形態、ハードウェアの目安表（デプロイ規模別）、systemd とバイナリデプロイ
   - データルートの各ディレクトリと `COPY_NINJIA_DATA_ROOT` ディレクトリ機能チェック（fsync / hard link / rename）
   - ID ストレージの移行：新規データベース作成、共有データベースのコールド移行、段階的アップグレード
   - よくある起動失敗（`bot.lock` 単一インスタンスロック、`memory/luck/receipt-secret.json` 鍵の一貫性を含む）の調査
   - アップグレードとリリース、日常の監視項目

8. **[08 画像ライブラリと定時タスク](08-images-and-cron.md)**
   - 専用ライブラリの準備、画像収集と内容の重複判定
   - 定時の単画像・アルバム・ランダム画像・音声の設定
   - タイムゾーン、対象グループと相対パスの基準

9. **[09 コマンドと挙動リファレンス](09-commands.md)**
   - Copy モードと対象の指定方法
   - 全コマンドの権限段階（権限キー / スーパー管理者 / グループメンバー）
   - `/gag`、`/block`、`/batch_kick`、広告検出、参加認証などの挙動の詳細

10. **[10 パフォーマンスベンチマーク](10-performance.md)**
    - `bun run perf:full` の各セクションの計測対象：コールドスタート、本番ホットパス、エンドツーエンドの永続化チェーン、SQLite とメインスレッドキャッシュ、コンテナとアルゴリズム、参加ログ容量線
    - 各項目を既定のラウンド数で実行し、平均・最小・最大・変動係数を報告
    - 1 ラウンドあたりの総スループット、総 I/O、モックデータルートの使用量

11. **[11 よくある質問](11-faq.md)**
    - Bot が動いているのに返信しない場合の順次確認：初期化、プライバシーモード、AI の反応条件、個人チャット、通知の自動削除、Inline Mode、Bot-to-Bot、既定で無効な保護機能、プロセスの状態
    - 通知の口調、画像ライブラリによる起動拒否、定時タスクの再送、定時ボイスと `/send` のボイス、ボイスの長さとメモリ設定、サードパーティゲートウェイ経由の Google モデル呼び出し

---

## 📝 ドキュメント保守規約

- **3 言語同期**：中国語版は `docs/cn/`、英語版は `docs/en/`、日本語版は `docs/ja/` に配置。構成や数値変更時は 3 言語を同時に更新。
- **一元管理**：モジュール横断の制約は [04 正式な不変条件](04-invariants.md) でのみ保守し、他のドキュメントからはリンクで参照します。
- **定数参照**：数値の信頼できる唯一の情報源は `packages/consts/` です。ドキュメントでは数値の直接記述を避け、定数名を記載します。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/footer_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/footer_ja_light.svg">
  <img alt="Copy Ninjia Footer" src="../../public/footer_ja_light.svg" width="750">
</picture>

</div>
