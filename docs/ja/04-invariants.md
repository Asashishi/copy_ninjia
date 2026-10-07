# 04 実行時の正式な不変条件

<p align="center">
  <a href="../cn/04-invariants.md">简体中文</a> · <a href="../en/04-invariants.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="03-directory-map.md">← 前のページ：03 ディレクトリマップ</a> · <a href="05-dev-workflow.md">次のページ：05 開発フロー →</a>
</p>

---

このページは、モジュールやライフサイクルをまたぐ**正式な制約**を記録します。ソースコメントでは局所的な不変条件を説明し、`@see ../../docs/cn/04-invariants.md`（ソースの深さに応じて `../` を調整）のようにここを参照してください。起動や永続化の説明全体を複数のモジュールへ重複させてはいけません。以下のいずれかに関わる変更では、コードより先にこのページを更新します。

案内用の説明は [02 アーキテクチャ概要](02-architecture.md)、これらの制約に触れる変更手順は [06 よくある変更手順](06-modification-guide.md) を参照してください。

> [!TIP]
> このページは実装とレビューで参照する制約の完全版であり、先頭から順番に読み通す必要はありません。下のナビゲーションから対象領域へ進んでください。長い項目では、段落冒頭の太字が通常、その段落で守るべき結論を示します。

## クイックナビゲーション

