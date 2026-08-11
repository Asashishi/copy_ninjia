# 07 運用とトラブルシューティング

<p align="center">
  <a href="../cn/07-operations.md">简体中文</a> · <a href="../en/07-operations.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="conntent-table.md">📚 開発者ドキュメント TOP</a> · <a href="06-modification-guide.md">← 前のページ：06 変更レシピ</a> · <b>次のページ：なし →</b>
</p>

---

## デプロイ形態

webhook と外部 database service を使わない、単一インスタンスのロングポーリングプロセスです。identity policy はローカル SQLite、その他の永続化は data root 内の file を使います。1 インスタンスはおよそ 15 個以下の active group を推奨します。主な bottleneck は 1 つの Bot API、AI provider の quota、メディア throughput です。ハードウェアの目安はルート README の「クイックスタート」を参照してください。

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

データルートはデプロイツールで事前作成します：`sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia`。container では同じディレクトリを persistent volume として mount し、host または init container で owner を設定します。`memory/` と `database/` を container の一時 layer に置かないでください。

program は root・`logs/`・`memory/`・初期 `database/` を `0750` で作り、4 path の symlink を拒否します。root・`logs/`・`memory/` は runtime UID 所有かつ `0750` 以下でなければなりません。identity migration は `database/` を `02770`、主 DB と WAL/SHM を `0660` にします。この directory は runtime UID 所有、または deployment account 所有でも group が runtime の有効 group で完全な `rwx` を持つ場合だけ許可されます。data root 全体へ再帰的に `chmod 0750` してはいけません。SQLite が sidecar を作るための group write を失います。`config/` は project tree 内の read-only deployment input であり、identity policy はもうここから load も write back もしません。

