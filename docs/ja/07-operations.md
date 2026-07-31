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

この permission gate を含む版へ既存 deployment を更新する前に、すべての instance を停止して手動 migration します：`sudo chown -R copy-ninjia:copy-ninjia /var/lib/copy-ninjia && sudo find /var/lib/copy-ninjia -type d -exec chmod 0750 {} +`。program は data root と `logs/`、`memory/` を `0750` で作成し、runtime UID の所有であることを検証し、3 path のシンボリックリンクを拒否します。`config/` は project tree 内の deployment input で、独立した runtime data root の一部ではありません。ただし `/white` と `/permission` は `whitelist.json` を atomic rewrite するため、runtime user はこの directory で一時 file を作成して rename できる必要があります。その他の設定 file は read-only のままで構いません。実行中に `whitelist.json` を外部編集すると、次の authorization command は上書きを拒否します。停止中に再起動して新しい file から cache を作り直してください。既存 data-root directory が `0750` より広い場合は起動を拒否し、暗黙の chmod は行いません。必要なら実際の owner/group に置き換え、runtime user の書き込み権限を維持してください。

`/unblock all` を削除する release への upgrade は strict configuration migration です。すべての instance を停止し、`config/whitelist.json` を worktree 外へ backup して、inventory・owner/mode・SHA-256 を記録します。各 entry から `isCanUnBlockAll` を手作業で削除し、現行の strict schema で parse できること、allowlist（`SUPER_ADMIN_USER_ID` を含む）と静的・動的 blocklist に交差がないことを確認します。期待する owner/mode を復元してから起動してください。旧 field は互換読込せず意図的に拒否するため、この変更は MAJOR release として扱います。backup と検証の出力に allowlist の内容を含めてはいけません。

