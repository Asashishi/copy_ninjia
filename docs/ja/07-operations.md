# 07 運用とトラブルシューティング

<p align="center">
  <a href="../cn/07-operations.md">简体中文</a> · <a href="../en/07-operations.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="06-modification-guide.md">← 前のページ：06 変更レシピ</a> · <a href="08-commands.md">次のページ：08 コマンドリファレンス →</a>
</p>

---

## デプロイ形態

webhook と外部 database service を使わない、単一インスタンスのロングポーリングプロセスです。identity policy はローカル SQLite、その他の永続化は data root 内の file を使います。

### ハードウェアの目安

<table width="100%">
<tr><th width="33%" align="left">規模</th><th width="26%" align="left">推奨スペック</th><th width="41%" align="left">備考</th></tr>
<tr><td>入門（低アクティブ、テキスト中心）</td><td>2 vCPU / 2 GB RAM / ローカル SSD</td><td>動作可能ですがメディアピーク時は CPU 競合が発生します。2 GB のスワップ領域を推奨します</td></tr>
<tr><td>軽量本番（テキスト中心）</td><td>4 vCPU / 2 GB RAM / ローカル SSD</td><td>2 GB はメディア処理ピーク時のメモリ確保に適しません。2 GB のスワップ領域を推奨します</td></tr>
<tr><td>推奨本番（1 グループあたり 1 日平均 1,000〜3,000 メッセージのアクティブグループ約 15 個）</td><td>4 vCPU / 4 GB RAM / ローカル SSD</td><td>2 GB のスワップ領域を推奨します</td></tr>
<tr><td>全群 AI 有効かつ画像・スタンプ多数</td><td>4 vCPU / 8 GB RAM</td><td>メディア処理と Base64 符号化に十分な余裕を確保</td></tr>
</table>

1 インスタンスは上記規模の active group をおよそ 15 個以下に抑えることを推奨します。主な制約は 1 つの Bot API、AI provider の quota、実際のメッセージ／メディア速度であり、グループの総メンバー数ではありません。

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

データルートはデプロイツールで事前作成します：`sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia`（`0755` も受け付けます。下記参照）。container では同じディレクトリを persistent volume として mount し、host または init container で owner を設定します。`memory/` と `database/` を container の一時 layer に置かないでください。

program は root・`logs/`・`memory/`・初期 `database/` を作り（前 3 者は `0755`、`database/` は `0770`。実際の mode は umask でさらに絞られます）、4 path の symlink を拒否します。root・`logs/`・`memory/` は runtime UID 所有かつ `0755` 以下でなければなりません。この gate が止めるのは**書き込み**で、group または other に `w` bit があれば起動を拒否します。読み側を `0755` まで緩めているのは、本 project を単一テナントとして扱い、大半の deployment が root で直接動かし、既定 umask で作られる directory がまさに `0755` だからです。

> **代償**：`memory/` の新規 file は `0644` が既定値なので、既定のまま使う deployment では group chat の逐語記録を主に directory bit で保護します。`0755` のままにすると、同じマシンのどの local account からも読めます。マルチテナント host では data root と `memory/` を `0750`、既存 file を必要に応じて `0600`/`0640` に収めてください。runtime の adopt と replace はその mode を維持し、自動 chmod しません。identity migration は `database/` を `02770` にし、主 DB と WAL/SHM は初回作成時に `0660` を使います。data root 全体へ再帰的に `chmod 0750` してはいけません。SQLite が sidecar を作るための group write を失います。`config/` は project tree 内の read-only deployment input であり、identity policy はもうここから load も write back もしません。

