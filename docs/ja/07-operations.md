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

program は root・`logs/`・`memory/`・初期 `database/` を作り（前 3 者は `0755`、`database/` は `0770`。実際の mode は umask でさらに絞られます）、4 path の symlink を拒否します。root・`logs/`・`memory/` は runtime UID 所有かつ `0755` 以下でなければなりません。この gate が止めるのは**書き込み**で、group または other に `w` bit があれば起動を拒否します。読み側は `0755` まで緩めています(既定 umask で作られる directory はもともとこの mode)。

> **代償**：`memory/` の新規 file は `0644` が既定値なので、既定のまま使う deployment では group chat の逐語記録を主に directory bit で保護します。`0755` のままにすると、同じマシンのどの local account からも読めます。マルチテナント host では data root と `memory/` を `0750`、既存 file を必要に応じて `0600`/`0640` に収めてください。runtime の adopt と replace はその mode を維持し、自動 chmod しません。deployment tooling は `database/` を `02770` に設定でき、主 DB と WAL/SHM は初回作成時に `0660` を使います。data root 全体へ再帰的に `chmod 0750` してはいけません。SQLite が sidecar を作るための group write を失います。`config/` は project tree 内の read-only deployment input であり、identity policy はもうここから load も write back もしません。

プロセス crash や非ゼロ終了は `Restart=on-failure` に再起動させます。認証待ち状態、ロックダウン timer、identity write-through、AI メモリ、未確認の Telegram update は [04 実行時の正式な不変条件](04-invariants.md#永続化) の復元 semantics に従って継続します。

### バイナリデプロイ

バイナリの配布ディレクトリには `copy-ninjia`、`binary.json`、インストーラー、設定例、`prompt/`、database schema ファイル、`node_modules/` 内の画像処理用ネイティブ依存が含まれます。全体を保持し、その中で `bash install.sh` を実行して設定と新規 database の初期化を行います。前面実行は `./copy-ninjia` を使います。systemd の `WorkingDirectory` はこのディレクトリ、`ExecStart` は実行ファイルの絶対パスとし、`start` 引数は付けません。システム Bun は不要です。

インストーラーが Latest の対応パッケージと SHA-256 を取得するのは新規ディレクトリだけで、既存バイナリデプロイの上書きや更新は行いません。更新は以下の停止、外部バックアップ、検証、手動移行手順に従います。独立した一時ディレクトリで新パッケージを検証し、デプロイ設定・資格情報・データを保持して、プログラムと同梱依存関係を更新します。cold migration が必要な場合は本ページの移行節に従ってツールを先に準備してください。起動入口は現在の形式だけを受け付けます。構築、プラットフォームの選択、アップロード照合は [05 リリース](05-dev-workflow.md#リリース) を参照してください。

## データルート

`COPY_NINJIA_DATA_ROOT` がすべての実行時データパスを決めます。未設定時はプロジェクトルートを使用し、明示的な空白値は起動時に拒否します。

- **`memory/global/state.json`**
  - **内容**：`copy` の全体復唱状態と、`ttsUsage` の音声合成の 1 日あたりの回数（窓の開始 `windowStartedAt` と回数 `count`。ボットが書き込みます。手でリセットするときはサービスを止めてからブロックごと削除します）。グループスイッチ・ロックダウン記録・権限スナップショット・翻訳セッションは `database/storage.sqlite` の `chat_states`、素材ディレクトリと URL は `config/dynamic/assets.json` に保持します。
  - **形式**：トップレベルは必須の `copy` と任意の `ttsUsage` だけです。`copy.copyMode` は欠落・`reverse`・`nya` だけを受け入れます。ファイルがなければ未使用として扱い、存在して不正な場合や未知のキーがある場合は起動を拒否し、自動アップグレードやエントリの破棄は行いません。メインスレッドだけが書き込み（一時ファイル + fsync + アトミック rename）、Disk I/O Worker は `memory/global/` に触れません。
  - **状態の手動編集**：サービスを停止して inactive を確認し、作業ツリー外の `mktemp -d` にこのファイルとデプロイデータを mode・所有者・SHA-256 付きでバックアップしてから編集します。変更しないフィールドは保持し、`decodeGlobalStateFile` で厳格に解析して想定差分と権限を確認してから起動します。バージョン更新は下記のコールド移行で行い、例や Git の内容でデプロイ状態を上書きしません。
  - **旧位置**：data root に 14.x の `state.json` または `state.json.bak` が残っている間は、起動と installer が拒否します。[全体状態のコールド移行](#全体状態のコールド移行statejson-memoryglobalstatejson-configdynamicassetsjson)で処理してください。
  - **専用画像ディレクトリ**（`config/dynamic/assets.json` の `random_h_image_dir`、既定 `./h_image`、data root 基準）：`/h_image` と明示ディレクトリのない cron ランダム画像が使います。追加は `/h_image add` を使い、手動ファイルは内容 SHA-256 の小文字 16 進数 64 文字に jpg/jpeg/png/webp 拡張子を付けます。他機能の画像は混ぜません。起動時に不正名、サブディレクトリ、ファイル symlink、残存 `.h_image-add-*` 一時ファイルを拒否します。残存物は停止・バックアップ後に確認して整理してください。サービスアカウントには読み書きとディレクトリアクセスが必要で、未作成なら 0755 で作成します。適合画像の増減は再起動不要です。稼働中に `random_h_image_dir` を変えると、同じ規則で新しいディレクトリを準備・検査してから切り替え、検査に失敗した変更は拒否します。ロールバックはコードに一致する設定・state・画像を一緒に復元します。
- **`memory/wed/<chatId>.json`**
  - **内容**：各群の発言済みメンバー ID の数値配列（例：`[5974478892]`）。主スレッドは各群で同じ長期 `Set<number>` を再利用します。最大 25 群、各群 150,000 ID です。満杯では既存 ID を保持し、退室で空きができると追加を再開します。
  - **検証**：ファイル名は正規形の負の安全整数グループ ID、要素は重複のない正の安全整数です。不正 JSON、重複、型や容量の違反は原本を切り詰めたり修復したりせず起動を拒否します。ディレクトリやファイルの欠落は許可し、必要時に作成します。
  - **保存とバックアップ**：実際の変更を累計 300 件または最初の変更から 30 秒で DiskIO に送り、全体を原子置換します。変更がなければ書き込みません。日次の期限は無く再起動時はファイルから復元しますが、`/init disable` と Bot のグループ退出ではファイルごと削除します（管理者権限の剥奪だけでは削除しません。権限が戻れば再び必要になるためです）。データルートの整合バックアップに含め、突然の終了では未保存変更を失う場合があります。
  - **退室の整理**：退室サービスメッセージ、`chat_member` 更新、毎日深夜の再確認が退室者をファイルから外します。後の 2 つは Bot がグループ管理者のときだけ機能します。管理者でない群では退室サービスメッセージしか残らず、大きめのスーパーグループやメンバー一覧を隠した群では Telegram がそれを送らないことがあるため、ファイルに退室済みの ID が残り、`/wed` もそのまま抽選します。これは想定どおりの挙動で、障害ではありません。確実に整理するには Bot に管理者権限を与えてください。手作業で ID を消す場合は、ほかの実行時状態と同じくサービスを停止してから編集します。
- **`memory/stickers/<pack>.json`**
  - **内容**：allowlist 対象スタンプパック 1 件の version=1 カタログ。
    `file_unique_id` ごとの emoji/説明とパック要約を保持。
  - **バックアップ**：オンラインパックとの照合で再構築可能。
    `config/dynamic/stickers.json` から外れたパックのファイルは起動復元時に削除。
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
    `/init disable` と Bot のグループ退出では、保持 window の内外を問わずその chat の
    ファイルをすべて削除し、自然な期限切れを待ちません（管理者権限の剥奪では削除しません）。
- **`database/storage.sqlite`**（runtime では `-wal` / `-shm` sidecar が存在し得ます）
  - **内容**：schema v11 共有ストレージです。`permission_list.policy` は厳密な JSONB の恒久権限、`blocklist_entries` はブラックリストを保持します（`data` は `blockedAt`、Telegram metadata、省略可能な `participantInvalidCount` を持ち、この field を認識しない旧版はこの field を持つ row があると起動を拒否します。そうした版へ戻すときはプログラムだけを置き換えず、アップグレード前の同一時点の database バックアップも併せて復元しなければなりません）。`temporary_ad_bypass_entries` は `ad_bypass`、`ad_bypass_granted_at`、`qualified_days`、`send_count`、`counted_at`、`qualified_at` で広告免除の活動を集計します。`pending_blocked_removals` は未完了の群別 ban、`storage_metadata` と Drizzle journal は schema と厳密な系譜を保持します。
  - **群状態と人設**：`chat_states` は最大 25 行。`chat_id` が主キー、`status` は必須 JSONB、`ai_persona` は NULL 許容・空白のみ不可の TEXT で、本群専用プロンプトを保存します。未設定ならプロジェクトの `prompt/persona.md` を使用します。起動時に状態と人設を既存メインスレッド群 cache に読み込み、`/bot_status` は設定の有無をそこから確認します。`status.translate` は本群の翻訳セッションで、欠落はセッションなし、存在する場合は 1–5 セッションの空でない配列です（例：`"translate": [{"translatedUser": {"id": 123}, "language": "uk"}, {"translatedUser": {"id": 456}, "language": "ru"}]`）。同群内の identity ID は一意で、方向は `ja`・`cn`・`en`・`uk`・`ru` のみ、identity は `CachedUser` として厳密検証します。`/init disable` と Bot 退群では行と人設を削除し、未復元 lockdown は復元 protocol に従って保持します。
  - **AI context**：NULL 許容 JSONB `ai_context` は version=1 の逐語メッセージ、要約、未統合要約、保存時刻を保持し、既存 AI Worker memory cache とメインスレッド復元 mirror を使用します。書き込みは既存群行だけを更新し、context だけの行は保持しません。記憶の消去はこの列を NULL にして人設を保持します。本文・名前・引用は単一行、引用 text/quote は最大 500 UTF-16 code unit、`at` は有効な東京時刻 `YYYY/MM/DD HH:mm:ss` です。まだ説明していない Bot 画像の逐語メッセージは `pendingImage`（`origin` は `command` / `generated` / `referenceGenerated`、`caption` は単一行）を持ち、説明済みの画像と通常のメッセージはこのキーを持ちません。要約は改行可能。不正 field は復元を拒否して入れ子 path を示し、元データを変更しません。
  - **バックアップと復元**：群会話と専用プロンプトを含む機密データです。Bot 停止中に本体と存在する WAL/SHM を同一集合として作業ツリー外へコピーし、所有者・mode・SHA-256 を記録して検証します。Disk I/O Worker が DB を独占し、起動時に integrity、JSONB、schema、系譜、厳密な行 codec、policy 排他、outbox 参照を検証します。群状態と AI snapshot は同じ接続から復元します。identity の参照は 8,192 件 LRU と update に必要な ID の cold read を使います。検証失敗時は自動建庫・移行・行破棄・縮退をせず起動を拒否します。
- **`memory/ad-detected/sample.json`**
  - **内容**：広告判定ヒットの生サンプル。時刻、メッセージ ID と本文、判定理由、
    引用/返信コンテキストを含む。
  - **バックアップ**：**純粋なバイパスで、プロセスは決して読みません**。失っても
    挙動は変わらず、`config/dynamic/ad_samples.json` を調整する素材が減るだけです。
    8 MiB 到達時に `sample.<東京日付>[.<連番>].json` へ自動ローテーションし、
    アーカイブは当日を含む直近 15 東京暦日だけ自動保持。
- **`memory/ad-detected/sample.<YYYY-MM-DD>[.<連番>].json`**
  - **内容**：`sample.json` のローテーション済みアーカイブ。同日 2 個目は
    `.2` から増加。
  - **バックアップ**：厳密な名前の通常ファイルだけを直近 15 東京暦日保持。
    不明な名前、ディレクトリ、シンボリックリンクは自動削除しない。
- **`memory/ai-daily-usage/usage.json`**
  - **内容**：モデルリクエストの token 使用量。provider 応答の usage だけを取り、会話内容は
    含まない。1 つの JSON object で、先頭の `summary` は直近に終わった東京暦日の集計
    （リクエスト数、入力/キャッシュ命中/出力 token、命中率、および
    `<capability>/<provider>/<model>` ごとの同じ集計）。残りのキーは未集計の個別記録で、
    キーは東京時刻 + UUID、値は capability、provider、model と 3 種の token 数。命中率は
    命中 token ÷ キャッシュ使用量を返したリクエストの入力 token で、小数 4 桁に丸める。
    キャッシュ使用量を返さない provider のリクエストは `cachedInputTokens` が `null` で、
    合計にだけ入る。
  - **書き込み**：記録は診断チャネル経由で Disk I/O Worker のメモリバッファに入り、300 件
    または最初の 1 件から 30 秒で末尾に追記し、統一 flush でも書き出す。東京 0 時の
    maintenance と起動時 maintenance が今日より前の記録を直近の日の `summary` にまとめて
    削除し、集計は 1 日分だけ残す。
  - **バックアップ**：純粋な副経路で、失っても動作は変わらない。書き込み失敗はその
    バッチの統計を失うだけ。現行形式に合わない内容へ書き換えられた場合（末尾の破断を
    除く）は起動を拒否して元のバイトを残すので、削除または修正してから起動する。
  - **計量対象**：`text`、`summary`、`media`、`image`、`tts`、`ad_detect`。Google generateContent と Interactions はそれぞれの field を対応付け、出力に応答と thought token を含めます。OpenAI Responses、広告判定 Chat Completions、画像生成・編集、token 型の文字起こしは各 usage を読みます。有効な usage は応答ごとに 1 回数え、空本文、decode 失敗、アプリ側 retry の各応答、取り消し後に届く SDK 応答も含みます。token 未提供や duration だけの応答は推定しません。TTS の 1 日の回数制限は別途 `memory/global/state.json` に保存します。
  - **記録欠落の診断**：`AI token usage unavailable` は capability、provider、reason だけを含みます。reason は `missing`（usage 欠落）、`invalid`（不正 usage）、`sink`（スレッド内の出口なし）、`duration`（時間だけ）、`transport`（出口送信失敗または主スレッド拒否）です。同じ出口の lifecycle 内で各組み合わせを 1 回だけ記録し、モデル名、本文、認証情報は含めません。診断 FIFO の超過は別の有界な破棄集計、書き込み失敗は Disk I/O のエラーで記録します。このファイルは best-effort の統計で、完全な請求記録ではありません。

- **`logs/`**
  - **内容**：英語メッセージのエラーログ。
  - **バックアップ**：必要に応じて。
- **`bot.lock` と `.guard` / `.recovery`**
  - **内容**：単一インスタンスロック。
  - **バックアップ**：停止時の snapshot とともに保全し、手動編集や実行中 process への lock 復元は行いません。

`memory/` 直下にはファイルを置かず、8 domain がそれぞれ 1 つの subdirectory を所有し、identity policy は別の `database/` に置きます。起動時は復元が必要な state domain（`joinlog/` の保持 window を含む）を read-only scan して厳格 decode し、すべて成功した後だけ owner を adopt します。directory 作成、temporary/orphan/期限切れ file の清掃、compact は成功応答後に行い、その後で `Asia/Tokyo` を明示した Bun native の東京 0 時 maintenance cron を 1 つ登録します。この cron は最初に主スレッドへ `/wed` の日次メンバー再確認を通知し、その後で運勢 file、log、AI キャッシュ使用量の集計、入室 log、広告 sample archive、認証待ちの日別 file、一時 allowlist activity をまとめて maintenance し、1 domain の失敗で残りを止めません。既存の起動時・業務 event 経路は fallback として残します。一時 allowlist maintenance は shared SQLite の pending final value を先に commit し、一時 write が未 commit のままなら削除を拒否します。当日 row と終了したばかりの日に qualified だった row を保持し、その日の unqualified row とさらに古い row は全体を削除します。cleanup 後に到着した失効済み旧日 write は元の revision の tombstone に正規化します。`ad-detected/` は引き続き最初の hit 後にだけ現れ、すでに directory がある場合も起動成功後の maintenance は sample 内容を読まず directory entry だけを走査します。物理上の `anti-raid/<day>.json` は単純な active 一覧ではなく追記ログです。作成・変更時に完全 snapshot を追加し、決着時に同じ key の `null` tombstone を追加し、復元時に履歴を現在 active な Challenge へ畳み込みます。停止が東京日付をまたいだ場合、起動時に最新旧日を厳格に読み、当日の記録を新しい値として重ねます。旧日破損時はどちらも書き換えず復元を拒否し、起動成功後の maintenance だけが当日の原子 snapshot を公開して旧日を清掃します。実行中は統一 cron が同じ rollover を起動し、失敗時は active mirror を保持したまま unref 済み 1 秒 timer で再試行します。

`joinlog/` の query は `[since, now]` を覆う最大 2 個の chat/day file を読み、window 内で user ごとの最後の入室だけを返します。3 日目の保持は 23:59 に採取され、深夜を越えて Worker が処理する in-flight query 専用です。冗長履歴 10,000 件または新規追記 4 MiB で compact を評価し、512 KiB 以上回収できる場合だけ atomic rewrite します。parse 可能でも schema が不正な file は byte を変えずその read/write を拒否し、末尾の truncate 断片だけ append layer が修復できます。

### `memory/` の補助ファイルとプロセス内限定状態

- 原子的な置換では一時的に `.<対象ファイル名>.<pid>.<uuid>.tmp` を作り、`fsync + rename` 後に消します。両者の間で hard kill された場合だけ残る可能性があります。起動 inspect はこれらを記録するだけで削除しません。全 domain の検証と adopt が成功して成功応答を返した後、logs、`ai-daily-usage/`、`stickers/`、`luck/`、`joinlog/`、`wed/` の maintenance が対応する `*.tmp` を清掃します。既存の `ad-detected/` directory は起動成功後の maintenance で `.sample.json.*.tmp` を清掃し、最初の sample 書き込みにも同じ fallback を残します。`anti-raid/` は temporary file を復元 input から除外します。`storage.sqlite-wal` と `storage.sqlite-shm` は通常の SQLite sidecar であり、孤児一時 file として削除してはいけません。
- Challenge timer、広告検出の admission queue / deduplication Set、Telegram member/admin の短期 cache はプロセス内だけに存在し、対応ファイルはありません。

Bot 停止中または storage snapshot の整合境界でデータルート全体をバックアップし、SQLite 主 DB と存在する sidecar は同一時点から取得します。`memory/` と `database/` は機密データとして扱ってください。新規 memory file は `0644`、DB と sidecar は初回作成時に `0660` が既定値で、既存 file の mode は adopt と atomic replace 後も維持されます。詳細は [04](04-invariants.md#永続化) を参照してください。

## Identity Storage Migration

runtime は旧形式の互換 path を持たず、database を自動作成しません。migration 前に Bot を停止して inactive を確認します。失敗時は外部 backup と現場を保全し、新版を起動せず、`config_example/` で実 input を上書きしてはいけません。

### 新規 deployment での database 作成

起動は database 欠落を「空 policy」と推測しないため、新規 deployment は現行 schema の空 database を明示的に一度作成する必要があります。手順は [01 セットアップ](01-getting-started.md#identity-storage-の初期化) にあり、`install.sh` にも含まれています。作成 entry point は既存 target の上書きを拒否します。

<a id="upgrade-15"></a>

### 14.0.0 から 15.0.0 への更新

> [!IMPORTANT]
> 15.0.0 は全体状態を data root の `state.json` から `memory/global/state.json` へ、ランダム画像ディレクトリと素材 URL を `config/dynamic/assets.json` へ移し、`state.json.bak` を保持しなくなり、`config/` を反映方法ごとに `static/` と `dynamic/` の 2 つの subdirectory に分けます。先にサービスを停止してバックアップし、それからプログラムとデプロイデータを更新してください。設定とデータの検証が終わるまで起動しないでください。

| 確認項目 | 操作 |
| :--- | :--- |
| 全体状態 | 次節の全体状態コールド移行を実行し、出力を `memory/global/state.json` に置き、旧 `state.json` と `state.json.bak` を data root の外へ移します。どちらかが data root に残っている間は起動と installer が拒否します |
| 素材設定 | 移行は組み込み既定値と異なる素材項目だけを `config/dynamic/assets.json` に書きます。このファイルが出力されなければ置く必要はありません。フィールドは[設定リファレンス](../../config_example/README/ja.md#assetsjson)を参照 |
| 設定ディレクトリ構成 | 停止後に `bot.json`、`g-auth.json` を `config/static/` へ、残りの 6 つ（`agent.json`、`assets.json`、`ad_samples.json`、`mood.json`、`stickers.json`、`cron.json`）を `config/dynamic/` へ移し、元の所有者と mode を保ちます。`config/dynamic/` は空でも作成します。いずれかの file が `config/` 直下や誤った subdirectory に残っている場合、または `config/dynamic/` がない場合は起動を拒否し、installer も置き場所の誤りを拒否します。`static/` の file は変更後に再起動が必要で、`dynamic/` の file は hot reload されます。詳細は[設定リファレンス](../../config_example/README/ja.md)を参照 |
| 復元と権限 | 外部バックアップと一覧を保持します。サービスアカウントは `memory/global/`、database ディレクトリ（WAL/SHM を含む）、ロック、その他の memory ディレクトリに書けなければなりません。`config/` は読み取り専用でも構いません |

### 全体状態のコールド移行（state.json → memory/global/state.json + config/dynamic/assets.json）

入口は [`scripts/migrateGlobalState.ts`](../../scripts/migrateGlobalState.ts) で、14.x が出力する形式だけを受け付けます。`state.json` のトップレベルは `global` だけで、`copy` は必須、`assets` は任意です（14.0.0 の状態形式と同じで、14.0.0 より後に追加された `ttsUsage` も拒否します）。`state.json.bak` があれば `state.json` とバイト単位で一致しなければならず、一致しない場合は拒否して人手の照合に委ねます。未知の系譜、移行済みの新形式、不正なフィールドは拒否します。古い配置は先に[次節](#1400-より前のバージョンからのアップグレード)で 14.x 形式に到達させてください。本番起動は現形式だけを検証し、移行は行いません。

1. サービスを停止し、inactive と全プロセスの終了を確認します。作業ツリー外に `mktemp -d` でバックアップを作り、`state.json`、`state.json.bak`、`config/`、`database/` 全体（SQLite 本体と既存 WAL/SHM は同一停止時点のもの）と `memory/` をコピーします。ファイル一覧・mode・所有者・SHA-256 を記録して全コピーを検証します。
2. ソースバックアップの外に新しい出力ディレクトリを指定します。親ディレクトリは存在している必要があります。スクリプトはソースを変更せず、サービスを操作せず、デプロイファイルも置換しません。

```bash
bun run migrate:global-state \
  --source-root /absolute/cold-backup \
  --output-root /absolute/new-staging-directory
```

バイナリ配布パッケージは現在有効なコールド移行をすべて同梱し、システムの Bun もソースも不要です：`BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateGlobalState.js --source-root <バックアップ> --output-root <新ディレクトリ>`。

3. `copy` はそのまま出力の `memory/global/state.json` に書きます（`global` の包みはなくなります）。`assets` の 5 項目は `config/dynamic/assets.json` のキー（`random_h_image_dir`、`fortune_thumbnail_url`、`probability_thumbnail_url`、`gag_thumbnail_url`、`bot_default_avatar_url`）に変わり、値は前後の空白を除き URL を正規化したうえで、組み込み既定値と異なるものだけを残します。すべて一致すればこのファイルは生成しません。database はこの移行に関与しません。
4. `ready.json` は変換・厳格検証・ソース再確認が完了した唯一の印です。`sourceFiles`・`outputFiles` のハッシュとメタデータ、および `assetKeys` を確認します。失敗や中断時はバックアップと不完全な出力を残し、元のバックアップから新しいディレクトリへ再実行します。既存の出力は上書きしません。
5. 停止状態で `memory/global/state.json` を runtime data root に、存在する場合は出力の `config/dynamic/assets.json` を設定ディレクトリの `dynamic/` に置き、旧 `state.json` と `state.json.bak` を data root の外へ移します（外部バックアップには残します）。サービスアカウントが `memory/global/` に書けることを確認します。`config/dynamic/assets.json` は他の設定と同じく読み取り専用で構いません。
6. 設定と全体状態を厳格に検証してから起動し、supervisor の再起動間隔を 2 回以上観察して `active/running`、`NRestarts` が増えないこと、journal に新しい非ゼロ終了がないこと、起動ログの復唱対象と `/h_image` の画像庫が想定どおりであることを確認します。すべての検証が終わるまで外部バックアップを保持し、ロールバックでは対応するコードと同一時点のデータ一式を復元します。

### 14.0.0 より前のバージョンからのアップグレード

14.0.0 より前の配置は段階的に 14.x 形式へ到達させます。`14.0.0` タグのソースを checkout（または 14.0.0 配布パッケージをインストール）し、そのドキュメントに従って停止状態で `migrate:translate-sessions` を実行します（13.0.x より前の配置は先に `13.0.2` のドキュメントに従って `migrate:h-image-add-permission` と `migrate:bot-config` を実行します）。その出力を配置してから、本バージョンで前節の全体状態移行を実行します。中間バージョンを起動する必要はありません。現在の入口はこれら以前の形式を直接受け付けません。installer も 12.1.0 の `telegram.json` identity 入口を見つけると拒否し、先に 13.x への更新を求めます。

### ランダム画像ライブラリのファイル名コールド移行

専用画像は `config/dynamic/assets.json` の `random_h_image_dir` で指定し、既定は runtime data root 下の `h_image/` です。この cold migration は直接前序の `<uuidv7>[-<file_unique_id>]<拡張子>` だけを受け付け、**内容 SHA-256** と拡張子の名前を生成します。現在の起動検査は旧名を拒否し、自動移行しません。入口は
[`scripts/migrateRandomImageNames.ts`](../../scripts/migrateRandomImageNames.ts) です。

1. サービスを停止し、inactive で残留プロセスがないことを確認します。`mktemp -d` でライブラリ
   ディレクトリを作業ツリー外に完全バックアップし、ファイル一覧・mode・所有者・SHA-256 を記録して
   コピーを 1 ファイルずつ照合します。
2. ソース外の新しい出力ディレクトリを指定します。親ディレクトリは存在し、出力先自体は未作成で
   ある必要があります。スクリプトはソースを変更せず、サービス操作もデプロイファイルの置換も
   行いません。

```bash
bun run migrate:random-image-names \
  --source-directory /absolute/cold-backup/images \
  --output-directory /absolute/new-staging-directory
```

3. 各画像は内容の SHA-256 に改名し、拡張子はファイル先頭から判定し直します（`.jpeg` は `.jpg` に
   なり、実体と合わない拡張子は訂正されます）。バイト列が完全に同じ画像は 1 ファイルに統合し、
   明細は `ready.json` の `duplicates` に記録します。ライブラリ候補でない項目（隠しファイル、
   サブディレクトリ、シンボリックリンク、他の拡張子）が 1 つでも混ざっている場合、または内容が
   jpeg・png・webp でないファイルがある場合は、その場で名指しして移行全体を拒否します。
   ライブラリはデプロイ側のデータであり、何を捨ててよいかをスクリプトが代わりに決めることは
   しません。整理してから再実行してください。
4. コピー、ファイルごとのハッシュ照合、ソース再確認が完了した場合だけ `ready.json` が生成され
   ます。`sourceFiles`・`outputFiles` のハッシュと metadata、および `renamed`・`alreadyNamed`・
   `deduplicated` を確認します。失敗・中断時はバックアップと途中出力を保持し、元のバックアップから
   別の新規出力先へ再実行します。既存出力は上書きできません。
5. 停止状態でライブラリディレクトリを検証済みの産物に手動で置き換え、`sourceFiles` から所有者と
   mode を復元します。サービスアカウントがそのディレクトリを読め、かつ書き込めること
   （`/h_image add` が書き込みます）を確認してください。
6. 起動後は最低 2 回の supervisor 再起動間隔にわたり `active/running`、増えない `NRestarts`、
   journal に新しい非ゼロ終了がないことを確認し、`/h_image` を 1 回引いて送信できることを
   確かめます。全検証完了まで外部バックアップを保持します。

### 11.0.9 からの段階的なアップグレード

11.0.9 は schema v8 を使用し、三段階が必要です。独立ディレクトリで固定コミット `500e848faeda75dcae3c3329507f24d05137e3b9` の `migrate:ai-context` を実行して v9 を生成し、12.1.0 リリースの `migrate:clear-context-permission` で v10 を生成し、13.0.2 リリースの `migrate:h-image-add-permission` で v11 を生成します。Bot 設定も同様に 13.0.2 の `migrate:bot-config` で 13.x 形式へ移行します。その後、14.0.0 リリースの `migrate:translate-sessions` で 14.x 形式に到達させ、現行入口で[全体状態移行](#全体状態のコールド移行statejson-memoryglobalstatejson-configdynamicassetsjson)を完了します。全工程でサービスを停止したままにし、中間バージョンのアプリは起動しません。すでに 12.x（schema v10）のデプロイは 13.0.2 の段階から始めます。以下の実行前に、上節の手順で `memory/ai/` と SQLite WAL/SHM を含む外部の整合バックアップを取得してください。Git リポジトリには固定コミットと 12.1.0、13.0.2 タグが必要で、各出力ディレクトリは未作成である必要があります。

中間ソースはこの手順の必須入力です。11.0.9 タグまたは現行ソースアーカイブだけを持つ環境では、先に固定コミットの完全なソースを取得してください。リリース前にそのソースを独立して保持・提供し、squash 後に reset される dev 履歴だけに依存しないでください。

独立した中間ソースアーカイブ `copy-ninjia-schema-v9-source-500e848f.tar.gz` も使用できます。SHA-256 は `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8` です。検証後、以下の `git archive` を `tar -xzf /absolute/copy-ninjia-schema-v9-source-500e848f.tar.gz -C "$MIGRATION_CODE"` に置き換えてください。

```bash
MIGRATION_CODE="$(mktemp -d)"
git archive 500e848faeda75dcae3c3329507f24d05137e3b9 | tar -x -C "$MIGRATION_CODE"
(
  cd "$MIGRATION_CODE"
  bun install --frozen-lockfile
  bun run migrate:ai-context \
    --source-root /absolute/11.0.9-cold-backup \
    --output-root /absolute/new-schema-v9-staging
)
RELEASE_CODE="$(mktemp -d)"
git archive 12.1.0 | tar -x -C "$RELEASE_CODE"
(
  cd "$RELEASE_CODE"
  bun install --frozen-lockfile
  bun run migrate:clear-context-permission \
    --source-root /absolute/new-schema-v9-staging \
    --output-root /absolute/new-schema-v10-staging
)
V13_CODE="$(mktemp -d)"
git archive 13.0.2 | tar -x -C "$V13_CODE"
(
  cd "$V13_CODE"
  bun install --frozen-lockfile
  bun run migrate:h-image-add-permission \
    --source-root /absolute/new-schema-v10-staging \
    --output-root /absolute/new-schema-v11-staging
)
```

第一段階では元の 16 権限がすべて true の場合だけ `isCanConfigAiPrompt` を付与し、第二段階では 17 権限がすべて true の場合だけ `isCanClearContext` を付与し、第三段階では 18 権限がすべて true の場合だけ `isCanAddHImage` を付与します。第一段階は `chat_states` に存在するグループの記憶だけを取り込みます。対応行のない記憶は `discardedContexts` に計上し、グループ状態を作成しません。各段階の `ready.json`、入力・出力ハッシュ、取り込み・破棄件数を確認し、v11 主 DB と 13.x 形式の state を翻訳セッション移行の入力にします。元のバックアップ全体を保持し、移行済みの `memory/ai/` を配備ルートから手動で削除してください。他の設定と状態は元のパスに保持します。続いて上節の所有者・権限復元、厳密検証、起動観察を実施します。現行ランタイムと移行入口は v8 や v9 を直接受け付けません。

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
- **設定ディレクトリ構成の不一致**
  - **原因**：deployment file が `config/` 直下や誤った subdirectory にある（エラーは `<パス>: $ must be absent; <file> belongs in <subdirectory>/.` の形）、または `config/dynamic/` がない。
  - **対処**：停止後に `bot.json`、`g-auth.json` を `config/static/` へ、その他の deployment file を `config/dynamic/` へ移し、所有者と mode を保ちます。
- **config schema 検証失敗**
  - **原因**：`config/{static,dynamic}/*.json` が不正。
  - **対応**：指摘された field を修正。mood の重みは合計 100、天気・時間帯の倍率は
    100 以下、スタンプパックは最大 5 個。
- **identity database が欠落、または validation failure**
  - **原因**：migration 未実行、`storage.sqlite` が書込不能、integrity/JSONB/schema/
    migration lineage 不正、row codec failure、または blocklist と恒久／一時 allowlist が交差。
  - **対応**：現在のデータベース形式は schema v11 です。14.0.0 の有効なデータベースはそのまま保持し、それ以前の系譜は上記の段階的更新を行います。
    それ以外は [Identity Storage Migration](#identity-storage-migration) に従って database を作成または
    rollback します。同一 consistency point の DB と sidecar を復元し、collaboration group
    permission を直してから起動します。空 DB を作ったり失敗 row を削除してはいけません。
- **運勢結果と receipt key が不整合**
  - **原因**：当日結果と `receipt-secret.json` が異なる backup 時点から復元された、
    または片方だけを復元した。
  - **対応**：Bot を停止し、同じ整合時点の `memory/luck/` 全体を復元。
    key だけを削除・再生成しない。
- **全体状態ファイルが不正、または旧位置に state.json が残っている**
  - **原因**：`memory/global/state.json` を解析できないか現在の schema に一致しない、または
    data root に 14.x の `state.json` / `state.json.bak` が残っている。
  - **対応**：サービスを停止したまま原本をバックアップし、エラーに示されたファイルパス、
    フィールドパス、期待される形式に従って修正して再検証します。旧位置のファイルはコールド移行を
    経てから data root の外へ移します。ランタイムは不正ファイルの全バイトを保全して起動を拒否し、
    `*.corrupt` ファイルを生成しません。

### `bot.lock` が起動を拒否する場合

lock file の形式は厳密な `v2:pid:starttime:boot_id:sha256(token)` です。`starttime` は `/proc/<pid>/stat` の 22 番目の field です。インスタンスロックは Linux `/proc` に明示的に依存し、fail-closed です。

- **別プロセスが実際に動作中**：PID、starttime、boot ID がすべて一致する場合だけ active owner と見なします。先にそのプロセスを停止してください。同じデータルートを 2 つのインスタンスで使うことはできません。
- **プロセス停止または再起動後の stale v2 lock**：次回の起動または終了時に自動削除するため、手作業は不要です。
- **旧形式または破損形式**：非互換 lock は読み取らず、自動 migration せず、PID から推測して削除もしません。関連プロセスが存在しないことを確認してから、旧 lock を手動削除して再起動します。
- **停止時の release 失敗**：owner を検証できない、または unlink に失敗したため、process は非ゼロで終了して lock を残します。先に報告された filesystem または ownership error を解消し、owner が動作中かもしれない lock を削除しないでください。
- `.candidate.*` は hard-link lock protocol の候補ファイルです。`.tmp` は全体状態ファイルまたは lock registry のアトミック書き換えに使う一時ファイルです。通常操作で削除され、現行形式の残存物は owner が inactive と確認できた後、またはインスタンスロック取得後に起動処理が回収します。

token fingerprint は lock owner の識別用であり、データ隔離境界ではありません。複数 Bot の並列デプロイでは別々のデータルートを使用してください。

## アップグレードとリリース

1. ソース作業ツリーで `bun run release:check -- --version <tag>`（frozen lockfile + 全検査 + カバレッジ数値の照合 + fault injection + バイナリ構築検証）をすべて通します。
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

### インストーラーのサービスとバックアップ境界

`install.sh` は最初のインプレース書き込み前に、既存サービスの `inactive/dead`、対象の実体作業ディレクトリ、単一の Bun 入口または現在のデプロイのバイナリ入口を確認します。状態問い合わせ失敗・パス不一致・複数の `ExecStart` は処理を拒否します。稼働中のデプロイは先に上記の運用手順で停止してください。

既存 unit と置換するデプロイ設定は共通の外部バックアップ一覧に原パス・mode・所有者・SHA-256 を記録します。失敗時は原本と現場を保持します。一覧に従って個別に復元し、ハッシュ・mode・所有者を照合したうえで、全検証成功後にだけバックアップを削除します。

設定・unit・データへの書き込み前に既存 unit の data root を照合します。`Environment` の `COPY_NINJIA_DATA_ROOT` は厳密に解析でき、今回の installer の有効 root と一致する必要があります。空でない `EnvironmentFiles` と、この変数を含む `PassEnvironment` / `UnsetEnvironment` は拒否します。それらを利用する deployment は、先にバックアップと停止の手順を実施し、対応する明示的な `Environment` 設定へ手動で整理してください。installer は有効値を推測・移行しません。既存 deployment JSON の再入力は元の mode を保持し、新規 file は `0600` を使います。

観察期間は有効な再起動待機上限の 2 倍に 2 秒を加えた値です。基準の `RestartUSec` に、有効な指数 backoff の `RestartMaxDelayUSec` と `RestartRandomizedDelayUSec` を反映します。`RestartMaxDelayUSec=infinity` は backoff を無効にし、基準間隔がゼロの場合も backoff は無効です。古い systemd にない backoff・ランダム遅延属性は加算せず、存在して不正な値は拒否します。unit 起動後に `NRestarts` 基準値を取得し、観察中の増加・減少はどちらも拒否し、観察後の同一回数と `active/running` を要求します。journal は起動前 cursor より後を読み、cursor がない場合は今回の開始時刻以降を読みます。読み取り不能・異常終了・状態不正は非ゼロ終了し、外部バックアップを保持します。

## 日常の監視項目

- `logs/`：Disk I/O Worker がエラーを batch 追記します。文面は英語なので直接 grep できます。
- Worker crash はレート制限付きで自己修復し、ミラーまたは snapshot から復元します。介入が必要なのは crash loop が繰り返される場合で、通常は永続化データとコード version の不一致が原因です。
- 永続化が上限付き retry を使い切ると、プロセスは非ゼロで終了します。これは availability より durability を優先する設計です。systemd が最後の整合状態から再起動します。
- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`：定時タスクのある動作が最終的に失敗し、その回の残りを飛ばしました。末尾は Telegram のエラーコードと説明、またはローカルの理由です。`403` はたいてい Bot が送信先グループから外されたこと、`400` はたいてい URL が取得できないか Telegram がファイル形式を受け付けないこと、`local file ... is missing` は `payload.path` の指すローカルファイルがなくなったこと、`speech synthesis failed: <理由>` は `send_voice` が音声を合成できなかったことを示します（`tts unconfigured` / `tts unsupported` は設定の問題、`worker unavailable` は AI Worker が動いていないこと、`synthesis failed` / `timed out` はたいていモデル側の問題で、同時に `Gemini speech synthesis API` のエラーが 1 行出ます。`daily limit reached` は 1 日のボイス上限 `agent.tts.daily_limit` を使い切ったことを示し、再試行しません）。`cron.json` や素材を直せば hot reload され、再起動は不要です。
- `/send TTS for chat <id> produced no voice: <理由>`：`/send` 中継の音声 request が音声を合成できませんでした。理由の読み方は上と同じです。スーパー管理者の個人チャットにも失敗の一言が届き、中継セッションは開いたままです。
- `Cron task "<name>" action #<n> (<type>) failed in chat <id> after <k> attempt(s)`：複数の会話に送るタスク（`["all"]`、`["except", ...]`、または複数を個別に列挙）がある会話で最終的に失敗し、その会話の残りの動作だけを飛ばしました。他のグループには通常どおり送ります。原因の読み方は上と同じです。`Cron task "<name>" skipped <n> chat(s) without send permission.` は通常ログで、Bot に送信権限がないか照会に失敗したためにその回で飛ばしたグループがあったことを示します。
- `Failed to probe chat membership` / `Failed to ban chat member` が `PARTICIPANT_ID_INVALID` で終わる場合、通常はブロックリストに退会済みアカウントがあります。sweep は通常の backoff で retry を続けます。1 chat での 1 回の sweep 処分ですべての要求がこのエラーを返すと 1 回と数え、いずれかの chat でそのユーザーを確認または BAN できれば 0 に戻ります。5 回に達するとブロックリストと待機中の処分から自動で外し、`Removed blocklisted user <id> after 5 consecutive PARTICIPANT_ID_INVALID sweep results` を記録します。`/wed` の日次再確認は同じエラーでその ID を候補集合から外し、error log は残しません。

---

<div align="center">

[← 前のページ：06 変更レシピ](06-modification-guide.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#07-運用とトラブルシューティング) · [次のページ：08 コマンドと挙動 →](08-commands.md)

</div>