プロセス crash や非ゼロ終了は `Restart=on-failure` に再起動させます。認証待ち状態、ロックダウン timer、AI メモリ、未確認の Telegram update は [04 実行時の正式な不変条件](04-invariants.md#永続化) の復元 semantics に従って継続します。

## データルート

`COPY_NINJIA_DATA_ROOT` がすべての実行時データパスを決めます。空の場合はプロジェクトルートです。

- **`state.json` + `state.json.bak`**
  - **内容**：グループスイッチ、copy、ロックダウンミラーなどの正式な状態。
  - **バックアップ**：主・副を同時にバックアップ。
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
    同一 key の revision、終端 tombstone を含む。
  - **バックアップ**：日付をまたぐ起動では最新旧日と当日を merge
    （当日の active/tombstone が優先）し、原子的な公開成功後だけ旧日を削除。
    定常時は当日だけ保持し、履歴 10,000 件または 4 MiB で compact。
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**
  - **内容**：`/batch_kick` が rolling window で読む正式な `chat_member` 入室事実。
  - **バックアップ**：user ID と timestamp を含むため機密データとして扱う。
    深夜をまたぐ処理中 query のため東京暦日 3 日分を保持。完全な再配信は再追記せず、
    履歴は user ごとの最新値へ compact し、1 chat/day は最新 250,000 人まで保持。
- **`memory/blocklist/blocklist.json`**
  - **内容**：`/block` の正式な恒久リスト（ユーザー ID とブロック時刻）。
  - **バックアップ**：必須。失うと全員のブロックが解除されたのと同じです。
    通常の解除は `/unblock` を使い、緊急の手編集は停止中に正しい JSON を保って
    行います。破損時は末尾を切り詰めず**起動を拒否**し、キーはそのまま復元できる
    10 進 ID でなければなりません。
- **`memory/blocklist/removals.json`**
  - **内容**：未完了のチャット別 BAN task を持つ durable outbox。
  - **バックアップ**：リストの複製ではありません。`blocklist.json` と
    `state.json` と同じ整合点でバックアップします。起動時に正式リストと
    チャット状態で filter して再投入し、task の着地後に削除。
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

`memory/` 直下にはファイルを置かず、7 ドメインがそれぞれ 1 つのサブディレクトリを所有します。起動復元は `ai/`、`stickers/`、`luck/`、`anti-raid/`、`blocklist/` を必要に応じて作成し、`ad-detected/` は最初の広告検出ヒット後、`joinlog/` は最初の入室事実または query 時にだけ現れます。起動復元は `joinlog/` を scan しません。物理上の `anti-raid/<day>.json` は単純な active 一覧ではなく追記ログです。作成・変更時に完全 snapshot を追加し、決着時に同じ key の `null` tombstone を追加し、復元時に履歴を現在 active な Challenge へ畳み込みます。停止が東京日付をまたいだ場合、起動時に最新旧日を厳格に読み、当日の記録を新しい値として重ねます。旧日破損時はどちらも書き換えず復元を拒否し、当日の原子 snapshot が成功した後だけ旧日を清掃します。

`joinlog/` の query は `[since, now]` を覆う最大 2 個の chat/day file を読み、window 内で user ごとの最後の入室だけを返します。3 日目の保持は 23:59 に採取され、深夜を越えて Worker が処理する in-flight query 専用です。冗長履歴 10,000 件または新規追記 4 MiB で compact を評価し、512 KiB 以上回収できる場合だけ atomic rewrite します。parse 可能でも schema が不正な file は byte を変えずその read/write を拒否し、末尾の truncate 断片だけ append layer が修復できます。

### `memory/` の補助ファイルとプロセス内限定状態

- 原子的な置換では一時的に `.<対象ファイル名>.<pid>.<uuid>.tmp` を作り、`fsync + rename` 後に消します。両者の間で hard kill された場合だけ残る可能性があります。`ai/`、`stickers/`、`luck/` は起動時に `*.tmp` を清掃します。`blocklist/` の 2 owner は自分の `.blocklist.json.*.tmp` / `.removals.json.*.tmp` prefix だけを清掃し、`ad-detected/` は最初の書き込み前に `.sample.json.*.tmp`、`joinlog/` は当日の directory を最初に接管するとき `*.tmp` を清掃します。現在の `anti-raid/` 復元はこの種のファイルを無視しますが、自動削除はしません。復元には使われないため、Bot を停止し、名前が原子書き込み形式へ厳密に一致すると確認した後だけ孤児として削除できます。
- `memory/ai/<chatId>.json.<timestamp>.<uuid>.corrupt` と `memory/stickers/<pack>.json.<timestamp>.<uuid>.corrupt` は JSON を parse できず一意名で隔離されたファイルです。通常復元の対象外で、自動削除もしません。同じ元 path が再び壊れた場合は旧証拠を上書きせず新しい隔離件を残します。parse はできても現行 version=1 schema に合わないファイルは隔離せず起動を拒否し、[06](06-modification-guide.md#永続化-schema-の変更) に従う手動 migration が必要です。
- `/block` の `confirmedKickedUserIdsByChat`、Challenge timer、広告検出の admission queue / deduplication Set、Telegram member/admin の短期 cache はプロセス内だけに存在し、対応ファイルはありません。特に東京日付単位の確認済み kick cache は日付変更またはプロセス再起動で空になり、`blocklist.json` や `removals.json` から推測して復元しません。

Bot 停止中または storage snapshot の整合境界で、データルート全体をバックアップします。`memory/` は機密データとして扱ってください。単一 tenant デプロイ基準では file mode が緩い `0644` です。詳細は [04](04-invariants.md#永続化) を参照し、アクセス制御はデータルートの owner・permission と host account の隔離で行います。

### `removals.json` v1 → v2

outbox v1 から v2 へ更新する前に Bot を停止し、手動で migration します。新版は v1 を厳密に拒否し、runtime 互換や自動書き換えを行いません。ファイルが存在しない場合、または既に v2 の場合は不要です。データルートを current directory として次を実行します。

```bash
outbox=memory/blocklist/removals.json
backup=memory/blocklist/removals.json.v1.bak
candidate=memory/blocklist/removals.json.v2
cp -a "$outbox" "$backup"
jq -e '
  if .version != 1 or (.entries | type) != "array" then
    error("expected removals.json version=1")
  else
    .version = 2
    | .entries |= map(
        if .params.probeMembership == true then
          .params |= del(.userIds, .joinedAt, .announcementMessageId)
        else
          .
        end
      )
  end
' "$outbox" > "$candidate"
chmod --reference="$outbox" "$candidate"
chown --reference="$outbox" "$candidate"
test "$(jq '.entries | length' "$backup")" = "$(jq '.entries | length' "$candidate")"
diff -u \
  <(jq -S '[.entries[].params.removalId] | sort' "$backup") \
  <(jq -S '[.entries[].params.removalId] | sort' "$candidate")
jq -e '
  .version == 2
  and all(.entries[];
    if .params.probeMembership == true then
      (.params | has("userIds") or has("joinedAt") or has("announcementMessageId")) | not
    else
      (.params.userIds | type == "array" and length > 0)
    end
  )
' "$candidate" > /dev/null
```

変更するのは sweep task だけです。`probeMembership: true` は「現在の blocklist でこの chat を走査する」という task なので、固定された `userIds`、`joinedAt`、`announcementMessageId` を削除します。`probeMembership: false` の即時 kick / 広告処置は、空でない `userIds` をそのまま保持しなければなりません。上記コマンドは version 2、entry 数と全 `removalId` の一致、sweep に上記 3 field がないこと、非 sweep に list が残ることも検証します。いずれかが非ゼロ終了した場合は置換しません。すべて通過した後だけ `mv "$candidate" "$outbox"` を実行して新版を deploy します。起動復元に失敗した場合は service を停止して `$backup` を戻し、復元と replay が正常だと確認してからだけ backup を削除します。Release の Compatibility / Migration Notes にもこの手順を必ず記載してください。

まだ `config/blocklist.json` を使う旧版から更新する場合、runtime 互換分岐は残しません。Bot を停止し、旧ファイルと既存の `memory/blocklist/` をバックアップしてから、旧ファイルを `memory/blocklist/blocklist.json` へ手動移動します。`removals.json` と結合してはいけません。前者は「誰を恒久的にブロックすべきか」、後者は「どのチャット別処置が未完了か」だけを表します。バックアップと移動先 JSON の一致を確認してから再起動してください。

## 起動失敗の調査

起動失敗は**意図的な fail-fast**で、原因を含みます。検査を迂回せず、原因に合わせて対応してください。

- **パス付きでデータルート事前検査が失敗**
  - **原因**：data root・`memory`・`logs` がシンボリックリンク、mode が `0750`
    より広い、ディレクトリへ書き込めない、または filesystem が fsync、hard link、
    アトミック rename をサポートしない。
  - **対応**：全 instance を停止し、owner/group を修正して
    `chmod 0750 <data-root>` を実行。それでも失敗する場合は、必要な semantics を
    持つ local filesystem を使用。
- **`bot.lock` が起動を拒否**
  - **原因と対応**：次の section を参照。
- **config schema 検証失敗**
  - **原因**：`config/*.json` または `.env` が不正。
  - **対応**：指摘された field を修正。mood の重みは合計 100、天気・時間帯の倍率は
    100 以下、スタンプパックは最大 5 個。
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
    state は別 copy が有効なら自己復旧できますが、AI/スタンプの隔離ファイルは
    自動復元も自動削除もしません。

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

[← 前のページ：06 変更レシピ](06-modification-guide.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#07-運用とトラブルシューティング) · **次のページ：なし →**

</div>