| 範囲 | トピック |
| --- | --- |
| [起動と import の境界](#起動と-import-の境界) | [起動順序とリソース取得](#起動順序とリソース取得) · [任意の資格情報と設定の厳密な事前検証](#任意の資格情報と設定の厳密な事前検証) · [データルートとバックグラウンドタスク](#データルートとバックグラウンドタスク) · [送信リクエストとメッセージの安全性](#送信リクエストとメッセージの安全性) |
| [Worker と状態の所有権](#worker-と状態の所有権) | [スレッドと状態の帰属](#スレッドと状態の帰属) · [状態機械の contract](#状態機械の-contract) · [AI チャットの実行時](#ai-チャットの実行時) · [AI プロンプトと transcript](#ai-プロンプトと-transcript) · [参加認証と終端処置](#参加認証と終端処置) · [連投ミュートと自身の権限キャッシュ](#連投ミュートと自身の権限キャッシュ) · [識別子の解決と実行時のクリーンアップ](#識別子の解決と実行時のクリーンアップ) |
| [永続化](#永続化) | [永続化と snapshot の contract](#永続化と-snapshot-の-contract) · [グループ状態と `chat_states`](#グループ状態と-chat_states) · [chat Q&A と `chat_qa`](#chat-qa-と-chat_qa) · [ブロックリストと広告検出](#ブロックリストと広告検出) · [運勢と AI メモリの復元](#運勢と-ai-メモリの復元) · [確認境界と停止](#確認境界と停止) · [ファイル権限と schema](#ファイル権限と-schema) · [ロックダウンミラーと終端フラグ](#ロックダウンミラーと終端フラグ) |
| [互換エントリ](#互換エントリ) | トップレベル barrel と運勢 receipt の形式 |

## 起動と import の境界

### 起動順序とリソース取得

- **既定タイムゾーンはプロセス起動時のスナップショット**：`config/static/bot.json` の任意項目 `time_zone` は IANA 名を受け付け、省略時は `DEFAULT_BOT_TIME_ZONE` です。前後の空白を除去し、外部接続前に Intl・Temporal・Bun cron の対応を検証した上で、Temporal で正規化された名前（大文字小文字を統一。`Japan` などの別名は統一しない）を保持します。空文字、不正な型、未知のタイムゾーンは起動を拒否します。メインスレッドが権威スナップショットを保持し、AI・Anti-Raid・Disk I/O Worker は `init`・`agentConfig`・`load` メッセージ経由でこれを受理し、クラッシュ再構築時にも同一の値を再生します。各 isolate の `cache/perThread/time.ts` はタイムゾーン、formatter、UTC オフセット区間をそれぞれ 1 つ保持します。オフセットは隣接する 2 つの夏時間等の規則遷移の間で一定であるため、通算日数、日付文字列、ローカル時刻文字列、時は区間内では比較と整数演算のみで求め、区間外となった場合のみ Temporal がその時点のオフセットと前後の遷移点から区間を再構築します。日付・時刻文字列は `FORMAT_MIN_TIMESTAMP_MS` から `FORMAT_MAX_TIMESTAMP_MS` までの整数タイムスタンプのみを受け付けます。未初期化時の暦操作は拒否されます。ホットリロードやメッセージごとのスレッド間同期は行いません。運勢、ログ、広告の発言累計、入室ログ、AI の時刻、日次保守で共用され、cron の省略時にも継承されます。明示的に指定されたタスクのタイムゾーンは独立して機能します。各暦日の最初の実在時刻はネイティブ Temporal が算出し、1 日を 24 時間固定とは仮定しません。東京天気ツールは起動時のタイムゾーンが `TOKYO_TIME_ZONE` と一致する場合のみ登録されます。それ以外のタイムゾーンでは登録されず、呼び出し時には未知のツールとしてエラーを返します。
- **データルートはタイムゾーンに固定**：`initializeStorageDatabase` は設定されたタイムゾーンを `storage_metadata` の `time-zone` マーカー（`{"timeZone":"<正規 IANA 名>"}`）として書き込みます。Disk I/O の起動時はスキーマバージョン検査の直後、日付に基づく検証より前にこれを設定タイムゾーンと照合し、インストーラーもサービス登録前に同様の照合を行います。一致しない場合は起動を拒否し、`storage_metadata.time-zone` の期待値を示します。runtime はマーカーの自動補完や書き換えを行いません。既存データルートにおけるタイムゾーンの変更はサポートされません。

- **副作用のない Import**：本番モジュールの import 時に Worker の起動、タイマーの登録、ネットワークリクエストの発行、または共有ディレクトリへのデータ書き込みを行うことは固く禁止されます。
- **データルート事前検査と排他ロック**：
  - メインプロセスは実行時データルートを再帰的に作成し、書き込み、ファイル fsync、hard link、アトミック rename、およびディレクトリ fsync を事前検証してから `bot.lock` の競合取得を試みます。
  - **パスとパーミッションの制約**：データルートおよび機密性の高いトップレベルディレクトリ `memory/`、`logs/`、`database/` は物理ディレクトリでなければならず、`lstat` がシンボリックリンクに一致した場合は直ちに fail-closed で終了します。`COPY_NINJIA_DATA_ROOT` を明示設定した場合、データルート、`memory/`、`logs/` のパーミッション mode は `RUNTIME_DATA_ROOT_MAX_MODE` 以下（group/other の書き込みビットを禁止）でなければなりません。`database/` は SQLite サイドカーファイル用に `IDENTITY_DATABASE_DIRECTORY_MODE` に従って協調グループの書き込みを許容しますが、実行 UID 以外の所有である場合はプロセスの有効グループに属し、グループに `rwx` が付与されている必要があります。既存ディレクトリは検証のみを行い、自動 chmod は行いません。
  - **クリーンアップとコールドスタート復元**：トップレベルの孤立した一時ファイルを削除し、データルートのトップレベルに `state.json` または `state.json.bak` が存在すれば起動を拒否したうえで、ネットワーク接続や Worker 作成より前に `memory/global/state.json` を厳格に復元します。
  - **インスタンスロックの境界**：`bot.lock` の guard と recovery 補助ファイルは hard link で原子的に公開しますが、古いファイルの「停止判定 → 削除」は原子的ではありません。同じデータルートで同時に起動中にできるプロセスは 1 つだけです（`infra/storage/instanceLock.ts` を参照）。
  - **ライフサイクル推進順序**：
  1. 存在するすべてのデプロイ入力を厳格に検証。
  2. Disk I/O Worker を初期化し、永続化状態を完全にロード・復元。
  3. Telegram クライアントを初期化し、ハンドラーの登録、コマンドメニューの登録、および `bot.init()` ハンドシェイクを完了。
  4. AI Worker と Anti-Raid Worker を初期化して hydrate。
  5. 起動 acknowledgement-safe runner を開始し、update の取得と消費を開始。
- **統一ライフサイクル終端**：初期化失敗と正常終了はどちらも `ApplicationLifecycle` に合流し、実際に正常取得できたリソースに対してのみクリーンアップ、解放、または flush を実行します。

### 任意の資格情報と設定の厳密な事前検証

- 設定 parser 自体は I/O を行いません。メインスレッドは Worker 作成と外部接続より前に `validateExistingDeploymentInputs` で存在する全 deployment input を厳密検証します。機能が無効化されていても不正な設定は拒否します。任意ファイルが本当に存在しない場合は起動を妨げず、`packages/config/readiness.ts` と各 availability 境界で対応機能の利用を拒否します。設定 holder の権威 snapshot はメインスレッドが保持します。`assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json` は稼働中に後述の「`config/dynamic/` ホットリロード」に従って内容が差し替えられ、それ以外の deployment input の変更反映には再起動が必要です。

  `config/dynamic/agent.json` は consumer ごとに読み込まれます。広告検出は `agent.ad_detect`、AI 雑談は `text`、`summary`、`media` と任意の tool 機能を使用します。起動時には存在する全能力を検証し、feature readiness は各機能の必要条件を独立して判定します。

  Disk I/O recovery は `stickerPacksForRecovery()` から nullable なスタンプ許可リストを受け取ります。欠落時の `null` は全既存カタログを厳密に読み取りますが、許可リストに基づく削除は行いません。明示的な空配列は空リストとして照合されます。存在する設定が不正または読み取り不能である場合は起動を拒否します。

- ホワイトリスト、ブラックリスト、一時ホワイトリストの活動記録、未完了の削除は `database/storage.sqlite` を authoritative source とし、runtime は policy JSON を直接読み書きしません。Disk I/O Worker は起動時に SQLite integrity、JSONB storage class、migration lineage、schema version とデータルートのタイムゾーンマーカー（`storage_metadata` はちょうど `schema-version` と `time-zone` の 2 行）、全 row の strict codec、ブラックリストと 2 種類のホワイトリストの非交差性、outbox reference を検証し、1 つでも失敗すれば部分的な状態での起動を行いません。production startup は欠落した database を自動作成・自動マイグレーションせず、オフラインのマイグレーションスクリプトのみが構造を変更します。

  **同期的な権限判定はメインスレッドの有界 LRU キャッシュのみを読み取ります。** 恒久ホワイトリスト、ブラックリスト、一時ホワイトリスト活動はそれぞれ最大 `IDENTITY_READ_CACHE_MAX_ENTRIES` 件の positive/negative エントリを保持し、`null` は明示的な negative cache です。Disk I/O startup は恒久ポリシーの件数のみを返し、テーブル全体を複製しません。update preflight は必要な身分をバッチでプリフェッチし、スレッド間のコールドリードは 1 回最大 `IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES` 個の主キーを処理します。コマンドと参加判定はその後、同期キャッシュを読み取り、判定ごとの request/reply 往復を行いません。プリフェッチはキャッシュ済み身分の利用順を更新するため、同一プリフェッチで書き込まれるコールドキーがそれらを追い出すことはありません。コールドリードの失敗時は通常パスでは fail-closed、破壊的な一括処理パスでは処理を中止し、未知の身分を保護対象外として扱ってはなりません。`/batch_kick` はキャッシュの残留に依存せず、各チャンクの処理前にチャンク内の全身分の恒久ポリシー判定を直接コールドリードして局所保持し、「局所判定 ∪ リアルタイムキャッシュ」で判定します。

  単一対象の身分コマンドも対象ポリシーのプリフェッチ成功を確認し、コールドリード失敗時はデフォルト権限での変更続行を行わず拒否します。`/permission query` は自身と明示対象の双方をプリフェッチし、失敗時は `COMMAND_MESSAGE_AUTO_DELETE_MS` で自動削除される照会失敗通知のみを送信し、デフォルト権限ボードは表示しません。一時ホワイトリストの活動集計はブラックリスト LRU が明示的に `null` である身分のみを受け付け、登録済みおよび未取得の身分はカウントしません。

  **一時ホワイトリストは広告検出中の通常発言を可視の送信者身分単位でグループ横断集計します。** 広告設定が利用可能で、現在のグループが広告検出を明示的に有効化している場合のみ、実ユーザーまたはチャンネル身分をカウントします。サービスメッセージ、自動転送、Bot 自身、現在のグループの匿名管理者身分、恒久ホワイトリストメンバーは対象外です。設定タイムゾーンの暦日における発言数が `TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD` を厳密に超えた時点でその日を 1 回のみ qualified day と認定し、最初の qualified day で広告免除のみを含む `TEMPORARY_AD_BYPASS_PERMISSIONS` を即時付与します。`TEMPORARY_AD_BYPASS_REQUIRED_DAYS` 日連続で qualified に達すると、同一の広告免除のみを持つ恒久ホワイトリストエントリへ自動昇格します。集計はローリング 24 時間ではなく、設定タイムゾーンの暦日ごとに再計算されます。終了した日が qualified であれば行を翌日へ持ち越し、一時広告免除と連続日数を維持します。翌日の最初の対象メッセージで `send_count` を 1 に戻して当日の `qualified_at` を消去し、発言数が再び閾値を超えた時点でその日を qualified とします。その日が qualified に達した後、同日の後続発言は行を書き換えません。`send_count` と `counted_at` は qualified に達した発言時点で凍結され、`counted_at` は `qualified_at` と等しくなります。その日が再度 qualified に達しなかった場合、次の設定タイムゾーン 0 時に行全体と発言累計を削除します。さらに古い行も削除し、当日行は保持します。深夜メンテナンスは共有 SQLite の保留中の最終値を先にコミットし、トランザクション失敗で一時ホワイトリスト書き込みが保留のままである場合はクリーンアップを拒否します。クリーンアップ後に到着した旧日付の書き込みも同一の日境界で正規化し、失効した値は元の revision の tombstone として ACK して旧行の再挿入を防止します。メインスレッド LRU の読み取りと Worker リカバリも同一境界を使用し、期限切れキャッシュは広告免除を付与せず、期限切れの未 ACK 値は tombstone としてリプレイされます。適用可能な真の広告判定、ブラックリスト追加、恒久昇格は一時アキュムレータ全体を明示的に削除しますが、付与後に到着した古い判定結果が権限を取り消すことはできません。ウォールクロックが `counted_at` より過去へ巻き戻った場合は現在の発言からカウントタイムラインを再構築し、既に付与済みの一時資格は保持します。巻き戻しが qualified 認定後に発生した場合は、同一設定タイムゾーンの暦日として継続します。いずれの場合もメンバーシップは保持されます。

  **書き込みは容量判定、ライトスルー、exact revision ACK を使用します。** 身分書き込みは未 ACK の主キー数・バイト数・トランスポートの予算を確認してから LRU 最終値を公開し、revision を登録して Disk I/O へ送信します。メインスレッドの各ポリシータブルは置換差分でバイト合計を更新し、exact ACK のみが対応する最終値の予算を解放します。古い ACK が新しい revision に影響することはありません。メインスレッドの各ドメインは未 ACK キー数と推定ペイロードの上限をそれぞれ `STORAGE_PENDING_MAX_ENTRIES`、`STORAGE_PENDING_MAX_BYTES` とし、Worker の SQLite 6 テーブルはそれぞれ同一の上限で予約されます（`cache/workers/diskIO/storageDatabase.ts` の `storagePendingBudgets`）。トランザクション成功時に各ドメインの予算をまとめて解放します。Worker は、恒久ポリシー・ブラックリスト・一時ホワイトリスト・outbox のいずれかのドメインで変更が `IDENTITY_WRITE_BATCH_MAX_ENTRIES` 件に達したとき、チャット状態が `STATE_MANAGED_CHAT_LIMIT` 件に達したとき、QA が `CHAT_QA_WRITE_BATCH_MAX_ENTRIES` 件に達したとき、または最初の変更から `IDENTITY_WRITE_FLUSH_INTERVAL_MS` 経過したときに、同期トランザクションで保留中の値をすべてコミットします。成功時はバッファを空にしてから exact ACK を送信し、失敗時はすべての保留値を保持します。`IDENTITY_WRITE_FLUSH_INTERVAL_MS` に連続失敗回数を乗じた間隔でバックオフ再試行し、連続 `STORAGE_WRITE_MAX_FAILURES` 回失敗した時点で致命的エラーを通知して新規業務を停止します。停止時の明示的 flush は再試行可能です。遅延読み取りが未 ACK の最終値を上書きすることはなく、復元は revision 順に行われます。`/white`、`/permission`、`/block` の重要な成功通知はドメインの耐久的確認を待ち、拒否・タイムアウト・ACK 欠落はコマンド内で報告します。ドメインバリア（`flushDiskIODomain` / `flushDiskIODomainOutcome`）はそのドメイン名を flush 範囲とし、Worker は該当ドメインのみを flush するため、他ドメインのバッチウィンドウには影響しません。SQLite の 6 テーブルと AI コンテキストは 1 つのトランザクションを共有するため、いずれの SQLite ドメイン（`aiMemory` を含む）のバリアでも全テーブルの保留値をコミットします。Anti-Raid の高信頼配送（`postAntiRaidDurably`）は今回変化したミラーのドメインバリアのみを通過させます。認証待ちミラーの変化は `verification`、非公開モード記録の変化は `chatState` を flush し、いずれも変化していなければ flush を発行しません。停止時の排出（`drainAntiRaid`）は引き続き統一 flush を使用します。

  **スーパー管理者の権限は身分そのものに由来し、SQLite 行には記録されません。** `packages/infra/identityPolicy/whitelist.ts` の `getEffectiveWhitelistPermissions` は `SUPER_ADMIN_USER_ID` に対して全フラグが true の `SUPER_ADMIN_WHITELIST_PERMISSIONS` を返します。それ以外は恒久ホワイトリストを先に読み取り、ヒットしなかった場合のみ、設定タイムゾーン暦日の保持境界内にある一時メンバーシップから `TEMPORARY_AD_BYPASS_PERMISSIONS` を取得します。スーパー管理者オーバーライドは読み取り専用であり永続化されません。`/white` と `/permission` は現在のチャット自身を対象に指定できません。`isCanWhiteOther` は `/white enable` のみを委任し、他の身分をデフォルト権限で追加できますが、メンバー削除と権限の変更はスーパー管理者のみが実行可能です。

  `/permission query` と `/permission help` は読み取り専用です。`query` は自身、返信先、明示対象を照会し、デフォルト補完済みのビューを返すのみで行を作成しません。どちらも描画された権限ボードを長期保持し、遅延削除は設定されません。対象解決の失敗、変更の拒否、使い方案内は共通の自動削除（`COMMAND_MESSAGE_AUTO_DELETE_MS`）に従います。
- **プロセス全体の Telegram identity は `config/static/bot.json` のみから厳密に読み取ります**。`bot_token` と `super_admin_user_id` はネットワーク接続前に必須検証され、欠落、未知のフィールド、不正な値は起動を拒否します。AI キーはすべて `config/dynamic/agent.json` の能力設定内にプロバイダ、エンドポイント、モデルとともに配置されます。資格情報のデフォルト値、能力間のフォールバック、実行時の上書きは存在しません。`base_url` は `https` のみを受け付け、平文 `http` は `localhost`/`127.0.0.1`/`::1` に限定され、userinfo や `#` フラグメントは許可されません。google プロバイダの能力は `headers`（1〜`AGENT_HEADERS_MAX_ENTRIES` 個のリクエストヘッダー。名前は HTTP トークン形式で大文字小文字を区別せず重複不可、`x-goog-api-key` は不可。値はトリム後に空でない印字可能 ASCII）を宣言でき、そのまま `GoogleGenAI` の `httpOptions.headers` に渡され、generateContent と Interactions の双方のリクエスト経路に付与されます。openai・anthropic プロバイダにこのフィールドが存在する場合は起動を拒否します。プロバイダは `google`、`openai`、`anthropic` のみで、`image` と `tts` は前二者のみに実装が存在するため設定解析で anthropic を拒否します。プロバイダの資格情報は api_key のみを通し、サードパーティゲートウェイの認証は headers を通します。

  **AI 設定をディスクから読み取るのはメインスレッドのみです。** `agent.json` は起動ゲートでメインスレッドが解析し、稼働中の編集は `config/dynamic/` ホットリロードによって厳密に再解析されます。AI 雑談 Worker は `init`/`configReload`、Anti-Raid Worker は `agentConfig` を通じて、メインスレッドから現在有効な読み取り専用スナップショットを受け取ります。双方の Worker はスレッドごとの holder を読み取るのみで、Worker 側のコードパスからディスクに直接アクセスすることはなく、再生成時もメインスレッドの現在のスナップショットをリプレイします。`ad_detect` 未設定時のスナップショットは明示的な `null` であり、判定側は旧インスタンスの値を流用せず fail-closed します。

  AI 雑談には `text`、`summary`、`media` が必須です。`image`/`tts` の欠落は該当ツールのみ、`ad_detect` の欠落は広告検出のみを停止させます。`tts` にはメインスレッド側の消費者がさらに 2 つ存在します。`/send` 中継の TTS リクエストは `tts` が未設定であればそのままエラーとなります。`cron.json` が `send_voice` を使用する場合は `tts`（および対話中核能力）が、`send_web_digest` を使用する場合は対話中核能力が必須であり、起動ゲートは `agent.json`、`cron.json` の順に検証し、不足があれば起動を拒否します（`packages/config/cron.ts` の `assertCronAgentSupported`）。起動時検証は存在するデプロイ入力を厳密にチェックします。任意入力が存在しない場合は readiness が該当機能を利用不可と判定し、永続化されたグループ設定値は保持されます。

  **任意の能力はプロバイダ名ではなくメンバー関数の有無で判定します。** Gemini と OpenAI は音声文字起こし入口を持ちますが、Anthropic は持ちません（Messages API に音声入力がなく、media に選択した場合は音声がプレースホルダーに降格され、起動時に診断ログが 1 行記録されます）。設定された media モデルの画像/音声対応は最初のリクエスト時に個別に probe されます。モダリティごとに進行中の probe は 1 つであり、再試行はプロバイダ SDK の予算に従い、待機者は media runner の実行枠を占有せず共有待機枠を使用します。結論は次の通りです：`supported`、`unsupported`（エンドポイントが明示的に該当モダリティを拒否）、`misconfigured`（404/405。モデルまたは base_url の誤りで、確定時に `$.agent.media` を指す診断ログを 1 行記録）、それ以外は `unknown`。`unsupported` と `misconfigured` は該当モダリティの新規ダウンロードとリクエストを拒否します。同一設定世代で既に実行中のリクエストが成功した場合は `supported` に復帰しバックオフを解除できます。ホットリロードによって `media` 能力が差し替えられると、双方向モダリティは新世代へ移行して `unknown` にリセットされ、前世代のリクエストが遅れて返した結果はすべて破棄されます。エンドポイント障害（タイムアウト・408/429/5xx・ネットワークエラー）は連続回数に応じた有限の指数バックオフのみを適用し（`MEDIA_PROBE_BACKOFF_BASE_MS` 起点、上限 `MEDIA_PROBE_BACKOFF_MAX_MS`）、そのウィンドウ中はダウンロードも実行スロットも消費せず共有結果を返し、1 回成功すればカウンタはクリアされます。通常の 4xx パラメータエラー、ファイル形式やエンコーディングの不正、破損メディア、ダウンロード失敗、空レスポンスはその 1 件のメディア自体の問題にすぎず、モダリティの判定もバックオフも動かしません。両プロバイダとも音声合成も実装しています（OpenAI 実装パッケージは `speech_protocol` により audio/speech か xAI `/tts` に振り分けられます）。ボイスツールは引き続き `provider.synthesizeSpeech === undefined` の場合にツールごと除外され、「設定は存在するが選択された実装がその能力を持たない」場合は Worker 初期化時および agent 設定ホットリロードのたびに診断ログが 1 回記録されます。

  コールド probe のダウンロード・パラメータ・空応答の失敗はそのメディアの呼び出し元にのみ返され、待機者は各自のメディアを直列に probe します。対応済みモダリティの並行要求は受付時の capability state object を保持します。同一状態で受け付けられた要求がエンドポイント障害のバックオフを進めるのは 1 度のみであり、遅延した一時的障害が成功を上書きしたり失敗回数を重複加算したりすることはありません。メインスレッドはメディアイベントの `replyTelegramBackpressured` を 1 回だけ設定します。`undefined` はコメントなし、boolean はコメント対象とその時点の Telegram バックプレッシャーを示します。Worker は追加のスレッド間照会を行うことなくランダム割り込みと返信並行数を判定します。

  メディアのエラー分類は `packages/aiChat/ai/utils/mediaSupportError.ts` に集約されます。HTTP 400/415/422 を `unsupported` と判定するのは、レスポンス本文がメディア入力の非対応を明示し、モデル・エンドポイント・入力モダリティの能力に関する記述を含み、個別ファイルの形式・エンコーディング・サイズ・破損等のエラーを示していない場合のみです。単なる `Unsupported media type` のみではモダリティを閉じません。404/405 は設定エラーとして優先処理され、408/429/5xx および HTTP ステータスのないネットワーク障害はエンドポイント障害として分類されます。

  **OpenAI 互換画像の wire protocol は `config/dynamic/agent.json` の `agent.image.image_protocol` から取得し、エンドポイントやモデル名から推測してはならず、デフォルト値で補うことも禁止されます。** 現在許可されるのは `openai`、`openai-standard`、`xai` であり、能力設定が不正であっても 400 エラーの後に別プロファイルで自動再試行してはなりません。新しい protocol を追加する際は union、解像度対応表、exhaustive dispatch、テストを同期更新します。

  **翻訳セッションの有効判定は `packages/translate/message.ts` の `activeTranslateStateIn` に集約されます**。セッションが存在し、対象グループの `isTranslationEnabled` が true で、`g-auth.json` が利用可能である場合のみ動作します。開始・有効化コマンドも同一の設定判定によって拒否されます。資格情報の欠落時はセッションを実行せず、実際の API 呼び出し失敗時は `translateText` が null を返し、呼び出し側は何も送信しません。

  **AI 雑談が「稼働中であるか」の判定は `packages/aiChat/availability.ts` の単一箇所**（資格情報の有無とグループごとの opt-in の論理積）で行われ、新規呼び出し箇所は必ずここを経由します。この論理積を各呼び出し箇所に直接記述してはなりません。

  **資格情報が欠落している場合、`hydrateAiMemory` / `hydrateStickerCatalog` は復元された内容をメインスレッドのミラーに格納するのみで、メッセージ送信も削除も行いません**。`memory/` 配下のスナップショットはキーが配置されるまでそのまま保持されます。
- **設定ディレクトリ構成は、いかなる deployment ファイルを読み込むよりも前に検証されます。** `packages/config/bot.ts` は `config/static/bot.json` を読み込む前に `packages/config/layout.ts` の `assertDeploymentConfigLayout` を呼び出します。config ルート直下の `telegram.json`、または deployment ファイルが `config/` 直下や誤ったサブディレクトリに存在する場合（リンク切れシンボリックリンクや同名ディレクトリを含み、内容は読み込まない）は起動を拒否し、`config/dynamic/` は既存ディレクトリでなければなりません。`config/static/`（`bot.json`、`g-auth.json`）は起動時にのみ読み込まれ、ホットリロードは `config/dynamic/` のみを監視します。deployment ファイルを追加する際は所属サブディレクトリを決定し、`layout.ts` の配置表に登録します。インストーラーもテンプレートを配置する前に同一の `assertNoMisplacedConfigFiles` で配置の誤りを検査します。
- **起動時の総ゲートが検証するのは「既に存在する」デプロイ入力のみであり、欠落の許容可否は feature readiness に委ねられます。** 起動時の総ゲートは `packages/config/readiness.ts` の `validateExistingDeploymentInputs` を呼び出します。`bot.json` はプロセスレベルで必須であり、その他の任意入力（`stickers.json`、`mood.json`、`ad_samples.json`、`agent.json`、`assets.json`、`cron.json`、`g-auth.json`、`prompt/persona.md`、`prompt/voice_tool.md`）は**ファイルが存在する限り厳格なパースを通過しなければなりません**。対応する機能が現在オフであっても不正な内容を見逃すことはありません。ファイルが真に存在しない場合は起動を妨げません。`prompt/persona.md` と `prompt/voice_tool.md` は同一ゲートがプロセス単位の通知口調とともに取り込みます（`ensurePromptFiles`）。`persona.md` が存在すればその本文をペルソナとし、存在しなければ内蔵ペルソナを使用します。`voice_tool.md` が存在すればその本文を `send_voice` の説明とし、存在しなければ `null`（内蔵説明を使用）とします。通知口調は `bot.json` で明示された `atmosphere` を優先し、省略時はカスタムペルソナなら通常版、内蔵ペルソナならメスガキ版となります。

  Google 資格情報は `packages/config/googleAuth.ts` が厳密に解析し、RS256 用の RSA PEM 秘密鍵を要求します。EC、Ed25519、RSA-PSS は拒否します。main owner の `googleServiceAccountKey` が起動時に完全な読み取り専用スナップショットを公開し、翻訳クライアントは `credentials` で同一内容を使用してファイルを再読み込みしません。`closeTranslate` はクライアントのみを閉じます。起動時に欠落していた資格情報は同一プロセス内では利用不可のままであり、変更の反映には再起動が必要です。各フィールドの制約は [01 Google 資格情報](01-getting-started.md#前提条件) を参照してください。

  **SQLite `chat_states` は起動時の資格情報検証に関与しません**。機能スイッチは永続化復元時にデコードされます。資格情報欠落時は機能ごとの入口が処理します。`packages/aiChat/availability.ts` は AI Worker とメモリ復元を停止して有効化を拒否し、`activeTranslateStateIn` は翻訳セッションを無効と判定してコマンド側も `g-auth.json` の欠落を理由に開始・有効化を拒否し、`adDetectConfigReadiness()` は広告の判定要求を停止します。

  `deploymentInputExists` が「真に未設定」と判定するのは ENOENT のみです。リンク切れのシンボリックリンクやアクセス不能なパスは「設定済みだが不正」として従来通り起動を拒否します。報告されるのは最初に破損が検出された入力 1 つのみです。
- **`config/dynamic/` ホットリロードは適用済み設定をファイル単位で差し替え、ファイルやセクションの追加・削除はそのまま機能の可用性を切り替えます。** メインスレッドの owner は `packages/app/configReload.ts` です。AI 雑談と Anti-Raid の初期化が完了した後に `node:fs` の `watch` で `config/dynamic/` ディレクトリのみを監視し（`config/static/` 内のファイルは変更後に再起動が必要）、監視開始直後に 1 回照合を行います。ディレクトリイベントを受信するたびに `CONFIG_RELOAD_DEBOUNCE_MS` のデバウンスタイマーを再設定し、発火時に最新値ランナーが 1 ラウンドを直列に実行します。ラウンド実行中に到着したイベントは最大 1 回の追加ラウンドに集約されます。watcher とタイマーは双方とも unref されます。ディレクトリ自体が改名・削除・置換された場合（イベントのファイル名がディレクトリ名と一致する場合）は、デバウンス 1 回分の待機後に古い watcher を閉じて同一パスを再監視し、直ちに 1 回照合します。ディレクトリが一時的に存在しない間は `CONFIG_RELOAD_REWATCH_RETRY_DELAYS_MS` に従ってバックオフ再試行し（試行回数上限後は最終値を維持）、エラーログは最初の失敗時のみ記録します。watcher の初回起動失敗時や稼働中のエラー発生時はエラーログを 1 行記録し、そのプロセスでは以降ホットリロードを行わず、適用済み設定のまま稼働を継続します。停止時の maintenance quiesce（`quiesceLifecycleMaintenance`）でイベントの受け付けを停止し、実行中の読み込みが完了しても配布は行いません。

  判定は `packages/config/reload.ts` に集約され、対象は `assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json` であり、起動ゲートと同一の厳密 parser を使用し、ファイルごとに全適用か全拒否かを判定します。読み取り不能または解析に失敗したファイルは丸ごと拒否され、holder は直前に検証済みのスナップショットを維持します。ファイルが真に存在しないことは正当な状態です。`assets.json` を削除すると素材の内蔵デフォルト値に復帰し、他の対象ファイルを削除すると holder は `null` に置き換わり、稼働中に追加されたファイルは新しい内容で満たされ、`agent.json` の `ad_detect` セクションと `text`/`summary`/`media` 中核部は独立して判定されます。現在のスナップショットと深く等しい内容は差し替えられず、holder のオブジェクト同一性も維持されます。拒否が発生するたびに英語のエラーログが 1 行記録され、内容はファイルパス、フィールドパス、期待される形式のみを含みます。`image`/`tts` など任意能力の追加・削除は通常の内容差し替えとして扱われます。ファイル間の制約は `cron.json` のアクションが要求する `agent.json` 能力への依存関係です（`send_voice` は `agent.tts`、`send_web_digest` は会話中核能力を必要とします）。`agent.json` と `cron.json` を個別に判定し、相互依存を照合してから holder を差し替えます。新しいタスク表が要求する依存先が欠けていれば `cron.json` の変更を拒否し、既存の有効なタスク表が使用中の依存先を削除するような `agent.json` の変更も拒否します。2 つのファイルはそれぞれ引き続き全適用か全拒否の原則に従います。

  AI Worker は新しい `agent.json` スナップショットを受け取ると旧い能力ファサードと SDK クライアントを破棄し、次の利用時に新しいスナップショットから作り直します。AI 返信は 1 回ごとにセッション作成時点の text 能力のモデルとクライアントを固定し、その返信のツール往復（Anthropic の `pause_turn` 続行を含む）すべてで使い続けるため、ホットリロードが影響するのはその後に始まる返信だけです。最初のリクエスト前に設定が差し替わった Gemini セッションは共有の明示キャッシュを参照しません。

  各ラウンドで holder を適用した後、`packages/app/configReload.ts` は holder から AI 雑談と広告検出の readiness を再計算し（`packages/config/readiness.ts` の `aiChatReadinessFromHolders` / `adDetectReadinessFromHolders`、判定基準は起動時の probe と同一）、可用性または失敗ファイルに変更があった時点で `cache/main/configReadiness.ts` の結論オブジェクトを丸ごと差し替えます。メッセージごとのゲートは引き続き holder を 1 回読み取るのみであり、メモリ割り当てを行いません。ディスク読み込み後の判定・公開・配布はすべて同期処理で完結します。利用不可への遷移時はまず結論を公開し、入力パイプラインと対応する enable コマンドを即座に閉じます。永続化されたグループスイッチは元の値を維持し、AI Worker は停止せず待機状態となり、記憶の永続化も継続されます。AI 雑談が利用可能へ復帰する際は、先に `packages/aiChat/hydration.ts` の `resumeAiChat` で Worker を復旧し（稼働中なら完全な `configReload` を送信し、未起動であれば起動時と同一順序で `init`、音声合成回数、記憶とスタンプ目録のミラーを送信）、成功を確認してから可用性を公開します。失敗した場合は利用不可のままエラーログを残し、次回の `config/` イベントで再試行します。広告検出の可用性が変化した場合は `agentConfig` を再送し、利用不可の間はサンプル一覧を `null` とします。起動時に AI の前提条件が欠落している場合、復元された記憶とスタンプ目録はメインスレッドのミラーに格納されるのみで、送信も削除も行いません。`/clear_context`、`/ai_chat disable`、グループ teardown は引き続き `requestAiMemoryDelete` でミラーから除去され、復旧時にグループスイッチに従って送信または削除されます。`g-auth.json`、`prompt/persona.md`、`prompt/voice_tool.md` はホットリロードの対象外であり、翻訳の結論は起動時にのみ判定されます。

  設定の配布は既存の Worker プロトコルのみを使用します。AI 雑談 Worker には `configReload`（変更のあった領域のみを含む）を送信し、メインスレッドは post の前に `lastInitState` を現在のスナップショットへ書き換えます。Anti-Raid Worker には `agentConfig` を送信します。post が拒否された分は Worker 再生成時のリプレイによって補填され、Worker が起動していない、または再起動を断念した場合はメインスレッドの holder のみを更新します。Worker 側はまず holder を丸ごと差し替え、その後に旧スナップショットから派生した状態を無効化します。実行中のリクエストは旧 facade と旧クライアントを保持したまま完了します。AI 雑談は能力 facade と 3 社の SDK クライアントを破棄し、プロトコル・エンドポイント・資格情報が新スナップショットから引き続き参照される quota lane は維持して他を除去し、`media` 能力が変更された際は入力モダリティの probe を再初期化し、「設定はあるが未実装」の診断ログを再出力します。グローバルで共有される単一の気分（mood）は新スナップショットの同名フェーズへ差し替えられ、該当フェーズが削除されている場合は次回読み取り時に再抽選されます。スタンプ許可リスト差し替え後は新たに追加されたパックのカタログ照合を開始し（シャットダウン時の drain 中は開始しません）、許可リストから除外されたパックはスタンプツールから非表示となり、そのカタログは Disk I/O 復旧時の許可リスト照合を待ちます。Anti-Raid は広告検出用の 3 社の SDK クライアントを破棄し、例文リストが差し替えられた際は system prompt キャッシュをクリアします。

  各スレッドは `cache/perThread/logger.ts` の `current` holder に完全な読み取り専用の資格情報スナップショットを保持します。初回利用時、またはいずれかの設定オブジェクトの参照が変化した際、生テキスト一覧、JSON エスケープ済み断片、走査コールバックを一括構築し、スナップショット全体を差し替えます。各ログ出力は同一スナップショットを捕捉し、シリアライズの再入が外側のスナップショットを変更することはありません。現在の資格情報（Telegram token、各能力の api_key、google プロバイダの各 `headers` 値）は旧資格情報より前に配置され、合計最大 `LOGGER_MAX_REDACTED_SECRETS` 件とし、上限超過時は最も古い資格情報から破棄されます。Worker 再構築後は該当スレッドの設定から補充されます。

### データルートとバックグラウンドタスク

- ソース実行時のプロジェクトルートはモジュールの物理位置、バイナリ実行時はデプロイ作業ディレクトリから決定されます。設定、素材、デフォルトのデータルートはそこから導出されます。各 Worker のエントリポイントは `packages/consts/paths.ts` に集約され、バイナリは埋め込み Worker を使用します。スレッド所有権、メッセージプロトコル、シャットダウン順序には同一の制約が適用されます。
- `bot.lock`、`logs/`、`memory/`（グローバル状態 `memory/global/state.json` を含む）、`database/` はすべて 1 つの実行時データルートから導出されます。本番環境のデフォルト値はプロジェクトルートです。テスト用 preload は本番モジュールを import する前に isolate ごとの一時データルートを注入し、物理ファイル I/O が本番キャッシュや身分データベースへアクセスするのを完全に遮断します。
- 低優先度のグループタイトル保守タスクは、コマンドメニュー、`bot.init()`、Worker hydrate、acknowledgement-safe runner の準備完了後にのみ開始されます。title owner は `runBoundedSettledBatch` でグループごとに `getChat` を呼び出し、並行上限は `STATE_MANAGED_CHAT_LIMIT` です（グループ状態は管理対象グループのみを対象とするため、管理グループごとに 1 回ずつ照会します）。各グループは独立して結果を確定し、ライフサイクルの quiesce/abort シグナルを受理します。

### 送信リクエストとメッセージの安全性

- grammY のキャンセルシグナルは最後の省略可能な位置引数として渡します。`libs/telegramSignal.ts` はインストール済み SDK の Node 型定義のみを適合させ、Bun のネイティブシグナルを同一参照のまま渡します。引数配列のコピーやシグナル変換オブジェクトは作成しません。ネイティブ `AbortSignal` を受け取るプロジェクト内 API にはシグナルを直接渡します。

- **メインスレッドと Worker は同一の送信処理パイプラインを使用します**：`bot.api`、`bot.api.raw`、`ctx.api`、`ctx.api.raw`、`ctx.reply` は `initTelegramClients` が登録した共通の transformer を通過します。`cron/delivery.ts` の全送信アクションは他の送信と同様に対象チャットの送信スケジューラ lane に入り、`cron/targets.ts` のメンバー・グループ権限照会は `query` カテゴリを使用します。`getUpdates` は受信ロングポーリングであり送信ゲートを通過せず、`app/updateFetcher.ts` がバックオフとキャンセルを管理します。
- **アバターおよびファイルのダウンロードは `download` カテゴリを共有します**：Telegram ファイル CDN、公開アバターページと画像、デフォルトアバターの URL ソースはすべて `runTelegramCategorizedRequest` で待機・再送されます。待機、429 再送、レスポンスボディの読み取りは各ダウンロードのタイムアウト予算を共有します。デフォルトアバターはデプロイ設定の URL を使用してリダイレクトを追跡し、対象アバターをコピーする CDN・公開プロフィール経路はリダイレクトを禁止します。双方のアバター取得経路は有界読み取りとアップロード前の JPEG/PNG シグネチャ検証を維持し、デフォルトアバターのローカルファイルソースはダウンロードリクエストを発行しません。キャンセルは待機ジョブを除去して実際の fetch に届き、破棄される 429 レスポンスボディは送信ゲートが解放します。

- **Telegram ネットワーク能力はメインスレッドに 1 つのみ存在します。** 実際の grammY Bot、Bot API HTTP、Telegram ファイル CDN ダウンロードはすべてメインスレッドから開始されます。AI/Anti-Raid Worker は `supervisedDuplexWorker` の構造化ホワイトリスト能力のみを要求でき、grammY ランタイム、`mainClient.ts`、Bot トークンを直接 import することはできません。Worker 世代の失効は現世代のリクエストを abort して待機者を精算し、レスポンスの同期送信失敗も該当世代を取り消します。`check:conventions` は各 Worker のランタイム import クロージャでこの完全隔離を検証し、type-only import はランタイム依存グラフに数えません。

  Worker プロキシは読み取り専用の `TelegramWorkerApi` サブセットを実装します。`copyMessage`、`deleteEphemeralMessage`、`editMessageText`、`unbanChatSenderChat` はメインスレッドの完全な `TelegramApi` のみが提供し、Worker プロトコルおよび dispatch には含めません。共有 facade は Worker 内でこれらを拒否します。利用可能なメソッドは `requestMainThread`、メインスレッドの owner ホワイトリスト、共通アウトバウンドゲートを通過し、アップロードと CDN ダウンロードも同一の境界に従います。

- **Worker が duplex プロキシ経由で送信したメッセージは、メインスレッドがプロキシ境界で self-sent として登録します**（`infra/telegram/workerRequests.ts` の `markWorkerSentMessage`）。`infra/selfSentTracker.ts` はスレッドごとに分離されているため、Worker 側の `markSelfSent` は該当 isolate にのみ記録されます。実際の Bot API 呼び出しはメインスレッドの `bot.api.raw.*` で発生し、共有アクション層の登録を経由しないため、プロキシ境界で登録します。登録はレスポンスを Worker へ返却する前に行われ、判定はメソッド名の switch ではなく**戻り値のオブジェクト形状**（`message_id` が存在し、数値の `chat.id` が存在する）によって行われるため、メッセージを生成する能力が将来追加されても自動的に網羅されます。レスポンスの `chat.id` を読み取り、リクエストペイロードの `chat_id` は読み取りません。この境界が Worker 起因の自発メッセージすべてにとって唯一の登録ポイントとなります。

  **この登録はエコーバックの競合ウィンドウを極小化するのみであり、原理的に完全消去するものではありません**：メッセージ出力を生成し、かつチャンネル投稿やチャンネルからの自動転送を受信し得る入口はすべて、同期の `isBotOwnMessage` に加えて `needsBotOwnMessageWait` + `waitForBotOwnMessage` の有界ランデブーを通過させなければなりません（`auto/message/index.ts`、`commands/cjkAction.ts`、`commands/qa/ingress.ts`）。ランデブーが待機するのは、対象チャットに進行中の自発送信が存在する場合のみです：自発メッセージを登録する送信リクエスト（共有アクション層で `runTelegramAction` に `selfSentChatId` を渡す送信、およびプロキシ境界 `executeTelegramWorkerRequest` のメッセージ生成リクエスト）は、送出前にチャットごとに `beginSelfSentSend`、完了後に `endSelfSentSend` を必ず対で呼び出します。該当チャットに進行中の送信が存在しなければ、`waitForBotOwnMessage` は即座に false として通過させます。該当チャットの最後の進行中送信が完了した時点で、未確定の待機者もまとめて false として解決されます。`SELF_SENT_RENDEZVOUS_TIMEOUT_MS` は上限値にすぎません。update runner は厳密に直列化されているため、待機中は後続の update を進めません。
- **チャットごとの送信スケジューラに入るのは実際にチャットメッセージを生成するメソッドのみです**（`infra/telegram/outboundRetryPolicy.ts` の `isTelegramMessageRequest`）。`sendMessage`、メディア/ファイル/メディアグループ/スタンプ送信、copy、forward は送信ゲートから `infra/telegram/sendScheduler.ts`（実行状態は `cache/main/telegramSend.ts`）へ渡されます。inline answer、chat action、query、kick、restriction、delete、reaction、callback、edit、management は対象外です。スケジューラは Telegram FAQ の公開レート上限に従って能動的に送信速度を制御し、次の条件をすべて満たした場合にのみ送信します。チャットごとのトークンバケットは `TELEGRAM_SEND_CHAT_REFILL_MS` ごとに 1 つ補充され、容量は `TELEGRAM_SEND_CHAT_BURST` です。グループ系チャット（負数 ID および `@username`）は任意の `TELEGRAM_SEND_GROUP_WINDOW_MS` 内で最大 `TELEGRAM_SEND_GROUP_LIMIT` 件まで、全チャット合計は任意の `TELEGRAM_SEND_GLOBAL_WINDOW_MS` 内で最大 `TELEGRAM_SEND_GLOBAL_LIMIT` 件までです。アルバムは枚数、一括 copy/forward は件数単位で枠を消費し、1 回の件数がバケット容量を超える場合はバケットが満杯になった時点で通過させ、残りの不足分は次回へ繰り越します。チャットキーは `payload.chat_id` から取得し、数値はそのまま、`@username` は小文字化、数値文字列は数値へ変換します。チャットごとに FIFO キューは 1 本、実行中は最大 1 件とし、同一チャット内の送信順序を厳格に保持します。グローバル枠のみが不足しているレーンはグローバルのラウンドロビンキューに入り、順番に通過します。枠は実際に送信する瞬間にのみ消費され、キュー待機中のキャンセルは O(1) で離脱して枠を消費しません。アイドル状態のレーンは、グループ系の送信ウィンドウ・保守期間・フリーズ期間がすべて経過した後に安全に破棄されます。キュー上限（実行中を除く）はグループごと `TELEGRAM_MESSAGE_GROUP_PENDING_MAX`、個人チャットごと `TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX`、全チャット合計 `TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX` であり、超過した新規リクエストは `TelegramSendQueueFullError` で即座に拒否されます。これらのキュー上限は `TELEGRAM_429_RETRY_QUEUE_MAX` にはカウントされず、共有もされません。Inline Mode には公開送信制限が存在しないため、`inline` のアダプティブ 429 カテゴリのみを使用します。
- **Telegram アウトバウンドはすべて 429 を捕捉しますが、送信系は所属チャットのみを、その他は同一カテゴリのみを一時停止させます。** 送信系が 429 を受信すると、該当チャットの FIFO は `retry_after` が満了するまで停止し、その後 `TELEGRAM_SEND_CHAT_CAUTIOUS_MS` の間はバースト容量が 1 に引き下げられます。その間に再度 429 を受信した場合は期間が延長されますが、他のチャットは通常通り送信を継続します。該当タスクは自チャットのキュー先頭に戻されて 429 待機として再カウントされ、再送時に実行中へ復帰します。`message` カテゴリの `activeCount` は受理済みで未完了の送信（枠待ちを含む）を、`pendingCount` は実際の 429 受信後に再送を待機している送信をカウントし、AI のバックプレッシャーはこの 2 つを読み取ります。`inline`、`download`、`kick`、`query`、`restrict`、`delete`、`chatAction`、`reaction`、`callback`、`edit`、`profile`、`management`、`other` は個別の FIFO と `retry_after` を保持し、1 つのカテゴリが他を停止させることはありません。正常なリクエストは即座に開始されキュー容量にはカウントされません。429 リトライ待機者および既にクールダウン中のカテゴリへ到着したリクエストのみが全体の `TELEGRAM_429_RETRY_QUEUE_MAX` 上限に入り、超過分はドメインオーナー側へ拒否されます。安全措置は認証スナップショットまたはブラックリスト outbox に残され、リトライ用メモリを永続化とみなすことはありません。復帰時は 1 リクエストから probe を行い、成功後にのみ並行数を引き上げます。キャンセル操作は intrusive FIFO ノードを O(1) で安全に切り離します。

- Telegram 429 の再投入は初回受付時の `admissionSeq` を保持し、同一カテゴリ内の FIFO 順序を維持します。再度の 429 によって先行タスクを追い越すことは禁じられます。通常の末尾追加および abort による切り離しは定数時間で行われます。

  送信ゲートは再初期化可能なライフサイクル世代も所有します。受理された各ジョブは呼び出し元のシグナルとオーナーの `AbortController` を合成し、そのシグナルを実際の grammY/fetch 境界へ渡します。drain 処理は最初に受付をアトミックに遮断し、予算超過時は実行中のリクエストを abort、すべての 429 タイマーを解除、pending ノードを reject、drain 待機者を解決します。その後のカウントは 0 でなければならず、遅れて到着したコールバックが再カウントや再スケジュールを行うことはできません。旧世代の active、pending、timer、waiter がすべて完全に空になった場合にのみ次世代を初期化できます。既に受理されたキックリトライは quiesce 後も内部メンバーシップ再検証を実行できますが、このバイパスは通常の呼び出し元へ公開されません。
- 汎用 JSON API リクエストは `JSON_API_ALLOWED_ORIGINS` に明記された HTTPS オリジンのみを許可し、リダイレクトを無効化します。新規の呼び出し元を追加する場合はホワイトリストを明示的に拡張する必要があります。

  Telegram アバターのダウンロードは Telegram 所有のアセットドメインサフィックスの独立ホワイトリストを使用しますが、HTTPS 必須・認証情報禁止・DNS ラベル境界という同一の URL ポリシーを再利用します。Bot API `file.getUrl()` の主経路と `t.me` のページ/画像フォールバックは双方ともリダイレクトを無効化し、読み取り上限を維持します。JSON ホワイトリストへ併合したり、任意の HTTPS 画像を受け付ける形へ緩和することは禁止されます。
- 送信メッセージのリッチテキストは 2 つの表現形式のいずれか一方のみを使用します（Bot API は `entities` と `parse_mode` を排他と定めており、送信境界の `SendMessageFormat` が型システムでこれを保証します）。
  - 呼び出し側がテキストをセクションごとに組み立て、`entities` を明示的に渡す（offset は Telegram の UTF-16 コード単位基準で、JavaScript の `String#length` と一致。長さ 0 の entity を含めることは禁止）。
  - `parse_mode` を設定する。プロジェクト全体で使用するのは `MarkdownV2` のみです。本文に結合される動的文字列——表示名、モデル出力、設定値、固定文言——はすべて `libs/telegramMarkdown.ts` を用いて挿入文脈に応じてエスケープします（本文、`code`/`pre` の内部、リンク URL はそれぞれ異なるエスケープ文字セットを使用し、混用しません）。エスケープされていない文字列をそのまま結合してはなりません。Telegram 側に拒否された場合は通常の送信失敗として統一 Telegram エラーログに記録し、平文での再送へ勝手にフォールバックさせてはなりません。

  双方とも指定しないメッセージは純粋な平文として送信されます。表示名やメッセージ本文は平文としてのみ結合し、書式やリンクとして誤解釈される余地を残してはなりません。
- **オウム返しのコマンドガードは、変換前の原文ではなく実際に送信される文字列を判定しなければなりません。** `applyCopyModeTransform` の `reverse` は文全体を反転するため、変換後の文字列がクリック可能なコマンドになり得ます。ガードは変換後の文字列を判定します。判定に `startsWith("/")` のみを使用してはなりません。Telegram の `bot_command` entity は行頭に限定されず（`/` の直前がテキスト先頭または空白で、直後がコマンド名の先頭文字であれば成立）、該当した場合はオウム返し自体を破棄し、原文の送信へフォールバックさせてはなりません。変換前の原文側のガードもそのまま維持します（メディアメッセージの `caption` を含む）。2 つのガードはそれぞれ異なる文字列を判定しています。
- **オウム返しの出口は 1 つのみです**（`copy/echo.ts` の `sendEchoPayload`）。テキストとキャプションは処理済みの文字列として渡されます。純粋なテキストは `sendMessage`（entity なし、parse_mode なし、元の `link_preview_options` を引き継ぐ）、有料メディアはテキストのみを送信し、それ以外はすべて `copyMessage` を使用し、テキストが存在する場合は `caption` で新しいキャプションに差し替え、`show_caption_above_media` と動画の `start_timestamp` を引き継ぎます。ファイル・サムネイル・スポイラー・カバーは Telegram のサーバー側で複製され、ローカルホストへはダウンロードしません。長さ上限（本文 `TELEGRAM_MESSAGE_MAX_CHARS`、キャプション `TELEGRAM_CAPTION_MAX_CHARS`）は呼び出し側で判定し、超過したものは破棄します。`check:conventions` は `sendEchoPayload` 以外で `copyMessage` によりキャプションを差し替えることを禁止します。翻訳はこの出口を使用せず、`translate/message.ts` が訳文のみを `sendMessage` で送信し、メディアは複製しません。

  **判定ロジックは 1 か所に集約され、Bot 自身が生成したテキストを送信するすべての出口を網羅しなければなりません**（`libs/renderableCommand.ts` の `containsRenderableCommand`）。オウム返しのほか、AI 返信ツールセットの `send_message` 本文、その誤字版、画像生成の caption、および Web 要約の各項目（`libs/webDigest.ts`）はすべてこの判定を通過しなければなりません。誤字版は個別に判定します：ガードが判定するのは実際に送信される誤字文字列であり、置換前の本文ではありません。ガードと保護対象の値は同一の文字列でなければならない——これはすべての経路に例外なく適用されます。AI 側で本文または caption が該当した場合は再試行可能な `toolError` として差し戻し、モデルに先頭スラッシュを除去した言い換えを促します（ラウンド全体を無効化することはありません）。誤字版が該当した場合はその誤字のみを無効化し、本文は通常通り送信します。要約の項目が該当した場合は検証失敗として拒否します。
- **`/mute` の `until_date` 上限値は Bot API の境界値に貼り付けず、余裕を持たせなければなりません**：Bot API は受信時刻を基準に計算し、`until_date` が現在時刻から境界値を超過すると無期限制限として扱われます。`MUTE_MAX_DURATION_MS` はその境界値を下回るように設定されています。本プロセスは復帰タイマーを保持せず永続状態も記録しないため、無期限ミュートは手動の `/unmute` でのみ解除可能です。

  **Bot API が許容する期間の下限値は発行期限によって保護し、端数切り上げには依存しません。** `until_date` はキュー投入前に算出された絶対時刻であり、`restrict` カテゴリの 429 は専用レーンで `retry_after` に従って待機させられます。そのため `muteChatMemberWithOutcome` は `dispatchTimeoutMs` を**必須パラメータ**とし、ラッパー内部で呼び出し元のシグナルと合成して下流へ渡し、期限切れとなった場合は今回のミュート処理を安全に断念します。予算は各自の最短時間に合わせて呼び出し元から供給されます。スパム連投ミュートは `FLOOD_MUTE_DISPATCH_TIMEOUT_MS`、`/mute` は「今回の時間 − `MUTE_DISPATCH_MIN_REMAINING_MS`」となります。断念した場合の影響は該当回のミュートがスキップされるのみです。
- グループ内の非機能的なコマンド通知は `sendCommandMessage` を経由し、送信成功から `COMMAND_MESSAGE_AUTO_DELETE_MS` 経過後に自動削除されます。個人チャットは対象外です。ユーザーが明示的に許可した `/permission help`、`/permission query` の権限ボード、`/qa query` の Q&A ボード、および成功した漢字アクションコマンドの結果のみが `preserveInGroup: true` によって長期保持可能です。アクションコマンドの対象バリデーション失敗や `/x` の使い方案内は引き続き自動削除されます。新たな長期保持例外を追加する場合は呼び出し箇所とテストの双方で明示的に宣言しなければなりません。`check:conventions` はこの関数呼び出しに `messageThreadId` も渡すことを強制します。トピックの着地先は次項の規約に従います。
- **フォーラム（トピック対応）グループでのメッセージ着地先は「何がそのメッセージをトリガーしたか」に基づいて決定されます**。`message_thread_id` を渡さないことは General への送信と同義であり、reply 先の指定はこのパラメータの代替にはなりません（返信先が削除済みの場合、`allow_sending_without_reply` により通常送信へ降格されます）。
  - **ユーザーのコマンドや操作が引き起こしたメッセージはトリガーメッセージのトピックに着地させる**：会話的な出力（Copy、翻訳、AI 返信、入浴トリガー返信、Q&A 直接応答）、前項で挙げた `preserveInGroup` の例外、および固定遅延削除が適用されないステートマシン所有のメッセージ（`/qa set` フォーム、gag の発言案内通知）は呼び出し側が明示的にトピックを渡します。gag 専用入口の表示には Telegram の ephemeral message 規則も適用されます。自動削除されるコマンドレシートおよび使い方案内の引数に `messageThreadId` キーが存在しない場合は、`sendCommandMessage` および画像付きレシートの境界が現在の update のトリガートピックで補完します（`infra/updateContext.ts` の `updateTopicThreadIdFor`。トリガーメッセージと同一グループの場合のみ引き継ぎます）。明示的に `undefined` を渡した場合は General を意味し、スコープからの自動補完は行われません。バックグラウンド処理はトリガー update のスコープ内で動作し続けるため、投入時に記録されたトピックをそのまま反映しなければなりません。
  - **トリガートピックは update スコープとともに伝播する**：`app/updateRunner.ts` が各 update のトリガーメッセージのトピックを記録します（`libs/forumTopic.ts` の `updateTopicOf`：message、channel_post、またはボタンが付与されたメッセージを確認し、トピック内でなければオブジェクトを割り当てません）。遅延コマンドや `/wed` の操作はキューから取り出す際に受付時のトピックを復元します。update スコープ外から送信されるレシートは発行時にトピックを記録します：アバター更新のレシート、AI のレート制限通知、gag 終了のレシート。
  - **Bot が自発的に発信する通知にはトピックを渡さない**：連投ミュート告知、広告警告および BAN 告知、ロックダウン告知、そして `cron.json` の定時タスク（トピックが有効なグループでは General に着地します）。
  - **参加認証のリマインダーも Bot の自発的通知に分類される**：返信形式のリマインダーは未認証メンバーの発言に紐づけられ、トピックは付与されません。ステートマシンが認証完了時にこれを削除します（上限は `VERIFICATION_TIMEOUT_MS`、未配信の極端なケースでも `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS`）。
- **発生していない状態変化を応答メッセージで報告してはなりません。** `/init`、`/ai_chat`、`/ad_detect`、`/flood_control`、`/antiraid`、`/translate` などのトグルコマンドは書き込み前に必ず元の値を読み取り、同一状態で重複実行された場合は「既にその状態です」と明示しなければなりません。状態変更直後のメッセージをそのまま流用してはなりません。各結末の文言は `ToggleCommandTexts`（`packages/types/commands.ts`）の必須フィールドに定義され、選択は `toggleReplyText` が行います。いずれかの結末文言が欠落している新規トグルコマンドはコンパイルを通過しません。`/white` も同様の方針で応答します（`WHITE_COMMAND_TEXTS.alreadyEnabled` / `alreadyDisabled`）。

  判定は「目標状態」と「元の状態」のみを比較します。**永続化や実行時クリーンアップが成功したかどうかは比較対象としません。** クリーンアップはベストエフォートで実行され、失敗してもログを記録するのみです（`clearAdDetection`、`clearFloodControl`、`invalidateAiChat`、および `/init disable` の `teardownChatRuntime`——失敗しても全体の主スイッチは既に耐久的に off となっているため、応答は「一部リソースの解放に失敗しました」と具体的に名指しする文面に切り替え、例外をスローしません）。同一状態での重複実行であっても永続化とクリーンアップは通常通り実行され、応答メッセージのみが状態を変更していない事実を正確に伝えます。`/init` は、既に有効なチャットで `enable` を繰り返しても管理者身分の記録を無効化しません。

  **`/init disable` も永続化処理を teardown より先に実行します**（`runChatToggleCommand` と同一順序）。`teardownChatRuntime` は不可逆な永続化処理を含みます（aiChat owner の記憶削除、translate owner のセッション削除、wed owner のメンバー集合削除、joinLog owner の入室ログ削除、qa owner の問答削除）。主スイッチの永続化失敗はそのまま例外をスローし、再配信時に読み取られる `wasEnabled` は true のままとなります。

  **teardown の後には必ず 2 回目の書き込みを実行します**。`teardownChatRuntime` が同期的に消去する `isProxySendEnabled` と、その直後の `purgeChatStateExceptLockdown` による行全体の削除は、双方ともメモリ上のみを操作するため、`persistChatState` を再度呼び出します。状態がデフォルト値へ復帰した時点でこの書き込みは削除 tombstone となり、`chat_states` 内の該当行も削除されます。未復帰のロックダウン状態のみが保持されます。2 回目の書き込みは teardown と同一のフォールバック経路を共有し、失敗時は「一部リソースの解放に失敗しました」と応答し、offset の保留は行いません。

  **disable 操作は記録が存在しないチャットに新規エントリを作成しません**。到達点は該当行の削除です。`clearChatStateField` / `disableChatStateSwitch` はエントリが存在しないチャットに対しては明示的な no-op であり、その後の書き込みは削除 tombstone を出力し、`assertChatStateCapacity` の検証をスキップします。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## Worker と状態の所有権

### スレッドと状態の帰属

- メインスレッドは Telegram runner、Worker 監視ハンドル、`cache/main/storage.ts` の正式な `memory/global/state.json` メモリミラーを所有します。`infra/storage/stateStore.ts` はミラーの復元、snapshot 構築、domain accessor を担う業務 facade です。`infra/storage/statePersistence.ts` の `StateStore` は厳密 decode、latest-only atomic write、上限付き失敗 retry、終了時 flush だけを担当します。retry 上限の超過は fatal durability failure であり、runner を停止して update の確認を続けてはいけません。
- AI Worker はグループチャットメモリ、返信の受け入れ、メディア説明パイプライン、全グループ共通のムード、スタンプカタログ生成の実行時状態を排他的に所有します。
- Anti-Raid Worker は認証およびロックダウンのステートマシンとタイマーを排他的に所有し、メインスレッドは復元可能なミラーのみを保持します。
- Disk I/O Worker はログ、AI メモリ、スタンプカタログ、運勢、認証待ちデータの永続化を排他的に所有し、1 つの Worker スレッド内で共有ディレクトリへの読み書きを直列化します。`memory/global/` は明示的な例外で、メインスレッドが `stateStore.ts` facade 経由で `statePersistence.ts` の `StateStore` を呼び出して非同期に管理します。業務 Worker は共有ディレクトリへ直接書き込みません。
- 長寿命の Map、Set、キュー、timer には、対応する `packages/cache/` モジュールと業務ライフサイクルモジュールが共同で容量、削除、Worker 再構築の意味を定義しなければなりません。
- **キャッシュの所有スレッドはディレクトリ名で宣言し、実際のモジュールグラフで照合します。** `packages/cache/` の第 1 階層が所有者です。`main/` はメインスレッド専有、`workers/aiChat|antiRaid|diskIO/` は各 Worker スレッド専有、`perThread/` は各スレッドが個別に 1 つずつ持つ、互いに無関係な状態（Telegram capability holder、Worker duplex waiter、デプロイ設定 singleton、自己送信メッセージ登録、update 取消コンテキストの storage）です。各 cache ファイルの 1 行目は `/** owner: <main|perThread|workers/<スレッド>>。` で始まり、所在ディレクトリと一致することを `bun run check:conventions` が同じく検証します。

  スレッド間はメッセージのみでやり取りしメモリは共有せず、**あるスレッド専有の状態を別スレッドが import してはいけません**。`bun run check:conventions` が各スレッドエントリ（`index.ts` と各 `*Worker.ts`）から実行時 import の閉包をたどって照合し（`import type` と `new Worker(new URL(...))` は辺として数えません）、違反時は import 連鎖を全て出力します。

  スレッドをまたぐ import の適用除外は `CACHE_OWNER_EXEMPTIONS` にのみ登録でき、現在は空です。`infra/logger.ts` は `infra/diskIO.ts` に静的に依存しません。メインスレッドの error ログは `cache/perThread/logger.ts` の `logRelaySink`（`initDiskIO` が `relayLogMessage` を設定）を経て書き込みスレッドへ渡され、Worker スレッドの error ログはバッチでメインスレッドへ転送されてから同じ経路に渡されます。
- **Worker から到達できるモジュールが main-thread state を必要とする場合、main thread が値を解決して最終 field だけを送ります。** たとえば AI Worker の super-admin ID は `init` message で注入し、Worker は `config/bot.ts` を import しません。Telegram action は Bot token、client、outbound queue を mirror せず、最小 allowlist payload を main thread へ送ります。自然に remote result が必要な Telegram call だけが duplex 境界を通り、group message の hot path 全体に request/reply を追加してはいけません。
- 業務 Worker と独立 Disk I/O host は同期 `postMessage` 拒否を明示的な失敗に統一します。request の拒否は waiter/timer を即座に削除し、重要業務の拒否は fatal とします。受理済み error log は Worker → main、main → Disk I/O の 2 hop で ACK を待ちます。各 hop は batch を 1 つだけ in-flight にし（上限はそれぞれ `LOGGER_FORWARD_BATCH_MAX_MESSAGES`、`DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` 件）、ACK まで原 batch を保持して世代交代後に再送します。障害境界では重複を許容します。main 側は実際の flush 後だけ ACK し、書込失敗時の log-file reopen backoff を新着 log が迂回してはいけません。

  各 hop は待機中と in-flight の件数・JSON payload byte 数を合わせて制限します。業務 Worker は 1 スレッドあたり `LOGGER_FORWARD_MAX_PENDING_MESSAGES` と `LOGGER_FORWARD_MAX_SERIALIZED_BYTES`、main → Disk I/O は `DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES` と `DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES` を上限とします。超過分の object は保持せず、破棄件数と byte 数の counter だけを残し、空きができたら要約を送ります。Worker の error は同スレッドの stderr にも出力します。受理済み batch は同期拒否や再構築で捨てません。process 終了や isolate 強制終了では未永続化 log が失われ得ます。Disk I/O 初期化前は journal のみに出力します。

  並行 batch で `Promise.all` を直接使ってはいけません。独立した固定 task は `Promise.allSettled` ですべての settlement を待ち、項目ごとに failure を集約します。動的 input は固定 worker 数の `runBoundedSettledBatch` を通し、各項目を 1 回だけ実行し、結果に `item/index` を保持します。Telegram outbound gate など下位 owner が既に retry する場合、呼び出し側は副作用を重ねて実行してはいけません。owner に登録済みの task だけを待つ drain は snapshot を直接 `allSettled` できますが、各 task が既に error の帰属先を持つ必要があり、settlement をエラーの捨て場所にしてはいけません。Disk I/O の runtime recovery は不可分な 1 つの handshake です。

  load 成功後、各 domain は登録順に現世代の scoped transport だけを使って mirror を replay し、非同期処理をすべて await します。その後で復旧窓の上限付き business FIFO を排出し、最後にだけ writable を公開できます。mirror replay の前後には `storageFlushHold` の開始・終了マークを送り、区間内の Worker は満杯 batch と定時 commit の timer だけを設定し、終了マークで閾値に従って 1 回のトランザクションで commit します。明示的な flush はこのマークの影響を受けません。AI context の削除と purge 後の最初の snapshot は区間内では queue に入るだけで、マークを閉じた時点で即座に commit します。listener の `false`、throw、reject、timeout、または scoped post の拒否は現世代を終了させる fatal failure です。

  旧世代 listener の遅延 settlement が新しい世代へ書き込んだり、activate したりしてはいけません。処理または永続化の確認が必要な caller は `false` を失敗として扱い、対応する Telegram update を確認してはいけません。

  復旧 FIFO の排出前後には、別に `recoveryReplay` の開始・終了マーク（`RecoveryReplayRequest`）を 1 対送ります。共有 SQLite への書き込みメッセージがオンラインで拒否された場合、Worker は domain の拒否マークを記録し、呼び出し側が直後に発行する domain barrier が失敗 receipt を受け取るため、update を確認せずに再配信させられます。復旧 FIFO 内のメッセージにはそれを問う後続の barrier がないため、区間内の拒否は追加で `recoveryReplayFailed` を返し、メインスレッドはそれを受けて統一 fatal 停止を行い、Telegram に最後の確認点から再配信させます。

- **main thread から Disk I/O への業務 transport は常に有界です。** 待機中と送信中の payload は `DEFAULT_MAX_PENDING_BUSINESS_MESSAGES` message と `DISK_BUSINESS_MAX_RETAINED_BYTES` の推定予算を共有し、control 用に別途 `DISK_OPERATION_CONTROL_RESERVE` slot を確保します。送信中は最大 `DISK_BUSINESS_BATCH_MAX_MESSAGES` message の 1 batch のみで、Worker の直列 operation queue は最大 `DISK_WORKER_MAX_QUEUED_OPERATIONS` operation です。投入元も有界です。main thread の業務 batch と診断 batch はそれぞれ最大 1 batch が送信中、load と毎日の保守 cron はそれぞれ 1 operation、Worker 自身が予約する各 domain の定時 flush は期限到来後に `workers/diskIO/timedFlush.ts` が 1 operation にまとめます（実行前に同じ投入元が再び期限を迎えても 1 回だけ実行します）。ほかのモジュールは直接投入しません。batch 消費 ACK は transport 容量を解放し、domain 永続化 ACK は durable を表します。`DISK_BUSINESS_ACK_TIMEOUT_MS` 以内に batch ACK が届かない場合または容量拒否は fatal を通知し、最終 flush の経路は保持します。Worker 再生成は業務 FIFO を保持し、read waiter は失敗で完了させます。同世代の mirror replay、FIFO 排出、writable 公開の順に進みます。復元中だけの revision 水位、およびスタンプ snapshot とメンバー操作の object marker は mirror が覆う古い write だけを除外し、後続 update は保持します。

- **Worker の非機能的なグループ内通知はメインスレッドの送信・クリーンアップ境界へ集約します。** AI のレート制限・トピックエラー通知、ロックダウン解除、認証の歓迎メッセージ・終端通知、連投ミュート通知は送信成功後に `COMMAND_MESSAGE_AUTO_DELETE_MS` で自動削除されます。`sendTemporaryMessageFromMain` の `notice` 要求は共通のグループ内通知期限を使用し、任意の `replyToMessageId` で元の返信先を渡します。メインスレッドは送信成功時の `onSent` 内で削除を登録してから Worker にメッセージ ID を返し、応答消失・キャンセル・Worker 再生成後も削除責任を保持します。送信失敗時は削除タスクを作成しません。歓迎メッセージの送信・通信エラーは共通の Telegram action 境界で処理し、後続の認証副作用を順に実行します。削除タイマーは `unref()` され、削除失敗は統一 Telegram エラーログへ送られます。認証ボタンと `/qa set` フォームはステートマシンが削除し、inline おみくじは inline API を使用します。

- **他の Bot から届くメッセージはメインスレッドの入口で制限します。** `app/registerHandlers.ts` は update ID の追跡後、受領確認と業務 dispatch の前に `shouldPassBotMessage`（`infra/botMessageGate.ts`）を呼び出します。`sender_chat` を持たない `message.from.is_bot` のみをカウントします。チャンネル名義、メッセージ以外の update、本 Bot 自身の ID は記録せずに通過させます。他の Bot はチャットをまたいで ID ごとにカウントされ、最初の `BOT_MESSAGE_ACTIVITY_LIMIT` 件を通過させ、以降は通知することなく破棄します。遮断されたものを含む受信メッセージごとに、該当 Bot 専用のタイムアウトを最終発言から `BOT_MESSAGE_ACTIVITY_TTL_MS` 後まで延長します。メインスレッドの Map は最大 `BOT_MESSAGE_ACTIVITY_MAX_ENTRIES` 個の Bot ID を保持し、満杯の間は新しい ID をタイマーを作成せずに拒否します。既存の ID は引き続き件数で判定され、記録を追い出すことはありません。各記録のタイマーは最大 1 個で、`unref()` されます。プロセス再起動でカウントは消去されますが、Worker 再生成では消去されません。

- **1 件の update あたりの dispatch 構造は必須の制約です。** すべてのスラッシュコマンドは共有の `:entities:bot_command` ゲートの後ろの子 Composer に収め、`bot` へ個別に登録してはなりません。ゲートは grammY の `matchFilter(":entities:bot_command")` を使用し、判定は `Context.has.command()` の第 1 段階と同一であるため、一致する集合・相対順序・「マッチしたら終了」の契約は変わらず、`bot_command` entity を持たないメッセージはグループ全体を 1 回でスキップできます。update_id の記録からメッセージの最終処理までの前置チェーン（Anti-Raid、gag と `/qa set` フォーム投稿のメッセージ ingress、コマンドゲート、漢字アクションコマンドのゲート、最終処理を含む）は順に 1 つの配列へまとめ、`bot.use(...preamble)` で一括登録します。順序・認領・next の契約は grammY SDK が管理します。`message` / `channel_post` 上の ingress とメッセージの最終処理は `bot.on` では登録せず、同一の判定を手動で記述します（`allowed_updates` に `edited_*` は含まれないため `ctx.msg` は常に `message ?? channelPost`）。漢字アクションコマンドの `hears` は「原文の先頭文字が `/`」というゲートの後ろの子 Composer に配置され、このゲートは `CJK_ACTION_COMMAND_PATTERN` の厳格な上位集合です。グループメッセージごとに前置される各 ingress と、それらが共有する Bot 自身の管理者判定は、いずれも `boolean | Promise<boolean>` を返します。定常状態では同期的に返して Promise を生成せず、権限の実照会・実際のメッセージ削除・durable な書き込みのときだけ Promise を返し、`app/registerHandlers.ts` の `claimOrContinue` が一括で受け取ります。

  **Promise を返すか否かは semantics の一部です**：durability barrier を待機する経路（参加/退出のサービスメッセージ、認証ボタンのコールバック）は必ず Promise を返す必要があり、同期的に返してしまうと、書き込みが確定する前に Telegram がその update を確認済みにしてしまいます。常に false の同期判定を不用意に `async` にしてはなりません。双方向ともテストで固定検証されています：定常状態は同期返却を、durable な経路は `toBeInstanceOf(Promise)` を検証します。

- **`packages/workers/` 内で独自に保持する各タイマーハンドルは必ず `unref()` します。** 独自のタイマーが単独で isolate のイベントループを維持してはなりません。順序付きシャットダウンは各 isolate の drain/flush が先に完了し、その後にメインスレッドが terminate します。Worker は共有 libs の短命な待機タイマー（`libs/sleep.ts` のシグナル付き分岐、`libs/drainWaiter.ts`）も使用しますが、そちらは `unref` しません。abort または `finally` の `clearTimeout` が寿命を決定するためであり、この規則はスレッドではなくディレクトリ境界で区別されます。`check:conventions` は `packages/workers/` 配下をハンドル単位で検証します。各 `setTimeout`/`setInterval` の代入先を取得し、同一関数本体内で、その呼び出しより後、かつ同一代入先への次の書き込みより前に `<同一代入先>.unref()` が 1 回現れることを要求します。代入先を持たないハンドル（`return setTimeout(...)` のような記法）も拒否されます。メインスレッド側は対象外です。

### 状態機械の contract

- ステートマシンの `State/Event/Effect/Transition/Decision` contract はすべて `packages/types/states/` が所有します。`packages/states/` は I/O のない純粋な状態遷移のみを実装し、interpreter と cache は前者の型へ直接依存します。

  **形態は 2 種類あり、判定対象に永続化すべき離散状態が存在するかで選択します**。`verification` と `lockdown` には離散状態が存在し（PENDING/ACTIVE のような状態を Map に保存し、後続イベントが参照します）、`transition(state, event) → {next, effects}` のステートマシン形態を取ります。

  `replyAdmission` と `adDetectAdmission` には永続化すべき離散状態がなく（判定規則は呼び出し側が算出したスカラー値のみを受け取り、コンテナとタイマーは実行時モジュールに残ります）、純粋関数の集合という形態を取ります。
- **ロックダウンがチャットのデフォルト permission を読み書きする際は、毎回 `use_independent_chat_permissions: true` を渡します。** 封鎖、期限切れの復元、遅延応答後の再適用、メイン側の onGiveUp 緊急復元は `packages/workers/antiRaid/lockdownApi.ts` と `packages/infra/telegram/lockdownPermissions.ts` を使用します。双方の境界は `getChat().permissions` を読み直し、`can_invite_users` のみを変更して、未知フィールドを含む他の既定権限をそのまま Telegram へ返却します。
- **封鎖告知は開始時のラウンドに属します**（`LockdownState.announced` と `announcementMessageId`）。APPLYING のプレースホルダー設置後、告知は権限の準備クエリより先にグループ単位の直列チェーンに入ります。送信前と応答の適用時に `LockdownEntry` のオブジェクト同一性を確認します。終了済みラウンドの未送信タスクは破棄され、送信済みの告知は同一チェーンで自身の ID を削除し、新規ラウンドの告知を引き受けることはありません。`onSent` はキャンセルの伝播前にリモート ID を記録します。現ラウンドの ID は永続化され、復元完了後に該当メッセージを削除します。削除失敗はログに記録され、権限復元の状態を変更することはありません。

- **解除告知は、そのラウンドで封鎖を告知した場合にのみ送信します**（`announced`）。期限切れ、手動解除、結果不明の権限コミット、永続化失敗はいずれも復元状態を使用します。復元成功後、現ラウンドの告知フラグに基づいて解除案内の送信可否を決定します。

  告知の記録は同一の封鎖ラウンドに属し、APPLYING / ACTIVE / RESTORING / RECONCILING を通じて保持されます。RESTORING 中の閾値超過は復元意図を維持し、新規ラウンドを開始しません。`announced` と `announcementMessageId` は `{phase,intentId,originalPermissions,announced,announcementMessageId?,expiresAt}` として永続化されます。ID は送信成功時のみ設定され、未告知であるにもかかわらず ID が存在する記録は拒否されます。APPLYING フェーズでも告知済みになり得ます。送信中状態はメモリ上のみに存在し、再構築時に継続が必要な未告知ラウンドは再告知されますが、RESTORING では行われません。現ラウンドの復元完了時に `reportUnlock` を送信し、メインスレッドが永続化記録を削除します。

- **非公開モード（ロックダウン）は期限満了後に復元を進めます。** `LOCKDOWN_MS` の期限は ACTIVE への遷移時に確定し、追加の入室によって再延長されることはありません。期限満了時は復元意図を永続化し、durable ACK 受信後に復元 API を呼び出します。RESTORING 中の閾値超過イベントは管理者キャッシュの準備のみを行い、ACTIVE へ戻すことはありません。失敗時は `RESTORE_RETRY_MS` 後に再試行します。権限拒否（Bot の退出・管理者解任）により連続して `RESTORE_PERMANENT_FAILURE_LOG_LIMIT` 回を超えて失敗した後は警告ログに引き下げ、リトライ間隔を `RESTORE_RETRY_MS` から指数関数的に延長して `RESTORE_PERMANENT_RETRY_MAX_MS` で頭打ちとし、記録は保持します。Bot がメンバー制限権限を再取得したことが確認された時点で直ちに再試行します。Worker 停止時の drain でキャンセルされた復元リクエストは通常の失敗として返され、連続拒否回数を変更せず、エラーログも出力しません。外部 API が即時成功することは保証されません。成功後に入室ウィンドウを空にします。告知メッセージの削除失敗はログに記録されるのみで次ラウンドを妨げず、後続の入室から再カウントされます。

- **永続化する permission のコピーにはスキーマが宣言したフィールドのみを含めます**（`packages/libs/chatPermissions.ts` の `normalizeChatPermissions`）。準備クエリの入口で `ChatState.lockdown.originalPermissions` を収束させ、strict decoder がそのコピーを検証します。復元時はコピーから元の `can_invite_users` のみを読み取ります。Telegram への書き込みは再照会した完全な permission を使用し、招待権限のみを上書きします。他のフィールドを永続化コピーで置き換えることは禁止されます。

- **永続化失敗時であっても、有効である可能性が残る制限の復元責任を保持します**（`persistFailed`）。APPLYING はコミット未発行の場合のみプレースホルダーを撤回します。発行済みであれば処理中の可能性があるものとして RESTORING に遷移し、元の API 直列チェーンで補償処理を行います。ACTIVE と RECONCILING も復元意図を発行し、新たな永続化応答を待たずに復元を実行します。応答待ちの RESTORING は直ちに復元を開始し、処理中の復元を重複発行しません。メインスレッドはスキーマ検証済みの復元記録を Worker 再構築用に保持し、`unlock` でのみ消去します。不正な Worker 記録はミラーに登録される前に拒否されます。対象の遷移は `LOCKDOWN_RETRIGGER_COOLDOWN_MS` を開始し、遅延・重複した失敗は現在の phase と intent に一致しなければなりません。復元失敗時はステートマシンのリトライタイマーを維持します。

- **Worker イベントの lockdown レコードは、メモリ上の `ChatState` に格納する前に永続化の自己検証を通過させます**（`assertPersistableLockdown`）。`ChatState` はメモリに先行して書き込んでから永続化します。自己検証はメモリへ書き込む前に完了させ、`encodeChatStateData` まで遅延させてはなりません。

- **同一 applying intent の `commitApply` は 1 度のみ発行します**（`commitStarted`）。発行は Telegram 側でのコミット完了を意味しません。処理は直列キューや権限クエリで待機中である可能性があります。実行前、クエリ完了後、結果適用前にラウンドの entry、phase、intent を確認し、キャンセル済みタスクによって権限を狭めてはなりません。重複した永続化応答によって再発行することはなく、永続化確認済み intent の引き継ぎ時は発行と同時にフラグを設定します。`lockdownRuntime.ts` は状態とタイマーを解釈し、`lockdownApi.ts` は直列 API 副作用を実行します。

### AI チャットの実行時

- 天気情報の定期更新は AI Worker が所有し、`init` を受信し、かつ設定タイムゾーンが `TOKYO_TIME_ZONE` と一致する場合のみ開始されます（`get_tokyo_weather` の登録条件と同一）。他のタイムゾーンでは天気リクエストを送信せず、気分の抽選にも天気による重み付けは適用されません。プロセス停止時には interval タイマーを解除し、処理中の HTTP リクエストをキャンセルしてキャッシュ更新権を取り消します。再開後に結果を書き込めるのは現行ループのみです。HTTP 境界は呼び出し元のキャンセル、タイムアウト、応答本文の容量上限を同時に適用します。

- `/mood query` と `/mood switch` は、メインスレッド側の request/waiter と AI Worker 側の acknowledgement によるハンドシェイクを共有します。前者は任意のグループメンバーが現在有効な気分（mood）を強制再抽選なしで読み取り、後者のみが `isCanSwitchMood` を検証して即時再抽選を実行します。メインスレッドは送信前に waiter を登録し、タイムアウト、Worker クラッシュ、再起動断念、シャットダウン時に統一して精算します。リクエストは絶対的な deadline を保持し、Worker は読み取りや再抽選の前に期限切れリクエストを拒否します。リクエスト ID と期待するイベント型が双方一致する `moodQueried` / `moodSwitched` acknowledgement のみが処理成功を証明します。その後の Telegram への返信送信失敗を query や再抽選の失敗へ書き換えてはなりません。mood は AI Worker 内に全グループ共通の単一インスタンスとして保持され、リクエストおよび acknowledgement に chat ID は含まれません。どのグループから再抽選を実行しても全グループに即時反映され、`/clear_context`、`/ai_chat disable`、グループの teardown、メモリ容量による退避はいずれも mood に影響を与えません。
- **AI 会話 teardown の完了責任はタイムアウト後も保持されます。** メインスレッドの `pendingAiMemoryTeardowns` は耐久的削除とリクエスト ID が一致する `chatInvalidated` を待機します。AI Worker の再構築・放棄・終了時であっても旧要求を確定できます。削除待ちのタイムアウトは waiter のみを解放し、遅延応答から完了処理を継続します。Worker の `memoryDeleted` が再び削除を登録した場合は、その tombstone の確認も待機します。新規記録やスナップショットが引き継いだ場合は旧完了責任を取り消し、通常の `/ai_chat disable` はこの teardown identity を作成しません。新規スナップショット、初回永続化マーカー、tombstone、waiter がすべて解消されてからメインスレッドのグループカウンターを解放し、FIFO で `forgetAiMemory` を送信します。単一のグローバル revision 下限により、新ライフサイクルが解放済み番号を再利用することはありません。未完了 teardown は最大 `STATE_MANAGED_CHAT_LIMIT` 件であり、上限到達時は既存の storage fatal 境界へ通知し、新規責任を拒否します。Disk I/O 再構築時はメインスレッドが削除をリプレイし、プロセス再起動時はこれらのメモリ identity を復元しません。

- AI チャットの invalidate は、完了を待機可能な cancellation 境界です。各チャットで最初の generation-sensitive タスクを受け入れると、該当 Worker isolate 内で二度と再利用されない一意の epoch を割り当てます。

  invalidate は現在の epoch を同期的に削除し、旧世代を abort して未開始タスクを消去した後、該当 epoch に登録された返信ラウンド、レート制限通知、メディア説明、メモリ圧縮（compaction）タスクが settle するのを待機してから `chatInvalidated` 応答を返します。

  **この待機時間には上限が必要です**（`AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS`。メインスレッド側の `AI_CHAT_INVALIDATE_TIMEOUT_MS` より短く設定すること）。

  メモリ圧縮とメディア説明は双方とも該当世代の `AbortSignal` をモデルリクエストへ渡し、圧縮のリトライ待機も同一のシグナルを受理します。`Promise.race` 用の unref expiry タイマーは、タスク完了またはタイムアウトのいずれが先に発生しても `finally` で確実にクリアされます。タイムアウトは待機のみを終了させ、旧返信ラウンドの存続容量は実際の後処理が完了するまで保持されます。

  時間切れとなった場合は安全に降格して処理を続行し、エラーログを 1 行記録します。登録されたタスクはすべて自身の世代を検証し、無効化後は一切の書き込みを行いません。

  遅延タスクは副作用のない epoch 照合のみを実行し、エントリ回収後やチャット再有効化後に古いトークンが復活することはありません。epoch Map は現在アクティブな処理数に応じてのみ伸長し、過去のチャットを保持し続けることはありません。メインスレッドが invalidate 完了を報告できるのは、メモリ削除の永続化と Worker の確認応答が双方とも成功した後に限られます。`/ai_chat disable` と `/clear_context` は同一の `invalidateAiChat(chatId)` を共有し、双方ともグループの会話記憶を消去し、`chat_states.ai_context` を NULL にリセットし、その他のグループ状態は変更しません。唯一の違いは、前者が機能スイッチ自体も永続化する点です。

- `/clear_context` は実行者の身分が `isCanClearContext` を保持していることを検証し、現在のグループの会話記憶のみを消去します。スーパー管理者は常に true であり、新規ホワイトリストメンバーはデフォルトで false です。権限の付与・剥奪は `/permission` で個別管理されます。
- モデルリクエストのトランスポート、ネットワークエラー、429、5xx リトライは選択されたプロバイダの公式 SDK のみが所有します（Gemini は `@google/genai` の `retryOptions`、OpenAI と Anthropic は各 SDK の `maxRetries`。予算定数は `GEMINI_REQUEST_RETRY_ATTEMPTS`、`OPENAI_REQUEST_MAX_RETRIES`、`ANTHROPIC_REQUEST_MAX_RETRIES`）。各 SDK のタイムアウトは**試行ごと**の期限であり、aiChat の各最下層ラッパー（`aiChat/gemini/client.ts`、`aiChat/openai/client.ts`、`aiChat/anthropic/client.ts`）は `libs/abortSignal.ts` の `signalWithTimeout` を用いて、呼び出し全体（全リトライとバックオフを含む）をカバーする deadline を合成して渡します。シグナルが発火した時点で SDK は残りのリトライを短絡するため、最悪のハング時間は各能力の `GEMINI_REQUEST_TIMEOUTS_MS` / `OPENAI_REQUEST_TIMEOUTS_MS` / `ANTHROPIC_REQUEST_TIMEOUTS_MS` に抑えられます。3 社の SDK クライアントは `aiChat/capabilityClient.ts` で能力ごとに構築・キャッシュされます。呼び出し側の invalidate シグナルはこの deadline と合成され、置き換えられることはありません。1 回のリクエストが `failureKind: "request"` で失敗した後に、呼び出し側が独自にリクエスト全体のリトライを重ねることは禁止されます。ドメイン層での再サンプリングは、SDK リクエスト自体は成功したもののモデル応答が利用不能または異常終了した場合（`failureKind: "response"`）、あるいは正規化後のテキストが空となった場合にのみ許可されます。

  `aiChat/openai/image.ts` も `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` を各試行および画像生成処理全体に適用します。合成シグナルを SDK と外側の待機処理へ渡し、参照素材の準備、SDK リトライ、バックオフを包括します。呼び出し側のキャンセルは静かに終了し、全体 deadline の超過はリクエスト失敗として記録されます。
- AI モデル呼び出しは Telegram 送信ゲートには入りませんが、同一プロバイダ・`base_url`・API キーは 1 つのクォータレーンを共有し、モデル名や `headers` では分割されません。1 つのレーンはアクティブなモデルリクエスト上限を `AI_PROVIDER_MAX_CONCURRENT`、未開始タスク上限を `AI_PROVIDER_MAX_PENDING`、バックグラウンド待機枠上限を `AI_PROVIDER_BACKGROUND_MAX_PENDING` とします。対話リクエストを `AI_PROVIDER_INTERACTIVE_BURST` 件連続で開始した後は、待機中のバックグラウンドタスクを 1 件通過させます。SDK リトライは元のスロットを維持し、ローカルキューが満杯の場合はプロンプトやメディアバイトを無制限に保持することなくドメインエラーを返します。Telegram メッセージレーンの実行中リクエストが高水位（`AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER`）に達するか実際の 429 待機が発生した場合は、ランダムな自発割り込み発言を停止し、同一チャット内の直接トリガー並行数を 1 に引き下げるのみであり、プロバイダキューと Telegram キューは独立したまま保たれます。
- 返信アクションツールは呼び出しの中でバリデーション、クールダウンの確保、枠の予約を同期的に完了させ（`send_voice` は呼び出し時に日次枠を予約し、TTS 成功時に本登録します）、検証・資格・クールダウン・枠のいずれかを満たさない呼び出しには直ちにエラーを返します。どちらのラウンドでも呼び出し ID ごとに `success: true, queued: true, actions_used` を返却し、これは実際のメッセージ ID を含まない受理通知であり、この受理通知の時点で action budget を消費します。`toolset.execute` は同期的に返却されるため、モデルとの対話往復は自然な待機時間、音声合成、送信処理の完了をブロックしません。`send_voice` は呼び出し時にバックグラウンドで合成とエンコードを開始し、受理通知は合成完了を待ちません。各ラウンドの直列アクションチェーンは 1 本のみです（`aiChat/ai/tools/replyToolset/actionChains.ts`）。どちらのラウンドも受理したアクションをツール呼び出し順に整列させ、生成処理、自然な待機、ボイス合成待機、Telegram 送信待機とキュー側の再試行はチェーン内部で実行されます。順序付き並行ラウンドのチェーンは送信順が来るまで待機し、直接ラウンドのチェーンには関門が存在しません。チェーンの各ステップは完了するたびに idle 状態へ復帰します。バックグラウンドへ移行したボイスはチェーンを占有せず、合成成功時点のチェーン末尾に整列します。追送や自己記録は実際の結果を待機します。ラウンド全体は受信順に送信され、後続ラウンドが先行ラウンドの本文・訂正・キャプションの間へ割り込むことはありません。失敗の記録と後処理はチェーンが担当し、モデルが受理済みのアクションを再投入することは禁止されます。

  **チャット状態表示**（入力中・スタンプ選択中・録音中・写真送信中）はラウンドの heartbeat ハンドル（`aiChat/ai/chatActionHeartbeat.ts`）を経由してのみ切り替えられます。アクション実行時の状態表示はチェーン上で現在実行中のステップのみが切り替え、executor は呼び出し時には切り替えません。直接ラウンドはそれに加えて `replyToolset/pacing.ts` の `createDirectPacing` でリクエスト中の状態を表示します。アクションをまだ受理していないモデルリクエストの間は「入力中」を表示し、該当リクエストが返却した最初のアクションがテキスト（`send_message`）であれば、その状態のまま追加待機なしで送信します。スタンプパックを新たに閲覧した直後のリクエストでは「スタンプ選択中」を表示し、それ以外のリクエストでは何も表示しません。リクエストの状態表示は直列チェーンが空いている間のみ点灯します。チェーンが空からステップ実行中へ変化した場合はチェーン側のステップに委譲し、チェーンが再び空いた際にリクエスト側がまだ状態表示を必要としていれば改めて点灯させます。アクションは受理時に呼び出し順でリクエストの状態を引き継ぎ、バックグラウンドから補送されるボイスステップは引き継ぎません。その他のアクションはチェーン上で独自の状態へ切り替えて自然な待機を行い、完了時に idle へ復帰します。モデルフェーズの終了時（`toolset.afterModel`）には、リクエスト側が点灯させたままアクションに引き継がれなかった状態を取り下げます。`view_sticker_pack` 自体は状態表示を変更しません。送信前に idle へ切り替えて settle し、着地後にもう一度 idle へ切り替えます。idle への切り替えは状態の区切りであり、同一チャットは直前の idle から `CHAT_ACTION_REST_MS` の間は非表示を維持します。その間は状態表示リクエストを一切送信せず、途中の切り替えは非表示期間の満了時に点灯し、自然な待機時間は残りの非表示時間分だけ延長されるため、視覚的な表示時間は削られません。現在の状態を保持していないラウンドの idle は、該当状態を取り下げることも非表示期間を開始することもありません。誤字メッセージが着地した後の訂正メッセージは、`TYPO_QUICK_CORRECTION_MIN_MS`〜`TYPO_QUICK_CORRECTION_MAX_MS` の非表示待機を経てから `TYPO_QUICK_CORRECTION_TYPING_MS` の「入力中」を表示して送信されます。

  `view_sticker_pack` は待機や送信完了を待たず、該当ラウンドの実際のメニュー番号・パック名・説明文を同期的に返却して閲覧意図を記録します。1 ラウンドにつき異なる `MAX_STICKER_PACK_VIEWS_PER_REPLY` パックまで、同一パックは 1 回のみ閲覧可能であり、送信時は閲覧済みの同一メニューを参照します。天気情報とグループ Q&A は既存データのみを読み取り、問い合わせ枠はアクション予約枠から独立しています。

  `activeReplyCounts` は未完了のモデルラウンド（直接ラウンドを含む）のみをカウントします。上限は `states/replyAdmission.ts` の `replyRoundConcurrencyLimit` が決定し、順序付き並行ラウンドは同一チャット内で `REPLY_ROUND_MAX_CONCURRENT` まで、直接ラウンド（チャット内に進行中のラウンドが存在しない、すなわち送信ウィンドウが存在しない状態で開始されるラウンド）はそれとは独立してモデルフェーズの間のみ 1 枠を追加消費し、ウィンドウの `directModelActive` がその状態を記録します。Telegram 高負荷時は同一チャット内で合計 1 ラウンドに制限されます。受付とキューの補充は同一の上限を使用します。`pendingReplyTriggers` は未開始の直接トリガーをチャットごとに最大 `REPLY_TRIGGER_QUEUE_MAX` 件保持します。teardown は該当チャットの待機タスクをすべて削除します。AI Worker の `replyDelivery.ts` はチャットの送信ウィンドウごとに 1 つの FIFO に受信順の送信枠を予約します。全世代で `REPLY_DELIVERY_MAX_PER_CHAT` と `REPLY_DELIVERY_MAX_TOTAL` を共有します。容量上限到達時はランダムトリガーを破棄し、直接トリガーを待機させ、待機列も満杯の場合は一時的な溢れ通知を記録します。予約失敗時はレート制限枠を消費せず、プロンプトやモデルタスクも生成しません。開始成功後にのみキューの先頭を除去し、メディア認識は枠予約後に実行されます。モデルフェーズの終了時（早期 return やキャンセルを含む）にコミットしてモデル枠を返却します。順序付き並行ラウンドは完全なチェーンを準備完了状態とし、直接ラウンドは追加枠を返却します。送信処理は準備完了となった先頭から順次実行され、空ラウンドや失敗した完了項目は順にスキップされます。直接ラウンドは新規ウィンドウの先頭であり、予約時点で準備完了となり、チェーンが受理したアクションを即座に実行して生成しながら送信し、モデルフェーズは送信完了を待ちません。後続の順序付き並行ラウンドは直接ラウンドの完了後に順番に解放されます。実際の送信と heartbeat の後処理完了後に存続容量が解放されます。`onFinished` は溢れ通知を精算して待機チャットを進め、枠を獲得しても待機タスクが残るチャットは末尾へ再配置します。invalidate、reset、無効化待機のタイムアウトは現ウィンドウを解除しますが、旧タスクの容量を先行返却することはありません。旧世代の後処理が新ウィンドウを削除することはできず、Worker 破棄時にカウンタも解放されます。`RATE_LIMIT_LONG_WINDOW_MS` のレート制限、トリガー FIFO、プロバイダレーン、Telegram のチャット別送信スケジューラ、分類別 429 キューは各境界で個別に制御されます。直列アクションチェーン（バックグラウンドへ移行したボイスを含む）と該当ラウンドの heartbeat 後処理、送信枠の回収がすべて完了するまで、ラウンドを generation task 集合内に保持します。どちらの完了通知が例外をスローしても後処理を省略してはなりません。無効化およびキャンセルのシグナルは実際のリクエストおよび再試行キューまで伝播します。メモリの容量整理は、モデル処理中または現世代のタスクを保持するチャットを優先的に回避し、全候補がアクティブである場合は LRU 順序に従います。実際の送信に成功したメッセージと Telegram が返却した返信関係のみを自己記録し、受理通知をメモリに書き込むことはありません。
- AI 返信は、テキスト、スタンプ、リアクション、画像、ボイスを受理した時点で統一 action budget を同期的に予約します。モデル向けプロンプト上限は `AI_MAX_ACTIONS_PER_REPLY`、実行側ハードキャップは `HARD_MAX_ACTIONS_PER_REPLY` です。スタンプ、リアクション、生成画像、ボイスはそれぞれ最大 1 回のみ受理可能であり、その他のアクションツールに呼び出し回数制限はありません。スタンプパック閲覧は独立したルックアップ上限を保持します。サーバー側ウェブ検索の 1 返信あたりの回数はプロンプトに記載されたソフトリミットであり、実行側はカウントと上限超過時のログ記録のみを行います。カスタム関数呼び出し全体にもラウンド単位のループガードが存在し、上限を超過した呼び出しは「予算切れのため、ツール呼び出しを終了して締めくくってください」というツール結果のみを受け取ります。これらの上限はアクションハードキャップと同様に実行側のみで管理され、ラウンドの途中でツール定義を変更することは一切ありません。

  受理したアクションが 0 件の場合のみ、最終本文を `send_message` 経由でフォールバック送信します。意図的に表示するすべての文字列は、モデルがツールを明示的に呼び出して生成しなければならず、最終応答本文に直接記述したままにしてはなりません。

  **可視テキストの出口は厳密に 2 つのみです**：単独の発言は `send_message`、該当ラウンドの `generate_image` で生成された画像に添えるキャプションは同ツールの `caption` を経由します。キャプション付きの画像生成は Telegram 上で**1 通**のメッセージ（`message_id` も 1 つ）であるため、アクション消費も 1 枠のみ計上し、自己記録も 1 件に統合しなければなりません。キャプションが `TELEGRAM_CAPTION_MAX_CHARS` を超えた場合、Bot API は切り詰めではなく送信自体を拒否するため、実行側は「キャプションなし画像 + 独立テキスト 1 通」へと降格させ、受理時に `actions_used: 2` を予約します。残りが 2 枠未満であれば画像のみを受理し、受理通知に `caption_delivery: "no_action_budget"` を返却します。誤字本文と追送する訂正文字も受理時に 2 枠を予約し、訂正は本文の送信完了後に実行されます。

  **同一返信ラウンド内における重複テキストは送信前に静かにスキップされます。** `send_message` の本文と `generate_image` のモデルキャプションは `modelAuthoredTextPolicyResult` を共有します。通常のテキスト整形後、比較時のみ空白を集約し Unicode NFC で正規化して、該当ラウンドで既に受理されたモデル本文・キャプション・実行側が予約した訂正文字と完全一致で照合します。語句・大文字小文字・句読点は厳格に区別され、意味的類似度による強制拒否は行いません。一致した場合は `{"success":true,"skipped":"duplicate","actions_used":0}` を返し、入力状態表示・生成要求・クールダウンの消費・Telegram 送信・メモリへの自己記録を開始しません。受理後の失敗やキャンセルによって予約枠が返却されることはなく、モデルによる再投入も認められません。受理前に拒否された呼び出しは枠を消費せず、重複判定の状態はラウンド間で共有されません。

  システムプロンプトは同一内容を一度のみ表現し、言い換えやアクション数合わせのための反復を禁止します。現在のトリガーに対して既に返信済みであり新しい内容が存在しない場合は終了し、キュー再開時にも同一のルールが適用されます。スキップ結果も呼び出し ID と紐付けて SDK セッションへ返却されます。モデル出力とツール結果は末尾への追記のみとし、履歴・推論コンテキスト・思考署名・該当ラウンドのツール定義を保持します。

  **ツール一覧は毎ラウンド固定であり、ラウンドごとの利用資格は該当ラウンドのツール状態ブロックにのみ記述され、executor が呼び出し時に最終判定します。** `createReplyToolset` は以下の条件に基づいてツール群を組み立てます。一覧はこれらの条件のみによって変化し、トリガー種別・本グループの Q&A 登録状況・誤字の抽選結果とは無関係であり、条件が同一であれば完全に同一の定義となります。
  - 常に含めるツール：`send_message`、`add_reaction`、`group_qa_query`、`group_qa_answer`。`send_message` の `typo_original_char` / `typo_replacement_char` は常に任意のフィールドとして宣言され、説明文は「返信タスクから指示された場合のみ指定する」とだけ記述されます。誤字のルールは抽選に当選したラウンドの返信タスクにのみ `TYPO_REQUIRED_INSTRUCTION` として付与されます。
  - `generate_image`：画像生成プロバイダが設定されている場合に登録されます。
  - `send_voice`：`agent.tts` が設定され、選択された実装が `synthesizeSpeech` をサポートしている場合に登録されます。
  - `view_sticker_pack`、`send_sticker`：スタンプメニューが空でない場合に登録されます。
  - `get_tokyo_weather`：起動時のタイムゾーンが `TOKYO_TIME_ZONE` と一致する場合のみ登録されます。
  - `web_search`：`agent.web_search` が設定されている場合はローカルの関数ツールとして登録されます。未設定の場合は関数ツールとしては登録されず、text モデルの組み込み検索機能を使用します（詳細は「AI プロンプトと transcript」のウェブ検索項を参照）。

  **セリフの言語は 1 度のみ選択されます**：`send_message`・`send_voice`（`text` / `tone` 引数の説明を含む）の宣言文とシステムプロンプトの「行动与停止」節は、`agent.tts.bot_language` に従って `VOICE_LANGUAGE_PROMPTS`（`consts/aiChat/prompts/tools.ts`。`TTS_BOT_LANGUAGES` ごとに 1 セット登録）から同一の 1 セットを取得します。`tts` 節が省略されている場合は `TTS_DEFAULT_BOT_LANGUAGE` となります。
  - `createReplyToolset` は組み立てのたびにこの 1 セットのみを取得し、「行动与停止」節は `ReplyToolset.replyActionInstruction` 経由で `workers/aiChat/replyModel.ts` へ渡されるため、1 回の返信における各所の言語は厳密に一致します。
  - `prompt/voice_tool.md` を取り込んでいる場合、`send_voice` のツール説明はその本文を使用し（`buildSendVoiceToolDefinition` が `voiceToolPromptCache` を読み取る）、引数の説明、`send_message` の宣言、「行动与停止」節、および `createSendVoiceExecutor` が AI の音声合成リクエストごとに付与する読み上げ言語指定（`speechLanguageStyle`）は引き続きこの 1 セットを使用します。

  **該当ラウンドのツール状態ブロック**（ランタイム状態ブロック内の【本轮工具状态】。`aiChat/ai/tools/replyToolset/toolStatus.ts`）：
  - `createReplyToolset` がツールを組み立てる同一時点で 1 回のみスナップショットを取得し、同一返信内のツール対話往復では同一テキストを再利用します。
  - 条件付きツールごとに 1 行ずつ客観的事実のみを記述し、行の順序は画像・ボイス・Q&A・独立検索の順で固定されます。
    - 画像行（`generate_image` が登録されている場合のみ）：利用可能（参照素材の説明付き）、利用不可（該当ラウンドが直接の @メンションや返信ではない）、クールダウン中（残り秒数付き。スーパー管理者のトリガーはクールダウン対象外）のいずれかを示します。
    - ボイス行（`send_voice` が登録されている場合のみ）：本日の残り利用可能回数または上限到達を示します。
    - Q&A 行：常に出力され、本グループにおける登録件数または未登録状態を示します。
    - 検索行：独立した `agent.web_search` が設定されている場合のみ出力され、該当ラウンドの関数呼び出し上限を示します。
  - この節には客観的事実のみを記述し、「利用不可・クールダウン中・上限到達のツールは該当ラウンドで呼び出さない」という制約は「行动与停止」節が規定します。

  **executor は呼び出し時に最終判定を実行します**：スナップショットは返信処理の途中で古くなる可能性があるため、各 executor は呼び出し時に改めて検証を行います。
  - `generate_image`：`mediaToolsRequested` が false であれば認可なしとして拒否します。`replyRound.ts` はこれを、入口で画像ツールが許可されており（`imageGenerationRequested`）、トリガーがランダムではなく、テキストラウンドまたは `directTriggerReason` を伴うメディアラウンドである場合、すなわちメンバーが Bot を直接 @メンション / 返信したかメディアで直接呼び出した場合にのみ true に設定します。チャットのクールダウンは呼び出し時にアトミックに確保され（スーパー管理者のトリガーは免除）、クールダウン中であれば残り秒数とともに直ちに拒否されます。この利用資格は創作意図を意味するものではなく、実際に創作を実行するかどうかはモデルが判断します。
  - `group_qa_query`：本グループに Q&A が未登録であれば空一覧を返却します。`group_qa_answer` は質問の原文と完全一致で回答を取得し、一致しない場合は `found: false` を返し、あいまい一致は行いません。
  - `send_message`：誤字の抽選に当選していないラウンドでは誤字フィールドを無視し、原文のまま送信します。

  **ツール受理通知の意味は「行动与停止」節（`VOICE_LANGUAGE_PROMPTS[*].replyActionInstruction`）で 1 度のみ宣言されます**：`error` は該当アクションが実行されなかったことを示し、モデルは以降それを完了扱いせず、引用や同一テキストでの再試行を行わず、失敗そのものに対しても単独で反応してはなりません（謝罪しない、言い訳しない、ツール・枠・クールダウン・失敗の事実に言及しない）。唯一の例外は、メンバーが該当ラウンドで明示的に画像を求めたにもかかわらず `generate_image` が利用できない、または拒否された場合であり、その際は今回描けない旨を一言で簡潔に伝えます。

  **`send_voice` にはラウンド単位の利用資格は存在しません。** 同一の `bot_language` であればツール定義は完全に一定であり、ボイスを送信するかどうかはツール説明に従ってモデルがすべて自律判断し、実行側がラウンドごとの資格判定を設けることはありません。

  **受理プロセス**（`createSendVoiceExecutor`。呼び出し時に同期的に完了し、直接ラウンドと順序付き並行ラウンドで同一）：
  - 次の順序で検証します：該当ラウンドが有効であるか、該当ラウンドで受理済みのボイスが `MAX_VOICES_PER_REPLY` に達していないか、選択された実装が音声合成能力を持つか、引数が妥当であるか。最後に `ai` 区分の 1 日の枠を 1 回分予約します（`reserveAiTtsUsage`）。ウィンドウ内の `agentCount` と進行中の予約の合計が上限に達している場合は、その場で `SEND_VOICE_DAILY_LIMIT_TOOL_ERROR` を返却して拒否します。
  - 引数仕様：`text` は必須、`tone` と `reply_to_trigger` は任意です。`text` と `tone` は空白を集約して 1 行化し、前後の空白を除去します。整形後の `text` は空でなく `VOICE_TEXT_MAX_CHARS` 以下、`tone` は `VOICE_TONE_MAX_CHARS` 以下でなければならず（整形後に空であれば未指定扱い）、`reply_to_trigger` は boolean のみを受け付け、省略または null は false 扱いとなります。制限超過や型不一致は切り詰めを行わず引数エラーとして差し戻します。
  - 受理に成功した場合は、その場で受理通知（`success: true, queued: true, actions_used`。今回の予約後の残り `voice_remaining_today` を含む）を返却して統一 action budget を予約します。同時にバックグラウンドで音声合成とエンコードを開始し、配送ステップを呼び出し順に直列チェーンへ整列させます。モデルは合成完了を待ちません。

  **配送プロセス**（直列チェーン上の配送ステップ）：
  - チェーンがこのステップに到達した時点で合成が完了しておらず、`VOICE_FOREGROUND_WAIT_MS`（呼び出し時点を起点とする）も未経過であれば、「録音中」を表示して待機します。
  - 待機ウィンドウが終了しても合成が完了していなければ「録音中」を取り下げ、配送をバックグラウンドへ移行させて（`chains.defer`）チェーンは後続ステップへ進みます。バックグラウンドの合成が成功した場合は、その時点のチェーン末尾に整列させて補送します。
  - 合成に失敗した場合（タイムアウトや再生不能な音声を含む）は送信を行わず、英語ログ `AI reply voice was not sent` を記録するのみで、モデルへは通知しません。返信が無効化済みであればログも残しません。
  - すべてのボイスは（バックグラウンド移行後の補送を含め）送信前に音声の再生時間分だけ「録音中」を表示し、合成待機の間に表示された時間とは無関係に独立して制御されます。
  - 送信成功後、実行側は同一メッセージに対して `（发送了一条语音：…）` の自己記録記号を書き込みます。
  - 合成結果はツール呼び出しの外側で、待機ウィンドウタイマー、直列チェーン、バックグラウンド配送がそれぞれ待機するため、`synthesizeVoiceMessage` は例外をスローしません。合成エントリやエンコード処理における想定外の例外はログに記録され、合成失敗として処理されます。

  **1 日あたりの回数管理と予約**：
  - 予約情報は AI Worker のメモリ上のみに保持され（`cache/workers/aiChat/ttsUsage.ts` の `pendingAiTtsReservations`）、永続化されません。
  - `agentCount` は TTS 呼び出しが成功した瞬間にのみ本登録され（`settleAiTtsReservation`）、TTS の失敗、成功前のキャンセル、例外発生時は予約を解放するのみです。TTS 成功後のエンコード失敗・送信失敗・キャンセル時には枠を返却しません。
  - tts facade は `ai` 区分のリクエストを登録せず、facade がリクエスト前に本登録するのは `/send` と `cron.json` の `operator` 区分のみです（後述）。
  - モデルから参照可能な残り回数は各返信の開始時に 1 回読み取られます：該当 isolate の現在の `agent.tts` における `ai` 区分の上限から、現在のウィンドウ内の `agentCount` と進行中の予約数を減算した値であり、0 未満にはなりません。これが該当ラウンドのツール状態ブロックのボイス行（`voiceToolStatus`）となります。上限到達時のエラー文面とツール説明は、再試行を行わず、グループ内でボイス・上限・失敗の事実に言及しないようモデルに要求します。

  **セリフと重複判定の規約**：
  - セリフは音声として読み上げられるコンテンツであり可視テキストの出口ではないため、`modelAuthoredTextPolicyResult` の重複判定を通過しません。
  - 「ボイスで発言した内容を `send_message` で再送しない」という原則はプロンプトによる意味論的な制約のみであり（セリフは `bot_language` の言語であるため、言い換え・翻訳・注釈付きもすべて重複とみなされます）、実行側が意味的比較を行うことはありません。
  - プロンプトはさらに、テキストメッセージでこのボイスに言及する・予告する・指し示すこと、および声を使用しなかった理由を説明することを固く禁じます。

  **「テキスト + 口調 → 音声」の実装は 1 箇所に集約されます**（`packages/aiChat/ai/voiceSynthesis.ts`、AI Worker）：
  - `resolveSpeechSynthesizer` がエントリポイントの有無を判定します。`agent.tts` が未設定なら `tts unconfigured`、選択された実装が非対応なら `tts unsupported` です。
  - `synthesizeVoiceMessage` は tts facade（対話優先の quota gate）を経由して合成します。合成結果が返却された時点でシグナルがキャンセル済みであればエンコードを行わず、1 日の枠を使い切っていれば `daily limit reached` として終了します。
  - `aiChat/ai/voiceEncoding.ts` が MIME に応じて Telegram ボイス形式へ変換します：
    - WAV：モノラル PCM を抽出し、`VOICE_OPUS_ENCODE_CHUNK_SECONDS` ごとに `OPUS_RATE` へリサンプルして OGG/Opus にエンコードし、チャンク間で AI Worker のイベントループを明示的に解放します。
    - OGG/Opus および MP3：`aiChat/ai/utils/voiceContainer.ts` でコンテナ（Ogg ページ構造と OpusHead、MPEG Layer III のフレーム列）を検証して再生時間を算出し、専用バッファへコピーしてそのまま使用します。
    - それ以外の MIME は `unsupported speech mime type` で失敗します。
    - 変換結果はコンテナ形式に応じたアップロード用ファイル名（`VOICE_OGG_FILE_NAME` / `VOICE_MP3_FILE_NAME`）を保持し、各送信境界はそれを使用します。
  - セリフと口調の正規化および長さの検証は呼び出し側が担当し、ツール宣言、引数仕様、ラウンド単位の上限、返信先の指定は AI ボイスツール固有のものです。

  **メインスレッドからの利用**（`/send` 中継の TTS リクエストおよび `cron.json` の `send_voice`）：
  - 入口は `aiChat/workerBridge.ts` の `synthesizeVoice` であり、`packages/aiChat/voiceSynthesis.ts` の `requestVoiceSynthesis` がメッセージを投函します。`agent.tts` が存在しなければ `tts unconfigured` を返し、Worker が利用不能であるか呼び出し側が既に取り消していれば直ちに終了します。いずれの場合もメッセージは投函されません。
  - それ以外の場合は待機者を登録してから `synthesizeVoice` を投函し、Worker が同一 requestId の `voiceSynthesized` レシートで結果を返却します。成功時は音声バイトバッファを transfer します。
  - 終了経路はレシート受信、`VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS` のタイムアウト、呼び出し側のキャンセル、投函拒否、Worker のクラッシュ再構築/放棄/終了のみです。タイムアウトやキャンセル時は `cancelVoiceSynthesis` を追加投函して Worker 側の合成処理を中止させ、遅延して届いたレシートは未知の requestId として破棄されます。解決は常に結果 union を返し、Promise の reject は行いません。
  - Worker 側では合成ごとのシグナルを Worker のライフサイクルシグナルと合成し、drain 開始後に到着したリクエストにはそのまま「worker unavailable」を返却します。
  - `/send` と `cron.json` の設定解析は、それぞれセリフを `VOICE_OPERATOR_TEXT_MAX_CHARS` 以下、口調を `VOICE_TONE_MAX_CHARS` 以下に厳格制限します。

  **運用側入口の 1 日あたりの回数は tts facade で記録されます**（`packages/aiChat/provider.ts` の `createSpeechFacade`。カウント関数は `aiChat/ai/ttsUsage.ts`）：
  - リクエストはすべて quota gate で順序を待ち、`quota: "operator"` のリクエストは実行順が回ってきてプロバイダリクエストを発行する直前に `claimOperatorTtsUsage` を呼び出します。待機中にキャンセルされたリクエストや満杯キューに拒否されたリクエストはカウントせず、`operator` の上限に達している場合はリクエストを発行せず `daily limit reached` として終了します。
  - 登録処理は claim（所属するウィンドウの起点時刻）を返却します。プロバイダが音声を返却しなかった場合（null 返却または例外スロー）、facade は該当 claim で `refundOperatorTtsUsage` を呼び出して 1 回分を返還し、登録後にウィンドウが切り替わっていた場合は返還しません。
  - AI ボイスツールは前述の通り自ら予約と本登録を実行し、`quota: "ai"` を渡すため、facade はそのまま合成を実行し本登録は行いません。
  - 上限値は `ttsQuotaLimit` で算出されます。`ai` 区分は `daily_limit - daily_reserve_quota`（AI ボイスツールは受理時に該当 isolate の現在の `agent.tts` から取得）、Worker へ転送された `/send` と cron は `operator` を渡し、上限は `daily_reserve_quota`（facade 構築時に捕捉した `agent.tts` から取得）となります。
  - AI は `agentCount`、`/send` と cron は `reserveCount` のみを確認して加算し、相互の枠を流用することはありません。`daily_reserve_quota` が 0 の場合、運用側の双方の入口は合成リクエストを発行しません。
  - 1 回の登録は 1 回の合成呼び出しに対応し、プロバイダリクエスト内部のリトライ（`GEMINI_SPEECH_REQUEST_ATTEMPTS`、`OPENAI_SPEECH_REQUEST_ATTEMPTS`）は個別にカウントしません。
  - カウントウィンドウは該当ウィンドウ内の最初のリクエストから開始されます。登録時にウィンドウ起点から `TTS_USAGE_WINDOW_MS` 以上経過している（または起点が現在時刻より未来にある、すなわちウォールクロックが巻き戻った）場合は、該当リクエストを新たな起点として双方のカウントをゼロにリセットし、該当リクエストが属する区分のカウントのみをインクリメントします。
  - `agent.json` のホットリロードは能力 facade をすべて破棄し、次回利用時に新しい `agent.tts` から再構築します。新規リクエストは新しい設定値で判定され、使用済みカウントはリセットされません。

  queue を補走するとき、起動がレート制限または容量で拒否された先頭 trigger は先頭に留め、排出を止めなければなりません（`drainReplyQueue`）。後続の trigger を続けて消費してはいけません。

- **Anthropic モデル応答の取り扱い**：
  - `max_tokens`、`refusal`、または `model_context_window_exceeded` の終了理由に達した応答本文は使用不可とみなします。
  - 広告検出において応答本文が空の場合、最大 `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` 回までリサンプリングを行います。リクエスト例外に対して業務層での再試行を追加することはありません。
  - 対話および独立検索において `pause_turn` を検出した場合、assistant の履歴をそのまま維持して対話を継続し、最大 `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` 回まで継続して各区間の本文と検索回数を合算します。独立検索は HTTP 成功であっても `web_search_tool_result_error` を含んでいれば失敗とみなし、説明文を検索結果として返却しません。構造化 JSON の Schema は SDK に直接渡し、呼び出し側で結果を厳密にデコードします。

- **トークンと利用量の算定**：
  - 利用量統計はプロバイダ SDK が返却する正規の `usage` を基準とし、`packages/infra/aiCacheUsage.ts` が集中的に検証・報告します。`packages/infra/aiCacheUsageRelay.ts` がメインスレッドから Disk I/O へ送信する診断エンベロープを統一します。
  - キャンセルや中断が発生した場合でも、SDK が有効な利用量を返却していれば集計に含め、SDK が返却しなかった場合は推定を行いません。
  - Gemini の本文トークンと思考トークンは検証後に合算し、OpenAI の出力トークンには推論トークンを重複加算しません。再生時間のみの文字起こしはトークン換算しません。
  - 費用のみを返却するモデル（xAI 画像生成の `cost_in_usd_ticks` など）は費用メトリクスとして個別に記録し、トークン換算は行いません。OpenAI audio/speech および xAI `/tts` の音声合成応答は usage を返却しないため、応答ごとに `missing` として診断し、利用量は記録しません。同一の応答を両方で記録することはありません。
  - Web 検索回数はモデルトークンと併せて記録し、日次集約では 1 回のリクエストとしてカウントします。独立した検索呼び出しは search usage として記録し、リクエスト数には加えません。Anthropic は `server_tool_use.web_search_requests` を基準とし、OpenAI は `action.type === "search"` かつ完了状態のアクションのみを集計します。

- **2 段階の返信受付メカニズム**：
  - **並行ゲート（`admitTrigger`）**：トリガー到着時に判定し、現在の並行数で受け入れ可能かを確認します。
  - **レート制限ゲート（`isReplyRoundRateLimited`）**：ラウンドを実際に開始する直前に、`RATE_LIMIT_LONG_WINDOW_MS` のスライディングウィンドウでレート制限を検証します。制限による拒否時、レート制限通知を送信するのは直接トリガー（`directInvokerId` が存在）のみであり、ランダムな相づちは何も送信せず静默に破棄します。
  - **FIFO 保証**：待機キューが空でない場合、並行スロットに空きがあっても新たに到着したトリガーは必ずキューの末尾に入り、割り込みは禁止されます。
  - モデル計算の完了（`onModelFinished`）、送信の後処理完了（`onFinished`）、新規タスクのキューイング、定期メンテナンスティック（`drainPendingReplyQueues`）のいずれもキューの排出（`drainReplyQueueIfWindowAllows`）を推進します。溢れ通知のフラッシュ（`flushOverflowNotice`）はレートウィンドウの制限を受けない独立経路で実行されます。キューの補走時にレート制限または容量で拒否された先頭トリガーは先頭に留め、排出を停止します（後続のトリガーを続けて消費してはいけません）。

- **グループアクティビティ確率レイヤーと JIT 性能保証**：
  - 可視メッセージを記録してランダム自発返信の発火確率を向上させますが、高アクティビティグループ向けの上限に達した後はそれ以上増加しません。アクティビティはグループごとに独立して計算され、プロセス再起動時は冷えた状態から始まります。直接トリガーはこの確率ゲートを完全にバイパスします。
  - このテーブルは全グループメッセージが通過する高頻度ホットパスです。既存のグループは固定 shape の `AiReplyActivityEntry`（`timestamps`、`lastAccessSequence`、`lastObservedAt`）をインプレースで更新し、`Map.delete` + `Map.set` による順序変更や複合キー・一時オブジェクトの生成を禁止します。満杯の有界テーブルに新規グループを挿入する場合にのみテーブルをスキャンして LRU を選出します。
  - ランダム返信のクールダウンは `[chatId][userId]` の 2 段の Map に保存し、文字列の連結を回避します。エントリ総数は `userReplyTriggerSweepState.size` で一元管理し、単一の unref クリーンアップタイマーを使用します。満杯テーブル走査時は全項目が有効な区間 `[validFrom, validUntil)` を記録し、有効なエントリを安易に追い出しません。
  - **グループメッセージ 1 件につきシステムクロックの読み取りは 1 回のみ**：ミドルウェア入口で `Date.now()` を 1 回だけ取得し、コンテキスト経由でアクティビティ、沈黙期間、連投制限などの全サブモジュールへ透過的に引き渡すことで、判定時刻の完全な整合性を保証します。

- **マルチモーダルメディア解析パイプライン（画像、スタンプ、GIF、音声）**：
  - 「プレースホルダーでキャッシュ → 非同期解析 → その場へ書き戻し」の統一パイプラインを採用します。
  - `transientDescriptionCache` は `file_unique_id` に基づいて Promise をキャッシュし、容量上限は `MEDIA_DESCRIPTION_CACHE_MAX` 件です。LRU 方式で淘汰し、失敗結果はその場で即座に削除します。同一ファイルに対する処理中のリクエストは単一の Promise を共有します。
  - 並行エグゼキュータ（`cache/workers/aiChat/mediaTasks.ts`）はアクティブな解析タスクを最大 `MEDIA_DESCRIPTION_MAX_CONCURRENCY` 件に制限し、キューイングとコールドプローブ待機の上限は合計 `MEDIA_DESCRIPTION_MAX_PENDING` 件です。
  - `libs/sharedResult.ts` によりキャンセル可能な共有サブスクリプションを管理します。単一の呼び出し元によるキャンセルは他の消費者に影響を与えず、最後の消費者が離脱した時点で初めて背後のタスクを実際に中止します。

- **Bot 自発画像の記憶バックフィル**：
  - ローリングメモリ内の自発画像（`packages/workers/aiChat/botImages.ts`）は、**プレースホルダー状態**（本文はプロンプトまたはキャプション記号、`pendingImage` を保持）と**内容状態**（記号が実際の画像認識記述に置き換わり、`pendingImage` が消去）に分かれます。
  - コマンドや定期タスクが送信した画像（`/wed`、`/h_image`、`cron.json` の `send_image`）はプレースホルダー状態で書き込まれ、先回りの画像認識は行いません。`/wed` の画像差し替えはホットゾーンの元エントリを新しいキャプションのプレースホルダーへ戻すのみで、エントリ数は増やしません。
  - `generate_image` は送信後にプロンプト付きのプレースホルダー状態で書き込み、直ちに返却された画像を非同期に認識し、成功後に画面の記述を書き戻します。
  - グループメンバーが Bot の画像を引用返信した際、メインスレッドは引用情報に画像のメタデータ（`botImage`）を添付します。元のエントリがプレースホルダー状態のままであれば非同期認識をトリガーし、元の記憶エントリおよび現在の返信コンテキストにバックフィルします。
  - **音声ダウンロードの厳格な事前検証**：音声の再生時間（上限 `VOICE_MAX_DURATION_SECONDS`）およびファイルサイズ（上限 `VOICE_MAX_DOWNLOAD_BYTES`）は、ダウンロード前に検証しなければなりません。上限を超えた音声は再生時間付きの `[语音 N 秒]` プレーンテキストへフォールバックして文字起こしをスキップしますが、後続の返信は遮断しません。文字起こしテキストの切り詰め上限は `VOICE_TRANSCRIPT_MAX_CHARS` です。

- **ホワイトリストスタンプパックの保守とミラー**：
  - AI Worker は起動時および定期メンテナンス時に、`retryIncompleteStickerCatalogs` を通じてスタンプパックを照合します。
  - 失敗エントリおよび失敗パックには、それぞれ `STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS` と `STICKER_SET_FAILURE_RETRY_MS` のネガティブキャッシュバックオフを設定します。
  - スタンプ設定のホットリロード時、Worker はホワイトリストから除外されたスタンプキャッシュを直ちにクリーンアップします。
  - メインスレッドの `stickerMirror.ts` はカタログスナップショットに単調増加するリビジョン番号を割り当て、Disk I/O がアトミック書き込みおよび親ディレクトリの fsync を完了した後に `stickerCatalogPersisted` で確認を返します。メインスレッドは現在の Worker に一致するレシートのみを受理し、リビジョン番号はファイル内に永続化されません。

### AI プロンプトと transcript

- **Bot 自身の身元と発言者識別**：
  - AI 自録、トランスクリプト名簿、返信引用、会話要約の入力において、Bot 自身の発言は一貫して `SELF_SPEAKER_NAME`（`自己（也就是你）`）として識別され、Telegram 上の `first_name`、`last_name`、`username` は表示されません。
  - 返信プロンプトの読み取り専用参考記憶には、現在のデプロイの `@username` を含む自己身元説明が 1 文添えられます。メインスレッドはプロセス起動ごとに `bot.init()` の `getMe` で自身のアカウント情報を一度だけ取得し、`initAiChat` で AI Worker に注入します。Worker の再生成時はこの起動時スナップショットを再送し、メッセージごとの再取得は行いません。
  - 名簿内では Bot に固定番号 `me` が割り当てられ、一般メンバーはアカウント ID と表示名が保持されます。過去の逐語スナップショットの描画時にも同一の規則が適用されます。

- **Web 検索（Web Search）プロンプト仕様とデュアルモード切り替え**：
  - **共通のファクトチェック原則**：プロバイダ中立の固定指示を使用し、同一返信内のすべてのモデル呼び出しで完全に同一の system prompt を再利用します。リアルタイムに変動する情報や未確証の事実について検索ツールが登録されている場合は、「先ず検索し、しかる後にアクションする」順序を徹底します。主観的な会話、創作、トランスクリプト内に既に提示されている事実については検索を行いません。検索の結論は曖昧な記憶よりも優先され、ツールが利用不能または根拠不足の場合は不確実性を率直に表明し、検索の技術的プロセスをグループメンバーに明かしません。
  - **デュアルモード検索の実装**：
    - **組み込み検索（`agent.web_search` 未設定時）**：system prompt に `WEB_SEARCH_INSTRUCTION` を使用し、`text` モデルのサーバー側組み込み検索をマウントします。ソフト上限は `MAX_WEB_SEARCH_CALLS_PER_REPLY` で制限され、実際の呼び出し回数は `replyModel.ts` が集計します。上限を超過しても記録のみを行い、system prompt を動的に改変したり検索ツールをアンマウントしたりしません。
    - **独立関数検索（`agent.web_search` 設定時）**：system prompt に `WEB_SEARCH_FUNCTION_INSTRUCTION` を使用し、ローカル関数ツール `web_search` をマウントします。各ラウンドの初期化時に呼び出し上限（既定 `WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE`）を確定させ、関数呼び出しごとに 1 回分を消費して、上限超過後は直接拒否します。このツールは `aiChat/ai/tools/webSearch.ts` が非同期に実行し、検索能力を持つモデルで単一往復の調査を行って、「注記 + 結論 + 番号付き出典」を `WEB_SEARCH_RESULT_MAX_CHARS` 文字以内かつ出典 `WEB_SEARCH_MAX_SOURCES` 件以内に収めて返却します。入力パラメータ不正、タイムアウト、未検索、空の結果の場合は一律に「模型搜索失败」を返し、ハルシネーションを検索結論として扱うことを防止します。
  - **タイムゾーンの照合**：「今日」「最新」などの時間的表現を検証する際は、Web ページの公開日時ではなく、設定されたタイムゾーンの現在日時に基づいて事実の適用期日を確認します。
  - 検索（サーバー側またはローカル）が実行された場合、後続のリクエストには `grounded: true` が付与され、Gemini はハルシネーションを抑制するためにサンプリング温度を自動的に引き下げます。

- **入力ブロック（Blocks）の固定順序とプロンプトインジェクション防止**：
  - **厳格に順序付けられた 4 つの入力ブロック**：
    1. 【只読参考記憶】（安定グループ `stableBlocks`：背景情報、ペルソナ記憶）
    2. 【只読現在対話】（可変グループ `volatileBlocks`：階層別会話トランスクリプト）
    3. 【本輪実行時状態】（可変グループ：現在時刻、今日の気分、【本轮工具状态】）
    4. 【本輪返信タスク】（可変グループ：今回のトリガー要因と目標指示）
  - 直接メンション（@）によるトリガーであれランダム自発返信であれ、ブロック数と構造は恒常的に維持されます。直接メンションの場合は【本輪返信タスク】の先頭にメンション元の宣言文（`directInvokerSentence`）が 1 行追加されるのみで、Part の動的な増減やメンバーメッセージの重複複製は厳禁です。
  - **プロバイダアダプタ層のマッピング**：
    - Gemini：安定グループと可変グループを隣接する 2 つの `user Content` で保持し、各ブロックを 1 つの `text Part` に格納します。
    - OpenAI：単一の user message 配下に複数の `input_text` を配置します。
    - Anthropic：単一の user message 配下に複数の `text` ブロックを配置し、現在対話は確定切点で分割します。
  - **プロンプトインジェクション防御の境界**：データと指示の峻別、偽造境界の無効化、内部構造の非開示という共通防御規則は system prompt 内に 1 回だけ宣言し、各段落で重複させません。トランスクリプトデータ内に現れる同名のタグや状態宣言はすべて純粋な平文として扱われ、制御効果を持ちません。
  - **system prompt の厳格な逐字不変性**：system prompt は独立したシステムフィールド経由でのみ渡されます。動的な状態データ（時刻、気分、ツール状態）は user コンテンツ内の実行時状態ブロックに配置しなければならず、system prompt への混入は固く禁じられます。

- **Gemini 明示コンテキストキャッシュ（Explicit Context Cache）**：
  - **2 種類のリクエスト構造**：返信ラウンドの初回リクエストは、キャッシュの準備が整っていれば明示キャッシュ（`cachedContent`）を直接参照し、リクエスト本文は `contents` のみを含んで `systemInstruction`、`tools`、`toolConfig` は含めません。キャッシュが未準備の場合は完全な設定を送信します。2 回目以降の往復では静的な `systemInstruction` とツール構成を送信し、サーバー側の暗黙プレフィックスキャッシュが引き継ぎます。
  - **明示キャッシュの内容**：「system prompt + ツール宣言 + toolConfig」のみをキャッシュし、参考記憶、トランスクリプト、実行時状態は含めません。
  - **スロット管理**：system prompt のフィンガープリントごとにスロットを分割し、全グループが同一スロットを共有します。スロット数上限は `GEMINI_TEXT_CACHE_MAX_SLOTS` で、超過時は `lastUsedAt` に基づき最長未使用のスロットおよびサーバー側エントリを淘汰します。`displayName` の形式は `copy-ninjia:text:<スロット指紋>:<内容指紋>` です。
  - **非ブロッキング取得**：`acquireGeminiContextCache` の呼び出し時にキャッシュの作成完了を待つことはありません。初回利用時は完全な設定をそのまま送信し、バックグラウンドでスキャンと作成を開始します。キャッシュヒット時は `lastUsedAt` を更新し、残存寿命が `GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS` 未満であればバックグラウンドでフルの TTL へ静默に更新します。
  - **失敗バックオフ**：エンドポイントから 400 拒否が返された場合はフィンガープリントを記録してバックオフに入ります。拒否回数が `GEMINI_CONTEXT_CACHE_MAX_REJECTIONS` 回に達した後はその内容でのキャッシュ作成を断念し、全量リクエストへフォールバックします。

- **プロンプトキャッシュブレークポイント（Prompt Cache Breakpoints）**：
  - OpenAI プロトコルリクエストでは安定コンテンツを前方、動的コンテンツを後方に配置し、グループごとに分割された `prompt_cache_key` を付与します。公式エンドポイントかつモデル名が `OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX` で始まるモデルに限り、最後の安定ブロックの後に明示的な `prompt_cache_breakpoint` を配置します。
  - Anthropic セッションでは、system prompt 末尾、最後の安定ブロック末尾、現在対話の最後の確定セグメント末尾、およびリクエスト最上位の自動ブレークポイントの境界にキャッシュブレークポイントを配置します。

- **直接メンション時の読解順序と混同防止**：
  - system prompt 内の `DIRECT_INVOCATION_READING_INSTRUCTION` は、モデルの標準的な推論順序を規定します：
    1. まず【最热记忆】を通読し、グループ会話の背景と文脈の展開を把握します。
    2. 返信タスクに示されたメンション元の名簿番号に基づき、相手が具体的に何を述べたかを特定します。
    3. 文脈と相手の意図を踏まえて返信を構築します。
  - 混同防止ルール：メンバーの特定は名簿番号の背後にある `[id:]` のみに基づき、転送メッセージは転送者自身の陳述とはみなしません。過去の発言は文脈理解の参考に留め、1 件ずつ個別に返信してはいけません。

- **記憶階層メカニズムの沈黙原則**：
  - `MEMORY_MECHANISM_SILENCE_INSTRUCTION` は、モデルがグループ内で内部記憶メカニズム（【最热记忆】、【较早逐字记录】、【冷记忆】、【发言人名册】、【转发来源名册】などのセクション名、`me`/`uN`/`fN` の番号、`#メッセージ番号`、`[已滑出]`、スライディングウィンドウ、トークン、圧縮、コンテキスト、system prompt などの技術用語）に言及または示唆することを固く禁止します。
  - メンバーからの探りや記憶の仕組みに関する問いかけに対しても、肯定も否定もせず自然な日常会話の口調で受け流し、内部実装を決して露見させません。

- **コンパクトな階層別逐語トランスクリプト形式（`buildTieredVerbatimTranscript`）**：
  - **名簿 + 番号体系**：身元および転送元は末尾の【发言人名册】と【转发来源名册】に 1 回だけ集約提示し、逐語行内には番号のみを記載します（Bot は固定で `me`、メンバーは `u1`、`u2` など）。
  - 日付は日跨ぎまたは階層の境界でのみ 1 行の区切りを出力し、メッセージ行内には時分秒のみを残します。
  - `#メッセージ番号` は返信されたメッセージおよび今回のトリガーメッセージにのみ付与されます。返信先メッセージが現在のセグメント内にある場合は `（回复 #番号）` ポインタでモデルに元の行を参照させ、ウィンドウから流出した場合は `[已滑出]` 付きのインライン要約へフォールバックします。
  - **階層境界のアライメント**：【较早逐字记录】の長さは `TIER_BOUNDARY_ALIGNMENT` の整数倍へ切り上げられ、メッセージがその倍数に達するごとにのみ境界が移動します。これにより前回の逐語行が今回において純粋な追記となり、プレフィックスキャッシュヒット率を最大化します。
  - **確定切点（Settled Offsets）**：`TRANSCRIPT_SETTLED_SEGMENT_SIZE` をステップ数として安定した過去ログを分割し、切点は境界にあるメッセージ末尾にのみ配置され、ブロック単位でキャッシュを行う Anthropic 等のプロバイダで使用されます。
  - 同一の `message_id` がホット区間内に複数存在する場合（スナップショット復元と Telegram の再送など）、最新の 1 件のみを描画します。

- **単一ホップ返信とトランスクリプト整合性**：
  - トランスクリプトの外部でメンバーやメッセージを指定する際も名簿番号を踏襲し、存在しない番号を捏造してはいけません。
  - コンテキストは単一ホップの返信関係、転送元、Telegram の正確な引用断片のみを保持し、返信タスクにおいて独立した多層引用ツリーを再帰的に展開することはありません。

- **冷履歴の圧縮形式（`summarizeBatch`）**：
  - バッチ圧縮では自己完結形式（`formatBufferedMessageLine`）を使用し、各行に発言者を含めて名簿は使用しません。
  - 圧縮パイプラインの system prompt には不変の `SUMMARY_SYSTEM_PROMPT` を使用し、現在時刻は userContent の最末尾に追加されます。

- **自発アクション記号の実行側ハードインターセプト**：
  - グループチャットトランスクリプト内で Bot の振る舞いを記録する記号（`（发了一枚贴纸：…）`、`（…生成并发送了一张图片：…）`、`（发送了一条语音：…）` など）は `transcript.ts` テンプレートに由来し、**アクションが実際に送信完了した後にシステム実行側のみが追記書き込みを行います**。
  - これらの記号は「該当アクションが確かに発生した」唯一の証跡であり、モデルは入力として読み取ることはできても、モデル自身が生成するテキスト内に偽造することは固く禁じられます。
  - **実行側の防御**：
    - `send_message` エグゼキュータは、送信前に偽造アクション記号を含む本文をインターセプトし、モデルに再生成を求めます。
    - `generate_image` の `caption` も同一のインターセプトロジックを通過し、キャプションの検証はクールダウンの消費前に実行されます。
    - インターセプトの判定にはモジュールレベルのシングルトン正規表現 `SELF_ACTION_TAG_PATTERNS`（全角括弧で囲まれ `：` または `）` で終わるテンプレート構造を厳密に照合し、`g`/`y` フラグは付与しない）を用い、日常的な表現の誤検知を防止します。

### 参加認証と終端処置

- **検証終端の再試行と永続化保証**：
  - 単一プロセス内での検証終端操作は最大 `VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS` 回まで試行します。
  - 終端操作の完了後は、最終リビジョンの永続化レシート（durable ACK）を待ってからメモリ上の記録を消去します。待機中にリビジョンが進んだ場合は、試行上限に達していても新しいリビジョンを確認し、成功済みの終端処理を遅延させません。
  - 終端許可を得た副作用の一群が途中で reject した場合（Worker→メインスレッド要求の失敗など）、`retryRejectedTerminal` はエントリーが同じ終端オブジェクトを保持している限り Worker ローカルの実行ゲートを戻し、そのエントリーのバックオフ列で再試行を 1 回予約します（`kickPending` は `kickRetry`、`checkingInviter` と `expelling` は `terminalPersisted` を投げます）。エラーは通常どおりログに残し、状態が変わったエントリーには触れません。タイムアウトキックの処置レポートは `runTelegramAction` 経由で送るため、要求の reject は「未送信」として同じバックオフに乗ります。
  - メインスレッドが緊急私密モード（Lockdown）を復元する際は、記録消去前に公告 ID に基づくメッセージ削除を開始します。削除失敗時は Telegram ログにのみ記録し、復元のメインフローは削除の完了を待ちません。

- **タイムアウト検証における招待者身分の再確認（`checkingInviter`）**：
  - 認証タイムアウト後、`checkingInviter` 段階で `isChatAdmin` により招待者の身分を再確認します：
    - 管理者と確証できた場合：招待されたメンバーに免除を付与します。
    - 非管理者と確証できた場合：タイムアウト追放段階（`expelling`）へ移行します。
    - 身分を確証できなかった場合（ネットワークタイムアウトや照会失敗）：元の終端状態とディスクスナップショットを維持し、ローカルの実行占有を解除して既定の指数バックオフ後に再確認します。各試行はメインスレッドが承認した終端予算を消費します。

- **実行許可のライフサイクルと延期メカニズム**：
  - 終端の実行許可結果は、状態オブジェクト、世代（generation）、リビジョンが一致し、業務がキャンセルされていないタスクにのみ適用されます。
  - 許可申請が拒否（reject）、`stale`、または予算切れとなった場合、メモリ上の実行時状態をアンロードして正確な延期インデックスを送信し、リビジョンを進めずトゥームストーン（tombstone）も書きません。
  - メインスレッドはディスクスナップショットとプロセス単位の延期ラッチを保持します。Worker の再生成時もラッチはリセットされず、同一キーの新規イベントに対して認証を再作成しません。完全なプロセス再起動後にディスクから復元します。古いトークン、世代、リビジョン、キャンセル後のタスク結果は破棄されます。

- **バックオフタイマーと永続化コールバックの安全性**：
  - 重複して受信した永続化 ACK は、現在の終端のバックオフタイマーを追い越してはなりません。
  - タイマーコールバックの実行時は、エントリ、状態オブジェクト、現在のハンドルがすべて一致することを確認し、ハンドルをクリアした後に再試行をディスパッチします。再予約、置換、teardown 後の古いコールバックは動作しません。
  - `expelling.successNoticeSent` の正確な永続化レシートは、バックオフタイマーが存在していても直ちに記録を完了します。

- **Worker 実行時容量のハードキャップ**：
  - Anti-Raid Worker の実行時状態は、永続段階および `exempt` / `kicked` の重複排除記録を含め、`VERIFICATION_RUNTIME_CAPACITY` の容量上限で保護されます。
  - 新規キーによって容量上限に達した場合、グループ参加カウント、状態遷移、副作用の実行前に拒否し、現在の世代で致命的エラー（fatal）を 1 回報告するとともに、後続の新規参加を新世代の adopt または stop までロックします。既存キーの更新、検証解除、終端処理は継続します。
  - 新世代での adopt 時は旧実行状態を消去した後に永続ミラーを復元します。増分復元時に満杯となった場合は、永続責任を保護するために非永続の重複排除スロットのみを解放し、新規参加の拒否状態は維持します。
  - リビジョンテーブルもアクティブキーと保持期間内の終結キーに対して `VERIFICATION_REVISION_CAPACITY` の上限を適用します。新規キーで満杯になった場合は期限切れトゥームストーンを先に掃除し、それでも超過する場合はシステムを停止します。Worker 再構築時はアクティブおよび延期の記録のみを再生します。

- **参加認証と対レイド私密モードの統一スイッチ**：
  - 参加認証と対レイド私密モードはグループ単位のスイッチを共有し、既定で無効です。`ChatState.isAntiRaidEnabled === true` のときのみ認証ウィンドウと参加カウントが有効になります。
  - `isCanControllAntiRaidPermission` を持つ権限者（スーパー管理者は常に保持）が `/antiraid enable|disable` で切り替えて永続化します。
  - 両機能は同一の参加イベントストリームを共有します。同一の Anti-Raid Worker 上で動作する `/ad_detect`（広告検出）、`/flood_control`（連投ミュート）、永久ブロックリストの即時キック、`/batch_kick` が依存する参加ログは**本スイッチの影響を受けず**、それぞれ独立した境界を持ちます。
  - **メインスレッド入口での遮断**：対レイドが無効なグループでは `updateIngress.ts` で直接遮断し、Worker へ `join`、`left`、認証関連のメッセージやコールバックを送信しません。ただし**招待者管理者の変更（`adminsChanged`）は意図的に遮断しません**。低頻度のキャッシュ保守メッセージとして Worker 側の管理者キャッシュを更新するのみで、ステートマシンには触れないためです。ブロックリストの即時キックは対レイド無効時も通常通り送信されますが、**`joinedAt` を付与せず**、対レイドのスライディングウィンドウには参入させません。

- **対レイド無効化（`/antiraid disable`）の後処理**：
  - 核心的な意味論は「即座に停止し、すべての対話的な残骸を撤去する」ことです：
    - `deactivateJoinGuard` により、そのグループの全認証レコードをステートマシンの `guardDisabled` 遷移に通し、すべて ABSENT にリセットします。
    - Bot が送信済みの参加認証リマインダーとボタンを削除します（ボタンは無効化されており、グループ内に放置してはならないため）。参加アナウンスおよびメンバー自身のメッセージは削除せず、キック操作も行いません（保留中のタイムアウトキックや終端処理は一括して失効します）。
    - 永続化済みのキック待ちタスクにはディスパッチャがトゥームストーンを発行し、再起動後に adopt で復活してキックを実行することはありません。
    - 私密モード（Lockdown）に対しても同時に `deactivate` を送信します。未発効の `APPLYING` 段階はそのまま破棄し、それ以外の段階は `RESTORING` フローへ移行してグループ招待権限（`can_invite_users`）を返還し、封鎖告知を撤去して参加スライディングウィンドウをクリアします。
  - 管理者が明示的に無効化した場合、または `/init disable` を実行した場合にのみ Telegram API を呼び出してメッセージをクリーンアップします。Bot が管理者権限を喪失した場合やグループを退出した場合は、ローカルで緊急解体を行うのみで、権限のない削除 API は呼び出しません。
  - Worker が一時的に利用不能でクリーンアップに失敗した場合でも、スイッチは永続的に無効化され、残骸はプロセス起動または Worker 再生成時に `purgeDisabledJoinGuards` が完全に回収します。

- **連携チャンネルディスカッショングループのコメント免除**：
  - 連携チャンネルのディスカッショングループにおける直接コメントおよびスレッド内返信には同一の免除ロジックが適用されます。コメント関連付けキャッシュはメッセージ ID と観測時刻のみを記録します。
  - 対象は連携チャンネルのディスカッションスレッドに厳格に限定されます。フォーラムスーパーグループ（Topics）の通常トピックメッセージも `message_thread_id` を持ちますが、`is_topic_message !== true` によって除外され、通常の認証待ちロジックに従います。
  - コールドキャッシュ内の `message_thread_id` は非同期確認の候補にすぎません。照会結果が得られるまでは通常のメッセージとして扱い、`linked_chat_id` であることおよび状態世代の一致が確認された時点で検証責任を取り消します。照会失敗時は fail-closed とし、後続の再試行を許可します。

- **Worker 側管理者キャッシュのインフライト・世代管理**：
  - 管理者リストの非同期取得は `libs/keyedTask.ts` で集中的に重複排除され、`.finally()` では現在の Promise がテーブル内の自身の記録である場合にのみクリーンアップを実行します。
  - キャッシュをリセットするたび（`resetAdminCache()`）にテーブルの世代番号をインクリメントします。インフライトのリクエストが完了した際、世代番号が一致しなければ結果を現在の待機者に渡すのみで `cacheAdminIds` へは書き戻さず、失効した保留中の変更を破棄します。

- **認証ボタンの対話権限の独立性**：
  - **「我是良民」（本人認証）ボタン**：認証待ちの新人本人のクリックのみを受け付けます。Worker は発言者の自己申告ではなく、`callback_query.from.id === callback_data` の対象関係から厳格に本人性を検証します。
  - **「通过」（承認）ボタン**：そのグループの**非匿名管理者**が他人の代理で押した場合のみ受け付けます（人間と Bot は同一）。資格は Worker 側の管理者キャッシュ（`isChatAdmin`）で判定し、キャッシュミス時は `getChatAdministrators` を取得し、失敗時は「後ほど再試行してください」と応答して記録は変更しません。
  - **ホワイトリストとの完全な非相関**：ホワイトリストメンバーやスーパー管理者であっても、該当グループの管理者でなければ「通过」を押す権限はありません。また、認証対象者本人が「通过」を押しても必ず拒否されます。招待者免除も同様に非匿名管理者のみを認め、ホワイトリストメンバーによる招待は免除対象となりません。

- **終端キックとグループタイプの適合**：
  - `kickChatMember` を呼び出す前に、必ず `probeChatMembership` で現在のメンバー状態を確認します。在室を確認できた場合のみキックを実行し、既に退出していることが確認された場合は処置レポートを出さずに完了します。照会失敗時は終端状態を保持してバックオフ再試行に回します。
  - ボットに `can_restrict_members` がないと確定している場合（`botCanRestrictIn === false`）も在室照会は行い、キック要求だけを送りません。退出済みならその場で精算し、在室なら終端状態を保持してバックオフします。失敗通知が送信済みでクリーンアップも完了した `expelling` は、再試行ごとに照会を 1 回だけ送ります。
  - **初回リクエストも例外なく免除なし**：スーパーグループの「BAN せずキック」は `only_if_banned` を指定しない `unbanChatMember` に対応し、この呼び出しは**既存の BAN を解除します**。そのためメインスレッドは実行前に必ず `getChatMember` で在室を確認し、既に `left` または `kicked` であれば即座に中止します。明示的な解除操作は `only_if_banned: true` を伴うため、この制限を受けません。
  - **グループタイプの厳格な振り分け**：通常グループには `banChatMember`（通常グループでは退出のみ）、スーパーグループには `unbanChatMember` を使用します。グループタイプはメインスレッドが管理対象グループの update から監視・ミラーリングし、コールドスタート時はグループをキーに `getChat` を呼び出します（`VERIFICATION_CHAT_KIND_FETCH_MAX` で流量制限）。

- **私密モード即時キックと不可逆トークン（`kickPending`）**：
  - 即時キックはまず `kickPending` に入ります（状態スナップショットは先行して write-ahead 永続化され、再起動後もキック処理を続行可能；オブジェクト本体と `executionStarted` はメモリ内にのみ保持）。
  - 前段のクリーンアップが完了し、実際に `kickChatMember` を呼び出す直前に、メモリ内のエントリが同一の状態オブジェクトを保持していることを再確認します。この確認と API 呼び出しの間に `await` を挟んではなりません。途中で管理者免除、退出、新世代の参加によってオブジェクトが置換された場合、操作はこの確認で遮断されます。
  - Telegram リクエストが成功しトークンが一致した場合のみ、状態を `kicked` に遷移させて重複排除ウィンドウを開始します。
  - **参加カウント取り消しの対象**：実際に `recordJoin` が行われた物理的な参加記録（`joinCreatesNewRecord === true`）のみを対象とします。キック後に再申請されて再構築された記録には `countedJoinAt` が含まれず、取り消しには関与しません。
  - 管理者を誤ってキックした際の診断（`logUncancelableKickExemption`）は `logger.error` に出力し、手動復旧・調査のための唯一の証跡とします。

- **認証リマインダーの送信とメンバー発言の保護**：
  - 認証リマインダーはメンバーごとに 1 つの配信 owner が割り当てられます。`reminderMessageId` または `replyReminderMessageId` の送信成功がタイムアウトキックの前置条件です。1 度も送信できていない場合はウィンドウを延長して再送を試みるのみです。
  - 延長には絶対的な上限があります：参加から `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` を超えても送信できない場合は通常のタイムアウトとして処理します（キックのみで BAN は行いません）。
  - **メンバー自身の発言は削除対象外**：認証レコードは `trackedMessageTimes` にメンバーの参加ウィンドウ内のタイムスタンプのみを記録し、`ANTI_RAID_PER_MINUTE_LIMIT` を超えた場合は直ちに連投終端キックへ遷移します。処置時は Bot 自身が送信したリマインダーと告知のみを削除し、メンバー自身の通常発言を記録・削除することは決してありません（メッセージの抹消は `/block` および広告即時キックの経路に限定されます）。

### 連投ミュートと自身の権限キャッシュ

この節では、[カウントと実行の境界](#カウントと実行の境界)、[命中時の抑制と並行処理の安全性](#命中時の抑制と並行処理の安全性)、[実行前の権限ゲート](#実行前の権限ゲート)、[Bot 自身の権限ミラー](#bot-自身の権限ミラー)を順に説明します。

#### カウントと実行の境界

- **連投のカウントと実行は完全に Anti-Raid Worker が独立して担当**：
  - 機能はグループ単位で既定で無効であり、`ChatState.isFloodControlEnabled === true` の場合のみ有効です。`isCanControllFloodControlPermission` を持つ権限者が `/flood_control enable|disable` で切り替えて永続化し、無効化時は既存のウィンドウを消去します。
  - **スーパーグループのみが対象**：同一メンバーが 1 分以内に `FLOOD_MESSAGE_LIMIT` 件の発言に達した場合、直ちに `FLOOD_MUTE_DURATION_MS` のミュートを実行します（`restrictChatMember` は Telegram の仕様上スーパーグループでのみ有効）。
  - **メインスレッドでの同期フィルタリング**：候補オブジェクトを生成する前に、グループスイッチ、スーパーグループ種別、実ユーザーか否か、連投免除権限（`isCanBypassFloodControl`）を順に判定します。チャンネル名義および匿名管理者は実メンバー ID を持たないためカウントしません。ホワイトリストは既定で免除され、スーパー管理者は常に免除されます。門番を通過した後に通常の `post` で Worker へ送信します（update ループをブロックしません）。
  - ウィンドウ状態は Worker の `cache/workers/antiRaid/flood.ts` に保持され、上限は `FLOOD_WINDOW_MAX_MEMBERS` 件です。LRU 淘汰と定期クリーンアップが適用されます。ミュート解除は Telegram 側の `until_date` による自動復帰に依存し、Worker は復帰タイマーを持たず、ディスク永続化も行いません。

#### 命中時の抑制と並行処理の安全性

- **命中したその場で抑制フラグを設定**：
  - ルールに命中した瞬間にその場で抑制フラグを立て、ミュートのネットワーク通信完了を待ちません。
  - 確定的な結果（ミュート成功、対象が管理者、Bot に制限権限がない）は抑制フラグを**保持**し、無駄な再試行を回避します。一時的な障害（ネットワークエラーや身分未確認）は抑制フラグを 0 に**ロールバック**し、次の満杯ウィンドウでの再試行に備えます。
  - 各 `await` の後（権限確認やネットワーク通信など）に、状態オブジェクトの同一性検証によりエントリが管理下にあるか（`stillManaged`）を確認します。非同期待機中にグループの管理が停止されたり LRU で淘汰されていた場合は、処置全体を直ちに中止し、抑制フラグの書き戻しや告知を行いません。

#### 実行前の権限ゲート

- **実行前の二重権限チェック**：
  - ミュートを実行する前に、以下の 2 つのゲートを必ず通過しなければなりません：
    1. Bot 自身の `canRestrictMembers` 権限ビット；
    2. ホットキャッシュ（`freshAdminIds`、コールド時は現査）による、対象が**本グループの管理者ではない**ことの確証。
  - 三値判定ロジック（`true` = 管理者 / `false` = 管理者でないと確証 / `undefined` = 判定不能）：**対象の身分を確証できない場合は一切手を出しません**。Bot 自身の権限が `undefined`（未観測）の場合は、そのまま Telegram API に判定を委ねます。
  - ミュートリクエストは `muteChatMemberWithOutcome` が実行し、同様に三値を返します：`muted`（成功）、`forbidden`（拒否、抑制フラグを保持して再試行しない）、`failed`（レート制限やネットワーク障害、抑制フラグをロールバック）。
  - ミュートリクエストには `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` のタイムアウトが設定されます。グループ内通知はミュート成功後にのみ送信され、メインスレッド側で `COMMAND_MESSAGE_AUTO_DELETE_MS` のタイマーにより自動削除されます。すべてのインフライトタスクは `antiRaidDispatchSignal` 停止シグナルを購読します。

#### Bot 自身の権限ミラー

- **Bot 自身の権限ビットはメインスレッドが保持し Worker へミラーリング**：
  - 権限スナップショットは `ChatState.botPermissions` に永続化され、`packages/infra/botAdmin.ts` が集中的に管理します。
  - メインスレッドで権限の変更が観測された際（`my_chat_member` 更新の受信、または `getChatMember` による現査）にのみ、`botPermissionsChanged` により Worker へ配信されます。
  - **重複排除ポリシー**：永続化時は全権限フィールドを比較しますが、スレッド間配信では下流が実際に参照する `canRestrictMembers` と `canDeleteMessages` の 2 ビットのみを比較します。
  - 他者によってトリガーされた `chat_member` 更新からは「自分が管理者である」ことしか推測できず、具体的な権限ビットは推測できないため、不完全な権限記録を書き込んではなりません。
  - スナップショットが存在しないか矛盾がある場合は `getChatMember` による現査を 1 回実行します。**この現査にはバックオフゲート（`BOT_PERMISSION_PROBE_RETRY_MS`）を適用し、絶対に `await` してはなりません**（update の受信ループを遮断してはいけないため）。
  - ミラーから読み出された権限は三値（`true` / `false` / `undefined`）を維持し、二値の真偽値へ丸めてはなりません。すべての破壊的操作（キック、ミュート、削除）は権限が**確証された `false`** の場合にのみ短絡中止し、`undefined` の場合は通常通りリクエストを発行します。
  - 削除は複数の結果を返します（`deleteMessageWithOutcome`：`deleted` / `gone` / `forbidden` / `failed`）。`gone` は `deleted` と同様に痕跡が消えた扱いとし、管理者を名指しできるのは Telegram が実際に権限を拒否したときだけです。
  - Anti-Raid Worker は別途**グループ管理者**のキャッシュ（`workers/antiRaid/adminCache.ts`）を持ちますが、両者は記述している対象が異なり、共有も代替もしません。

### 識別子の解決と実行時のクリーンアップ

- **ユーザー名双方向キャッシュの整合性**：
  - 送信者キャッシュは「正規化 username → identity」と「sender ID → 現在の username」の双方向マッピングを同時に維持します。
  - 改名、username の削除、再紐付け、および LRU 容量淘汰は、同一の owner が双方向の関係性をアトミックに更新します。リゾルバは別名の衝突や不整合な記録を厳格に拒否します。
- **匿名管理者とグループ身分の取り扱い**：
  - 匿名管理者本人は管理者としての免除を享受しますが、特定の識別可能なアカウントに帰属できないため、管理者招待による継承免除を新規メンバーに与えることはできません。
  - 匿名管理者が現在のグループとして発言した場合、可視送信者の解決は `/copy` やアバター取得のためにそのグループ identity を保持します。ただし、破壊的な管理コマンドは現在のグループ identity をユーザー対象として受け付けることを拒否しなければなりません。
- **ユーザー ID 引数のサポート（`acceptUserId`）**：
  - `/block … enable` および `/block … disable` は、数字のみのユーザー ID（`USER_ID_ARG_PATTERN` に合致し、`Number.isSafeInteger` を満たすもの）の指定を個別に追加サポートします。
  - キャッシュに該当 ID が存在しない場合でも解決は失敗せず（`resolveIdTarget` は ID のみを含む最小限の identity オブジェクトに縮退して生成）、操作回執内のテキスト表示名にのみ影響します。
  - 単体の数字 ID 引数はコマンドごとの明示的なオプトイン（`acceptUserId`）であり、グローバルの既定動作ではありません。`/copy` や中国語アクションコマンドは単体の数字 ID を受け付けません。
  - **引数と返信先の衝突判定**：返信先メッセージとコマンドライン引数が同時に指定され、かつ両者が異なるユーザーを指している場合は、いずれかを黙って優先することなく明示的にエラーとして拒否しなければなりません。引数から対象を解決できない場合も同様に衝突エラーとして扱います。両者が同一ユーザーを指している場合は無害な重複とみなし、正常に通過させます。
- **会話 ID 引数のサポート（`acceptChatId`）**：
  - 負数のチャンネル/グループ ID（`CHAT_ID_ARG_PATTERN` に合致するもの）に対しては、独立した `acceptChatId` スイッチを設けています。
  - 負数の会話 ID を指定できるのは `/gag`、`/ungag`、`/block disable`、`/permission`、`/white`、`/translate`（翻訳停止対象の指定）、および `/info` に限られます：
    - `/gag` と `/ungag` は一時的かつ可逆的な発言抑制状態の開始・解除のみを担当します。
    - `/block disable` は復旧操作に属します。
    - `/permission` と `/white` はチャンネル身分を許容するホワイトリスト設定を管理します。
    - `/info` は読み取り専用の照会です。
    - それ以外のコマンドが負数の会話 ID を通常ユーザー対象として操作することは厳禁です。
  - チャンネル名義の ID もブロックリストの対象となります（チャンネルメッセージへの返信による `/block`、または広告検出が `sender_chat` に命中した場合など）：
    - `/block enable` は負数の会話 ID の入力を拒否しなければなりません。
    - `/block disable` は解除操作であるため負数の会話 ID を受け付けます。
  - **負数 ID の `isChannel` 属性付与**：`resolveIdTarget` が最小 identity を生成する際、符号に基づいて `isChannel` フラグを付与します。下流の `workers/antiRaid/blocklistEffects.ts` と同源でディスパッチされ、`/block disable` はこのフラグを参照して `unbanChatMemberIfBanned` ではなく `unbanChatSenderChat` を呼び出します。
- **`/gag` 禁言ステートマシンとメッセージライフサイクル**：
  - **権威セッション管理**：メインスレッドがグループごとの対象セッションリストを一元管理し、グローバル上限は `GAG_SESSION_MAX` 件です。同一グループ内の同一 identity は、`starting`、`active`、`ending` の全期間を通して単一のスロットを独占します。
  - **提示メッセージの送信フロー**：
    - すべての対象に対し、まずグループ内の公開提示メッセージを 1 件送信します。
    - 通常ユーザー：グループ内公開提示にはボタンを付けず、続いて `ephemeral_message_parameters.receiver_user_id` で限定された、対象本人のみに見える解除/発言ボタン付きの ephemeral 入口を送信します。
    - チャンネル身分：受信ユーザーが存在しないため、ボタン付きのグループ内公開提示のみを送信します。
    - 必要な全メッセージの送信が成功し、公開 `message_id` と検証済みの `ephemeral_message_id` を同期的に記録した後にのみ、セッションは `active` 状態へ遷移して `unref` タイマーを設置します。2 通目の送信に失敗した場合は、スロットを解放する前に着地済みの 1 通目の公開提示を削除しなければなりません。
  - **解除とリソース回収**：
    - タイムアウト、対象指定の `/ungag`、またはグループ runtime teardown によるクリーンアップ時は、まず同期的に `ending` 状態を確保してタイマーを解除し、対応する Telegram 削除 API を順次呼び出します。
    - すべての関連メッセージの削除結果が `deleted` または `gone` と確証され、必要な解除回執メッセージが確定した後にのみ、identity に基づいてスロットを解放します。
    - 削除で `failed` または `forbidden` が発生した場合は `ending` の所有権を維持し、有限回数の `unref` バックオフ再試行を実行します。再試行を使い切った後も後続の `/ungag`、teardown、またはシャットダウン時に再クリーンアップを試みます。旧セッションのクリーンアップが完了する前に、同一対象の新セッションが割り込んだり誤って新メッセージを削除したりしてはならず、未決債務の総量は `GAG_SESSION_MAX` で制限されます。
    - 開始メッセージは gag セッション自身が所有し、通常のコマンド提示メッセージの 30 秒自動削除キューには入れません。解除回執のみが統一されたコマンド削除境界を通ります。シャットダウン時、gag owner は Telegram 送信ゲートの前に排空（quiesce/drain）を完了しなければならず、クリーンアップの未完了は最終 offset の確定とインスタンスロックの解放を阻止します。
  - **発言提示入口の更新メカニズム**：
    - 更新は現在のセッション owner が一元的にスケジューリングします。`commands/gag/counter.ts` がグループメッセージ数を集計し、`GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` の閾値に達した時点でトリガーします。閾値未満、または既に更新タスク（`speakNoticeRefreshTask`）が処理中の場合は新たなタスクを作成しません。
    - `commands/gag/refresh.ts` が準備完了したセッションのタスクを取得して `gagBackgroundTasks` に登録します。各セッションは独立して開始され、出線の並行制御は Telegram 共通境界が担保します。最大 `GAG_SESSION_MAX` 件の更新タスクが並行して実行されます。
    - 通常ユーザーは有効化時および各更新完了後に、唯一の `speakNoticeRefreshTimer`（間隔 `GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS`、必ず `unref`）を設置します。チャンネルの公開入口にはこのタイマーを設置しません。タイマーはセッションが `active` かつ残り有効期間が更新間隔を超える場合にのみ設置され、更新開始、セッション終了、quiesce、テストリセット時に直ちに解除されます。
    - 更新手順：排他タスク内でまず破棄済み（`retired`）スロットを削除してから新入口を送信し、`onSent` コールバックで `pending` を同期記録します。コミットにより現在の入口とトピックを切り替え、カウントをリセットした後に旧入口を削除します。送信や旧入口削除が失敗した場合も ID を保持し、次の閾値到達またはタイマーで再試行します。
  - **沈黙後の発言による再送**：
    - `lastTargetMessageAt` はセッション有効化時に初期化され、以後は対象ユーザーが本グループで発言したときにのみ更新されます。
    - `refreshGagSpeakNoticeOnSpeech` は前回の発言時刻と比較し、ユーザーが `GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS` 以上沈黙した後に再び発言した場合、直ちに同一の更新タスクで再送をトリガーします。他者の発言や定期更新によって沈黙の起点が変更されることはありません。
    - 沈黙後の再送はタイマーをリセットします。沈黙閾値に達していない発言は発言時刻のみを更新し、タイマーはリセットしません。チャンネル入口はメッセージ件数の達成またはトピック移動時にのみ更新されます。
  - **Inline ルーティングの排他性と認証**：
    - gag とおみくじの inline クエリプロトコルは厳格に分離されています。`gag:` プレフィックスのない通常の `@bot` クエリは、クエリ実行ユーザーが gag 中であっても gag ロジックを完全にバイパスしておみくじ処理へ渡されます。
    - gag ボタンの事前入力フォーマットは厳格に `gag:<対象 Telegram ID> `（ユーザーは正数 ID、チャンネルは負数 ID）に固定されます。最初の空白より前はこの正準な安全整数のみを許容し、ハッシュダイジェスト、ランダムトークン、グループ ID 等の付加パラメータを付与してはなりません。`ParsedGagInlineQuery` にそのような scope フィールドを追加してはならず、`GagSession.chatId` はコマンド入口で確定した権威グループ ID のみを保持します。
    - `gag:` プレフィックスを持つクエリはすべて gag 入口で処理を完結させ、引数不正、セッション期限切れ、ユーザー身分不一致の場合は空の結果を返却し、決しておみくじへフォールバックさせてはなりません。
    - クエリ応答後に登録される元テキスト（`recordInlineResultSources`）は広告検出の照合用データにすぎず、身分の通過やグループ紐付けの根拠としては使用できません。メッセージがグループに着地した際、Bot 身分、プレフィックス、marker、アクティブセッション、送信者/グループ ID を厳格に検証します。
    - 正確な marker 形式は `<対象プロフィール>#<セッションチャット ID>` に固定され、公開検証ペイロードとして機能します。メッセージ着地後に不一致や別チャットの結果が検出された場合は直ちに削除して処理を終了します。
- **`/icon steal` アバター取得フォールバック**：
  - t.me プロフィール経由でアバターを取得する際は、**必ず `getChat(targetId)` でその場に問い合わせた username を採用しなければなりません**。呼び出し側のコンテキストが持つ username（返信コンテキストや身分キャッシュ由来）でこの照会を短絡してはならず、渡された値は診断ログのヒントとしてのみ使用します。
- **グループ Runtime Teardown（解体）規約**：
  - 各ドメインのクリーンアップコールバック（`copy`、`translate`、`gag`、`qa`、`wed`、`aiChat`、`antiRaid`、`joinLog`）は `packages/cache/main/chatTeardown.ts` が集中的に保持し、上位ドメインは末端モジュール `packages/infra/chatTeardownRegistry.ts` を通じて逆向きに登録します。`packages/infra/chatTeardown.ts` は統合的な呼び出しのみを担当し、個別の業務モジュールへの静的依存を禁じます。
  - **解体理由とデータ保持の判定（`ChatTeardownReason`）**：
    - `explicitDisable`（手動での `/init disable`）および `departed`（Bot がグループから除外された場合）：管理の完全停止を意味し、該当グループの `/wed` メンバー集合、入室ログ、問答データベース、および `chat_states` レコードを完全に削除しなければなりません。
    - `lostAuthority`（グループに在室したまま管理者権限のみ剥奪された場合）：実行時状態を停止するのみで、永続化データはすべて保持し、権限復帰後に即座に再開できるようにします。
    - 各ドメインは必ず `packages/libs/chatTeardown.ts` の `purgesChatData` 共通ユーティリティを介して判定しなければならず、独自に reason 文字列を比較してはなりません。
    - 例外：AI 記憶はいかなる teardown 理由でも削除されます。参加認証等の残留ボタンメッセージは `explicitDisable` のときのみ API で削除し、`departed` 時は Bot が既に退出しているため Telegram リクエストを発行しません。
  - **厳格な順序による同期的ディスパッチ**：`teardownChatRuntime` は `packages/consts/chatTeardown.ts` の `CHAT_TEARDOWN_ORDER`（型システムにより `ChatRuntimeOwner` を網羅）を順次走査します。teardown はこの順序で全 owner のクリーンアップを同期的に開始してから、非同期の完了をまとめて待機します。
- **メンバー在室再確認の境界**：
  - 非同期照会 `probeChatMembership` が在室を返してから実際に `kickChatMember` を呼び出す直前に、メモリ内の終端状態オブジェクトの参照が変化していないことを再確認しなければなりません。この確認ステップと API 呼び出しの間に `await` を挟んではなりません。
- **`/block` 跨グループ BAN の結果キャッシュ禁止**：
  - `/block` を実行するたび、管理対象グループのリスト全体へ `banChatMember` を再送しなければなりません（Telegram の `revoke_messages` による過去メッセージ撤回をトリガーするため）。権限スナップショットで `canRestrictMembers` の欠如が確証されたグループでのみリクエストをスキップして失敗計上します。`/block disable` も同様にコマンド側の BAN 結果キャッシュを持ちません。

### `/wed` のメンバー永続化と操作

- **日次メンバー再確認メカニズム**：
  - 再確認フローは Disk I/O Worker 固有の Bun ネイティブ cron が、設定タイムゾーンの 00:00 に発行する `midnightMaintenance` 通知によってのみトリガーされ、メインスレッドに独立した cron は作成しません。
  - `commands/wed/memberReview.ts` は、アクティブなセッションのないグループも含め、復元済みのすべての管理対象グループを直列に走査し、1 グループあたり最大 `WED_MEMBER_LIMIT` 件の ID スナップショットを抽出します。
  - グループをまたぐ照会は最低 `WED_MEMBER_REVIEW_INTERVAL_MS` の間隔を共有し、単一照会のタイムアウト予算は `WED_OPERATION_TIMEOUT_MS` です。
  - Telegram が退出済みを明確に返却した場合、または 400 `PARTICIPANT_ID_INVALID` を返却した場合にのみ `removeWedMember` を呼び出してメンバーを除外・ダーティマークを付与します（API エラーとしては記録しません）。一時的なネットワーク障害ではメンバーを保持します。走査期間中に該当ユーザーの発言、在室を示す `chat_member`、または入室サービスメッセージを観測した場合は、遅延した退出判定を否決できます。
  - Bot が管理者でないグループでは `getChatMember` が権限不足（403 または 400 `CHAT_ADMIN_REQUIRED`）で拒否されるため、エラーを 1 行記録して該当グループの検査を直ちに終了し、既存メンバーを全員保持します。**管理者権限のないグループにおいて、退室済みのメンバーが抽選されるのは仕様上の想定動作です**。
- **権限と受付ゲート**：
  - `/wed` コマンドおよびコールバックは統一された `/init` ゲートの背後に配置されます。新規メンバーの追加には `isInitEnabled === true` が必要です。初期化されていないグループで退出イベントが発生した場合は既存集合から ID を削除するのみで、グループ状態の作成や業務ハンドラの実行は行いません。
- **キャッシュと永続化アーキテクチャ**：
  - **メンバー権威キャッシュ**：`packages/cache/main/wedMembers.ts` が各グループで単一の長期 `Set<number>` を再利用し、上限は `WED_MEMBER_LIMIT` 件です。満杯時は新規 ID を拒否し、退出により空きができた時点で追加を再開します。チャンネル名義、返信/転送元、匿名身分からの発言は候補に追加しません。
  - **対話セッションキャッシュ**：`packages/cache/main/wed.ts` が対話状態とアバター照会を管理し、1 人 1 グループにつき 1 セッション、1 グループあたり最大 `WED_SESSION_LIMIT` 件のセッションを保持します。グループリストは `STATE_MANAGED_CHAT_LIMIT` で制約され、LRU 淘汰は行いません。
  - **ディスクフラッシュ方針**：実際にメンバーの追加・削除が発生した場合にのみリビジョンをインクリメントしてダーティマークを付与します。Disk I/O の `FLUSH_MAX_ENTRIES` および `FLUSH_INTERVAL_MS` 閾値を流用し、一時ファイル、fsync、およびアトミック rename を経由して `memory/wed/<chatId>.json` を書き換えます。
  - **グループ全削除の保証**：`purgeWedMembers` がメモリ上の集合を削除した後、`pendingWedMemberDeletes` に単調増加する番号を登録して Worker へ投函します。正確な永続化確認を受け取った後にのみ保留中のタスクを解放します。シャットダウンまたは再構築時は最新状態を再送します。
- **起動時読み取り専用ゲート**：
  - 起動時に `memory/wed/` 配下のすべてのファイル名（正規化された負の整数グループ ID）、ユーザー ID（正の安全な整数）、単一グループ上限、および総グループ数を厳格に検証します。不正なデータが 1 つでも存在する場合は起動を直ちに拒否し、原本ファイルを保護します。存在しないファイルは記録なしとみなし、必要に応じて新規作成します。
- **抽選とアバター取得フロー**：
  - 候補者の情報源は `memory/wed` の ID 集合のみです。抽選後は `readCurrentAvatar` によりアバターを取得し（`getChat` のプライベートプロフィールを流用）、Bot に管理者権限は不要です。
  - `getChat` が 400 `Bad Request: chat not found` を返した場合、該当 ID を管理対象の全グループの候補プールから完全に除外します。
  - 抽選エグゼキュータは `createPrioritizedBoundedTaskRunner` を再利用し、グローバルの `WED_MAX_CONCURRENT` 実行枠と `WED_MAX_PENDING` FIFO 待機キューを共有します。
  - **結果送信と差し替え**：`commands/wed/messages.ts` の `sendWedResult` が唯一の画像送信境界であり、結果画像は長期保持され、30 秒の自動削除は適用されません。引き直し時は、新しい結果画像が正常に送信された後にのみ古い画像を削除します。送信に失敗した場合は古い画像とセッション状態を維持します。Bot がグループから退出済み（`departed`）の場合、引き直し中のセッションの後始末では新旧どちらの結果にも削除リクエストを送りません。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

### `/info` プロフィール照会

- **引数解析と予算**：
  - `commands/info.ts` は `acceptUserId`、`acceptChatId`、および `allowSelfTarget`（Bot 自身の照会を許可。他のコマンドは既定で拒否）を有効化して対象を解決します。
  - 遅延コマンドエグゼキュータの `interactive` 枠にタスクを投入し、照会全体は `INFO_TASK_BUDGET_MS` の予算内に収めます。タイムアウト時は取得済みの情報で応答し、シャットダウン時は静かに終了します。
- **プロフィールとアバターの取得**：
  - ユーザー対象は `readChatMemberUser`（本グループでの身分）を優先し、チャンネル/グループは `getChat`、Bot 自身は `ctx.me` を使用します。いずれも取得できない場合はキャッシュ情報にフォールバックします。
  - 表示名は `sanitizeDisplayName` で双方向制御文字を無害化し、ID は `code` エンティティで表示します。アバターは `readCurrentAvatar` を再利用します（グループ身分にはアバターがありません）。
- **回執送信ルール**：
  - アバター付き回執は `infra/telegram/commandPhotos.ts` の `sendCommandPhoto` を通じて送信され、グループ内では 30 秒で自動削除され、プライベートチャットでは削除しません。画像送信が失敗した場合は `sendCommandMessage` によるプレーンテキスト回執へ自動降格します。

### `/h_image` ランダム画像

- **画像ディレクトリ検証とホットリロード**：
  - 画像ディレクトリのパスは `config/dynamic/assets.json` の `onlyPath.random_h_image_dir`（既定 `./h_image`）から取得します。
  - 起動段階において、外部接続の確立前に `infra/randomImage.ts` の `ensureRandomImageDirectory` でディレクトリの妥当性を事前検証します：存在し、読み書き可能でなければなりません。サブディレクトリ、シンボリックリンクファイル、隠しファイル、または 64 文字の小文字 SHA-256 形式でないファイル名が存在する場合は起動を直ちに拒否します。
  - ホットリロードでディレクトリを変更する際も同一の厳格な検証を実施し、新ディレクトリが不適合の場合は変更を拒否して元のディレクトリを維持します。稼働中にディレクトリが削除されても自動再作成は行いません。
- **画像抽選アルゴリズム（`pickRandomImage`）**：
  - 毎回ディレクトリを再スキャンし（ファイルリストは常駐キャッシュしない）、対応拡張子かつ `RANDOM_IMAGE_MAX_BYTES` 以下の通常ファイルのみを一様ランダムに抽出します。
  - 抽出したファイルが上限を超過しているか、読み込み前に削除・変更されていた場合は、候補リストから除外して残りの候補から再抽出します。送信可能なファイルが存在せず、上限超過ファイルを引いていた場合は `tooLarge`、候補が空の場合は `empty` を返します。
- **レート制限と遅延タスクスケジューリング**：
  - `/h_image` と `/h_image add` は単一のグローバルスライディングウィンドウ枠を共有します（`H_IMAGE_RATE_LIMIT_WINDOW_MS` 内に最大 `H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` 回）。超過した呼び出しはキューイングも返答もせず静默に破棄します。
  - コマンド解析後に遅延コマンドエグゼキュータ（`commands/deferredCommands.ts`）へ投入します：
    - 抽選は `interactive` 優先度；
    - 追加（add）、`/batch_kick`、および `/block` の fan-out は `background` 優先度。
    - キュー満杯時は混雑案内を即座に返し、シャットダウン時は Telegram 総ゲートの前で排空します。
- **画像送信境界とアルバム収集（add）**：
  - `commands/hImage/draw.ts` の `sendHImageResult` が画像送信の唯一の境界です。結果画像は長期保持の例外であり、30 秒の自動削除は適用されず、フォーラムグループではトリガーメッセージのトピックを付与して返信します。各種案内は 30 秒で自動削除されます。
  - `/h_image add` は `isCanAddHImage` 権限を要求します。候補画像は返信先メッセージおよびメインスレッドのアルバムキャッシュ（`mediaGroups.ts`）内の同一 `media_group_id` の画像から取得されます。
  - ダウンロードは `H_IMAGE_ADD_TASK_BUDGET_MS` の予算内で `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE` 枚ずつページングして並行取得します。SHA-256 を算出して UUIDv7 一時ファイルに書き込んだ後、アトミック rename で永続化します。同一ハッシュのファイルが既に存在する場合はスキップし、重複を排除します。

### `cron.json` 定時タスク

- **設定解析とソースファイル検証**（`packages/config/cron.ts`）：
  - ファイルが存在しない場合は定時タスクなしとみなします。1 箇所でも不正なフィールドがあれば全体を拒否し、診断にはファイルパス、フィールドパス、期待される形態のみを出力します。
  - `parseCronConfig` は構文・形態・値の検証のみを行い、ディスク I/O は行いません。`loadCronConfig` は読み込み後にローカルファイルが実在し型が適合していることを確認します（シンボリックリンクを追跡）：固定画像やファイルの `path` は通常ファイル、ランダム画像ディレクトリは実ディレクトリでなければなりません。
  - **タスクテーブル仕様**：
    - トップレベルは配列でなければなりません。タスク総数上限 `CRON_MAX_TASKS`、タスクごとの動作数上限 `CRON_MAX_ACTIONS_PER_TASK`、タスク名の長さ上限 `CRON_TASK_NAME_MAX_CHARS`（超過時は切り詰めず即座に拒否）。
    - タスク名は前後の空白を除去した後に非空かつ全テーブル内で一意でなければなりません。未宣言の未知キーは厳格に拒否します。
    - 動作の `type` は `send_message`、`send_image`、`send_file`、`send_voice`、`send_web_digest` のみ許可されます。`just_once`、`rand_image`、`is_blurred` はブール値のみを受け付けます。
  - **ペイロードとタイムゾーン規約**：
    - `payload.path` は絶対パスまたは実行時データルート（`RUNTIME_DATA_ROOT`）からの相対パスを受け付けます。前後の空白を除去した後に空文字列や NUL 文字を拒否し、解析時に絶対パスへ正規化します。
    - `time_zone` は省略時に起動時タイムゾーンを使用し、明示された不正値（`null` を含む）は即座に拒否します（IANA 標準名、カレンダーと Bun cron の双方がサポートするものを `parseTimeZone` で検証）。
    - `cron` 式は `Bun.cron.parse` により該当タイムゾーンで解析され、将来の発火時刻が存在しない式も拒否されます。
    - `rand_cron` は任意で、`"<min>-<max>"` または単一値（下限 `CRON_RANDOM_INTERVAL_MIN_MS` 起点）の形式を受け付け、単位は `m` / `h` / `d`、`CRON_RANDOM_INTERVAL_MIN_MS` から `CRON_RANDOM_INTERVAL_MAX_MS` の範囲内で min ≤ max でなければなりません。`just_once: true` のときは設定を禁止します。
  - **各動作のフィールド制約**：
    - `send_message`：前後の空白を除去した `content` が非空で、`TELEGRAM_MESSAGE_MAX_CHARS` 以下。
    - `send_image` と `send_file`：`content`（キャプション）は任意で、`TELEGRAM_CAPTION_MAX_CHARS` 以下。`send_file` の送信元は `url`（絶対 HTTP/HTTPS アドレス）または `path` のいずれか 1 つ。固定画像は 1〜`CRON_MAX_IMAGES` 項目を受け付け、1 枚なら `sendPhoto`、複数枚なら `sendMediaGroup`（キャプションは先頭のみ付与）を呼び出します。ランダム画像モードは 1 枚に限定されます。
    - `send_voice`：`content` は必須、`tone` は任意。前後の空白を除去した後にそれぞれ `VOICE_OPERATOR_TEXT_MAX_CHARS`、`VOICE_TONE_MAX_CHARS` 以下であり、単一行に整形した後に非空であること。
    - `send_web_digest`：`topic` は必須で単一行かつ `WEB_DIGEST_TOPIC_MAX_CHARS` 以下。`language` は任意（`zh` / `ja` / `en`、既定 `zh`）、`max_items` は任意の整数（`WEB_DIGEST_MIN_ITEMS`〜`WEB_DIGEST_MAX_ITEMS`、既定 `WEB_DIGEST_DEFAULT_MAX_ITEMS`）、`instructions` は任意で `WEB_DIGEST_INSTRUCTIONS_MAX_CHARS` 以下。
  - **依存関係とグループリスト**：
    - タスクが `send_voice` を使用する場合は `agent.tts` が必須であり、`send_web_digest` を使用する場合は会話コア能力が必須です。`assertCronAgentSupported` が起動総ゲートおよびホットリロード時に厳格に照合します。
    - `chat_id` は非空配列でなければなりません：単一要素 `["all"]`（`CRON_ALL_CHATS`）、除外指定 `["except", <id>, ...]`（`CRON_EXCEPT_CHATS`）、または明示的に列挙された安全な整数 ID リスト（重複不可、最大 `CRON_MAX_CHAT_IDS_PER_TASK` 件）。スカラー表記は拒否します。
- **ホットリロードとスケジューリングの照合**：
  - スケジューラは起動段階で `startConfigReload` より前に開始されます。ホットリロードは全体適用または全体拒否の不可分な処理であり、設定不正時は直前のタスクテーブルを維持します。設定ファイルが削除された場合は空のタスクテーブルへ切り替えます。
  - スケジューラはメインスレッドの `packages/cron/scheduler.ts` に配置され、状態は `cache/main/cron.ts` に保持されます。各タスクに Bun ネイティブのプロセス内 cron（タスクのタイムゾーン、`unref`）を 1 つ割り当てます。
  - 実行ハンドラはすべての内部例外を捕捉し、未処理の rejection によるクラッシュを防止します。同一タスクは先行動作が未完了の間は重複してスケジューリングされません。
  - **照合ルール**：深い等価性を持つタスクは既存のスケジュールハンドルを維持します。変更または削除されたタスクは停止・取り消しされ（実行中の要求は現在の動作または再試行の完了後に終了）、新規タスクは独立して登録されます。
  - `just_once` は初回の発火後に即座に登録解除され、記録は上限 `CRON_JUST_ONCE_RECORD_MAX` 件の LRU キャッシュに保持されます。周期タスクへ変更された場合は記録を削除します。
  - `rand_cron` は初回発火後に元の cron を停止し、ランダム区間内で一様ランダムに次回時刻を抽出して分単位に切り上げ、単発の UTC cron を再登録します。記録やランダム時刻は永続化されず、停止期間中に逃したスケジュールは補填しません。
- **配信と実行スケジュール**（`packages/cron/run.ts` および `packages/cron/delivery.ts`）：
  - 動作間は `CRON_ACTION_GAP_MS` の間隔を維持します。ネットワークエラー、5xx、429、出線キュー満杯時は `CRON_ACTION_RETRY_DELAYS_MS` の間隔でバックオフ再試行します。
  - 音声合成や検索のエラーはバックオフ再試行をサポートしますが、TTS 未設定、1 日の上限到達、エンコード不正、ダイジェストの出典欠落や長さ超過などの不可逆エラーは再試行しません。最終失敗時はエラーログを記録して該当ラウンドの残りの動作を中止します。
  - **ラウンド内リソースの再利用**：
    - 同一ラウンド内で `CronRoundVoices` を新規作成し、同一の `send_voice` 動作は 1 回のみ合成して全グループおよび再試行で音声を再利用します。初回成功時に Telegram の `file_id` を記録し、以後は再アップロードせずその ID を参照します。
    - 同一ラウンド内で `CronRoundDigests` を新規作成し、`send_web_digest` の成功後はレンダリング済みの MarkdownV2 原文をキャッシュして全グループで再利用します。生成失敗時はキャッシュしません。
  - **全グループブロードキャスト（`all` / `except`）の安全確認**：
    - `packages/cron/targets.ts` がメインスレッドの `chat_states` 内の `/init` 有効かつ除外されていない全グループを走査し、チャット ID 昇順で `getChatMember` および `getChat` により対応メディアの送信権限（`can_send_messages`、`can_send_photos`、`can_send_documents`、`can_send_voice_notes`）をその場で確認します。権限不足または照会失敗のグループは丸ごとスキップし、ラウンド末尾にログを記録します。
  - **メッセージ送信境界と留存**：
    - `delivery.ts` が唯一の送信境界であり、メインスレッドの出線スケジューラを経由し、フォーラムトピックは付与せず（General トピックに着地）、成功時に自発メッセージとして登録します。
    - 定時タスクメッセージは長期保持の例外であり、30 秒の自動削除は適用されません。
    - ローカルファイルはアップロード前にサイズ上限（`TELEGRAM_PHOTO_UPLOAD_MAX_BYTES`、`TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES`）を確認し、ストリーム読み込みはシリアライズごとに再オープンして、429 再試行時に消費済みストリームを渡さないようにします。
- **AI 要約生成（`send_web_digest`）**：
  - AI Worker 内の `aiChat/ai/webDigest.ts` で実行されます。検索は `agent.web_search` モデルを優先し、未設定時は `text` モデルの組み込み検索にフォールバックします。
  - 呼び出しエンドポイントで検索が実行されず（`searchCalls === 0`）本文が存在する場合、モデルキャッシュ警告を付与して MarkdownV2 にエスケープして送信します。検索が実行された場合は、出典メタデータおよび HTTPS リンクをホワイトリスト化し、未確認の外部リンクの捏造を防止します。
  - 記事の組み立ては `text` モデルで構造化 JSON を出力し、`libs/webDigest.ts` で厳格にデコードして文字数上限を検証します。フォーマットが不合格の場合は診断付きで 1 回のみ再試行します（`WEB_DIGEST_COMPOSE_ATTEMPTS`）。
  - メインスレッドが単一の要約生成を待機する総期限は `WEB_DIGEST_REQUEST_TIMEOUT_MS` です。シャットダウン時は実行中リクエストを取り消し、スケジューラは Telegram ゲートの閉鎖前に drain を完了します。

### 返信と response body のリソース境界

- **有界読み取りとメモリ管理**：
  - `libs/boundedResponse.ts` はストリーミング応答の受信時、チャンクごとに累積バイト数を検証し、空チャンクをスキップします。
  - チャンク参照数が予算を超過した場合は `Bun.ArrayBufferSink` で集約し、成功結果がメモリを独占的に確保できるようにします。上限超過、ネットワーク中断、またはキャンセル時は統一して中止処理を行いリソースを解放します。アバター取得で HTTP 非 2xx 応答を受信した際は未消費のレスポンスボディを明示的にキャンセルします。
- **AI 雑談の並行数と送信容量制御**：
  - ツールコンテキストのライフサイクルはメッセージの最終送信およびリソース後処理完了まで維持されます。
  - 同一グループ上限 `REPLY_DELIVERY_MAX_PER_CHAT`、Worker 全体上限 `REPLY_DELIVERY_MAX_TOTAL` は、生存中の全世代を統一してカバーし、ウィンドウ間の閉塞や異常な滞留を防止します。

## 永続化

- **永続化入力の厳格な検証と祖先パスの確認**：
  - `libs/fileAccess.ts` の `inspectOptionalDirectory` および `inspectOptionalFile` は、ファイルやディレクトリが欠落している場合、その祖先パス全体を再帰的に検証します。リンク切れ、循環シンボリックリンク、ディレクトリがファイルパスを占有している状態、`ENOTDIR`、`EACCES` を検出した場合は直ちに起動を拒否します。
  - ドメインディレクトリには有効なシンボリックリンクを許可しますが、通常の永続化データファイルにシンボリックリンクを使用することは厳格に禁止されます（`memory/global/state.json` は固有のリンク規約を維持します）。
  - 起動段階において、身分データベース、検証、ログ、運勢、AI メモリ、メンバーファイルなど全ドメインに対して読み取り専用の inspect を実施します。いずれか 1 つのドメインでも検証に失敗した場合、状態の公開、秘密鍵の生成、クリーンアップの実行は一切行わず、ディスク上の既存データをそのまま保持します。

### 永続化と snapshot の contract

- **身分フィールドの原文通りの永続化**：
  - 復唱および翻訳の対象身分フィールド（`username`、`first_name`、`last_name`、`title`）は、Telegram から受信した内容のまま保存・読み込みを行います。前後の空白を自動除去せず、空文字列や空白のみの文字列も有効な値として扱います。存在するフィールドが文字列型でない場合は、デコード処理で厳格に拒否します。未知のフィールドは固定のプレースホルダーで表現し、ログ秘匿化の際に機密キー名を出力しません。
- **グローバル状態 `memory/global/state.json`**：
  - 最新値のマージ、一時ファイル、fsync、およびアトミック rename を経由して書き込みます。トップレベルには `copy`（必須）と `ttsUsage`（任意）のみを保持し、冗長なバックアップファイルは作成しません。
  - 起動段階の `loadCurrentGlobalState` は、データルート直下に旧形式の `state.json` または `state.json.bak` が存在しないかを最初に確認し、存在する場合は起動を直ちに拒否します（`assertLegacyStateFilesAbsent`）。続いて現行スキーマで厳格にデコードし、検証に失敗した場合も同様に起動を阻止します。
  - copy 対象の変更は、該当 revision のディスク書き込みが確認されるまで、ミドルウェアおよび呼び出し元へ成功を返しません。
- **音声利用枠 `ttsUsage` のスレッド帰属と永続化**：
  - `memory/global/state.json` 内の `ttsUsage`（音声合成の日次カウント）の権威状態は AI Worker（`cache/workers/aiChat/ttsUsage.ts`）に帰属します。メインスレッドの `cache/main/storage.ts` にある `globalTtsUsageState` は永続化用のミラーにすぎません。
  - AI Worker が利用枠を更新するたび、`ttsUsage` イベントによって全量カウント（`{ windowStartedAt, agentCount, reserveCount }`。両者が 0 にリセットされた場合は未利用を表す `null`）を返送します。メインスレッドはミラーを差し替え、`StateStore` を通じてバックグラウンドで遅延書き出し（`STATE_BACKGROUND_SAVE_DELAY_MS`）を行います。停止時や強制フラッシュ時には即座にディスクへ書き出します。
  - AI 音声ツール受付時の進行中予約（`pendingAiTtsReservations`）は AI Worker のメモリ上のみに存在し、返送も永続化も行いません。Worker 再構築時は 0 から再開します。
  - カウントウィンドウは `windowStartedAt` 起点で `TTS_USAGE_WINDOW_MS` の期間継続します。大幅な時計の巻き戻しによりウィンドウ開始時刻が現在時刻より未来となった場合は、ウィンドウ終了とみなして新規にウィンドウを開始します。設定上限が引き下げられた際、過去のカウントは書き戻さず、新上限を超過する新規リクエストのみを拒否します。
- **翻訳セッション（`ChatState.translate`）の状態管理**：
  - 翻訳セッションは `ChatState.translate` フィールドとしてグループ状態とともに SQLite の `chat_states` に保存され、メインスレッドがホットリード用コピーを保持し、`STATE_MANAGED_CHAT_LIMIT` の容量制約を共有します。
  - グループごとに最大 `TRANSLATE_CHAT_USER_LIMIT` 件の異なる身分と対応言語（`ja|cn|en|uk|ru`）を保持し、セッションが存在しない場合は `undefined` となります。`memory/global/state.json` 内に `translate` フィールドが存在した場合は起動を拒否します。
  - 翻訳メッセージは `translate/message.ts` によりグループごとに直列の非同期チェーンで送信され、update ミドルウェアをブロックしません。グループごとのキュー上限は `TRANSLATE_CHAT_BACKLOG_MAX` であり、満杯時は新規メッセージの翻訳を破棄してログを記録します。セッションの開始・停止は、`persistChatState` による厳密な永続化確認を受け取った後にのみ成功を返します。
- **状態ファイルの読み取り境界**：
  - `memory/global/state.json` は通常ファイルまたは通常ファイルへの有効なシンボリックリンクでなければなりません。ディレクトリ、壊れたリンク、または `EACCES`/`ELOOP`/`ENOTDIR` などのアクセス権限エラーに遭遇した場合は直ちに起動を拒否します。`lstat` が `ENOENT` を返した場合にのみ未設定（ファイル不在）として扱います。
  - 読み取り時は fatal モードの `TextDecoder` で UTF-8 を厳格にデコードし、BOM を除去します。デコードやスキーマ検証に失敗した場合は原本ファイルを保護します。
- **素材設定 `config/dynamic/assets.json`**：
  - トップレベルは厳格に 3 グループに分かれます：`onlyPath`（ランダム画像ディレクトリ `random_h_image_dir`）、`pathOrUrl`（Bot の既定アバター `bot_default_avatar`）、`onlyUrl`（インライン運勢および gag サムネイルの直リンク）。
  - フィールドの欠落はコード内の定数（`consts/ui/assets.ts`）へ一律にフォールバックし、前回の実行状態を引き継ぐことはありません。Bot がこのファイルを書き換えることはなく、未知のグループや未宣言フィールドが存在した場合はファイル全体を拒否します。
  - サムネイルは Telegram クライアントがダウンロードするため `https` のみを許可します。ローカルで取得する既定アバターは平文 `http` またはローカルファイルパス（絶対パス、または `./` / `../` で始まる相対パス）を許可します。ローカルのアバターファイルは `AVATAR_MAX_DOWNLOAD_BYTES` 以下であり、かつ正当な JPEG/PNG バイトシグネチャを備えていなければなりません。
- **統一ログ秘匿化（Redaction）境界**：
  - journal、Worker エンベロープ、または `logs/` への出力前に、読み込み済み設定に含まれるすべての機密資格情報（トークン、API キー、秘密鍵、Google プロバイダのヘッダー値など）を自動的に秘匿化します。
  - ログ内の HTTP(S) URL は `origin + pathname` のみに正規化し、クエリパラメータ、フラグメント、userinfo を除去します。
  - エラーオブジェクトは `cause` や `AggregateError` を最大深度 `LOGGER_NESTED_ERROR_MAX_DEPTH` まで展開します。引数のシリアライズ上限は `LOGGER_MAX_SERIALIZED_BYTES` であり、循環参照は静的プレースホルダーで置き換えます。
- **グループ状態の正準形状と Normalizer**：
  - `normalizeChatState` は真に期限切れとなったフィールドのみを回収します：`quietUntil` は `QUIET_CLOCK_SKEW_TOLERANCE_MS` の許容差で時計の微小な巻き戻しを吸収し、大幅な巻き戻しが発生した場合は静粛期限を `now + QUIET_MAX_DURATION_MS` に収束させ、フィールドを勝手に削除することはありません。
  - `ChatState` は**厳格な正準形状**（`libs/chatState.ts` の `createChatState`）を維持します：すべてのフィールドはオブジェクト生成時に一度に初期化され、未設定のフィールドには `undefined` が割り当てられます。`delete` による形状の変更は固く禁止されます。
  - エンコード時は既定値と異なるフィールドのみを `chat_states.status` に書き出します。確認済みの `botPermissions` は全フラグが `false` であっても明示的に永続化し、未確認の `undefined` と厳格に区別します。
- **永続化のバッチ処理とタイムゾーン保守**：
  - AI メモリは `AI_SNAPSHOT_INTERVAL_MS` ごとにダーティデータを報告し、Disk I/O Worker の検証を経て共有 SQLite トランザクションに投入され、主キー単位で `chat_states.ai_context` を更新します。
  - 運勢、認証待ち状態、ログ、AI キャッシュ使用量、広告サンプルはいずれも追記型ログ形式を採用し、`FLUSH_MAX_ENTRIES` 件に達するか最初の変更から `FLUSH_INTERVAL_MS` 経過した時点でバッチ永続化を行い、成功時に fsync を実行します。
  - 設定タイムゾーンの 00:00 を迎えると、Disk I/O Worker は日次保守 cron を発火します：まずメインスレッドへ `/wed` の日次メンバー再確認を通知し、続いて運勢、ログ、入室ログ、認証待ち状態などの日跨ぎ保守とアーカイブを順次実行します。
- **入室ログ（`joinLog`）のバッチ処理と `/batch_kick` の読み出し**：
  - `chat_member` 入室イベントは `recordJoinLog` を経由してメインスレッドの未確認ミラーに登録された直後に復帰します。Disk I/O Worker は `chatId:day` ごとにバッチをまとめてディスクへ書き込み、確認シーケンス番号（`through` と `pending`）を返します。
  - ディスク書き込み失敗時はデータを保留バッファに残してバックオフ再試行を行い、破棄することは決してありません。メインスレッドのミラー上限が Worker メモリを同時に拘束します。
  - `/batch_kick` は `[since, now]` のローリングウィンドウ内の入室ログを読み出し、期間は `DAY_MS` を超過しません。ウィンドウ両端のタイムスタンプと日次ファイル名は Telegram イベントの原本時刻（`joinedAt` の設定タイムゾーン日付）に由来し、ホスト時計との混用は固く禁止されます。
  - レコードを重複排除し、各ユーザーの最新の入室記録のみを保持します。ホワイトリスト該当者はスキップし、ブラックリスト該当者は統一封禁へ引き渡し、グループに残存するメンバーは `kickChatMemberWithOutcome` でキック（BAN はしない）します。単一バッチ内にブラックリスト該当者が含まれていた場合、バッチ完了後に全名簿の再スイープを 1 回トリガーします。
- **ペルソナと通知文言の起動時スナップショット**：
  - AI ペルソナは `prompt/persona.md` を優先して読み込み、不在時は内蔵の `DEFAULT_AI_PERSONA` を使用します。`send_voice` ツールの説明は `prompt/voice_tool.md` を優先します。双方は起動総ゲート段階で不変の読み取り専用スナップショットを生成して AI Worker に注入し、稼働中のホットリロードは行いません。
  - 通知文言のトーンは `bot.json` の `atmosphere` で明示的に指定します（`mesugaki` 雌小鬼、`normal` 普通）。未設定時、カスタムペルソナファイルが存在すれば普通トーン、存在しなければ既定の雌小鬼トーンとなります。プロセス全体でトーンを統一し、稼働中にメッセージごとの追加 SQL や RPC クエリを発生させません。

### グループ状態と `chat_states`

- **権威ストレージと容量上限**：
  - グループごとの状態の権威ストレージは SQLite の `chat_states` テーブルです。メインスレッドは容量上限が `STATE_MANAGED_CHAT_LIMIT` 件の固定ホットリード用コピーを保持します（`packages/cache/main/chatState.ts`）。
  - `status` カラムには機能トグル（`isProxySendEnabled` を含む）、`quietUntil`、`lockdown` ログ先行記録、`botPermissions` スナップショット、`title`、および翻訳セッション `translate` が完全な形式で保持されます。
- **容量保護ポリシー**：
  - 容量が上限に達した場合、**厳格に拒否し、LRU 淘汰は決して行いません**：限度を超過する新規グループの作成は `assertChatStateCapacity` がエラーを投げます。起動段階では `decodeStoredChatStates` が容量を検証し、Disk I/O Worker も書き込み前に独立して再確認します。
  - ホットリード用コピーは挿入順序でイテレートされ、`get` 操作で順序が変わることはないため、`/block` の連動 BAN グループ一覧における提示順序は決定論的に保たれます。
  - 容量超過による拒否は `/init enable` コマンドにのみ属し、`INIT_CHAT_LIMIT_TEXT` で明確に応答します。他のコマンドがグループレコードの暗黙的な新規作成を誘発することは禁止されます。
- **状態の回収と既定値の消去**：
  - 書き込み前に必ず `normalizeChatState` を呼び出して期限切れタイマーを回収します。`isEmptyChatState` が真（すべてのスイッチが `false`、その他のフィールドがすべて `undefined`）となった場合、メモリ上のエントリを削除して永続化用の削除墓石を書き込みます。
  - `/init disable` の実行時はグループ名 `title` も同時に消去し、管理停止したグループのスロットを完全に解放しなければなりません。
- **プロキシ送信の唯一性（`isProxySendEnabled`）**：
  - プロキシ送信が有効なグループはグローバルで最大 1 つに限定されます。このオプションを有効化する書き込み時のみ他の行を検証し、判定を軽量に維持します。
- **永続化バリア（ライトスルーと exact revision ACK）**：
  - ライトスルーと exact revision ACK メカニズムに従います：`persistChatState` は中核の権威的決定が待機するための耐久的バリアとして機能し、`saveChatStateInBackground` はグループ名更新や権限スナップショット失効など、再構築可能な状態のための低優先度非同期書き込みに使用されます。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

### chat Q&A と `chat_qa`

- **権威ストレージと複合主キー**：
  - Q&A データベースの権威ストレージは SQLite の `chat_qa` テーブルであり、メインスレッドが唯一のホットリード用コピーを保持します（`packages/cache/main/qa.ts`）。
  - 主キーは `(chat_id, q)` の複合キーで `q` にインデックスが張られ、同一グループ内の同一質問に対して答えは厳格に 1 つです。テーブル全体の行数上限は管理対象グループ数 × `CHAT_QA_MAX_PER_CHAT` であり、起動時に全表を一括ロードし、稼働中のページングは行いません。
- **件数上限の独立した多重防壁**：
  - グループごとの問答件数上限は 3 箇所で独立して検証されます：メインスレッドの `setChatQa`、Disk I/O Worker のトランザクションバッファ投入前、および起動時の全表デコード段階です。
- **`/qa set` フォームの認証とライフサイクル**：
  - コマンド側で `isCanControllQaPermission` を検証し、`openedById`（`visibleSenderChat` で取得した可視身分）を記録します。以後のユーザー投稿メッセージは可視身分の一致のみを検査し、管理者権限の再照会は行いません。
  - 自発メッセージ待ち、入力削除、フォーム編集などの await 処理の完了後は、セッションの有効性を都度再確認します。終了済みまたは代替された旧セッションは破棄し、その後の入力処理や受領通知の送信を行いません。
  - フォームの送信とクリーンアップは `qa/notices.ts` の境界に集約され、Telegram の取り消しとエラー処理に厳格に従い、独立した再試行キューは構築しません。
  - 項目の検証：質問が `CHAT_QA_QUESTION_MAX_CHARS` を、回答が `CHAT_QA_ANSWER_MAX_CHARS` を超える場合、または質問全体・回答の ``` コードブロック外にクリック可能なコマンドとして表示されるスラッシュ表記が含まれる場合（`containsRenderableCommand`。回答は直答の出口と同じ `renderFencedText` で分割）、その項目はセッションに書き込まず、フォームは残し、`QaFormIngressResult.rejection` に応じた案内を返信します。
- **自発メッセージの遮断**：
  - 投稿受付口は `["message", "channel_post"]` をリッスンし、`isBotOwnMessage` により Bot 自身のメッセージ跳ね返りを遮断します。
  - 判定は**実行コストの昇順**に並びます：まずグループ ID による Map 完全一致（数値キーでメモリ割り当てゼロ）、次に `selfSentTracker.ts` によるローカルメッセージ ID の照会、最後にスレッド間を跨ぐ `waitForBotOwnMessage` の協調待機を実行します。
- **フォーマット、プレビュー切り詰め、および看板のページネーション**：
  - 回答内のコードブロックはリテラルの ``` フェンスとして SQLite に保存され、フェンス文字自体も `CHAT_QA_ANSWER_MAX_CHARS` にカウントされます。直接回答の送信時にエンティティへ復元されます。
  - フォームプロンプト（`renderQaFormPrompt`）は、単一メッセージの上限を超過した場合に**回答のプレビューのみ**を切り詰めて省略記号を付与し、質問文は完全に保持します。データベースには切り詰めのない完全な内容が保存されます。
  - `/qa query` 看板は回答を `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` に圧縮して省略記号を付与し、質問は完全に表示します。1 ページあたり `QA_QUERY_PAGE_MAX_ENTRIES` 件でページネーションを行い、ページ番号は `callback_data` 内に保持され、クリック時に最新データから再描画されます。
- **直接回答の一致判定と AI の隔離**：
  - 質問文は書き込み時にトリムされ、ホットパス上でのグローバル正規化は行いません。先頭エンティティが `@Bot` メンションである場合、Bot のユーザー名のみ大文字小文字を区別せず、質問文自体は完全一致を要求します。
  - 直接回答は AI 雑談より優先して判定され、`/quiet` による静音抑制を受けません。ヒット時は直ちに回答を送信して下流の処理を打ち切り、この対話は AI のローリングコンテキストに記録されません。
  - モデル側の照会ツール（`group_qa_query` と `group_qa_answer`）に必要なコンテキストは、メインスレッドの `trigger` メッセージに直接載せて運ばれ、スレッド間ミラーの構築や曖昧一致は行いません。永続化はライトスルーと exact revision ACK 規範に従います。

### ブロックリストと広告検出

この節では、[正式なブロックリストと block コマンド](#正式なブロックリストと-block-コマンド)、[広告検出の受付・判定・処置](#広告検出の受付判定処置)、[BAN とメッセージ撤回](#ban-とメッセージ撤回)、[blocklist removal outbox](#blocklist-removal-outbox)、[権限回復後の replay](#権限回復後の-replay)、[ブロックリストの退会アカウント検出](#ブロックリストの退会アカウント検出)を順に説明します。

#### 正式なブロックリストと block コマンド

- **権威名簿とキャッシュの一貫性**：
  - `/block` の権威ストレージは SQLite の `blocklist_entries` テーブルです。メインスレッドは最近アクセスされた身分の有界 LRU キャッシュと、永続化確認待ちの未決書き込みのみを保持します。
  - ブラックリストは同期的なセキュリティ境界です：変更決定の前に、対象身分のホワイト/ブラックリスト判定をあらかじめプリフェッチし、書き込み時はメモリ上の LRU 最終値を公開してから Disk I/O Worker へ revision を投函します。
  - 名簿エントリは時間経過で失効しません。削除経路は管理者による `/block disable`、またはシステムによる[退会アカウント検出](#ブロックリストの退会アカウント検出)の自動解除の 2 つのみです。
  - 各行は `blockedAt` と Telegram メタデータを含む厳格な JSONB 形式の完全レコードです。任意の `participantInvalidCount` は省略時 0 であり、存在する場合は `1` から `BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1` までの整数でなければならず、範囲外や不正な型は起動を拒否します。
- **`/block disable` による完全解除フロー**：
  - 対象がテーブル内に存在する場合、メインスレッドはネガティブキャッシュと件数を公開し、`pendingBlockedRemovals` の進行中バッチから該当 ID を除外してトリム後の outbox スナップショットを送信し、最後に削除墓石を送信します（`queueBlocklistDeletion`）。
  - Disk I/O Worker は到着順に処理し、スナップショットの書き込みが削除に先行するため、データベースが削除済みエントリを参照したり不要な補掃タスクが残留したりすることはありません。Worker 再構築時はドメイン優先度順に復旧されます。
  - 対象が以前登録されていたかどうかにかかわらず、`managedAdminChatIds` の管理対象グループ一覧において BAN を解除します：コマンドを発行した本グループを先頭とし、残りは `/init enable` かつ Bot が管理者と確認済みの全グループです。通常ユーザーは `unbanChatMemberIfBanned`（`only_if_banned: true`）、チャンネル身分は `unbanChatSenderChat` を呼び出します。必要な権限は `isCanUnBlock` です。
- **保護対象身分と排他直列化**：
  - スーパー管理者（`SUPER_ADMIN_USER_ID`）と恒久ホワイトリストメンバーは無条件で保護され、`isWhitelisted` は `/block`、`/mute`、`/batch_kick` の受付ゲートを横断して機能します。一時的な広告免除はこの恒久保護境界に含まれません。
  - `/white enable` はブラックリストに既に存在する身分を厳格に拒否します。
  - `runProtectedIdentityMutation` により、身分の排他判定と状態更新がメインスレッドで厳格に直列化されます。Telegram への API 呼び出しや永続化確認はクリティカルセクションの外側で実行されます。ブロック処理は一時免除の墓石を先行してキューイングしてからブラックリストレコードを書き込み、起動時およびトランザクション検証時に両名簿の交差を厳格に禁止します。
- **永続化バリアとドメインの分離**：
  - `/block` の永続化確認（`confirmBlocklistPersisted`）はホワイトリストと同じく `confirmIdentityPolicyPersisted("blocklist", id, …)` を通ります。ブラックリストドメインのフラッシュバリアのみを待機し、Worker はブラックリストを含む共有 SQLite トランザクションのみをフラッシュするため、他ドメイン（wed メンバーファイルなど）の無関係なエラーから隔離されます。フラッシュ成功後は、その id の最新 revision が正確な ACK を受け取ったことも確認します。
  - 統一フラッシュは全ドメインを対象とし、受領通知において `failedDomains` を明示します。AI キャッシュ使用量や広告サンプルは副経路データであり、フラッシュ失敗時もエラーログを記録するのみで、全体フラッシュを失敗扱いにはしません。
  - 同一対象への重複 `/block`（対象が名簿に残っていない `/block disable` を含む）は永続化失敗後の再試行手段です：その id に未確認の最終値（ブロック記録または解除墓石）が残っている場合、`retryUnacknowledged` により `requeueUnacknowledgedIdentityWrite` で同じ revision を再送信し、メモリ上の存在を理由に永続化確認をスキップすることはありません。
- **グループ単位の補掃トリガーと完了ラッチ（`sweepBlockedMembers`）**：
  - 「Bot が管理者である && グループで `/init` が有効」という論理積が成立したときにのみ補掃を実行し、どちらかの条件が変化するたびに再検証します。
  - Worker から `complete: true` の `blockedMembersRemoved` 受領通知を受け取った後にのみ、`blocklistSweepState` に `sweptAt` を記録します。
  - 再試行は `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` のバックオフタイマーに拘束され、この待機判定は名簿ページの読み込みより前に行われます。グループの管理解除や権限喪失時は `forgetChatBlocklistWork` により補掃進捗を破棄し、進行中のバッチも無効化します。
  - `sweptAt` は完了ラッチとして機能し、グループ内にブラックリストメンバーが残存していることが判明した場合（BAN 失敗や即時キックの未完など）、`requestBlocklistResweep` により `null` にリセットされます。連続失敗時はバックオフ間隔が線形に増加し、最大 `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS` で頭打ちとなります。
- **権限不足と対象が管理者である場合の細分化判定**：
  - Telegram が 403 または 400 `not enough rights` を返した場合、`forbidden` として分類されます。
  - 処分の対象自身がグループの管理者である場合も、Telegram は同様に 400 `not enough rights` を返します。この場合、Worker は `probeChatAdmin` で身分を確認します：対象が管理者であると確証された場合はログを記録して該当対象のみをスキップし、同バッチの残りは正常に処理してバッチ自体は完了させます。ただし受領通知に `targetIsAdmin` フラグを付与し、メインスレッドは `sweptAt` を更新せず失敗カウントを積算して、該当グループの補掃待ち状態を維持します。
  - Bot 自身に BAN 権限が不足している場合、Worker は `permissionDenied` を返送します：メインスレッドは `permissionBlocked` をマークしてタイマー再試行を一時停止し、outbox 内の補掃バッチを `missing-permission` として記録します。`canRestrictMembers` 権限を備えた `my_chat_member` 更新または現時点の照会結果を受信したときにのみ、ラッチを解除します。
- **タスク永続化と即時キック（入室時即時処置）**：
  - 処分バッチは `trackBlockedRemoval` により `pendingBlockedRemovals` に採番・記録され、Worker 再構築時に全量が再投入されます（BAN 操作は冪等です）。
  - ブラックリスト対象者の入室時は即時キックを発動し、通常の入室認証フローをバイパスします（認証ウィンドウを開きません）。`recentBlockedJoinCounts` により `chat_member` と `new_chat_members` の重複イベントを排除し、スライディングウィンドウの入室カウントを補記して入室サービス通知を削除します。
- **スレッド協調とクロスグループファンアウト**：
  - 身分の判定と名簿の管理はメインスレッドに帰属します。メンバー照会、BAN、および再試行の順序制御は Anti-Raid Worker が非同期直列に実行し、出線リクエストは `query` / `kick` の 429 制御レーンへ振り分けられます。
  - `/block` コマンド自身によるグループ横断の連動 BAN は明示的な例外です：メインスレッドは update 内で永続化確認を完了した後、遅延実行器のバックグラウンド枠（`commands/blocklistFanOut.ts`）へファンアウトタスクを投入し、並行数上限 `MANAGED_CHAT_BATCH_CONCURRENCY` で各グループへ `banChatMember` または `banChatSenderChat` を直接送信します。失敗したグループは後続の補掃へ委ねられます。

#### 広告検出の受付・判定・処置

- **受付ゲートと再検証メカニズム**：
  - 送検には 3 つの条件を同時に満たす必要があります：現在のグループで `ChatState.isAdDetectEnabled === true`、Bot がグループの管理者であること、送信者が免除権限（`isCanBypassAdDetection`）を持たないこと。スーパー管理者は常に免除されます。
  - Worker が広告と判定してイベントをメインスレッドへ返送した後、ブラックリスト書き込みのクリティカルセクションに入る直前に、グループのスイッチとホワイトリスト状態を再確認します。その間にグループが広告検出を無効化していた場合は、想定内の競合として通常ログを記録し、ブラックリスト登録を中止します。
- **免除および特殊メッセージソース**：
  - 連携チャンネルからの自動転送（`is_automatic_forward`）および Bot 自身の投稿（`isBotOwnMessage`）は一律にスキップします。
  - 本 Bot が送信した inline メッセージ（`via_bot` が自身を指すもの）は、グループに投稿されたレンダリング後の本文ではなく、ユーザーの**元のクエリテキスト**を送検して判定します。各 inline 機能は応答成功後に `recordInlineResultSources` で元テキストを登録し、容量上限は `INLINE_RESULT_SOURCE_MAX_AUTHORS` です。元テキストが取得できない場合や本文が一致しない場合は判定をスキップします。
  - ディスカッショングループのコメント欄で引用されたチャンネル投稿の本文や抜粋は、判定対象テキストに混入させません。グループオーナーおよび管理者は決して広告として処分しません。
- **キュー管理と流量制御（Worker スレッド）**：
  - キューは `chatId:senderId` をキーとし、同一送信者の連続メッセージは `pendingAdMessages` 内の単一 bundle にマージされ、重複してキュー枠を占有しません。
  - 待機送信者上限は `AD_DETECT_MAX_PENDING_SENDERS` であり、満杯時は新規送信者を拒否し、未判定の既存送信者を FIFO 追い出しすることはありません。
  - スケジューラは `AD_DETECT_QUEUE_TICK_MS` ごとにキュー先頭から最大 `AD_DETECT_BATCH_SIZE` 件を取り出し、グローバルの同時実行上限 `AD_DETECT_MAX_IN_FLIGHT` を適用します。
  - 抑制ウィンドウ `AD_DETECT_JUDGED_RETENTION_WINDOW_MS`：処分直後の送信者キーを `recentlyDisposedAdKeys` に記録し、その期間内に到着した新着メッセージに対する重複判定を抑制します。ただしチャンネル身分の場合、このウィンドウ内であっても新着メッセージの削除は通常どおり実行します。
- **送検データの組み立てとモデル連携**：
  - 送信者あたりのメッセージ数上限は `AD_DETECT_MAX_MESSAGES_PER_SENDER`、文字数予算は `AD_DETECT_BUNDLE_MAX_CHARS` です。未判定メッセージが上限超過で破棄される際は、本文は除去されますがメッセージ ID は `pendingDeleteIds` へ移され、処分時に確実に削除されるよう保証した上でエラーログを記録します。
  - 送信者の表示名（`firstName`、`lastName`）と非転送本文を合わせて判定し、名前による宣伝と本文による宣伝を同等に評価します。
  - **純粋なリンクの保護**：メッセージ束全体が 1 つ以上のリンクと（任意の）通常の名前のみで構成され、宣伝・勧誘・取引の文言が一切含まれない場合、必ず false と判定します（各種プロキシノードや購読プロトコルをサポート）。
  - プロンプトには必ず `"JSON"` 文字列を含め、モデルに裸の JSON オブジェクトのみを返すよう指示します。パーサーは裸のオブジェクトを優先し、markdown コードフェンスにも対応します。モデル呼び出し失敗時は未判定扱いとし、誤判定を防ぎます。
  - モデルコンテキスト事実の提示：入室認証中であるかどうかの事実はメインスレッドが同期取得し、固定位置に独立して提示し、判定対象の本文には混入させません。
- **処分の実行と通知**：
  - 広告と判定された場合、Worker 側は該当ユーザーの待機メッセージを削除して `adDetected` を返送します。メインスレッドはクリティカルセクション内で `blockUser` を実行し、ブラックリストをフラッシュし、耐久的な処分バッチを作成して Worker へ返送し、全グループでの BAN を実行させます。
  - メインスレッドは `sendTemporaryMessageOnMain` を通じて処置通知を送信し、30 秒の自動削除タイマーを設定します。通知内容は実際に BAN に成功したグループ数と権限不足の状況を正確に報告します。
  - 停止時、広告検出は新規リクエストの受付のみを停止し、進行中のモデル呼び出しは自然にタイムアウトまたは完了させ、迅速なシャットダウンを妨げません。命中サンプルは追記ログとして `memory/ad-detected/sample.json` に書き込まれ、設定タイムゾーンの日付に従って自動ローテーション・アーカイブされます。

#### BAN とメッセージ撤回

- **メッセージ撤回メカニズム**：
  - ブラックリストの BAN 操作（`/block`、入室時即時キック、補掃、広告処分）は統一して `banChatMember` を呼び出し、常に `revoke_messages: true` を指定してグループ内の過去メッセージを撤回します。
  - チャンネル身分にはメンバーの概念がなく `banChatSenderChat` はメッセージの自動撤回をサポートしないため、広告処置時は Worker 側で該当メッセージを明示的に削除します。

#### blocklist removal outbox

- **プロセス再起動を跨ぐ永続化保証**：
  - ブラックリスト処分バッチは Disk I/O Worker を通じて SQLite の `pending_blocked_removals` テーブルに永続化されます。トランザクションがディスクにコミット（durable）され revision ACK を受信した後にのみ、メインスレッドは Anti-Raid Worker へタスクを委譲し update を確認します。
  - 補掃タスク（`probeMembership: true`）は outbox 内にグループ ID のみを保持し、実行時に安定したカーソルで `BLOCKLIST_SWEEP_PAGE_SIZE` 件ずつ最新のブラックリスト主キーをページング取得します。即時キックタスク（`probeMembership: false`）は作成時に確定した `userIds` リストを凍結して保持します。
  - 起動段階で未完了タスクを SQLite から自動復元してリプレイします。outbox の容量上限は `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES` であり、検証失敗時は安全のため起動を停止します。

#### 権限回復後の replay

- **権限回復後の復旧手順**：
  - Bot に `can_restrict_members` 権限が回復したことを正式に確認した際、権限不足で保留されていた outbox 内の即時キックおよび広告処分バッチを元の `removalId` のまま優先して全件リプレイします。
  - 続いて現時点の全名簿による補掃を 1 回発行し、以前 BAN に失敗したメンバーや未処分のブラックリスト対象者を徹底的に処理します。補掃タスクとリプレイバッチはそれぞれ独立して収束・完了します。

#### ブロックリストの退会アカウント検出

- **退会エラーの検出とカウント**：
  - Telegram は退会済みアカウントに対して 400 `PARTICIPANT_ID_INVALID` を返します。全名簿補掃において、ユーザーに対するすべての試行（`BLOCKLIST_REMOVAL_MAX_ATTEMPTS` 回）でこのエラーが返り、シャットダウンによる中断でなかった場合に限り、結果を `participantInvalid` と認定します。
  - Worker は `blockedMembersRemoved` 受領通知において、`participantInvalidUserIds` と決着済みの `settledUserIds` を分類して返送します。メインスレッドは到着順に直列処理し、前者の `participantInvalidCount` を 1 加算し、後者に含まれる既存のカウントを消去します。
- **自動解除メカニズム**：
  - あるユーザーの `participantInvalidCount` が累積で上限 `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` に達した時点で、該当アカウントは Telegram から永久に削除されたと判定します。
  - メインスレッドは自動的に `unblockUser` を呼び出してブラックリストから除外し、ネガティブキャッシュを公開して削除墓石を書き込み、監査ログを記録します。このパスではクロスグループの BAN 解除 API は呼び出さず、無限ループに陥る無効な補掃を終束させます。

### 運勢と AI メモリの復元

- **運勢の日跨ぎローテーションと滞留キュー**：
  - 設定タイムゾーンの暦日 owner を切り替える前に、前日の追記バッファを正常にフラッシュしなければなりません。フラッシュ失敗時は旧 owner を維持し、日付の切り替えを拒否します。
  - 日付切り替えを誘発した新日付の抽選記録は滞留バッファへ移して後で補記しなければならず、切り替え失敗とともに破棄することは禁止されます（メインスレッドの `dailyLuckCache` は既に該当日の抽選事実を記録し、受領通知を発行済みです）。滞留バッファにはハードキャップが設けられており、溢れた場合は最古のエントリを破棄してエラーログを記録します。フラッシュの再試行が成功した時点で直ちに補記を実行します。
  - 対象日に確認済みレコードが存在する場合、鍵の欠落や日付の不一致は深刻なデータ不整合とみなし、新規鍵を勝手に生成して起動・日付切り替えを続行することはせず、直ちに拒否します。
- **日跨ぎ起動の時間許容処理**：
  - プロセスが 00:00 前後に起動した場合、メインスレッドと Disk I/O Worker が計算した設定タイムゾーンの「今日」に 1 日のずれが生じる可能性があります。
  - これは致命的エラーとしては扱わず、期限切れの資格情報とその日の旧レコードを明示的に破棄（キャッシュを空化）し、運勢の初回リクエスト時に `ensureLuckCacheFreshForToday` が Worker から当日の最新鍵を取得し直すとともに、プロセスが日付を跨いだとマークします。
- **AI メモリ復元ゲート**：
  - 起動段階では、現行の `AI_MEMORY_HYDRATE_BUFFER_MAX` および `MAX_SUMMARY_ROUNDS` の制約を満たす version=1 のスナップショットのみを受け入れます。不正なフィールドや上限超過が存在する場合は直ちに起動を拒否し、復元時に勝手に切り詰めることはありません。
  - メッセージおよび引用の各フィールド（表示名、ユーザー名、本文、引用文）は単一行テキスト（通常の半角スペースのみ許可）でなければならず、参照テキストの文字数は最大 `REPLY_REFERENCE_MAX_CHARS` UTF-16 コードユニットです。タイムスタンプ `at` の形式は `YYYY/MM/DD HH:mm:ss` に一致しなければなりません。`pendingImage` の構造は厳格に制限されます。
  - ハイドレーションを行うグループ総数は `AI_MEMORY_MAX_CHATS`（`2 × STATE_MANAGED_CHAT_LIMIT`）で有界化されており、管理対象グループと teardown 処理中のグループが一時的に併存しても容量超過が発生しないようにします。
  - AI Worker が再起動予算を使い切って自己修復を放棄した場合、`lastInitState.current` を自動的にクリアし、`flushAiMemory` が安全に `flushed` を返すようにして、雑談機能の縮退がグローバルの停止プロセスを巻き添えにしないようにします。
- **メモリ派生メッセージインデックス（`chatMessageIndexes`）**：
  - メモリ上のローリングキャッシュから完全に導出される純粋なインデックスであり、永続化されず、メッセージがホット領域に出入りする際にのみ同期して追加・削除され、ローリングキャッシュの上限で自然に制約されます。
  - Bot 自身の返信チェーンは Telegram が返した `reply_to_message` に基づいて関連付けられます。対象がホット領域から外れた場合は、ラウンド開始時に取得した上限付き trigger スナップショットをフォールバックとして使用し、インデックスの境界を拡張しません。

### 確認境界と停止

- **Telegram Update の確認境界**：
  - Update は対応するミドルウェアが完了し、すべての副作用が確定した後にのみ確認境界（offset）を進めることができます。
  - 停止処理中に実行中の update が失敗または中断された場合、runner は直ちに明示的な失敗フラグを記録します。ライフサイクルは停止の最終段階でこのフラグを検証し、未決の失敗が存在する場合は **Telegram への最終 offset の確認を拒否** して非ゼロコードで終了し、再起動後に Telegram から再配信されるようにします。
  - runner のポーリングは `limit: 1` に固定し、各メッセージが独立した確認境界内で完結することを保証し、バッチ内での非冪等な操作の重複実行を防止します。
- **ロングポーリングとネットワークバックオフ機構**（`app/updateFetcher.ts`）：
  - ロングポーリングのタイムアウトは `UPDATE_POLL_TIMEOUT_SECONDS`、再試行ウィンドウは `UPDATE_POLL_RETRY_WINDOW_MS` です。
  - ネットワークの瞬断時は、`UPDATE_POLL_INITIAL_RETRY_MS` から `UPDATE_POLL_MAX_RETRY_MS` の範囲で指数バックオフを実行します。429 を受信した場合は `retry_after` に厳格に従い、401/409 などの資格情報エラーに遭遇した場合は直ちに致命的エラーとして終了します。
  - 関連チャンネルの照会には `LINKED_CHANNEL_FETCH_TIMEOUT_MS` の独立したタイムアウトを適用し、タイムアウト時は `undefined` を返し、免除を与えません。
- **最終 Offset の確認と停止の 3 値分類**：
  - 最終 offset を確認する `getUpdates(timeout: 0)` の呼び出しは `FINAL_OFFSET_CONFIRM_TIMEOUT_MS` のデッドラインで保護されます。
  - 停止結果は 3 値（`classifyShutdown`）に分類されます：`clean`（完全な正常終了）、`offsetWithheld`（全コンポーネントの排出・フラッシュは完了したが offset は保留、インスタンスロックは解放）、`unsettled`（未決の異常が発生、インスタンスロックを保持したまま非ゼロ終了）。
- **Anti-Raid と広告処置の排出（Drain）**：
  - ライフサイクルは `drain` メッセージを Worker へ送信し、広告判定 ticker を同期的に静粛化（quiesce）します。
  - 進行中の広告処置タスク（`inFlightAdDisposals`）、永続化書き込み、受領確認、および派生した Worker タスクを順次排出します。前段の受領取得に失敗した場合でも、進行中のタスクの排出をベストエフォートで試行した上で、元の失敗理由を呼び出し元へ返します。
- **タイムアウト中止とリソース解放順序（Dispose 順序）**：
  - Update が通常の排出予算を超過した場合、ライフサイクルは `AbortController` を通じて全 update を中断し、短い取消収束ウィンドウを与えます。時間内に終了しなかったハンドラーは offset の確認とロック解放を阻止します。
  - 停止処理は固定順序で同期・非同期の収尾を実行します：各業務入口の quiesce → runner 停止 → AI のフラッシュ → AI の終了 → Telegram 出線の排出 → Disk I/O のフラッシュ → Anti-Raid と Disk I/O の終了 → StateStore のフラッシュ。
  - **共有 SQLite のクローズ**：現在の Disk I/O 世代が復旧ハンドシェイクを終え、書き込み可能で、致命シグナルを出していない場合、`terminateDiskIO` はまず `writable` を偽にしてから `closeStorage` を 1 回送ります（予算 `DISK_IO_STORAGE_CLOSE_TIMEOUT_MS`）。Disk I/O Worker は残りの書き込みを 1 トランザクションでコミットし、`PRAGMA wal_checkpoint(TRUNCATE)` を実行して接続を閉じ、以降の身分書き込みメッセージは無視します。応答が残り書き込みの未コミットを報告した場合、またはクローズ要求がタイムアウト・拒否・エラー応答となりコミットを確認できない場合も Worker は終了させますが、ディスク終了のステップは失敗として記録され、停止結果は `unsettled` になります。他の読み取り接続による checkpoint の阻害は診断を残すだけです（残り書き込みはコミット済みで、WAL はデータベースの横に残ります）。`closeStorage` は業務メッセージではなく、Worker 再構築時に再送されません。
  - プロセス内の経過時間予算は `packages/libs/monotonicDeadline.ts` が `performance.now()` に基づいて計算し、時計の巻き戻しによる停止デッドロックを防止します。

### ファイル権限と schema

- **データルートディレクトリの権限と setgid 制約**：
  - 明示的に設定された独立データルート、`memory/`、`logs/` は、起動段階で `RUNTIME_DATA_ROOT_MAX_MODE` 以下の権限であることを強制し、group および other の書き込みビットを禁止します。
  - SQLite の `database/` ディレクトリは `IDENTITY_DATABASE_DIRECTORY_MODE`（協調グループ書き込みの setgid ディレクトリ）として作成され、メイン DB および WAL/SHM サイドカーファイルは `IDENTITY_DATABASE_FILE_MODE` を使用します。実行時に暗黙の chmod を行うことは禁止され、権限の変更はデプロイツールが担います。
- **アトミック置換における既存権限の継承**：
  - 一時ファイルを経由した `tmp + fsync + rename` のアトミック置換では、既存の対象ファイルの mode を明示的に読み取って引き継がなければならず、`0666 & ~umask` で対象ファイルの権限をリセットしてはなりません。
- **推測的サイレントアップグレードの禁止**：
  - 起動段階でストレージスキーマとバージョンを厳格に検証し、非互換な入力は直ちに起動を拒否します。実行時に自動マイグレーションを行うことは禁止されます。

### ロックダウンミラーと終端フラグ

永続化の指紋・ミラー復元・終端スナップショットの制約仕様については、[ロックダウンミラーと終端フラグ](04-lockdown-invariants.md) を参照してください。

## 互換エントリ

- **Barrel 再エクスポートの副作用排除**：トップレベルの barrel 互換ファイルは型とシンボルの再エクスポートのみを行い、状態を所有せず、設定を解析せず、import 時の副作用を一切導入しません。
- **運勢レシートの形式仕様と安全なデコード**：
  - 運勢レシートは正当な HMAC 署名が埋め込まれた現行形式のみを受け付け、日次秘密鍵は設定タイムゾーンに従って毎日更新されます。
  - レシートのデコードは `libs/luckReceipt.ts` の正規化入口に集約されます。base64 長さ不正などの形式エラーは一律に `undefined` へ正規化し、`SyntaxError` などの例外がミドルウェアの外へ漏れてメインフローを破壊することを防止します。

---

<div align="center">

[← 前のページ：03 ディレクトリマップ](03-directory-map.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#04-実行時の正式な不変条件) · [次のページ：05 開発フロー →](05-dev-workflow.md)

</div>
