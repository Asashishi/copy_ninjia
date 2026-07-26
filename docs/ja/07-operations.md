# 07 運用とトラブルシューティング

<p align="center">
  <a href="../07-operations.md">简体中文</a> · <a href="../en/07-operations.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="README.md">📚 開発者ドキュメント TOP</a> · <a href="06-modification-guide.md">← 前のページ：06 変更レシピ</a> · <b>次のページ：なし →</b>
</p>

---

## デプロイ形態

webhook と外部 database を使わない、単一インスタンスのロングポーリングプロセスです。永続化はすべてローカルファイルを使います。1 インスタンスはおよそ 15 個以下の active group を推奨します。主な bottleneck は 1 つの Bot API、Gemini quota、メディア throughput です。ハードウェアの目安はルート README の「クイックスタート」を参照してください。

### systemd の例

```ini
[Unit]
Description=Copy Ninjia Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=copy-ninjia
Group=copy-ninjia
WorkingDirectory=/opt/copy_ninjia
Environment=COPY_NINJIA_DATA_ROOT=/var/lib/copy-ninjia
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

データルートはデプロイツールで事前作成します：`sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia`。container では同じディレクトリを persistent volume として mount し、host または init container で owner を設定します。`memory/` を container の一時 layer に置かないでください。

プロセス crash や非ゼロ終了は `Restart=on-failure` に再起動させます。認証待ち状態、ロックダウン timer、AI メモリ、未確認の Telegram update は [04 実行時の正式な不変条件](04-invariants.md#永続化) の復元 semantics に従って継続します。

## データルート

`COPY_NINJIA_DATA_ROOT` がすべての実行時データパスを決めます。空の場合はプロジェクトルートです。

| パス | 内容 | バックアップ時の注意 |
| :--- | :--- | :--- |
| `state.json` + `state.json.bak` | グループスイッチ、copy、ロックダウンミラーなどの正式な状態 | 主・副を同時にバックアップ |
| `memory/ai/` | グループごとの AI メモリ snapshot | グループチャットの逐語内容を含み、機密 |
| `memory/stickers/` | スタンプ説明カタログ | オンラインパックとの照合から再構築可能 |
| `memory/luck/` | 運勢結果 + `receipt-secret.json` | キーと当日結果を同じ整合 snapshot に含め、key だけを再生成しない |
| `memory/anti-raid/` | 日別の認証待ち状態 | 東京日付の当日ファイルだけを保持 |
| `memory/blocklist-removals.json` | 未完了 blocklist removal batch の durable outbox | `state.json` と `config/blocklist.json` と同じ整合点で backup。起動時は現行形式を厳密に検証 |
| `config/blocklist.json` | `/block` の永続ブロックリスト（ユーザー id とブロック時刻） | 必ずバックアップ：失うと全員のブロックが解除されたのと同じ。手編集（ブロック解除の唯一の手段）は停止中に行い、編集後も正しい JSON である必要があります。ログと違い、このファイルが壊れていると末尾を切り詰めて自動復旧するのではなく**起動を拒否**します。黙って数件落とすことは、その人たちを部屋に戻すことだからです。キーはそのまま復元できる 10 進の id でなければなりません |
| `logs/` | 英語メッセージのエラーログ | 必要に応じて |
| `bot.lock` と `.guard` / `.recovery` | 単一インスタンスロック | バックアップも手動編集もしない |

Bot 停止中または storage snapshot の整合境界で、データルート全体をバックアップします。`memory/` は機密データとして扱ってください。単一 tenant デプロイ基準では file mode が緩い `0644` です。詳細は [04](04-invariants.md#永続化) を参照し、アクセス制御はデータルートの owner・permission と host account の隔離で行います。

## 起動失敗の調査

起動失敗は**意図的な fail-fast**で、原因を含みます。検査を迂回せず、原因に合わせて対応してください。

| 症状 | 原因 | 対応 |
| :--- | :--- | :--- |
| パス付きでデータルート事前検査が失敗 | ディレクトリへ書き込めない、または filesystem が fsync、hard link、アトミック rename をサポートしない | ローカル filesystem のパスへ変更。ネットワーク storage や一部 container layer は必要な semantics を満たしません |
| `bot.lock` が起動を拒否 | 次の section を参照 | 次の section に従う |
| config schema 検証失敗 | `config/*.json` または `.env` が不正 | 指摘された field を修正。mood の重みは合計 100、スタンプパックは最大 5 個 |
| state の 2 コピーが両方無効 | schema 変更版をデータ migration なしでデプロイした | [06 永続化 schema の変更](06-modification-guide.md#永続化-schema-の変更) に従って migration してから起動。プログラムは元ファイルを変更しません |
| 運勢結果と receipt key が不整合 | 当日結果と `receipt-secret.json` が異なる backup 時点から復元された、または片方だけを復元した | Bot を停止し、同じ整合時点の `memory/luck/` 全体を復元。key だけを削除・再生成しない |
| `*.corrupt` ファイルが現れる | 壊れた state copy 1 件を隔離し、もう一方へ切り替えた | 正常な自己修復経路。原因調査後に隔離ファイルを削除可能 |

### `bot.lock` が起動を拒否する場合

lock file の形式は厳密な `v2:pid:starttime:boot_id:sha256(token)` です。`starttime` は `/proc/<pid>/stat` の 22 番目の field です。インスタンスロックは Linux `/proc` に明示的に依存し、fail-closed です。

- **別プロセスが実際に動作中**：PID、starttime、boot ID がすべて一致する場合だけ active owner と見なします。先にそのプロセスを停止してください。同じデータルートを 2 つのインスタンスで使うことはできません。
- **プロセス停止または再起動後の stale v2 lock**：次回の起動または終了時に自動削除するため、手作業は不要です。
- **旧形式または破損形式**：非互換 lock は読み取らず、自動 migration せず、PID から推測して削除もしません。関連プロセスが存在しないことを確認してから、旧 lock を手動削除して再起動します。
- **停止時の release 失敗**：owner を検証できない、または unlink に失敗したため、process は非ゼロで終了して lock を残します。先に報告された filesystem または ownership error を解消し、owner が動作中かもしれない lock を削除しないでください。
- `.candidate.*` は hard-link lock protocol の候補ファイルです。`.tmp` は `state.json` または lock registry のアトミック書き換えに使う一時ファイルです。通常操作で削除され、現行形式の残存物は owner が inactive と確認できた後、またはインスタンスロック取得後に起動処理が回収します。

token fingerprint は lock owner の識別用であり、データ隔離境界ではありません。複数 Bot の並列デプロイでは別々のデータルートを使用してください。

## アップグレードとリリース

1. `bun run release:check` をすべて通します。内容は frozen lockfile + 全検査 + fault injection です。ネットワーク環境では `bun run audit:release` も実行します。
2. 永続化構造を変更するリリースでは、先に [06 永続化 schema の変更](06-modification-guide.md#永続化-schema-の変更) に従い停止して migration します。
3. service を再起動します。systemd なら `systemctl restart <unit>` です。起動出力と `logs/` を監視します。

## 日常の監視項目

- `logs/`：Disk I/O Worker がエラーを batch 追記します。文面は英語なので直接 grep できます。
- Worker crash はレート制限付きで自己修復し、ミラーまたは snapshot から復元します。介入が必要なのは crash loop が繰り返される場合で、通常は永続化データとコード version の不一致が原因です。
- 永続化が上限付き retry を使い切ると、プロセスは非ゼロで終了します。これは availability より durability を優先する設計です。systemd が最後の整合状態から再起動します。

---

<div align="center">

[← 前のページ：06 変更レシピ](06-modification-guide.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#07-運用とトラブルシューティング) · **次のページ：なし →**

</div>