プロセス crash や非ゼロ終了は `Restart=on-failure` に再起動させます。認証待ち状態、ロックダウン timer、identity write-through、AI メモリ、未確認の Telegram update は [04 実行時の正式な不変条件](04-invariants.md#永続化) の復元 semantics に従って継続します。

## データルート

`COPY_NINJIA_DATA_ROOT` がすべての実行時データパスを決めます。空の場合はプロジェクトルートです。

- **`state.json` + `state.json.bak`**
  - **内容**：グローバルな状態だけ——copy の対象と、`global.assets` の素材直リンク 4 本
    （運勢サムネイル 2 枚、gag 発言 inline 結果のサムネイル、Bot 既定アバター）。
    グループ単位の状態——グループスイッチ
    （参加認証と対レイド private mode をまとめて制御する `isAntiRaidEnabled` を含む。
    既定で無効）、ロックダウン記録、権限スナップショット——は `database/storage.sqlite` の
    `chat_states` に移りました。model 選択は runtime state ではなくなりました。
  - **バックアップ**：主・副を同時にバックアップ。
  - **素材直リンクの変更は停止中のみ**：プロセスは正式な状態をメモリに保持しファイル全体を
    上書きするため、稼働中の編集は次回の保存で消えます。サービス停止 → `global.assets` を編集
    → 起動の順です。未設定項目は起動が完全に成功した後に現在有効な値で補完され、壊れた値
    （scheme 欠落や不一致）は decode 時にファイル全体を拒否してフィールドパスを示します。
    画像バイトを直接返せば画像ホストは問いませんが、サムネイル 3 枚は `https` 必須で、
    明文 `http` を許すのは `botDefaultAvatarUrl` だけです。またその取得は
    **リダイレクトを追います**——直リンクがまず実ストレージのドメインへ 302 する形
    （内蔵既定の Drive リンクもこれです）はそのまま使え、最終ホップを自分で解決する
    必要はありません。
  - **アップグレード前にこの 4 項目を確認**：サムネイル 3 枚は現在 `https` のみを受け付ける
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
  - **内容**：schema v7 共有ストレージ database。`whitelist_entries` と `blocklist_entries` は
    恒久 allowlist / blocklist の正式表です。`temporary_whitelist_entries` は group 横断発言の
    累計、連続 qualified day、一時 grant 時刻、最終発言時刻を relational column で保持し、
    `pending_blocked_removals` は未完了の chat 別 BAN
    outbox、`chat_states` はグループ単位状態の正式表（最大 25 行。26 行目があれば起動を
    拒否）、`storage_metadata` は唯一の schema version を保持します。Drizzle migration
    journal は対応する lineage と厳密に一致しなければなりません。`chat_states` の 25 行枠は
    record 全体が既定値へ戻ったときだけ解放されます：`/init disable` が消すのはグループ名
    だけで、機能スイッチは設計上そのまま残るため（`/init enable` し直しても再設定不要）、
    主ゲートを切っても `/ai_chat` などが有効なグループは 1 行を占め続けます。枠を空けるには、
    そのグループで `/ai_chat`、`/ad_detect`、`/flood_control`、`/antiraid`、`/ja_copy` を
    1 つずつ disable にするか、Bot をそのグループから外します——退出時にその row は削除
    されます（復旧待ちの lockdown が残っている場合を除く）。
  - **バックアップ**：必須です。blocklist を失えば恒久 BAN がすべて解除され、outbox を
    失えば未完了処置が抜けます。Bot 停止後、主 DB とその時点で存在する WAL/SHM を同じ
    consistency set として worktree 外へ copy し、owner/mode と SHA-256 を記録します。
    text editor や場当たり的な SQL で業務 row を手編集してはいけません。一時 allowlist の
    schema migration script は書き込み前に主 DB と既存 sidecar を byte 単位で外部 directory へ
    copy し、owner/mode/SHA-256 manifest を記録して読み戻し検証します。
  - **復元**：Disk I/O Worker が唯一の database owner です。起動時は integrity、JSONB、
    schema、migration lineage、row codec、blocklist と 2 種類の allowlist の非交差を検証してから、
    恒久 policy count と pending outbox だけを main thread へ返します。一時 activity は update が
    必要とする identity だけ 8,192-entry LRU へ cold read します。失敗時は起動を拒否し、空 DB の
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

`memory/` 直下にはファイルを置かず、6 domain がそれぞれ 1 つの subdirectory を所有し、identity policy は別の `database/` に置きます。起動時は復元が必要な state domain（`joinlog/` の保持 window を含む）を read-only scan して厳格 decode し、すべて成功した後だけ owner を adopt します。directory 作成、temporary/orphan/期限切れ file の清掃、compact は成功応答後に行い、その後で `Asia/Tokyo` を明示した Bun native の東京 0 時 maintenance cron を 1 つ登録します。この cron は運勢 file、log、入室 log、広告 sample archive、認証待ちの日別 file、一時 allowlist activity をまとめて maintenance し、1 domain の失敗で残りを止めません。既存の起動時・業務 event 経路は fallback として残します。`ad-detected/` は引き続き最初の hit 後にだけ現れ、すでに directory がある場合も起動成功後の maintenance は sample 内容を読まず directory entry だけを走査します。物理上の `anti-raid/<day>.json` は単純な active 一覧ではなく追記ログです。作成・変更時に完全 snapshot を追加し、決着時に同じ key の `null` tombstone を追加し、復元時に履歴を現在 active な Challenge へ畳み込みます。停止が東京日付をまたいだ場合、起動時に最新旧日を厳格に読み、当日の記録を新しい値として重ねます。旧日破損時はどちらも書き換えず復元を拒否し、起動成功後の maintenance だけが当日の原子 snapshot を公開して旧日を清掃します。実行中は統一 cron が同じ rollover を起動し、失敗時は active mirror を保持したまま unref 済み 1 秒 timer で再試行します。

`joinlog/` の query は `[since, now]` を覆う最大 2 個の chat/day file を読み、window 内で user ごとの最後の入室だけを返します。3 日目の保持は 23:59 に採取され、深夜を越えて Worker が処理する in-flight query 専用です。冗長履歴 10,000 件または新規追記 4 MiB で compact を評価し、512 KiB 以上回収できる場合だけ atomic rewrite します。parse 可能でも schema が不正な file は byte を変えずその read/write を拒否し、末尾の truncate 断片だけ append layer が修復できます。

### `memory/` の補助ファイルとプロセス内限定状態

- 原子的な置換では一時的に `.<対象ファイル名>.<pid>.<uuid>.tmp` を作り、`fsync + rename` 後に消します。両者の間で hard kill された場合だけ残る可能性があります。起動 inspect はこれらを記録するだけで削除しません。全 domain の検証と adopt が成功して成功応答を返した後、logs、`ai/`、`stickers/`、`luck/`、`joinlog/` の maintenance が対応する `*.tmp` を清掃します。既存の `ad-detected/` directory は起動成功後の maintenance で `.sample.json.*.tmp` を清掃し、最初の sample 書き込みにも同じ fallback を残します。`anti-raid/` は temporary file を復元 input から除外します。`storage.sqlite-wal` と `storage.sqlite-shm` は通常の SQLite sidecar であり、孤児一時 file として削除してはいけません。
- Challenge timer、広告検出の admission queue / deduplication Set、Telegram member/admin の短期 cache はプロセス内だけに存在し、対応ファイルはありません。

Bot 停止中または storage snapshot の整合境界でデータルート全体をバックアップし、SQLite 主 DB と存在する sidecar は同一時点から取得します。`memory/` と `database/` は機密データとして扱ってください。新規 memory file は `0644`、DB と sidecar は初回作成時に `0660` が既定値で、既存 file の mode は adopt と atomic replace 後も維持されます。詳細は [04](04-invariants.md#永続化) を参照してください。

## Identity Storage Migration

runtime は旧形式の互換 path を持たず、database を自動作成しません。migration 前に Bot を停止して inactive を確認します。失敗時は外部 backup と現場を保全し、新版を起動せず、`config_example/` で実 input を上書きしてはいけません。

### 新規 deployment での database 作成

起動は database 欠落を「空 policy」と推測しないため、新規 deployment は現行 schema の空 database を明示的に一度作成する必要があります。手順は [01 セットアップ](01-getting-started.md#identity-storage-の初期化) にあり、`install.sh` にも含まれています。作成 entry point は既存 target の上書きを拒否します。

### 旧 JSON → SQLite（9.1.5 以前）

`config/whitelist.json`、`config/blocklist.json`、および任意の `memory/blocklist/` を使う deployment は、**まず 9.1.5 へ上げてその版で migration を完了**させてから、現行版へ upgrade してください。

`bun run migrate:identity-storage` は 9.1.5 が最後の提供版です。「cold migration script は直近の released version → 現行版のみを覆う」という規約に従い 9.2.0 で `scripts/` から削除されており、現行版はこの migration を提供せず、旧 JSON リストを input として受け付けません。現行版で空の `whitelist.json`／`blocklist.json` を作ってから空 database を作る、という手順は取らないでください。実際のリストが取り残され、空の blocklist のまま Bot が稼働します。

### storage.sqlite：schema v5 → v7 一時 allowlist と広告免除

直近 released version の schema v5 には `temporary_whitelist_entries` がありません。現行の
production entry は正確な schema v7 lineage だけを受け付け、startup で table を自動追加したり
membership を書き換えたりしません。
新しいコードを配置した後も Bot を停止したまま、順に実行します。

```bash
bun run migrate:temporary-whitelist -- --check
bun run migrate:temporary-whitelist -- --apply
```

両 mode とも `bot.lock` を取得するため、systemd/supervisor は停止済みで inactive と確認できなければ
なりません。`--check` は read-only で SQLite integrity、JSONB storage class、schema version、
正確な v5/v6/v7 migration lineage を検証します。v5 は直接移行可能、v6 は同じ migration を再開する
ための intermediate lineage としてのみ受け付け、v7 は完了済みと報告します。その他の version や
未知 lineage はすべて拒否します。

released deployment に対して `--apply` が提供する直接 edge は v5 → v7 だけです。同じ migration が
v6 の commit 後に中断した場合は、その intermediate lineage から再開できます。書き込み前に主 DB と
既存 WAL/SHM を worktree 外へ byte 単位で copy し、owner/mode/SHA-256 manifest を書いて読み戻し
検証してから、現行 Drizzle migration で v6 の strict relational table を作り、最初の qualified day で
広告免除を付与する形へ table を再構築して `storage_metadata` を v7 に更新します。最後に完全な v7
inspect を再実行します。backup・migration・検証のどこかが失敗した場合は外部
backup path と元の error を保持するため、service を停止したまま同一 consistency set 全体を復元し、
row 削除、空 replacement 作成、version をまたぐ推測 migration は行いません。成功後も backup を保持し、
service を起動して `active/running`、2 restart interval の間 `NRestarts` が増えないこと、journal に
新しい非ゼロ終了がないことを確認して完了です。v7 に `--apply` を再実行しても完了済みと報告するだけで、
database は書き換えません。

### state.json：退場した `qaThumbnailUrl` を取り除く

`/set_qa` が「問題:」「回答:」形式の message でテキストを集めるようになり、inline 結果の
サムネイルは消費者を失ったため、`global.assets.qaThumbnailUrl` を schema から削除しました。
`state.json` は**厳格に解析**されます。キーが残っていると新しい版は起動段階で非ゼロ終了し、
黙って無視することはありません。アップグレード前に、Bot を停止してから実行します。

```bash
bun run migrate:qa-thumbnail -- --check
bun run migrate:qa-thumbnail -- --apply
```

どちらの mode も先に `bot.lock` を取得します（したがってサービスは停止済みである必要があります）。
このスクリプトは `state.json` と同じディレクトリの `state.json.bak` の**両方**を処理します。
両者は同じ厳格 schema を共有するため、主ファイルだけ直しても、破損時に `.bak` へ退避した時点で
やはり起動に失敗するからです。

**新しい版のコードが配置済みになってから実行してください**。順序は「サービス停止 → コード入れ替え → migration 実行 → サービス起動」です。逆に migration を先に済ませて*古い*版を起動すると、その版の起動時補完が `qaThumbnailUrl` を `state.json` に書き戻し（その版は補完対象 5 項目の 1 つとして数えます）、警告も出ないまま今回の migration が黙って取り消されます。

`--check` は deployment のデータを一切変更せず、どの副本にまだキーが残っているかを報告するだけです。
`--apply` はまず作業ツリー外に mode / owner / SHA-256 の manifest 付きで原文の snapshot を残し
（書き込み後すぐ読み戻してハッシュを照合）、その上でキーをその場で取り除きます。元の permission bit を
保ち、書き込み後に読み戻して検証し、さらに起動時と同じ厳格 codec で再度 decode します——書き出すものは
新しい版が読み戻せるものでなければなりません。同じファイルに他の不正フィールドがある場合は、
中途半端に完了させず、その場で書き込みを拒否します。

キーの除去は冪等です。すでに実行済みの deployment は「完了済み」と報告するだけで、何も変更しません。
`state.json` が無い新規 deployment も migration は不要です。
## 起動失敗の調査

起動失敗は**意図的な fail-fast**で、原因を含みます。検査を迂回せず、原因に合わせて対応してください。

- **パス付きでデータルート事前検査が失敗**
  - **原因**：data root・`memory`・`logs`・`database` が symlink、最初の 3 path が
    `0755` より広い（group/other に書き込み bit がある）、`database/` が `0770` より広いか collaboration group で書けない、
    directory が書込不能、または filesystem が fsync、hard link、atomic rename を
    support しない。
  - **対応**：全 instance を停止し、directory ごとに owner/group/mode を修正します。
    root・`memory/`・`logs/` は `0750` または `0755`、`database/` は deployment model に応じて
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
    migration lineage 不正、row codec failure、または blocklist と恒久／一時 allowlist が交差。
  - **対応**：error が schema v5 を示す場合は Bot を停止したまま上記 v5 → v7 cold migration を実行します。
    それ以外は [Identity Storage Migration](#identity-storage-migration) に従って database を作成または
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
  - **原因**：state の backup copy が壊れて隔離された。
  - **対応**：元のファイル名を特定し、先に破損原因を調査。
    state が自己復旧するのは壊れたのが**バックアップ側**のときだけです（壊れた
    バックアップを隔離し主ファイルから再構築し、ログを 1 行残します）。**主ファイル**が
    decode できない場合は常に起動を拒否し、両ファイルをそのまま保全します——エラーが
    示すフィールドを直してから起動してください。

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

[← 前のページ：06 変更レシピ](06-modification-guide.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#07-運用とトラブルシューティング) · **次のページ：なし →**

</div>