プロセス crash や非ゼロ終了は `Restart=on-failure` に再起動させます。認証待ち状態、ロックダウン timer、identity write-through、AI メモリ、未確認の Telegram update は [04 実行時の正式な不変条件](04-invariants.md#永続化) の復元 semantics に従って継続します。

## データルート

`COPY_NINJIA_DATA_ROOT` がすべての実行時データパスを決めます。空の場合はプロジェクトルートです。

- **`state.json` + `state.json.bak`**
  - **内容**：グループスイッチ（参加認証と対レイド private mode をまとめて制御する
    `isAntiRaidEnabled` を含む。既定で無効）、copy、ロックダウンミラーなどの正式な状態に
    加え、`global.assets` の素材直リンク 3 本（運勢サムネイル 2 枚と Bot 既定
    アバター）。model 選択は runtime state ではなくなりました。
  - **バックアップ**：主・副を同時にバックアップ。
  - **素材直リンクの変更は停止中のみ**：プロセスは正式な状態をメモリに保持しファイル全体を
    上書きするため、稼働中の編集は次回の保存で消えます。サービス停止 → `global.assets` を編集
    → 起動の順です。未設定項目は起動が完全に成功した後に現在有効な値で補完され、壊れた値
    （scheme 欠落や不一致）は decode 時にファイル全体を拒否してフィールドパスを示します。
    画像バイトを直接返せば画像ホストは問いませんが、サムネイル 2 枚は `https` 必須で、
    明文 `http` を許すのは `botDefaultAvatarUrl` だけです。またその取得は
    **リダイレクトを追います**——直リンクがまず実ストレージのドメインへ 302 する形
    （内蔵既定の Drive リンクもこれです）はそのまま使え、最終ホップを自分で解決する
    必要はありません。
  - **アップグレード前にこの 3 項目を確認**：サムネイル 2 枚は現在 `https` のみを受け付ける
    ため、古いバージョンで `http://` のままの項目があると decode 時に起動を拒否し、
    フィールドパスを示します。
- **`memory/ai/<chatId>.json`**
  - **内容**：チャットごとの version=1 AI メモリ原子 snapshot。直近の逐語メッセージ、
    過去の要約、要約待ち内容、保存時刻を保持。
  - **バックアップ**：機密のグループチャット本文を含む。チャットのメモリ purge 時に
    削除し、起動時は chat ID ごとに復元。
- **`memory/stickers/<pack>.json`**
  - **内容**：allowlist 対象スタンプパック 1 件の version=1 カタログ。
    `file_unique_id` ごとの emoji/説明とパック要約を保持。
  - **バックアップ**：オンラインパックとの照合で再構築可能。
    `config/stickers.json` から外れたパックのファイルは起動復元時に削除。
- **`memory/luck/<YYYY-MM-DD>.json`**
  - **内容**：東京当日の運勢結果。key はユーザー ID で、質問付きの場合は
    質問 digest も含む。
  - **バックアップ**：当日分だけ保持。下記 receipt key と同じ整合時点でバックアップ。
- **`memory/luck/receipt-secret.json`**
  - **内容**：当日の署名付き運勢 receipt 用 version=1 HMAC key
    （日付 + 32 byte key）。
  - **バックアップ**：既存結果と別に削除・再生成・復元してはいけない。
- **`memory/anti-raid/<YYYY-MM-DD>.json`**
  - **内容**：Challenge 認証待ち状態の当日追記ログ。active snapshot、
    同一 key の revision、終端 tombstone に加え、write-ahead 済みで kick 完了を
    未確認の `kickPending` を含みます。再起動後は membership probe と kick を再開し、
    別の kick 永続化ファイルは作りません。
  - **バックアップ**：日付をまたぐ起動では最新旧日と当日を merge
    （当日の active/tombstone が優先）し、原子的な公開成功後だけ旧日を削除。
    定常時は当日だけ保持し、履歴 10,000 件または 4 MiB で compact。
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**
  - **内容**：`/batch_kick` が rolling window で読む正式な `chat_member` 入室事実。
  - **バックアップ**：user ID と timestamp を含むため機密データとして扱う。
    深夜をまたぐ処理中 query のため東京暦日 3 日分を保持。完全な再配信は再追記せず、
    履歴は user ごとの最新値へ compact し、1 chat/day は最新 250,000 人まで保持。
- **`database/storage.sqlite`**（runtime では `-wal` / `-shm` sidecar が存在し得ます）
  - **内容**：schema v3 identity database。`whitelist_entries` と `blocklist_entries` は
    allowlist / blocklist の正式表、`pending_blocked_removals` は未完了の chat 別 BAN
    outbox、`storage_metadata` は唯一の schema version を保持します。Drizzle migration
    journal は対応する lineage と厳密に一致しなければなりません。
  - **バックアップ**：必須です。blocklist を失えば恒久 BAN がすべて解除され、outbox を
    失えば未完了処置が抜けます。Bot 停止後、主 DB とその時点で存在する WAL/SHM を同じ
    consistency set として worktree 外へ copy し、owner/mode と SHA-256 を記録します。
    text editor や場当たり的な SQL で業務 row を手編集してはいけません。schema migration
    script は SQLite serialization で別の外部 backup を作成し検証します。
  - **復元**：Disk I/O Worker が唯一の database owner です。起動時は integrity、JSONB、
    schema、migration lineage、row codec、allowlist/blocklist の非交差を検証してから、
    count と pending outbox だけを main thread へ返します。失敗時は起動を拒否し、空 DB の
    作成、row の破棄、silent degradation は行いません。
- **`memory/ad-detected/sample.json`**
  - **内容**：広告判定ヒットの生サンプル。時刻、メッセージ ID と本文、判定理由、
    引用/返信コンテキストを含む。
  - **バックアップ**：**純粋なバイパスで、プロセスは決して読みません**。失っても
    挙動は変わらず、`config/ad_samples.json` を調整する素材が減るだけです。
    8 MiB 到達時に `sample.<東京日付>[.<連番>].json` へ自動ローテーションし、
    アーカイブは当日を含む直近 15 東京暦日だけ自動保持。
- **`memory/ad-detected/sample.<YYYY-MM-DD>[.<連番>].json`**
  - **内容**：`sample.json` のローテーション済みアーカイブ。同日 2 個目は
    `.2` から増加。
  - **バックアップ**：厳密な名前の通常ファイルだけを直近 15 東京暦日保持。
    不明な名前、ディレクトリ、シンボリックリンクは自動削除しない。
- **`logs/`**
  - **内容**：英語メッセージのエラーログ。
  - **バックアップ**：必要に応じて。
- **`bot.lock` と `.guard` / `.recovery`**
  - **内容**：単一インスタンスロック。
  - **バックアップ**：バックアップも手動編集もしない。

`memory/` 直下にはファイルを置かず、6 domain がそれぞれ 1 つの subdirectory を所有し、identity policy は別の `database/` に置きます。起動復元は `ai/`、`stickers/`、`luck/`、`anti-raid/` を必要に応じて作成し、`ad-detected/` は最初の hit 後、`joinlog/` は最初の入室事実または query 時にだけ現れます。起動復元は `joinlog/` を scan しません。物理上の `anti-raid/<day>.json` は単純な active 一覧ではなく追記ログです。作成・変更時に完全 snapshot を追加し、決着時に同じ key の `null` tombstone を追加し、復元時に履歴を現在 active な Challenge へ畳み込みます。停止が東京日付をまたいだ場合、起動時に最新旧日を厳格に読み、当日の記録を新しい値として重ねます。旧日破損時はどちらも書き換えず復元を拒否し、当日の原子 snapshot が成功した後だけ旧日を清掃します。

`joinlog/` の query は `[since, now]` を覆う最大 2 個の chat/day file を読み、window 内で user ごとの最後の入室だけを返します。3 日目の保持は 23:59 に採取され、深夜を越えて Worker が処理する in-flight query 専用です。冗長履歴 10,000 件または新規追記 4 MiB で compact を評価し、512 KiB 以上回収できる場合だけ atomic rewrite します。parse 可能でも schema が不正な file は byte を変えずその read/write を拒否し、末尾の truncate 断片だけ append layer が修復できます。

### `memory/` の補助ファイルとプロセス内限定状態

- 原子的な置換では一時的に `.<対象ファイル名>.<pid>.<uuid>.tmp` を作り、`fsync + rename` 後に消します。両者の間で hard kill された場合だけ残る可能性があります。`ai/`、`stickers/`、`luck/` は起動時に `*.tmp` を清掃し、`ad-detected/` は最初の書き込み前に `.sample.json.*.tmp`、`joinlog/` は当日の directory を最初に接管するとき `*.tmp` を清掃します。現在の `anti-raid/` 復元はこの種のファイルを無視しますが、自動削除はしません。復元には使われないため、Bot を停止し、名前が原子書き込み形式へ厳密に一致すると確認した後だけ孤児として削除できます。`storage.sqlite-wal` と `storage.sqlite-shm` は通常の SQLite sidecar であり、孤児一時 file として削除してはいけません。
- `memory/ai/<chatId>.json.<timestamp>.<uuid>.corrupt` と `memory/stickers/<pack>.json.<timestamp>.<uuid>.corrupt` は JSON を parse できず一意名で隔離されたファイルです。通常復元の対象外で、自動削除もしません。同じ元 path が再び壊れた場合は旧証拠を上書きせず新しい隔離件を残します。parse はできても現行 version=1 schema に合わないファイルは隔離せず起動を拒否し、[06](06-modification-guide.md#永続化-schema-の変更) に従う手動 migration が必要です。
- Challenge timer、広告検出の admission queue / deduplication Set、Telegram member/admin の短期 cache はプロセス内だけに存在し、対応ファイルはありません。

Bot 停止中または storage snapshot の整合境界でデータルート全体をバックアップし、SQLite 主 DB と存在する sidecar は同一時点から取得します。`memory/` と `database/` は機密データとして扱ってください。単一 tenant 基準では memory file が `0644`、DB と sidecar が `0660` です。詳細は [04](04-invariants.md#永続化) を参照し、アクセス制御は top-level directory の owner/group/mode と host account の隔離で行います。

## Identity Storage Migration

runtime は旧形式の互換 path を持たず、database を自動作成しません。migration 前に Bot を停止して inactive を確認します。失敗時は外部 backup と現場を保全し、新版を起動せず、`config_example/` で実 input を上書きしてはいけません。

### 旧 JSON → SQLite

`config/whitelist.json`、`config/blocklist.json`、および任意の `memory/blocklist/` を使う deployment は次の順で migration します。

```bash
bun run migrate:identity-storage --check
bun run migrate:identity-storage --apply
```

`--check` は旧 allowlist、静的/動的 blocklist、v2 removal outbox を厳密に読み、統合するだけで file を変更しません。`--apply` は `bot.lock` を取得し、Telegram から identity metadata を補完し、inventory・owner/mode・SHA-256 付きの外部 backup を作ります。その後 candidate SQLite の integrity、JSONB、row count、主キー、codec を検証し、`database/storage.sqlite` を atomic publish してからだけ 3 つの旧構造を削除します。script が表示する外部 backup directory は、起動・permission command・removal replay の検証がすべて終わるまで保持します。

新規 deployment も同じ明示境界を通ります。[01 セットアップ](01-getting-started.md#identity-database-の初期化) に従って一時的な空の旧 input 2 件を作り、`--apply` を実行します。起動は database 欠落を「空 policy」と推測せず、migration も既存 target を上書きしません。

### SQLite schema v2 → v3

すでに JSONB schema v2 を使う deployment は、Bot 停止中に次を実行します。

```bash
bun run migrate:whitelist-permission -- --apply
```

script は対応する v2 migration lineage だけを受け入れます。最初に SQLite serialization で system temporary directory へ `0600` の外部 backup を作り、hash と integrity を検証してから allowlist permission を schema v3 へ上げます。未知 lineage、不正 row、allowlist/blocklist の交差、transaction failure は元のまま拒否します。v3 に対して実行した場合は strict validation だけを行い、migration 不要と報告します。Release の Compatibility / Migration Notes には実行した migration、backup location、restore 手順、permission 要件を記載します。

## 起動失敗の調査

起動失敗は**意図的な fail-fast**で、原因を含みます。検査を迂回せず、原因に合わせて対応してください。

- **パス付きでデータルート事前検査が失敗**
  - **原因**：data root・`memory`・`logs`・`database` が symlink、最初の 3 path が
    `0750` より広い、`database/` が `0770` より広いか collaboration group で書けない、
    directory が書込不能、または filesystem が fsync、hard link、atomic rename を
    support しない。
  - **対応**：全 instance を停止し、directory ごとに owner/group/mode を修正します。
    root・`memory/`・`logs/` は `0750`、`database/` は deployment model に応じて
    `0750` または `02770` を使います。解決しなければ必要な semantics を持つ local
    filesystem を使用します。
- **`bot.lock` が起動を拒否**
  - **原因と対応**：次の section を参照。
- **config schema 検証失敗**
  - **原因**：`config/*.json` が不正。
  - **対応**：指摘された field を修正。mood の重みは合計 100、天気・時間帯の倍率は
    100 以下、スタンプパックは最大 5 個。
- **identity database が欠落、または validation failure**
  - **原因**：migration 未実行、`storage.sqlite` が書込不能、integrity/JSONB/schema/
    migration lineage 不正、row codec failure、または同じ identity が両 list に存在。
  - **対応**：Bot を停止したまま [Identity Storage Migration](#identity-storage-migration) を完了または
    rollback します。同一 consistency point の DB と sidecar を復元し、collaboration group
    permission を直してから起動します。空 DB を作ったり失敗 row を削除してはいけません。
- **state の 2 コピーが両方無効**
  - **原因**：schema 変更版をデータ migration なしでデプロイした。
  - **対応**：
    [06 永続化 schema の変更](06-modification-guide.md#永続化-schema-の変更)
    に従って migration してから起動。プログラムは元ファイルを変更しません。
- **運勢結果と receipt key が不整合**
  - **原因**：当日結果と `receipt-secret.json` が異なる backup 時点から復元された、
    または片方だけを復元した。
  - **対応**：Bot を停止し、同じ整合時点の `memory/luck/` 全体を復元。
    key だけを削除・再生成しない。
- **`*.corrupt` ファイルが現れる**
  - **原因**：state copy 1 件が壊れて隔離されたか、parse 不能な AI/スタンプ JSON
    が復元集合から外された。
  - **対応**：元のファイル名から owner を特定し、先に破損原因を調査。
    state が自己復旧するのは壊れたのが**バックアップ側**のときだけです（壊れた
    バックアップを隔離し主ファイルから再構築し、ログを 1 行残します）。**主ファイル**が
    decode できない場合は常に起動を拒否し、両ファイルをそのまま保全します——エラーが
    示すフィールドを直してから起動してください。AI/スタンプの隔離ファイルは自動復元も
    自動削除もしません。

### `bot.lock` が起動を拒否する場合

lock file の形式は厳密な `v2:pid:starttime:boot_id:sha256(token)` です。`starttime` は `/proc/<pid>/stat` の 22 番目の field です。インスタンスロックは Linux `/proc` に明示的に依存し、fail-closed です。

- **別プロセスが実際に動作中**：PID、starttime、boot ID がすべて一致する場合だけ active owner と見なします。先にそのプロセスを停止してください。同じデータルートを 2 つのインスタンスで使うことはできません。
- **プロセス停止または再起動後の stale v2 lock**：次回の起動または終了時に自動削除するため、手作業は不要です。
- **旧形式または破損形式**：非互換 lock は読み取らず、自動 migration せず、PID から推測して削除もしません。関連プロセスが存在しないことを確認してから、旧 lock を手動削除して再起動します。
- **停止時の release 失敗**：owner を検証できない、または unlink に失敗したため、process は非ゼロで終了して lock を残します。先に報告された filesystem または ownership error を解消し、owner が動作中かもしれない lock を削除しないでください。
- `.candidate.*` は hard-link lock protocol の候補ファイルです。`.tmp` は `state.json` または lock registry のアトミック書き換えに使う一時ファイルです。通常操作で削除され、現行形式の残存物は owner が inactive と確認できた後、またはインスタンスロック取得後に起動処理が回収します。

token fingerprint は lock owner の識別用であり、データ隔離境界ではありません。複数 Bot の並列デプロイでは別々のデータルートを使用してください。

## アップグレードとリリース

1. `bun run release:check`（frozen lockfile + 全検査 + fault injection）をすべて通します。
   ネットワーク環境では `bun run audit:release` も実行します。
2. worktree を書き換える Git 操作の前に `git status --short`、現行から対象までの
   `git diff --name-status`、`git ls-files config .env g-auth.json` を確認します。
   `config/`、`.env`、`g-auth.json` と runtime state は deployment data であり、
   対象 commit や `config_example/` は backup ではありません。
3. systemd の `WorkingDirectory` が repository 自体なら、merge、test、tag、
   release は別 clone/worktree で行うことを優先します。in-place update が必要なら、
   先に service を停止して inactive を確認します。対象が deployment path を削除・
   rename・新規 ignore する場合は、最初の切替前に worktree 外へ file list、
   owner/mode、SHA-256 付きで backup します。更新後はファイルを個別に復元・migration
   し、`config_example/` で既存設定を上書きしません。
4. 永続化構造を変更する release は
   [06 永続化 schema の変更](06-modification-guide.md#永続化-schema-の変更)
   に従って手動 migration し、runtime code に旧形式互換を残しません。
5. deployment config と runtime state が揃い、strict parse と権限検査を通ってから
   service を起動します。systemd では `ActiveState=active`、
   `SubState=running` を確認し、少なくとも 2 回の `RestartSec` 間隔を観測します。
   `NRestarts` が増えず、journal に新しい非ゼロ終了がないことまで確認し、すべて
   完了するまで外部 backup を保持します。

## 日常の監視項目

- `logs/`：Disk I/O Worker がエラーを batch 追記します。文面は英語なので直接 grep できます。
- Worker crash はレート制限付きで自己修復し、ミラーまたは snapshot から復元します。介入が必要なのは crash loop が繰り返される場合で、通常は永続化データとコード version の不一致が原因です。
- 永続化が上限付き retry を使い切ると、プロセスは非ゼロで終了します。これは availability より durability を優先する設計です。systemd が最後の整合状態から再起動します。

---

<div align="center">

[← 前のページ：06 変更レシピ](06-modification-guide.md) · [📚 開発者ドキュメント TOP](conntent-table.md) · [⬆️ トップへ戻る](#07-運用とトラブルシューティング) · **次のページ：なし →**

</div>
