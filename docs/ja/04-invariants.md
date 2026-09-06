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
| [起動と import の境界](#起動と-import-の境界) | [起動順序とリソース取得](#起動順序とリソース取得) · [任意の資格情報と設定の縮退](#任意の資格情報と設定の縮退) · [データルートとバックグラウンドタスク](#データルートとバックグラウンドタスク) · [送信リクエストとメッセージの安全性](#送信リクエストとメッセージの安全性) |
| [Worker と状態の所有権](#worker-と状態の所有権) | [スレッドと状態の帰属](#スレッドと状態の帰属) · [状態機械の contract](#状態機械の-contract) · [AI チャットの実行時](#ai-チャットの実行時) · [AI プロンプトと transcript](#ai-プロンプトと-transcript) · [参加認証と終端処置](#参加認証と終端処置) · [連投ミュートと自身の権限キャッシュ](#連投ミュートと自身の権限キャッシュ) · [識別子の解決と実行時のクリーンアップ](#識別子の解決と実行時のクリーンアップ) |
| [永続化](#永続化) | [永続化と snapshot の contract](#永続化と-snapshot-の-contract) · [グループ状態と `chat_states`](#グループ状態と-chat_states) · [chat Q&A と `chat_qa`](#chat-qa-と-chat_qa) · [ブロックリストと広告検出](#ブロックリストと広告検出) · [運勢と AI メモリの復元](#運勢と-ai-メモリの復元) · [確認境界と停止](#確認境界と停止) · [ファイル権限と schema](#ファイル権限と-schema) · [ロックダウンミラーと終端フラグ](#ロックダウンミラーと終端フラグ) |
| [互換エントリ](#互換エントリ) | トップレベル barrel と運勢 receipt の形式 |

## 起動と import の境界

### 起動順序とリソース取得

- production モジュールを import しても Worker、timer、ネットワーク要求、共有ディレクトリへの書き込みを開始しません。
- メインプロセスは実行時データルートを再帰的に作成し、書き込み、ファイル fsync、hard link、アトミック rename、ディレクトリ fsync を事前検査してから `bot.lock` を取得します。root と機密トップレベルの `memory/`、`logs/`、`database/` は実ディレクトリでなければならず、`lstat` がシンボリックリンクを返した場合は fail closed します。`COPY_NINJIA_DATA_ROOT` を明示設定した場合、root・`memory/`・`logs/` は mode `0755` 以下、すなわち group と other の書き込み bit がないことを要求します。SQLite の sidecar を deployment group が書けるよう `database/` だけは `0770` まで許可し、別 UID 所有なら runtime の有効 group に属して group `rwx` が揃っていなければなりません。既存ディレクトリは検証するだけで自動 chmod は行いません。続いてトップレベルの孤立した一時ファイルを削除し、`state.json` を厳密に復元します。ここまではすべてネットワーク接続や Worker 作成より前です。

  deployment input の厳密検証後に Disk I/O Worker を初期化し、永続データを復元します。復元成功後に Telegram client を初期化し、handler・command menu・`bot.init()` の handshake を完了し、AI/Anti-Raid Worker を初期化して hydrate した後、acknowledgement-safe runner を開始します。
- 初期化失敗と正常終了はどちらも `ApplicationLifecycle` に合流し、実際に取得したリソースだけを解放または flush します。

### 任意の資格情報と設定の厳密な事前検証

- 設定 parser 自体は I/O を行いません。main thread は Worker 作成と外部接続より前に `validateExistingDeploymentInputs` で存在する全 deployment input を厳密検証します。機能が無効でも不正設定は拒否します。任意ファイルが本当に無い場合は起動を妨げず、`packages/config/readiness.ts` と各 availability 境界で対応機能の利用を拒否します。設定 holder は process 単位で結果を保持し、変更の反映には再起動が必要です。

  `config/agent.json` は consumer ごとに読みます。広告検出は `agent.ad_detect`、AI 雑談は `text`、`summary`、`media` と任意 tool 能力を使います。起動時には存在する全能力を検証し、feature readiness は自分の必要条件を独立に判定します。

  Disk I/O recovery は `stickerPacksForRecovery()` から nullable なスタンプ許可リストを受け取ります。欠落時の `null` は全既存 catalog を厳密に読みますが、許可リストに基づく削除は行いません。明示的な空配列は空リストとして照合します。存在する設定が不正または読み取り不能なら起動を拒否します。

- allowlist、blocklist、一時 allowlist の activity、未完了 removal は `database/storage.sqlite` を authoritative source とし、runtime は policy JSON を読み書きしません。Disk I/O Worker は startup 時に SQLite integrity、JSONB storage class、migration lineage、schema version、全 row の strict codec、blocklist と 2 種類の allowlist の非交差、outbox reference を検証し、1 つでも失敗すれば partial state で起動しません。production startup は欠落 database を作成・自動 migration せず、offline migration script だけが構造を変更します。

  **同期 authorization は main thread の有界 LRU 3 個だけを読みます。** 恒久 allowlist、blocklist、一時 allowlist activity はそれぞれ最大 8,192 positive/negative entry を保持し、`null` は明示 negative cache です。Disk I/O startup は恒久 policy の count だけを返し、3 table 全体を複製しません。update preflight は必要 identity を batch prefetch し、cross-thread cold read は 1 回最大 4,096 primary key。command と join check はその後同期 cache を読み、判定点ごとの request/reply を行いません。cold read failure は通常 path では fail-closed、destructive bulk path では中止し、unknown を unprotected と扱いません。

  **一時 allowlist は広告検出中の通常発言を visible sender identity 単位で group 横断集計します。** 広告設定が利用可能で、現在の group が広告検出を明示的に有効にしている場合だけ、実 user または channel persona を数えます。service message、自動 forward、Bot 自身、現在の group の匿名管理者 persona、恒久 allowlist member は対象外です。東京暦日の 8 通目でその日を 1 回だけ qualified day とし、最初の qualified day で広告免除だけを含む `TEMPORARY_WHITELIST_PERMISSIONS` を即時付与します。7 日連続で qualified になると、同じ広告免除だけを持つ恒久 allowlist entry へ昇格します。集計は rolling 24 時間ではなく、東京暦日ごとに再計算します。終了した日が qualified なら row を新しい日に持ち越し、一時広告免除と連続日数を継続します。新しい日の最初の eligible message で `send_count` を 1 に戻して当日の `qualified_at` を消し、8 通目でその日を再び qualified にします。その日が qualified になった後、同じ日の後続発言は row を書き換えません。`send_count` と `counted_at` は qualified になった発言で凍結され、`counted_at` は `qualified_at` と等しくなります。日境界の推進、保持判定、strict decode、深夜 cleanup が読む事実は一切変わりません。その日が再度 qualified にならなければ、次の東京 0 時に row 全体と発言累計を削除します。さらに古い row も削除し、当日 row は保持します。深夜 maintenance は shared SQLite の pending final value を先に commit し、transaction failure で一時 allowlist write が pending のままなら cleanup を拒否します。cleanup 後に到着した旧日の write も同じ日境界で正規化し、失効値は元の revision の tombstone として ACK して旧 row の再挿入を防ぎます。main-thread LRU の読取と Worker recovery も同じ境界を使うため、期限切れ cache は広告免除を付与せず、期限切れの未 ACK value は tombstone として replay されます。適用可能な true 広告 verdict、blocklist 追加、恒久昇格は一時 accumulator 全体を明示的に削除しますが、付与後に届いた古い verdict は撤権できません。wall clock が `counted_at` より前へ巻き戻った場合は現在の発言から count timeline を作り直し、すでに付与済みの一時資格は保持して未来の count を引き継ぎません。当日すでに qualified の row では `counted_at` が `qualified_at` と等しいため、その時刻より後への巻き戻しは同じ東京暦日として継続します。いずれの場合も membership は保持されます。

  **write は容量判定、write-through、exact revision ACK を使います。** identity write は未 ACK primary key・byte・transport の予算を確認してから LRU 最終値を publish し、revision を登録して Disk I/O へ post します。main thread の各 policy table は置換差分で byte 合計を更新し、exact ACK だけが対応する最終値の予算を解放します。古い ACK は新 revision に影響しません。main thread の各 domain は未 ACK key 8,192 件と推定 payload 32 MiB が上限で、Worker の SQLite 6 table は同じ上限を共有します。恒久 policy・一時 allowlist・outbox は 128 change、chat state と QA は管理 chat 上限、または最初の change から 30 秒で同期 transaction を実行します。成功時は buffer を空にしてから exact ACK を送り、失敗時は全 pending value を保持します。30 秒、60 秒後に retry し、3 回連続失敗で fatal を通知して新規業務を止めます。停止時の明示 flush は再試行できます。late read は未 ACK 最終値を上書きせず、復元は revision 順です。`/white`、`/permission`、`/block` の重要な成功通知は domain の durable 確認を待ち、拒否・timeout・ACK 欠落は command 内で報告します。

  **スーパー管理者 permission は identity 自体から来て SQLite row にはありません。** `packages/infra/identityPolicy/whitelist.ts` の `getEffectiveWhitelistPermissions` は `SUPER_ADMIN_USER_ID` に全 true の `SUPER_ADMIN_WHITELIST_PERMISSIONS` を返します。それ以外は恒久 allowlist を先に読み、未命中の場合だけ、東京日の保持境界内にある一時 membership から `TEMPORARY_WHITELIST_PERMISSIONS` を得ます。スーパー管理者 override は read-only で永続化しないため、identity 変更で全開の旧 row は残りません。`/white` と `/permission` は current chat 自身を target にできません。`isCanWhiteOther` は `/white enable` だけを委任し、他 identity を default permission で追加できますが、member 削除と permission mutation はスーパー管理者だけです。

  `/permission query` と `/permission help` は read-only です。`query` は self、reply target、explicit target を照会し、default 補完済み view を返すだけで row を作りません。どちらも描画した JSON を長期保持します。1 項目ずつ突き合わせる permission board であり、30 秒 cleanup では読み終える前に消えてしまうためです。対象解決の失敗、変更の拒否、usage hint は引き続き共通 30 秒 cleanup に従います。
- **process 全体の Telegram identity は `config/telegram.json` だけから厳密に読みます**。`bot_token` と `super_admin_user_id` は network 接続前に必須検証し、欠落、未知 field、不正値は startup を拒否します。AI key はすべて `config/agent.json` の能力内に provider、endpoint、model と一緒に置きます。credential default、能力間 fallback、runtime override はありません。`base_url` は `https` のみを受け付け、平文 `http` は `localhost`/`127.0.0.1`/`::1` に限られ、userinfo と `#` fragment は許可しません——このフィールドの隣には同じ能力の api_key があります。

  **1 つの process には 1 世代の AI 設定しか存在しません。** `agent.json` は起動 gate で main thread が一度だけ parse し、AI 雑談 Worker は `init`、Anti-Raid Worker は `agentConfig` で read-only な snapshot を受け取ります。どちらの Worker も thread ごとの holder を読むだけで、runtime path から disk に触れることはなく、再生成時も**同じ** snapshot を replay します。したがって設定変更には process 全体の再起動が必要で、Worker の再構築が disk 上の新しい版を拾うことはありません。`ad_detect` 未設定時の snapshot は明示的な `null` で、判定側は前の instance の値を流用せず fail-closed します。

  AI 雑談には `text`、`summary`、`media` が必要です。`image`/`song` 欠落は該当 tool だけ、`ad_detect` 欠落は広告検出だけを止めます。state 上ですでに有効なら startup preflight が欠落を拒否します。

  **任意能力は provider 名ではなく member の有無で判定します。** 両 provider が voice 転写入口を持ちますが、設定した media model の vision/voice 対応は最初の実 request で別々に probe します。modality ごとに在途 probe は 1 つ、SDK は最大 5 attempt、waiter は media runner slot を占有しません。結論は 4 状態です：`supported`、`unsupported`（endpoint が明示的にその modality を拒否）、`misconfigured`（404/405。model か base_url の誤りで、確定時に `$.agent.media` を指す診断を 1 行記録）、それ以外は `unknown`。`unsupported` と `misconfigured` はいずれも終局で、Worker lifetime 中その modality の download を止めます。endpoint 障害（timeout・408/429/5xx・network error）は連続回数に応じた有限の指数 backoff だけを課し（30 秒から最大 10 分）、窓の間は download も executor slot も使わずに共有結果を返し、1 回成功すれば counter は clear されます。通常の 4xx parameter error、download 失敗、空 response はその 1 件の media の問題にすぎず、modality の結論も backoff も動かしません。song は member 欠落時に tool ごと外し、「設定はあるが選択した実装がその能力を持たない」場合は Worker 初期化時に startup 診断を 1 度だけ記録します。

  **OAI 互換画像 wire protocol は `config/agent.json` の `agent.image.image_protocol` から取得し、推測も default も持ちません。**現在は `openai`、`openai-standard`、`xai`。不一致を別 profile で retry せず、追加時は union、canvas table、exhaustive dispatch、test を同期します。

  **日本語翻訳も同様で、唯一の判定入口は `packages/copy/availability.ts`** です（`g-auth.json` が使えること + チャットごとの opt-in）。`/ja_copy` と自動 copy の ja 変換は必ずここを通します。この経路の劣化は**サイレント**だからです——`translateToJapanese` は失敗時に null を返すだけで、呼び出し側は未翻訳の原文をそのまま送出し、グループからは「翻訳サービスが一時的に不調」と区別が付きません。設定事故が何日も隠れ続けることになります。

  コマンド経路は `g-auth.json` を名指しして拒否し、自動経路は通常の copy に退化します。どちらも「翻訳したふり」をしてはなりません。

  **AI 雑談が「いま動いているか」の判定は `packages/aiChat/availability.ts` ただ 1 か所**（資格情報の有無とチャットごとの opt-in の論理積）であり、新しい呼び出し箇所は必ずここを通します。この論理積を各呼び出し箇所に書き下すと、いずれどこかがチャット側のスイッチだけを見るようになります。それが起動時の hydrate 経路で起きるとデータ損失です——その経路は「このチャットは無効」をディスク上の記憶を削除する根拠として扱い、資格情報が無いときはすべてのチャットが無効に見えるからです。

  **したがって資格情報が欠けている場合、`hydrateAiMemory` / `hydrateStickerCatalog` は丸ごと早期 return し、1 件も削除してはなりません**。`memory/` 配下のスナップショットは鍵が戻るまでそのまま保持します。
- **起動時の総ゲートが検証するのは「すでに存在する」デプロイ入力だけで、欠落しているかどうかは feature readiness に委ねます。** `packages/app/featurePreflight.ts` は現在 `packages/config/readiness.ts` の `validateExistingDeploymentInputs` を再 export するだけです。`telegram.json` はプロセスレベルで必須、その他の任意入力（`stickers.json`、`reactions.json`、`mood.json`、`ad_samples.json`、`agent.json`、`g-auth.json`、`prompt/persona.md`）は**ファイルが存在する限り厳密なパースを通らなければなりません**。対応する機能が今オフだからといって不正な内容を見逃すことはありません。ファイルが本当に存在しない場合は起動を妨げません。

  Google 資格情報の解析境界は `packages/config/googleAuth.ts` で、返却値は呼び出し側から読み取り専用です。type は省略可能で、存在する場合は service_account に限ります。SDK が使用するフィールドの不正値は外部接続前に拒否します。フィールド契約は [01 Google 資格情報設定](01-getting-started.md#前提条件) を参照してください。

  **SQLite `chat_states` は起動時の前提照合に関与しません**。グループスイッチは永続化復元の境界でのみデコードされ、ランタイム状態の復元に使われます。資格情報の欠落は各機能の唯一の判定入口が扱います——AI 雑談は `packages/aiChat/availability.ts`（Worker は起動せず、メモリも hydrate せず、`/ai_chat enable` を拒否）、日本語翻訳は `packages/copy/availability.ts`（コマンドは `g-auth.json` を名指しして拒否し、自動 copy は通常コピーへ降格）、広告検出は `adDetectConfigReadiness()`（送出ゲートが bundle を送らなくなる）です。

  `deploymentInputExists` が「本当に未設定」と見なすのは ENOENT だけです。リンク切れの symlink やアクセス不能なパスは「設定済みだが不正」として従来どおり起動を拒否します。報告するのは最初に壊れた入力 1 つだけです。複数が同時に壊れる確率は「1 つ直して再起動」より遥かに低く、まとめて出すと本当に直すべき 1 つが埋もれます。

### データルートとバックグラウンドタスク

- `state.json`、`bot.lock`、`logs/`、`memory/`、`database/` はすべて 1 つの実行時データルートから導出します。production の既定値はプロジェクトルートです。テスト preload は production モジュールを import する前に isolate ごとの一時ルートを注入し、実ファイル I/O が production cache や identity database へアクセスできないようにします。
- 低優先度のグループタイトル保守は、コマンドメニュー、`bot.init()`、Worker hydrate、acknowledgement-safe runner の準備完了後にだけ開始します。title owner の `getChat` は現在最大 25 並列で、履歴補完が query category と network connection を同時に占有する量を制限し、ライフサイクルの quiesce/abort signal を受け取ります。

### 送信リクエストとメッセージの安全性

- **Telegram network capability は main thread に 1 つだけ存在します。** 実 grammY Bot、Bot API HTTP、Telegram file CDN download はすべて main thread から開始します。AI/Anti-Raid Worker は `supervisedDuplexWorker` の構造化 allowlist capability だけを要求でき、grammY runtime、`mainClient.ts`、Bot token を import できません。Worker 世代の失効は本世代の request を abort して waiter を精算し、response の同期 post failure も Promise を永久に残さず、その世代を取り消します。`check:conventions` は各 Worker の runtime import closure でこの隔離を検査し、type-only import は runtime edge に数えません。
- **Worker が duplex proxy 経由で送ったメッセージは、main thread が proxy 境界で self-sent として登録します**（`infra/telegram/workerRequests.ts` の `markWorkerSentMessage`）。`infra/selfSentTracker.ts` は thread ごとに分離されているため、Worker 側の `markSelfSent` はその isolate に記録されるだけで、実際の Bot API 呼び出しは main thread の `bot.api.raw.*` で起き、共有 action 層の登録を迂回します。この一手が無いと main thread は自分が送ったものだと認識できず、channel post の跳ね返りが新しい内容として AI / echo pipeline に流れ込むか、`/set_qa` の投稿入口に認識されてしまいます。登録は応答を Worker へ返す前に行い、判定は method 名の switch ではなく**戻り値の形**（`message_id` があり、数値の `chat.id` がある）で行うため、Message を産む capability が追加されても自動的に覆われます。payload の `chat_id` ではなく結果を読むのは、前者が `@username` 文字列になり得るからです（chat を持たず `MessageId` だけを返す唯一の `copyMessage` は、どちらの Worker の capability allowlist にも入っていません）。登録は Worker が message id を受け取る時点より前に行われ、どちらの Worker も「何を送ったか」を報告し返さないため、この境界が Worker 発の自発メッセージすべてにとって唯一の登録点です。

  **この登録は跳ね返りの競合を狭めるだけで、消しはしません**：登録の時点は送信レスポンスの到着であり、跳ね返りは並行する long poll が先に取得し得ます。したがって、出力を生み、かつ channel post や channel の自動転送を受け取り得る入口はすべて、同期の `isBotOwnMessage` に加えて `needsBotOwnMessageWait` + `waitForBotOwnMessage` の有界 rendezvous を通さなければなりません（`auto/message/index.ts`・`commands/cjkAction.ts`・`commands/qa/ingress.ts`）。rendezvous が成立するのは「登録が必ず届く」ことが前提です。決して登録されないメッセージに対しては `SELF_SENT_RENDEZVOUS_TIMEOUT_MS` を使い切ってから通すだけで、update runner は厳密に直列なので、その間プロセス全体が止まります。
- **grammY throttler に入るのは実際に chat message を生成する method だけです。** `sendMessage`、media/file/sticker send、copy、forward は公式 plugin を通ります。inline answer、chat action、query、kick、restriction、delete、reaction、callback、edit、management は通りません。全 chat の画像とテキストは plugin の global の毎秒 30 send request 枠を共有します。group と private chat は `maxConcurrent: 1` だけで各 chat の送信順序を維持し、`minTime` や個別の reservoir は設定しません。chat ごとの固定送信間隔や能動的な 20/min window はありません。Bottleneck `OVERFLOW` の memory high-water mark は、global 8,192、group ごと 128、private chat ごと 256 です。これを超える新規 message は拒否し、Telegram の処理速度を恒常的に上回る producer が closure を無制限に保持しないようにします。この 3 上限は共有 81,920 capacity に数えず、流用もしません。server-side 429 は main thread の統一 outbound gate が `retry_after` に従って処理します。Inline Mode に公開 send limit がないため、`inline` の adaptive 429 category だけを使います。
- **Telegram outbound はすべて 429 を捕捉しますが、cooldown は category ごとに独立です。** `message`、`inline`、`download`、`kick`、`query`、`restrict`、`delete`、`chatAction`、`reaction`、`callback`、`edit`、`profile`、`management`、`other` が個別の FIFO と `retry_after` を持ち、1 category が他を止めてはいけません。正常 request は直ちに開始し queue capacity に数えません。429 retry waiter と既に cooldown 中の category へ来た request だけが全体 81,920 上限に入り、超過は domain owner へ拒否します。安全処置は verification snapshot または blocklist outbox に残し、retry memory を persistence とみなしません。復帰時は 1 request から probe し、成功後だけ concurrency を増やします。cancel は intrusive FIFO node を O(1) で外します。

  gate は再初期化可能な lifecycle generation も所有します。受理した各 job は caller signal と owner の `AbortController` を合成し、その signal を実際の grammY/fetch 境界へ渡します。drain は最初に admission を atomic に閉じ、予算超過時は active request を abort、すべての 429 timer を解除、pending node を reject、drain waiter を settle します。その後の count は 0 でなければならず、遅れて届く callback が再計数・再 schedule してはいけません。旧 generation の active、pending、timer、waiter がすべて空の場合にだけ次を初期化できます。既に受理された kick retry は quiesce 後も内部 membership revalidation を行えますが、この bypass を通常 caller へ公開しません。
- 汎用 JSON API request は `JSON_API_ALLOWED_ORIGINS` に明記した HTTPS origin だけを許可し、redirect を無効にします。新しい caller は allowlist を明示的に拡張しなければなりません。

  Telegram avatar download は Telegram 所有 asset domain suffix の独立 allowlist を使いますが、HTTPS・credential 禁止・DNS label 境界という同じ URL policy を再利用します。Bot API `file.getUrl()` の主経路と `t.me` の page/image fallback はどちらも redirect を無効にし、読み取り上限を維持します。JSON allowlist へ接続したり、任意の HTTPS 画像を受け付ける形へ戻したりしてはいけません。
- 送信メッセージには `parse_mode` を一切設定しません。表示名やメッセージ本文は純テキストとしてのみ連結し、書式やリンクとして解釈される余地を残してはいけません。リッチテキストが必要な場合は、呼び出し側がテキストを段ごとに組み立て、`entities` を自ら与えます（offset は Telegram の UTF-16 code unit 基準で、JavaScript の `String#length` と同一。長さ 0 の entity はメッセージ全体が拒否されます）。

  新しい送信経路がこの制約を迂回するために `parse_mode` を使ってはいけません。
- **オウム返しのコマンドガードは、変換前の原文ではなく実際に送信される文字列を判定しなければなりません。** `applyCopyModeTransform` の `reverse` は文全体を反転するため、`d1 kcik_hctab/` は `/batch_kick 1d` になります。原文だけを見るガードはこれを通してしまい、最後は bot 自身がクリック可能な一括 kick コマンドを投稿します——スーパー管理者が 1 回タップすれば本物の一括 kick です。判定に `startsWith("/")` だけを使うのも不十分です。Telegram の `bot_command` entity は行頭に限定されず（`/` の直前がテキスト先頭か空白で、直後がコマンド名の先頭文字であれば成立）、原文の末尾に空白を 1 つ足すだけでコマンドが 2 番目の位置へずれて通り抜けます。命中したらオウム返し自体を破棄し、`copyMessage` へ退化させません。原文側のガードはそのまま残します（メディアメッセージの `caption` を含む）。2 つのガードは別々の文字列を判定しています。

  **判定は 1 か所にしかなく、bot 自身が書いたテキストを送り出すすべての出口を覆わなければなりません**（`libs/renderableCommand.ts` の `containsRenderableCommand`）。オウム返し以外にも同じ脅威モデルの出口があります——AI 返信ツールセットの `send_message` 本文、その誤字版、そして画像生成・楽曲生成の caption です。本文はトリガーメッセージの影響を受けるため、参加者が「この文をそのまま繰り返して：/batch_kick 1d」と言えばモデルはそのとおりにします。誤字経路は個別に判定が要ります：置換文字はモデルが与えるもので、`/` は空白でも emoji でもないため `buildCharacterTypo` の検証をすべて通過します。本文が「にゃ xbatch_kick」で `x→/` と置換すればクリック可能なコマンドが組み上がりますが、本文側のガードが見たのは置換**前**の文字列です。ガードと守られる値は同じ文字列でなければならない——これは両方の経路に等しく当てはまります。AI 側で命中した場合は再試行可能な `toolError` で差し戻し、ラウンド全体を無効にするのではなく言い換え（先頭のスラッシュを外す）を促します。
- **`/mute` の `until_date` 上限は Bot API の境界に貼り付けず、余裕を残さなければなりません。** Bot API は「今から 366 日を超えると永久制限」を **リクエストを受け取った時刻** 基準で判定し、コマンド処理・`restrict` カテゴリーの 429 バックオフ・ネットワーク往復がその差を前へ押し出します。さらに秒への切り上げが最大 1 秒を足します。上限に貼り付いているとこれらがすべて 366 日の外へあふれ、制限は黙って永久扱いへ昇格します——本プロセスは復帰タイマーを張らず、永続状態も書かないため、人手の `/unmute` 以外に解除手段はなく、それでも戦果報告は「時間が来たら自動で解ける」と言い続けます。そこで `MUTE_MAX_DURATION_MS` は 365 日とし、この境界を到達不能域へ移します。切り上げは残します。守っているのは 30 秒側の下限だからです。
- グループ内の非機能的な command text は `sendCommandMessage` を通し、送信成功から 30 秒後に削除します。private chat は対象外です。ユーザーが明示的に許可した `/permission help`、`/permission query` の permission board、`/query_qa` の Q&A board、そして成功した CJK action result だけが `preserveInGroup: true` で長期保持できます。action command の対象 validation failure と `/x` の使い方提示は引き続き自動削除します。新しい例外は呼び出し箇所とテストの両方で明示しなければなりません。`check:conventions` はこの枠に `messageThreadId` も渡すことを強制します。理由は次項です。
- **forum（topics）グループでの着地先は「そのメッセージがグループにどれだけ残るか」で決めます。メッセージの種類では決めません**。`message_thread_id` を渡さないことは General への送信と同義で、reply を付けても安全ではありません——返信先が削除済みだと `allow_sending_without_reply` が通常送信へ降格させ、その時 topic に残るのはこの parameter だけです。
  - **長期保持されるものは必ず渡す**：会話的な出力（copy、AI 返信、入浴トリガー返信、Q&A 直答）、上項で挙げた `preserveInGroup` の例外、そして固定遅延削除が保持しない状態機械所有の message（`/set_qa` フォーム、gag の発言提示）。自然に消えないため、topic を間違えれば永久にずれたままです。
  - **期限で自動削除されるものは渡さない**：30 秒で消える command receipt と使い方提示、広告 ban の告知、flood mute の告知。間違っても cleanup までで、そのために topic id を全呼び出し箇所と Worker protocol へ通す価値はありません。
  - **入室認証の reminder は明示的な適用除外**：reply 形式の reminder は未認証メンバーの発言に紐づくため、その anchor が削除されると General に落ちます。しかし state machine が認証確定時に削除し（上限は `VERIFICATION_TIMEOUT_MS`、未送達の極端な場合でも `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS`）、自動削除の枠に入ります。対応するには topic id を未認証 snapshot の形式へ永続化する必要があり、唯一の cold migration 辺を消費します。理由と再評価の契機は `packages/libs/forumTopic.ts` の module 冒頭注釈にあります。
- **起きていない状態変化を応答が報告してはいけません。** `/init`、`/ai_chat`、`/ad_detect`、`/flood_control`、`/antiraid`、`/ja_copy` の 6 つの switch command は書き込み前に必ず元の値を読み、同じ状態で繰り返し実行した場合は「元からそうです」と言い切らなければなりません。変更直後の文をそのまま流用すると、管理者は最初の実行が効いたのかどうか判断できません。4 つの結末の文言は `ToggleCommandTexts`（`packages/types/commands.ts`）という **4 項目すべて必須**の構造に収め、選択は `toggleReplyText` が行います。「on」「off」の 2 文しか用意しない新しい switch command は compile できません。`/quiet`、`/unquiet`、`/white`、`/permission` は同じ方針の既存実装です。

  判定は「目標の状態」と「元の状態」だけを見ます。**永続化や runtime cleanup が実行されたかは見ません。** これらの cleanup はベストエフォートで、失敗しても log を残すだけです（`clearAdDetection`、`clearFloodControl`、`invalidateAiChat`、および `/init disable` の `teardownChatRuntime`——失敗しても総 switch はすでに durable に off なので、応答は「片付け切れなかったものがある」と名指しする文面に切り替え、決して throw しません。throw すれば offset を確定できず、再配信時には `wasEnabled` がすでに false なので、管理者はかえって「もともと off だった」と告げられます）。したがって「disable したあともう一度 disable する」は Worker 復帰後にもっとも自然な手動リトライであり、同じ状態での繰り返し実行でも永続化と cleanup は通常どおり行い、応答だけが「何も変わっていない」と正直に伝えます。`/init` は、すでに有効なチャットで `enable` を繰り返しても管理者身分の記録を無効化しません。無効化すると `recordBotChatPermissions` が新しい `undefined -> true` の edge を見て blocklist 全体を再走査してしまうためです。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## Worker と状態の所有権

### スレッドと状態の帰属

- メインスレッドは Telegram runner、Worker 監視ハンドル、`cache/main/storage.ts` の正式な `state.json` メモリミラーを所有します。`infra/storage/stateStore.ts` はミラーの復元、snapshot 構築、domain accessor を担う業務 facade です。`infra/storage/statePersistence.ts` の `StateStore` は厳密 decode、latest-only atomic write、上限付き失敗 retry、終了時 flush だけを担当します。retry 上限の超過は fatal durability failure であり、runner を停止して update の確認を続けてはいけません。
- AI Worker はグループチャットメモリ、返信の受け入れ、メディア説明パイプライン、グループごとのムード、スタンプカタログ生成の実行時状態を排他的に所有します。
- Anti-Raid Worker は認証・ロックダウン状態機械とタイマーを排他的に所有し、メインスレッドは復元可能なミラーだけを持ちます。
- Disk I/O Worker はログ、AI メモリ、スタンプカタログ、運勢、認証待ちデータの永続化を排他的に所有し、1 つの Worker スレッド内で共有ディレクトリへの読み書きを直列化します。`state.json` は明示的な例外で、メインスレッドが `stateStore.ts` facade 経由で `statePersistence.ts` の `StateStore` を呼び出して非同期に管理します。業務 Worker は共有ディレクトリへ直接書き込みません。
- 長寿命の Map、Set、キュー、timer には、対応する `packages/cache/` モジュールと業務ライフサイクルモジュールが共同で容量、削除、Worker 再構築の意味を定義しなければなりません。
- **キャッシュの所有スレッドはディレクトリ名で宣言し、実際のモジュールグラフで照合します。** `packages/cache/` の第 1 階層が所有者です。`main/` はメインスレッド専有、`workers/aiChat|antiRaid|diskIO/` は各 Worker スレッド専有、`perThread/` は「各スレッドが個別に 1 つずつ持ち、互いに無関係」な状態（Telegram capability holder、Worker duplex waiter、デプロイ設定 singleton、自己送信メッセージ登録）です。

  スレッド間はメッセージのみでやり取りしメモリは共有しないため、**あるスレッド専有の状態を別スレッドが import するのは常に誤り**です。相手の isolate が受け取るのは同じコードの別インスタンスで、書き込んでも所有者側からは永遠に読めません。静的には何も見えず、実行時は「なぜかキャッシュが当たらない」としてしか現れません。

  `bun run check:conventions` が 4 つのスレッドエントリ（`index.ts` と 3 つの `*Worker.ts`）から実行時 import の閉包をたどって照合し（`import type` と `new Worker(new URL(...))` は辺として数えません）、違反時は import 連鎖を全て出力します。唯一の適用除外は `packages/cache/main/diskIO.ts` です。

  `infra/logger.ts` が `infra/diskIO.ts` の `relayLogMessage` に静的に依存し、かつ 4 スレッドとも log を書ける必要があるためで、Worker 側のそれは初期値のまま一度も読み書きされません（理由は当該ファイルのモジュール冒頭コメント）。
- **Worker から到達できるモジュールが main-thread state を必要とする場合、main thread が値を解決して最終 field だけを送ります。** たとえば AI Worker の super-admin ID は `init` message で注入し、Worker は `config/telegram.ts` を import しません。Telegram action は Bot token、client、outbound queue を mirror せず、最小 allowlist payload を main thread へ送ります。自然に remote result が必要な Telegram call だけが duplex 境界を通り、group message の hot path 全体に request/reply を追加してはいけません。
- 業務 Worker と独立した Disk I/O ホストは、同期的な `postMessage` の拒否を明示的な失敗へ統一します。request 型の送信は waiter と timer を即座に削除し、重要業務の拒否は fatal とします。実行中の error ログは、容量、同期拒否、Disk I/O Worker の crash を理由に能動的に破棄しません。業務 Worker → main thread、main thread → Disk I/O Worker の各 hop は最大 32 件の batch を 1 つだけ in-flight にし、producer は ACK まで原 batch を保持して世代交代後に再送します。意味論は at-least-once で、障害境界の重複は許容します。main-thread 側は log batch が実際に flush された後にだけ ACK し、書き込み失敗時は log file の reopen interval まで退避します。新しいログがその退避を迂回してファイル全体を繰り返し読み直してはいけません。

  2 つの待機 FIFO は意図的に無界です。約 15 グループの single-tenant 配備で、ログ転送と永続化は Telegram event の生成速度を十分に上回るため、長期障害時の理論上の memory 増加を受け入れ、process 内では能動的に失わないことを優先します。1 batch の window により、同じ滞留を不可視な Worker mailbox へ無界に clone することはありません。process 終了、または main thread へ渡す前に業務 Worker isolate 全体が kill された場合は、process 内 ACK queue が durable にできる範囲外です。唯一の Disk I/O owner の初期化前は、consumer のない queue を作らず、ログは journal のみに出します。

  並行 batch で `Promise.all` を直接使ってはいけません。独立した固定 task は `Promise.allSettled` ですべての settlement を待ち、項目ごとに failure を集約します。動的 input は固定 worker 数の `runBoundedSettledBatch` を通し、結果に `item/index/attempt` を保持します。追加 retry は domain が retryable と判定した failure だけに限定し、有限 delay list で回数を hard bound し、各 backoff を記録します。Telegram outbound gate など下位 owner が既に retry する場合、呼び出し側は副作用を重ねて実行してはいけません。owner に登録済みの task だけを待つ drain は snapshot を直接 `allSettled` できますが、各 task が既に error の帰属先を持つ必要があり、settlement をエラーの捨て場所にしてはいけません。Disk I/O の runtime recovery は不可分な 1 つの handshake です。

  load 成功後、各 domain は登録順に現世代の scoped transport だけを使って mirror を replay し、非同期処理をすべて await します。その後で復旧窓の上限付き business FIFO を排出し、最後にだけ writable を公開できます。listener の `false`、throw、reject、timeout、または scoped post の拒否は現世代を終了させる fatal failure です。

  旧世代 listener の遅延 settlement が新しい世代へ書き込んだり、activate したりしてはいけません。処理または永続化の確認が必要な caller は `false` を失敗として扱い、対応する Telegram update を確認してはいけません。

- **main thread から Disk I/O への業務 transport は常に有界です。** 待機中と送信中の payload は 45,000 message・推定 64 MiB を共有し、control 用に別途 16 slot を確保します。送信中は最大 128 message の 1 batch のみで、Worker の直列 operation queue は最大 8 operation です。batch 消費 ACK は transport 容量を解放し、domain 永続化 ACK は durable を表します。30 秒の batch ACK timeout または容量拒否は fatal を通知し、最終 flush の経路は保持します。Worker 再生成は業務 FIFO を保持し、read waiter は失敗で完了させます。同世代の mirror replay、FIFO 排出、writable 公開の順に進みます。復元中だけの revision 水位とスタンプ snapshot の object marker は mirror が覆う古い write だけを除外し、後続 update は保持します。

- **Worker の非機能的な群内通知は main thread の送信・清掃境界へ集約します。** AI の rate-limit/topic error、lockdown 解除、認証終端、連投 mute の通知は送信成功から 30 秒後に削除します。送信失敗時は task を作らず、成功後に request が取消されても main thread が清掃を所有します。削除 timer は `unref()` し、失敗は統一 Telegram error log へ送ります。認証ボタンと `/set_qa` form は状態機械が削除し、inline おみくじは inline API を使います。

- **1 件の update あたりの dispatch 形状は性能上のトレードオフではなく、必須の制約です。** grammY は `command`/`on`/`hears` を `filter → branch → lazy` で登録し、`lazy` は**すべての** update で factory を await し、配列を作り、Composer を new します。したがってスラッシュコマンドはすべて共有の `bot.on(":entities:bot_command")` サブチェーンの後ろに収め、`bot` へ個別に登録してはいけません。ゲートの判定は `Context.has.command()` 自身の第 1 段階とまったく同じなので、一致する集合・相対順序・「認めたら終了」は変わらず、`bot_command` entity を持たないメッセージはグループ全体を 1 回で飛ばせます。同じ理由で、グループメッセージごとに前置される 3 つの ingress（Anti-Raid、gag、`/set_qa` フォーム投稿）と、それらが共有する bot 自身の管理者判定は、いずれも `boolean | Promise<boolean>` を返します。定常状態では同期的に返して Promise を確保せず、権限の実照会・実際のメッセージ削除・durable な投稿のときだけ Promise を返し、`app/registerHandlers.ts` の `claimOrContinue` が一括で受けます。

  **Promise を返すか否かは semantics の一部であり、自由に最適化してよい実装詳細ではありません**：durability barrier を待つ経路（参加/退出のサービスメッセージ、認証ボタンの callback）は必ず Promise を返す必要があります。同期的に返すと、書き込みが確定する前に Telegram がその update を確認済みにしてしまうからです。逆に、常に false の同期判定を `async` にすると、グループメッセージ 1 件ごとに Promise の確保と microtask 1 往復を無駄に払うことになります。テストは両方向を固定しています。定常状態は同期返却を、durable な経路は `toBeInstanceOf(Promise)` を検証します。

- **Worker isolate 内の各 timer handle は必ず `unref()` します。** isolate の生存は main thread との message port が担保しており、timer の ref 状態とは無関係です。順序付き停止は各 isolate の drain/flush が先に履行し、その後 main thread が terminate します。したがって timer が単独で isolate の event loop を保持してはいけません。`check:conventions` は `packages/workers/` 配下を handle 単位で照合します。各 `setTimeout`/`setInterval` の代入先を取り、同じ関数本体内で、その呼び出しより後、かつ同じ代入先への次の書き込みより前に `<同じ代入先>.unref()` が 1 回現れることを要求します。代入先を持たない handle（`return setTimeout(...)` のような書き方）も拒否します。main thread は対象外です。そちらには `finally` で片付ける短命な promise race timer や停止のハード期限が別にあります。

### 状態機械の contract

- 状態機械の `State/Event/Effect/Transition/Decision` contract はすべて `packages/types/states/` が所有します。`packages/states/` は I/O のない純粋な状態遷移だけを実装し、interpreter と cache は前者の型へ直接依存します。

  **形態は 2 種類あり、判定対象に永続化すべき離散状態があるかで選びます**。`verification` と `lockdown` にはあり（PENDING/ACTIVE のような状態を Map に保存し、後続イベントが参照します）、`transition(state, event) → {next, effects}` の状態機械形態を取ります。

  `replyAdmission` と `adDetectAdmission` にはなく（規則は呼び出し側が算出済みのスカラーだけを受け取り、コンテナとタイマーは実行時モジュールに残ります）、純粋関数の集合という形態を取ります。後者を無理に状態機械へ押し込むと、「この 1 件」と「スレッド全体で何件」が同じ状態オブジェクトに同居し、両者のライフタイムはまったく異なるため、かえって読みにくくなります。
- **ロックダウンがチャットの既定 permission を読み書きするときは、毎回 `use_independent_chat_permissions: true` を渡します**（封鎖の適用、期限切れの復元、遅れて届いた復元回答の後の再適用、そしてメインスレッドの onGiveUp 緊急復元。境界は `packages/infra/telegram/lockdownPermissions.ts` と `lockdownRuntime.ts` の 2 か所）。この経路は `getChat().permissions` をそのまま読み戻し、`can_invite_users` だけを変えて書き戻すので、true の項目が必ず含まれます。このフラグが無いと Bot API は `can_send_other_messages` を `can_send_messages`・`can_send_audios`・`can_send_documents`・`can_send_photos`・`can_send_videos`・`can_send_video_notes`・`can_send_voice_notes` へ展開します（`can_send_polls` は `can_send_messages` を含意）。その結果、「スタンプ / GIF は許可、画像・動画・ファイルは禁止」に設定したグループは、ロックダウンを 1 回出入りするたびにメディア権限を黙って全開にされ、管理者には何も表示されません——両境界の契約はまさに「その他の既定 permission は Telegram の現在値に従う」ことなのに、です。
- **封鎖告知は placeholder が置かれたその瞬間に送り、そのラウンドの終わりに削除します**（`LockdownState.announced` と `announcementMessageId`）。`APPLYING` の placeholder が置かれた時点から、入室した人は——メンバーに引き込まれた人も含めて——即座に退出させられます。だから告知は既定 permission の読み取りより前に置きます：なぜ誰も入れないのかをグループが同時に知る必要があるからです。送信成功で返る message ID はレコードと一緒に永続化し、そのラウンドの復元完了時にそれで告知を削除します。告知が着地する前にラウンドが終わった場合（既定 permission の読み取り失敗、その間の解除）は、遅れて届いた送信結果を `INACTIVE` の分岐がそのまま削除に使い、孤児の告知を残しません。削除失敗はログだけで、復元を妨げてはいけません——解除の要は招待 permission を返すことです。

- **解除告知は、封鎖を実際に告知していた場合にだけ送ります**（`announced`）。`RESTORING` への入口は 2 つあります。通常の期限切れ・手動解除と、`setChatPermissions` が throw した後の補償照合（`applyResult(!ok)`）です。告知の送信に失敗したラウンドの `announced` は false のままで、その復元が成功しても「制限を解除しました」だけをグループへ送ってはいけません——封鎖告知を一度も受け取っていないチャットには前後の脈絡がない一文になります。

  告知の記帳は「このラウンド」に属し、すべての段階をそのまま引き継ぎます。`RESTORING ──再度しきい値超過──> ACTIVE` の戻り経路も同様です（その遷移は封鎖告知を再送しないため、そこでリセットしてはいけません）。`announced` と `announcementMessageId` はどちらも SQLite に入れなければなりません。永続化レコードの形は `{phase,intentId,originalPermissions,announced,announcementMessageId?,expiresAt}` で、message ID は送信成功からしか生まれないため、decoder は「未告知なのに ID を持つ」を拒否します。`applying` phase も「告知済み」になり得ます——告知は intent より先だからです。「送信中」は memory 上だけの情報です：新しい世代は前の世代の送信結末を追認できないため、永続化レコードが「未告知」と言い、かつロックダウンを続けるべきなら、もう一度だけ告知します（`RESTORING` は終息中なので除きます。そこで告知しても前後がつながりません）。`reportUnlock` は告知とは別件で、どの経路でも発行します——メインスレッドが永続化レコードを消すために必要だからです。

- **`LOCKDOWN_MS` は 1 ラウンドの長さであり、同時にその上限です。** 復元時刻はラウンドが `ACTIVE` に入った瞬間に確定し、その後どれだけ人が流入してもタイマーを組み直さず、永続化もやり直しません。期限が来たら本当に解除しなければなりません——permission を返し、告知を削除し、解除通知を送る——そしてそのチャットの入室スライディングウィンドウを空にします。ウィンドウがなおしきい値を超えるなら、次の入室が**新しい**ラウンドを開きます。逆（しきい値超過のたびにカウントダウンを満額で組み直す）をやると、継続的な荒らしが同じラウンドを無限に延長でき、グループから見れば「5 分経っても解除されない」になり、しかもエラーログは 1 行も残りません。解除時にウィンドウを空にしないのも同罪です：その 45 件以上のタイムスタンプは、まさにこのラウンドが蹴り出した人たちのものなので、残しておくと解除直後の 1 件目の入室が即座に再ロックし、上限は紙の上だけの数字になります。

- **`getChat().permissions` は入口で永続化 schema が知る field 集合へ収束させます**（`packages/libs/chatPermissions.ts` の `normalizeChatPermissions`）。その field 集合を決めるのは Telegram だけです：プラットフォームが permission key を 1 つ増やしただけで、応答をそのまま `ChatState.lockdown.originalPermissions` へ保存すると永続化の自己検査（`database/codec/chatState.ts`）が致命的エラーになり、ラウンド全体が `APPLYING` で固まります——即時退出は止まらず、カウントダウンはそもそも設定されないまま——そのうえ、そのチャットのその後すべての状態書き込みが道連れで失敗します。厳格な decoder が守るのは**こちらの**永続化フォーマットであり、プラットフォーム応答は入口で収束させます。収束は保存するスナップショットにだけ適用します（復元が読むのはその `can_invite_users` だけ）。Telegram へ書き戻す read-modify-write は、その場で読み戻した元のオブジェクトを渡し続けなければなりません。未知の field を落とすことは、そのグループの新しい permission を黙って切ることだからです。

- **永続化できない lockdown intent は必ず fail-safe に開きます**（`persistFailed`）。永続化は「クラッシュ後も誰かがこの制限を解除できる」唯一の根拠なので、それを失った以上グループをロックしたままにはできません：`APPLYING` は placeholder を撤回し（Telegram には触れていない）、`ACTIVE`/`RECONCILING` は永続化受領を待たずに即座に復元を開始し、その受領待ちだった `RESTORING` はそのまま復元します。メインスレッドは memory と disk の両方からそのレコードを消します——memory に残せばそのチャットのその後の状態書き込みが道連れで失敗し、disk に残せば次回のプロセス起動が「誰も復元していないロックダウン」を adopt して新規入室を蹴り続けます。破棄されたラウンドは同時に `LOCKDOWN_RETRIGGER_COOLDOWN_MS` のクールダウンに入ります（既定 permission を読めない 2 経路も同様）：この種の失敗は同じチャットに対しておおむね系統的である一方、トリガー判定はしきい値を超えるすべての入室にぶら下がっているため、クールダウンが無いと 1 人入るたびに告知と API 往復をやり直します。クールダウンは、実際にラウンドを破棄するその遷移で状態機械が発行します。遅延・重複した失敗通知が世代交代済みの状態に届いても、健全なラウンドを巻き添えにしないためです。クールダウン中も入室は通常どおり計数され 1 人ずつ検証されます。private mode に入らなくなるだけです。

- **Worker イベントの lockdown レコードは、memory 上の `ChatState` に載せる前に永続化の自己検査を通します**（`assertPersistableLockdown`）。`ChatState` は memory へ先に書き、あとから永続化します：検査を通らないレコードを載せることは、そのチャットのその後すべての状態書き込み（あらゆる切り替えコマンド）を throw させることであり、その例外は捕捉されない経路を通って update 処理ごと落とします。門番は入口に置き、`encodeChatStateData` まで待ってはいけません。

- **同じ applying intent の `commitApply` は 1 回だけ発行します**（`commitStarted`）。永続化受領は同じ `phase + intentId` に対して複数回届き得ます——告知結果の永続化も、メインスレッドの照合ループの再走行も、もう 1 回発行します——一方 `commitApply` は本物の `setChatPermissions` 呼び出しです：結果は冪等でも往復は無駄であり、「受領のあとちょうど 1 回 commit する」という契約が有名無実になります。永続化済みと分かっている intent を adopt するときは、その場で発行する `commitApply` と一緒にフラグを立てます。

### AI チャットの実行時

- `/query_mood` と `/switch_mood` は、メインスレッドの request/waiter と AI Worker acknowledgement による handshake を共有します。前者は任意のグループメンバーが現在有効な mood を強制再抽選なしで読み取り、後者だけが `isCanSwitchMood` を確認して再抽選します。メインスレッドは送信前に waiter を登録し、timeout、Worker crash、再起動断念、停止時に統一して精算します。request は絶対 deadline を持ち、Worker は読み取りまたは再抽選の前に期限切れ request を拒否します。request ID、chat ID、期待する event type がすべて一致する `moodQueried` / `moodSwitched` acknowledgement だけが結果を証明します。その後の Telegram reply 失敗を query または再抽選失敗へ書き換えてはいけません。
- AI チャットの invalidate は、完了を待てる cancellation 境界です。各チャットで最初の generation-sensitive task を受け入れると、その Worker isolate 内で二度と再利用しない一意 epoch を割り当てます。

  invalidate は現在の epoch を同期的に削除し、旧 generation を abort して未開始作業を消去した後、その epoch に登録された返信 round、rate-limit 通知、media description、memory compaction の task が settle するのを待ってから `chatInvalidated` 応答を返します。

  **この待機には上限が必要です**（`AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS`。メインスレッド側の `AI_CHAT_INVALIDATE_TIMEOUT_MS` より明確に短くすること）。

  登録された task がすべて abort を受け取れるわけではありません——memory compaction と media description の 2 本は、現在この generation の `AbortSignal` を受け取って model request へ伝播しておらず、resampling interval と SDK request timeout を合わせると最悪で数分走ります。`Promise.race` 用の unref expiry timer は、task と timeout のどちらが先に完了しても `finally` で clear し、完了済み invalidate の closure と Promise を deadline まで保持してはいけません。

  上限なしで待つと、`/ai_chat disable` がミラーブロックの rotation と重なった一度だけでメインスレッドが先に reject し、その例外が grammY のミドルウェアへ抜けます——その update は失敗扱いになり、最終 offset は保留され、再起動後に Telegram が同じコマンドを再配信します。時間切れでは降格して先へ進み、エラーログを 1 行残します。正しさは待機に依存していません——登録された task はすべて generation を自己照合し、無効化後は何も書き込めません。

  遅延 task は副作用のない epoch 照合だけを行い、entry 回収後やチャット再有効化後に古い token が復活することはありません。したがって epoch Map は過去のチャット総数ではなく現在の active work と同程度に保たれます。メインスレッドが invalidate 完了を報告できるのは、メモリ削除の永続化と Worker の確認応答が両方成功した後だけです。
- model request の transport、network、429、5xx retry は選択された provider の公式 SDK だけが所有します（Gemini は `@google/genai` の `retryOptions`、OpenAI は SDK の `maxRetries`。いずれも初回に加えて最大 5 retries で揃えています）。どちらの SDK も timeout は**試行ごと**の期限であるため、aiChat の 2 つの最下層ラッパー（`aiChat/gemini/client.ts`、`aiChat/openai/client.ts`）は `libs/abortSignal.ts` の `signalWithTimeout` で呼び出し全体（全 retry と backoff を含む）を覆う deadline を合成して渡します。signal が発火した時点で SDK は残りの retry を短絡するため、最悪のハングは試行回数を掛けた値ではなく `GEMINI_REQUEST_TIMEOUT_MS` / `OPENAI_REQUEST_TIMEOUT_MS` そのものになります。caller の invalidate signal はこの deadline と合成され、置き換えられることはありません。1 回の request が `failureKind: "request"` で失敗した後、caller が full request retry をもう一層重ねてはいけません。domain-level resampling は SDK request が成功しても model response が使用不能または異常終了した場合（`failureKind: "response"`）、あるいは normalize 後の text が空の場合だけに許可し、request 数、latency、一時 allocation の乗算を防ぎます。
- AI model call は Telegram gate に入りませんが、同じ provider・`base_url`・API key は 1 つの quota lane を共有し、model 名では分割しません。1 lane は active model request 16、未開始 task 128、background waiter 32 が上限です。interactive を 8 件連続で開始した後は、待機中 background を 1 件通します。SDK retry は元の slot を維持し、local queue が満杯なら prompt や media bytes を無制限に保持せず domain failure を返します。Telegram message pressure は random interjection を止め、同一 chat の direct trigger concurrency を 1 に下げるだけで、provider queue と Telegram queue は独立のままです。
- 返信 action tool は同期的に検証し、call ID ごとに `success: true, queued: true, actions_used` を返します。これは実際の message ID を含まない受理通知であり、不正な呼び出しには直ちに error を返します。受理した呼び出しごとに独立したチェーンが生成、自然な待機、Telegram の送信待ちとキュー側の再試行を所有します。同一ラウンドの action は tool 呼び出し順に進み、追送と自己記録は実結果を待ちます。ラウンド全体は受信順に送信され、後続ラウンドが先行ラウンドの本文・訂正・caption の間へ割り込むことはありません。失敗の記録と後処理はチェーンが担い、モデルは受理済み action を再投入してはいけません。

  `view_sticker_pack` は待機や送信完了を待たず、そのラウンドの実際のメニュー番号・名前・説明を同期的に返して閲覧意図を記録します。1 ラウンドに異なる 5 パックまで、同じパックは 1 回だけ閲覧でき、送信は閲覧済みの同じメニューを参照します。天気とグループ QA は既存データだけを読み、問い合わせ枠は action 予約から独立しています。

  `activeReplyCounts` はモデル処理が未完了のラウンドだけを数え、同一チャットの上限は `REPLY_ROUND_MAX_CONCURRENT`（現在 5）、Telegram の高負荷時は 1 です。`pendingReplyTriggers` は AI 処理未開始の直接 trigger だけを保持し、容量 `REPLY_TRIGGER_QUEUE_MAX`（現在 15）と溢れ処理を維持します。`replyDelivery.ts` は AI Worker 所有の `replyDeliveryWindows` にチャットごとに 5 個の固定バケットを持ちます。各バケットは複数ラウンドを FIFO で保持でき、モデル並行数の定数は送信待ちの総数を制限しません。ラウンド開始時に受信順の送信位置を予約して待機キューから外し、その後でメディアを解析します。モデル終了時に完全なチェーンを commit し、モデル枠を直ちに解放して `onModelFinished` で次を開始します。送信は準備済みの先頭だけを実行し、未準備の枠を待ち、空返信や失敗の完了項を飛ばします。実送信とリソースの後処理が終わった後に送信位置を順に回収し、`onFinished` が溢れ通知を処理して追加の排出を試みます。空の窓、チャット無効化、reset はキャッシュを削除し、Worker 再構築は空から始まります。旧世代の遅延回収は新しい窓を削除できません。5 分間のレート制限、trigger FIFO、provider lane、Telegram throttler、分類別 429 キューは各境界で制御します。全チェーンと心拍の後処理、スタンプのロック解放、送信位置の回収が終わるまでラウンドを generation task 集合に保持します。どちらの完了通知が例外を投げても後処理を省略してはいけません。無効化と停止の signal は実要求と再試行キューまで届きます。メモリの容量整理はモデルまたは現 generation の task があるチャットを優先的に避け、全候補が稼働中なら LRU に従います。実送信に成功したメッセージと Telegram が返した返信関係だけを自己記録し、受理通知は記憶に書きません。
- AI 返信は、テキスト、スタンプ、リアクション、画像、楽曲を受理した時点で統一 action budget を同期的に予約します。モデル向け prompt 上限は 8、実行側 hard cap は 11 です。スタンプ、リアクション、生成画像、生成楽曲はそれぞれ最大 1 回だけ受理でき、その他の action tool に per-tool call cap はありません。楽曲メッセージのカバー画像は**計上しません**——それはメッセージの装丁であってメンバーが求めた画像ではないため、画像生成の cooldown も消費せず、自己記録にも入りません。スタンプパック表示は独立した lookup cap を持ちます。サーバー側ウェブ検索の 1 返信あたりの回数は prompt に書き込んだ soft limit で、実行側は計上と上限超過時の記録だけを行います。custom function call 全体にも round 単位の loop guard があり、超過した呼び出しは「予算切れ、ツール呼び出しを止めて締めくくれ」という tool result だけを受け取ります。これらの上限は action hard cap と同様に実行側だけで履行し、いずれも round 途中でツール宣言を変えてはいけません。

  受理した action が 0 件の場合だけ、最終本文を `send_message` から fallback 送信します。意図的に表示するすべての文字列は、モデルがツールを明示的に呼び出して produce しなければならず、最終応答本文に置いたままにしてはいけません。

  **可視テキストの出口はちょうど 3 つです**：単独の発言は `send_message`、そのラウンドの `generate_image` が生成した画像に添える一言は同ツールの `caption`、`generate_song` が生成した楽曲に添える一言はそれ自身の `caption` を通ります。caption 付きの生成は Telegram 上**1 通**のメッセージ（`message_id` も 1 つ）なので action も 1 つだけ計上し、自己記録も 1 件に統合しなければなりません。caption が `TELEGRAM_CAPTION_MAX_CHARS` を超えた場合、Bot API は truncate ではなく送信ごと拒否するため、実行側は「caption なしの画像 + 独立したテキスト 1 通」に降格し、受理時に `actions_used: 2` を予約します。残りが 2 枠未満なら画像だけを受理し、受理通知に `caption_delivery: "no_action_budget"` を返します。誤字本文と追送する訂正文字も受理時に 2 枠を予約し、訂正は本文の実送信後に実行します。

  **同じ返信ラウンド内の重複テキストは送信前に静かにスキップします。** `send_message` の本文と `generate_image` / `generate_song` のモデル caption は `modelAuthoredTextPolicyResult` を共有します。通常のテキスト整形後、比較時だけ空白をまとめ Unicode NFC で正規化し、そのラウンドで受理したモデル本文・caption・実行側が予約した訂正文字と全文一致で判定します。語句・大文字小文字・句読点は区別し、意味の類似度による強制拒否は行いません。一致時は `{"success":true,"skipped":"duplicate","actions_used":0}` を返し、入力状態・生成要求・cooldown の取得・Telegram 送信・メモリへの自己記録を開始しません。受理後の失敗や取消しでは予約枠を戻さず、モデルによる再投入も認めません。受理前に拒否した呼び出しは枠を消費せず、重複判定の状態はラウンド間で共有しません。

  system prompt は同じ内容を一度だけ表現し、言い換えやアクション数合わせで繰り返さないよう要求します。現在の trigger に既に応答済みで新しい内容がなければ終了し、queue 再実行にも同じ規則を適用します。スキップ結果も call ID と対応させて SDK 会話へ返します。モデル出力とツール結果は末尾への追記だけとし、履歴・暗号化された推論・思考署名・そのラウンドのツール宣言を保持します。

  **楽曲側はこの降格を使わず、schema の時点で予約分を引きます。**実行側が caption の末尾に曲情報（曲名/演奏者/container/サイズ/bitrate）を付けるため、モデルが書ける部分の上限は「Telegram の hard limit から metadata 予約分を引いた値」で、超えた場合は引数 error として書き直させます。判断が分かれるのはコストが非対称だからです。画像側の追送は画像が生成済みの後にしか起きませんが、こちらの「画像」は数分待って 1 曲ごとに課金される楽曲であり、失敗し得る追送分岐を増やしても得るものがなく、最も高価な呼び出しに終わり方をもう 1 通り足すだけです。予約は必ず**モデルが書く側**から引きます——連結してから超過に気づいた時点で失うのは、すでに課金済みの 1 曲です。thumbnail（カバー画像）の 3 つの必須条件（JPEG・長辺 320 以下・200 kB 未満）も同じで、どれか 1 つでも満たさないとカバーが出ないのではなく送信ごと拒否されるため、圧縮は送信境界の手前で終えておく必要があります。

  **`generate_image` と `generate_song` は直接トリガーのラウンドだけに載せます。** メンバーが Bot を直接 @ / 返信した場合、または `directTriggerReason` 付きのメディアで直接呼び出した場合だけ、`replyRound.ts` が `mediaToolsRequested` を true にし、`createReplyToolset` が各 provider capability の有無に従ってツールを載せます。ランダムな自発返信と非直接のメディア評価では両 provider を参照せず、対応 schema もモデルへ公開しません。この資格はツールの可視性だけを制御し、実際に創作するかはモデルが判断します。

  並行枠が埋まって queue に入った直接 trigger は、追い出し実行中に rate limit の関門に拒否されたら queue の先頭に留め、そこで排出を止めなければなりません。rate limit はそのチャットの window 内の回数だけを見ており、どの trigger かとは無関係です。

  最初の 1 件が拒否されたなら後続もすべて拒否されますし、拒否では並行カウントが増えないため、そのまま進めると 1 回の同期 tick で @ メンションと返信の queue を丸ごと捨てることになり、その全員が 1 件も返信を受け取れません。
- AI 返信の受け入れは 2 つの独立した関門で、その間には「キューに入って補走を待つ」という長さの読めない中間状態が挟まります。並行関門（`admitTrigger`）はトリガー到着時に判定し、レート関門（`admitRound`）はラウンドを実際に始める直前に 5 分スライディング窓で判定します。

  **キューが空でない間は、並行枠が空いていても必ずキューへ入れます**。キューは FIFO であり、すでに 1 ラウンド待った人たちの前に新しいトリガーを割り込ませると、その意味論がまるごと反転します——窓が開いた瞬間に最初に走るのは到着したばかりの 1 件で、キューの人たちは数分待たされたままです。

  待機キューには 4 つの駆動源があります。モデル処理完了時の `onModelFinished`、実送信の後処理完了時の `onFinished`、新しい trigger の入隊直後の試行、AI Worker の保守 tick（`drainPendingReplyQueues`）です。モデル終了時は送信完了を待たずに次の処理を開始できます。

  入隊直後の試行と保守 tick は「稼働モデルなし・キュー非空」のチャットも再開します。レート制限による拒否はラウンド task を作らないため、窓に余裕が戻った後の先頭処理は保守 tick が再開します。

  4 つとも `drainReplyQueueIfWindowAllows` で 5 分窓の余裕を確認し、飽和中はそのまま戻ります。実際のラウンド開始時にも `admitRound` を通ります。モデル完了の callback は待機キューの排出だけを行い、溢れ通知は送信が順に完了するまで保持します。

  **溢れ通知の送出はキュー押し出しとは別経路でなければなりません**（`flushOverflowNotice` と `drainReplyQueueIfWindowAllows`）：`enqueueOverflow` がグループに負っているその 1 行は窓に余裕があるかどうかに関係なく出す必要があり、同じ関数にまとめると、ゲートを付ければ通知が永久に飲み込まれ、外せば上の連投が戻ってきます。

  窓がまだ満杯のグループは飛ばします——無駄に 1 回試すたびにレート制限の案内（自体 60 秒のクールダウン付き）が送られ、毎分 1 行グループに流すことになるからです。先に入れてから押すので、順番は先着順のままです。
- メインスレッドの AI 活動量・確率レイヤーは、ランダムな自発返信の受け入れ関門であり、AI 返信ラウンドの rate limit ではありません。表示されたグループメッセージはまずそのチャットの sliding window に入り、最近のメッセージが多いほどランダム発火率が上がりますが、活発なチャット向けの上限に達するとそれ以上は上がりません。チャット間で活動量を共有せず、プロセス再起動時は冷たい状態から始まり、直接トリガーはこの確率関門を通りません。調整値は `packages/consts/aiChat/rateLimit.ts` に集約し、文書は現在値ではなくこの意味論だけを固定します。

  この activity table は全グループメッセージが通る JIT hot path でもあります。既存 chat の hit は固定 shape の `AiReplyActivityEntry`（`timestamps`、`lastAccessSequence`、`lastObservedAt`）をその場で更新し、`Map.delete` + `Map.set` で並べ直したり、一時的な compound key や projection object を allocation したりしてはいけません。満杯の有界 table へ新しい chat を挿入する cold path だけが table を scan して LRU を選びます。window timestamp、capacity、eviction order、wall-clock rollback protection は性能変更でも維持する semantics です。

  **1 件のグループメッセージにつき壁時計を読むのは 1 回だけ**：`handleIncomingMessageMiddleware` が入口で `Date.now()` を 1 回だけ取得し、活動量ウィンドウへの記録・沈黙期間の判定・ランダム返信のクールダウン確保はすべてこの値を使います（`MessageTriggerContext.now` で下流へ渡します）。Anti-Raid 側も同様で、`enqueueAdCandidate` が受け取った `now` はそのまま管理者キャッシュの TTL 判定まで届きます。`now` を取る関数は必ず明示的な実引数を受け付け、メッセージごとに通る呼び出し点では値を渡し、デフォルト実引数は低頻度のコマンド経路にのみ残します。理由は 2 つあり、どちらも欠かせません。意味論上、同じ 1 件のメッセージに対する各判定は同一の時刻へ揃っていなければならず、別々に時計を読むとミリ秒境界をまたいで矛盾した結論に達します。工学上、壁時計読み取りのコストはホストの clocksource に完全に依存します。VM が vDSO の高速経路を持たないソースへフォールバックすると 1 回の読み取りがマイクロ秒に達し、判定そのものより 2 桁高くつくうえ、syscall によるキャッシュ汚染が同じ関数内の他の処理まで遅くします。
- **4 種類のメディア（画像 / スタンプ / GIF / 音声メッセージ）は 1 本の「プレースホルダー → 非同期解析 → その場で書き戻し」パイプラインを共有します**。重複排除 cache、有界 executor、書き戻しの順序はいずれも 1 つしか存在せず、種類ごとの差分は「vision 記述か音声文字起こしか」という 1 か所の分岐だけに落ちます（`packages/aiChat/ai/imageDescription.ts` の `resolveMedia`）。音声に別のパイプラインを立てると、同一メディアの並行マージ、容量による追い出し、executor スロットの競合をもう一度書くことになり、そこはまさに test で押さえるのが最も難しい部分です。

  カタログ外のメディア説明は AI Worker の `transientDescriptionCache` を共有し、`file_unique_id` ごとに最大 4,096 件の Promise を保存します（`MEDIA_DESCRIPTION_CACHE_MAX`）。ヒット時は LRU 順序を更新し、容量超過時は最も長く未使用の項目だけを追い出します。失敗結果は削除し、TTL は設定しません。同じメディアの処理中要求は Promise を共有し、Worker 再生成時は空の cache から始めます。許可済みスタンプのカタログは独立して復元し、この LRU の枠を使わず、その追い出しによって削除されることもありません。

  **音声の 2 つの上限（長さ・申告サイズ）はダウンロードの前に判定しなければなりません。**Telegram の update には最初から `duration` と `file_size` が載っている一方、ダウンロード側の byte gate は全体を引き終えてからでないと超過を知れません——1 時間の音声メッセージは media executor のスロットと帯域を丸ごと空費した挙げ句、得られるのは fallback placeholder 1 行だけです。弾かれた音声は時間付きの `[语音 N 秒]` の平文 1 行に退避します。**弾いているのは文字起こしであって返信ではありません**——直接トリガーには必ず何か返します。既読スルーは「長すぎて聞けなかった」と言うより悪いからです。音声 byte は transcode しません（voice note は常に OGG/Opus で、multimodal endpoint は `audio/ogg` を受け取ります）が、byte 上限は vision 側よりはるかに小さくする必要があります：音声は base64 として request に inline され 4/3 に膨らむため、16 MiB を流用すると 20 MB を超えて encode され、request ごとサーバー側で拒否されます。文字起こしの切り詰め上限もメディア記述より緩めです——それはモデルの要約ではなくメンバーの**発言そのもの**であり、途中で切るとモデルが見当違いの返事をします。

- ホワイトリストのスタンプパック目録の突き合わせを、Worker の `init` 受信時 1 回だけにしてはいけません。

  `generatePackCatalog` は `getStickerSet` に失敗するとそのパックを丸ごと諦めますが、systemd 管理のプロセスは数週間動き続け得ます——初回デプロイ（`memory/stickers/` が空）で数秒のネットワーク不調に当たると `catalogs` は永久に空になり、`view_sticker_pack` と `send_sticker` の 2 つの tool がすべての返信で null を返します。

  そこで保守 tick が `STICKER_CATALOG_RETRY_INTERVAL_MS` ごとに、**目録が空、またはパック要約が欠けている**パックだけを再試行します（`retryIncompleteStickerCatalogs`）。

  **1 枚単位の説明生成失敗の記録（`failedEntries`）も同様に TTL 付きの negative cache でなければならず、恒久的なラッチにしてはいけません**（`STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS`）：`getStickerSet` は成功しても vision endpoint が丸ごと使えない（quota 枯渇、鍵のローテーション直後、media task の飽和）とパック内の全枚数がこの表に入り、恒久ラッチだと上の再試行が毎周期正しくそのパックを選び直しても `generatePackCatalog` は 1 枚ずつその場でスキップし続けます——目録は永久に埋まらず、それはこの再試行が防ぐはずだった結末そのものです。

  `failedPacks` が `STICKER_SET_FAILURE_RETRY_MS` を使うのと同じ理由で、2 段ある失敗記録の片方だけが自己修復するのは許されません。正常化した後は毎回の空判定だけでリクエストは飛びません。間隔を保守 tick 自体ではなく分単位にするのは、パック名の設定ミスのように決して直らない場合、再試行のたびにエラーログが 1 行増えるからです。

### AI プロンプトと transcript

- AI 返信は provider 中立の固定ウェブ検証説明（`WEB_SEARCH_INSTRUCTION`）を 1 つだけ使い、同じ返信内のすべてのモデル request で同一の system prompt を再利用します。変化する現実情報や確認できない検証可能な事実について検索ツールがある場合は、可視 action より先に検索します。主観的な会話、創作、transcript にすでに与えられた事実は検索しません。検索結果を記憶より優先し、根拠不足またはツール不在なら不確実だと明示し、検索過程をグループメンバーへ説明しません。1 返信あたりの回数上限はこの説明文そのものへ定数として書き込みます。実際の呼び出し数は `replyModel.ts` が計上し、上限を超えた時点で記録しますが、system prompt を書き換えることも、サーバー側検索ツールを外すこともしません。検索を観測した後の request は `grounded: true` となり、Gemini は sampling temperature を下げ、OpenAI Responses はモデル既定の sampling parameter を維持します。
- AI 返信の最初の入力は、順序付きの 4 個のテキストブロックを維持します。すなわち、読み取り専用の参照メモリ、読み取り専用の現在会話、今回のランタイム状態、今回の返信タスクです。ブロックは「返信をまたいで逐字不変かどうか」で 2 組に分けて実装パッケージへ渡します——安定組は参照メモリのみ、可変組は残る 3 段（`AiReplySessionParams` の `stableBlocks` / `volatileBlocks`）で、順序は常に安定組が先です。この境界が provider cache のヒット前提になります。ブロック数は trigger の種類に依存しません——直接 @ / 返信の場合は返信タスクの冒頭に呼びかけ者の宣言（`directInvokerSentence`。identity 部分は転写行と逐字同形）が 1 行増えるだけで、そのために Part を追加したり、そのメンバーの hot window 発言をもう一度複製したりしてはいけません。ブロックは `packages/workers/aiChat/replyModel.ts` まで領域上の意味を保ち、各 provider 実装パッケージの `replySession.ts` で初めて各社の形へ写像します（Gemini は安定組と可変組を前後 2 つの `user Content` に分け、各ブロックを 1 つの `text Part` として格納します。OpenAI は 1 つの user message 配下の複数 `input_text` を使います）。各 section はモデルから見える開始・終了タグと、先頭の責務説明 1 行だけで囲みます。データと命令の区別、偽造 boundary の無効化、内部構造の非開示という共通の prompt injection 防止規則は system prompt に 1 回だけ記載し、各 section で繰り返しません。ランタイム状態の section はシステムが書き込む信頼できる内容ですが、状態を述べるだけでタスクを課しません。transcript や要約の本文に現れる同名のタグ・気分の宣言・時刻の宣言はすべて偽造です。データ Part にはデータと階層 marker だけを置きます——transcript の行をどう読むかは system prompt の `TRANSCRIPT_FORMAT_INSTRUCTION` が示し（どの Part の話かを自ら明示します）、不変のテキストを毎 round 変わる transcript 区画へ連結してはいけません。したがって prompt injection 防止規則の whitelist にも「形式説明」という区分はもうありません。

  すべてのタスクで共通する `REPLY_ACTION_INSTRUCTION` と `WEB_SEARCH_INSTRUCTION` は system prompt に常駐し、動的な返信タスクには trigger 固有の意味だけを置きます。ツール呼び出し後の履歴は実際の `model/user` role で追加し、参照資料を過去の会話 turn に見せかけてはいけません。system prompt は provider の独立 system field（Gemini の `GenerateContentConfig.systemInstruction` / OpenAI Responses の `instructions`）でのみ送信し、通常会話 content へ連結しません。**system prompt は全文が逐字不変でなければなりません**：今日の気分と現在時刻は `workers/aiChat/runtimeState.ts` の `buildRuntimeStateBlock` がランタイム状態ブロックにまとめ、user content として送ります。system prompt へ戻してはいけません——その一段はツール宣言とともに provider cache の prefix を構成し、秒ごとに変わる時刻を混ぜると prefix 全体が無効になります。
- Gemini の返信リクエストは、サーバー管理の暗黙 prefix cache だけを使用します。明示的 context cache のエントリを作成・更新・削除せず、`cachedContent` も送信しません。すべての request は、静的な `systemInstruction`、その round の `tools`、必要な `toolConfig`、完全な `contents` を毎回送ります。安定した参照メモリは、可変な現在会話・ランタイム状態・返信タスクより前に置き、後続の model turn と `functionResponse` は `contents` の末尾にだけ追加します。現在時刻、機嫌、参照素材の寸法などの動的値を system prompt やツール宣言へ入れてはいけません。置いてよいのはランタイム状態 block だけです。画像生成と楽曲生成のグループ cooldown はさらに厳しく、どの prompt block にも書かず、ツールが実際に呼ばれたときに実行側だけが判定し、残り秒数をその場で model へ返します。同じ業務形態ではツール宣言の内容と順序を逐字一致させ、さらに**1 回の返信の中では `tools` とサーバー側検索ツールの搭載を一切変えません**——action hard cap、function call 予算、検索回数のいずれもツールを外してはいけません。唯一の例外は、provider がサーバー側 tool call 上限を報告した後の 1 回だけの降格 retry で、その response はもともと使えません。返信をまたぐ場合は、ツール資格、persona の更新、bot identity の変化、cold memory の圧縮など、実際の意味が変わるときだけ prefix の変化を許します。これにより、返信間の安定 prefix と同じ返信内でツール往復に伴って伸びる prefix の両方を維持し、ヒット有無と保持期間は Gemini サーバーだけが決定します。すべての OpenAI protocol request も安定 content を可変 content より前に置き、安定 prefix から計算した chat 単位の `prompt_cache_key` を送ります。SDK 既定の公式 endpoint を使う GPT-5.6 family だけが最後の安定 block の後ろへ明示的 `prompt_cache_breakpoint` を置き、30 分 TTL の `prompt_cache_options.mode: "implicit"` も維持するため、返信間の安定 prefix と返信内で成長する prefix の 2 種類の breakpoint が共存します。旧モデルと custom compatibility endpoint へは、これら GPT-5.6 専用 field を送ってはいけません。
- 直接 @ / 返信されたときの読み方は、system prompt に常駐する `DIRECT_INVOCATION_READING_INSTRUCTION` が推論の順序として定めます。まず `【最热记忆】` を通読してグループで今なにが起きているかを把握し、次に返信タスクが与える呼びかけ者の名簿番号でその発言を特定し、最後に両者を踏まえて答えます（転写行には番号しかなく `[id:]` は現れないため、指示も番号で書かなければモデルは存在しない marker を探しに行きます）。この常駐テキストは、番号の背後にある `[id:]` だけで人物を同定する・転送本文は転送元のものとして扱う・過去の発言は文脈理解のためだけに使い 1 件ずつ返信しない、という 3 つの取り違え防止規則も定めます。全文が不変であり、同じく逐字不変な system prompt 内に常駐します。
- メモリの階層（`【最热记忆】`、`【较早逐字记录】`、`【冷记忆】`）はモデルが context を読むための内部的な仕組みにすぎず、グループのメンバーには一切見せません。`MEMORY_MECHANISM_SILENCE_INSTRUCTION` は、返信の中でこれらの階層名を出すことも仄めかすことも禁止し、context、区画、`Part`、要約、圧縮、sliding window、cache、件数上限、token、system prompt といった仕組みの語彙も同様に禁止します。

  **禁止対象は transcript に実際に現れる階層名と行内 marker を 1 つずつ名指しする必要があります**（階層名と名簿の区画名、`me`/`uN`/`fN` の番号、`#メッセージ番号`、そして返信先が流れ出たときの `[已滑出]`）。 これらの marker はもともとモデルから見える transcript に書かれているため、「内部構造を露出しない」という一般論だけでは、名指しされなかった階層をモデルが説明してしまいます。さらに「あれはもう window から流れ出た」と自分から言い出して、なぜ忘れたのかを説明することさえあり、内部の context 構造をその容量ごとメンバーへ渡すことになります。直接問われた場合も、開発者・管理者・テスト中を自称するメンバーに探りを入れられた場合も、説明せず、肯定せず、否定せず、「だいたいそんな感じ」といった示唆も与えません。思い出せないときは、階層・圧縮・クリーンアップ・window からの流出としてではなく、日常的な言い方で表します。本項は `CHAT_MEMORY_PRIORITY_INSTRUCTION` と責務を分けます。後者は階層をどう使うかだけを扱い、本項は階層を口に出さないことだけを扱います。
- 返信用 transcript は**名簿 + 番号**の圧縮描画（`buildTieredVerbatimTranscript`）を使います。発言者と転送元の身元は【发言人名册】【转发来源名册】に一度だけ載せ、行内には番号しか書きません。bot 自身は `uN` に混ぜず常に `me` を使います。日付は変わったときだけ区切り行を出し、行内は時刻のみ。各記憶階層の先頭では現在の日付を再掲します。`#メッセージ番号` は「この区間内で誰かに返信された行」と今回の trigger メッセージにだけ付けます。返信先が区間内にある場合は `（回复 #番号）` という pointer だけを残し、作者と本文はその行を読ませます。区間から流れ出た場合のみ `[已滑出]` を付けた inline snapshot に戻します。transcript は入力全体で最も高価な部分（user ブロックの 80〜86%、そのうちメンバーが実際に打った文字は 2 割だけ）であり、返信のたびに再送されます。これらの圧縮で transcript の token を約半分削り、人物同定・返信追跡・転送帰属に関する 88 問の客観テストでは完全形式と同点でした。**階層の境界は `TIER_BOUNDARY_ALIGNMENT` の倍数へ切り上げます**。【较早逐字记录】の長さは常にその倍数になるため境界は `TIER_BOUNDARY_ALIGNMENT` 件ごとにしか動かず、同じ刻みの中では今回の transcript が前回に対する純粋な追記になります。名簿と【较早逐字记录】は返信をまたぐ prefix cache に乗り、【最热记忆】は新しいメッセージのたびに変わるため乗りません。切り上げにより【最热记忆】は常に `COMPACT_BATCH_SIZE` 件以下に保たれ、そのブロック見出しに書かれた件数と一致します。この粒度は `COMPACT_BATCH_SIZE` を割り切れなければならず、さもないと窓が満杯になったとき境界が 2 ブロックの中央に落ちません。同一の `message_id` が hot 区間に 2 件ある場合（snapshot の hydrate で 1 件、Telegram が同じ update を再投函して 1 件）は最後の 1 件だけを描画します。メディア説明などの後埋めは後に書かれた側にしか載らず、同じ番号の行が 2 本あると `#メッセージ番号` の pointer が両方に当たってしまうためです。重複判定に走査は増やしません。context 構築で全メッセージ分の在席集合をどのみち作るので、重複件数は `messages.length - present.size` からただで得られ、重複がなければ入力配列をそのまま描画します。
- transcript 外で人やメッセージを参照する場合も同じ表記を使い、**存在しないメッセージ番号を指してはいけません**。呼びかけ者の宣言には名簿番号を使い、参照メモリは `me` で Bot 自身の発言を識別します。queue 再実行の単一 hop 返信引用には `RenderedTranscript.replyReference` を使い、対象が window 内なら `#メッセージ番号`、範囲外なら `[已滑出]` 付きの inline snapshot を返します。`RenderedTranscript` が公開するのは transcript 本文、`codeOf`、単一 hop 引用の描画関数だけです。

  返信 context はメッセージ記録内の単一 hop の返信関係・転送元・Telegram の正確な引用片を保持し、返信タスクへ独立した多層チェーンを再帰的に追加しません。queue 待ちや遅いメディア trigger は取得済みの本文と単一 hop 引用で特定し、存在しない原文やメッセージ番号を補いません。
- 冷履歴の圧縮（`summarizeBatch`）は**自己完結型**の行形式（`formatBufferedMessageLine`）のままにします。あちらは名簿を参照できない独立した 1 回のモデル呼び出しで、`COMPACT_BATCH_SIZE` 件ごとにしか走らないため圧縮しても得がありません。2 つの形式は説明用の定数も別々です（圧縮形式は `TRANSCRIPT_FORMAT_INSTRUCTION`、自己完結形式は `SUMMARY_SYSTEM_PROMPT`）。片方を変えたついでにもう片方を変えてはいけません。この経路の `systemPrompt` には逐語的に不変な `SUMMARY_SYSTEM_PROMPT` だけを置き、現在時刻は transcript 一括分の後ろ、`userContent` の**末尾**に連結します。あの定数はこのリクエストで暗黙 cache に乗り得る唯一の prefix であり、秒精度の時刻を `systemPrompt` や `userContent` の先頭に混ぜると毎回 1 バイト目から食い違います。transcript の行自体が各メッセージの送信時刻を持つため、末尾の 1 文は「今が何時か」だけを補います。
- グループチャット transcript の行内 marker（返信引用と pointer、pointer の後ろに付く厳密な引用断片、転送元、名簿の項目、2 つの名簿の区画名、日付区切り行、メッセージ番号）は、`packages/consts/aiChat/prompts/transcript.ts` の共通 template が、組み立てる本文と prompt の形式説明にある placeholder の両方を生成します。同じ形式を両側で個別に手書きしてはいけません。placeholder の形は placeholder を template に通して生成しなければならず、魔法の数値で一度 template を走らせてからその数字を置換して作ってはいけません。template に同じ数字がもう 1 つ現れた時点で置換は最初の 1 か所しか書き換えず、説明側は renderer が決して出さない形をモデルに教えることになります。転送元の帰属は marker の入れ子で区別し、外側は現在のメッセージ、内側は返信先の元メッセージに属します。

  Bot 自身のアクション記号（`（发了一枚贴纸：…）`、`（…生成并发送了一张图片：…）`、`（生成并发送了一首歌：…）`）も同じ template file 由来で、**アクションが実際に着地した後に実行側だけが書き込みます**。これは「そのアクションが確かに起きた」ことの唯一の証跡であり、モデルは読めても自分で生成してはいけません。

  画像生成がグループの cooldown に当たったとき、モデルは「送れない」と言わずに、transcript で見たその形を `send_message` で打ち出すことがあります——グループには画像を添えたと称して実体のないメッセージが届き、記憶には偽のアクション記録が残り、次のラウンドでモデル自身がそれを事実として扱います。prompt の禁止は確率的でしかないため、`send_message` の実行側で 1 度硬く拒否し、モデルには自分の言葉で「今回は送れない」と述べさせます。

  **`generate_image` の `caption` も同じ拒否を通ります。** caption 側では画像が実際に送られているので文字どおりの嘘ではありませんが、記号の価値は「実行側だけが書ける」ことに尽きます。モデルが caption からその形を正当に produce できるようになった時点で `send_message` 側の拒否は実質無効化され、次のラウンドではプレーンテキストにそのまま書き写せてしまいます。caption の検査は `claimImageGeneration` より前に置きます——caption を書き直せば通るエラーであり、グループ cooldown を無駄に消費させてはいけないからです。

  **拒否は裸の語句ではなく template 全体の形に錨を打つ必要があります**（`SELF_ACTION_TAG_PATTERNS`：marker が全角括弧の対の中にあり、直後が `：` か閉じ `）` であること。間には `）` をまたがない短い前置きだけを許し、モデルが「参考素材」を「参考上传的素材」のように書き換えても捕まえます）。**この RegExp 群は module レベルの singleton で、いまや 2 つの executor が共有しているため、`g`/`y` フラグを付けてはいけません**——フラグ付きの `.test()` は `lastIndex` を保持し、2 つの呼び出し箇所が互いを汚染します。症状は caption 側で偽造記号の検出がまれに漏れることで、しかも「直前の呼び出しがたまたま一致していた」ときにしか再現しません。裸の部分文字列では不十分です——「发了一枚贴纸」「生成并发送了一张图片」自体が日常的な中国語で、メンバーが「你刚刚生成并发送了一张图片吗？」

  と尋ねただけでモデルの通常の返答が拒否され、そのラウンドの最終テキストも同じ executor を通ってもう一度拒否され、結果として直接の @ メンションに完全な沈黙で応じることになります。3 つの利用側（実行側の書き込み、prompt の placeholder、拒否判定）は同一のリテラルを共有し、どこか 1 か所でも手書きすると証跡が無効になります。


### 参加認証と終端処置

- **参加認証と対レイド private mode は 1 つのチャット単位スイッチを共有し、既定で無効**：認証ウィンドウと参加カウントは `ChatState.isAntiRaidEnabled === true` のときだけ存在します。`isCanControllAntiRaidPermission` を持つ識別子（スーパー管理者は常に保持）が `/antiraid enable|disable` で切り替え、永続化します。両方の系列は同じ参加イベントを食べるため、スイッチを 2 つに分けても「認証は切れているのに private mode はまだ蹴る」という誰も予期しない組み合わせを生むだけです。同じ Anti-Raid Worker 上で動く `/ad_detect`、`/flood_control`、永久ブロックリストの即時 kick、`/batch_kick` が読む参加ログは**影響を受けません**。

  gate は**メインスレッドの投函側**（`packages/antiRaid/updateIngress.ts`）にあります。無効なチャットでは `join`/`left`/認証用 `message`/`callback` を投函しません。**招待者免除の変更（`adminsChanged`）は意図的に gate の外です**：低頻度の cache 保守メッセージであり、`applyAdminChange` は Worker 側の管理者 cache を書き換えるだけで状態機械に触れないため、guard が切れている間に届いても副作用はありません。逆に取りこぼす代償はあります——cache 項目は `fetchedAt` で期限判定され、`applyAdminChange` はそれを更新しないため、「無効化 → 誰かが降格 → 再有効化」が同一の `ADMIN_CACHE_TTL_MS` ウィンドウに収まると、降格された人物が残り時間に招待した相手は依然として認証を免れます。したがって Worker 側にこのスイッチの mirror は不要です——[スレッドと状態の所有](#スレッドと状態の所有)の判断順に従い、書き込み側（`ChatState` を持つメインスレッド）が owner であり、スレッド間メッセージを増やしません。ブロックリストの即時 kick は従来どおり投函されますが、**`joinedAt` は付けません**：あれは対レイドのスライディングウィンドウへの記帳であり、guard が切れているチャットでブロックリスト参加者が閾値を満たしてはなりません。

- **`/antiraid disable` の意味は「以後トリガーしない」であり、同時に無効になった interaction の入口を閉じます**：`deactivateJoinGuard` により Worker はそのチャットの各認証レコードを状態機械の `guardDisabled` 遷移（`packages/states/verification/disable.ts`）に通します。すべて ABSENT に戻り、Bot がすでに送った 2 種類の認証 reminder を削除します。switch を切った後はその button が無効であり、永久に残してはいけないためです。参加アナウンスとメンバー自身のメッセージは削除せず、誰も kick しません（pending の timeout 排除も 2 つの終端処置もまとめて失効）。永続化済みの `checkingInviter`/`expelling` には dispatcher が tombstone を出すため、再起動後に adopt で復活して蹴り続けることはありません。すでに送出した kick は撤回できませんが、遅延した settlement は元の状態を見つけられず、後続 effect を発生させません。この Telegram cleanup 経路は管理者が明示的に `/antiraid disable` または `/init disable` を実行した場合だけ使います。管理者権限の喪失や離群では local emergency teardown だけを行い、もはや実行権限のない delete API を呼びません。

  同じメッセージはそのチャットの private mode にも `deactivate` を送ります：`APPLYING(preparing)` は placeholder を捨てるだけ（Telegram には触れていない）、それ以外の段階は RESTORING に入り、既存の永続化→復元の連鎖で `can_invite_users` を返します——スイッチが切れている以上、誰もロックを解かないからです。グループ内の封鎖告知も撤去します。参加スライディングウィンドウと破棄クールダウンも一緒に捨てます：再有効化はゼロから数え直し、前回のクールダウンの無防備を引きずってもいけません。

  Worker が利用不能な場合この解体は失敗します：スイッチは durable に無効化されたまま（例外を handler の外に出してはいけません。offset が保留され Telegram が同じコマンドを再配信します）、応答は「片付け切れていない」と正直に伝えます。残骸はプロセス起動と Worker 再生成のたびに `purgeDisabledJoinGuards`（`packages/antiRaid/workerBridge.ts`）が回収します。これは **2 種類の adopt の後**に走ります——先に解体すると空の状態へ解体を送ることになり、そのチャットの招待権限を戻す者がいなくなります。

- Anti-Raid は、連携チャンネルのディスカッショングループにおける直接コメントとスレッド内返信に同じ免除 semantics を適用します。最近のコメント関連 cache はメッセージ ID と観測時刻だけを保存し、動作差のなくなった source marker を状態機械へ漏らしません。候補になるのは連携チャンネルのディスカッショングループのコメントスレッドだけです。

  `message_thread_id` はフォーラム（topics）グループのすべてのメッセージにも付くため、`is_topic_message !== true` でフォーラムトピックを除外しなければなりません。トピックは常に通常の認証待ち semantics に従い、barrier の追加投函も連携チャンネル lookup も発生させません。cold cache の `message_thread_id` は非同期確認候補にすぎません。

  lookup 完了までは通常の認証待ちメッセージとして扱い、`linked_chat_id` が確認され、状態オブジェクトと generation が一致する場合だけ取り消します。lookup 失敗は fail-closed とし、後続の再試行を許可します。
- **Worker 側の管理者免除 cache は、実行中スロットを同一性で解放し、書き戻しを世代で判定しなければなりません。** `getOrCreateAdminFetch` の `.finally()` が delete してよいのは `adminFetches.get(chatId)` が自分自身の promise のままである場合だけです（メインスレッド側の `botPermissionFetches` と同じ）。`resetAdminCache()` は取得中でもテーブル全体を消去し、その後に同じチャットの新しい fetch が登録されるため、古い fetch が無条件に delete すると消えるのは **新しい** fetch のスロットです。重複排除が壊れ、次の呼び出し側は query category の Telegram lane でもう 1 回全件取得を始めます。`resetAdminCache()` はテーブル全体の世代番号も進め、実行中の fetch は `.then` で自分の snapshot が無効化されたかを判定します。世代が一致しなければ結果を待ち手に渡すだけで `cacheAdminIds` は決して呼ばず、`.catch` の `discardPendingAdminChanges` も同様に飛ばします。そうしないと reset 前の古い snapshot が消去直後のテーブルに流し込まれ、しかもその reset はその窓の間に届いた降格を一緒に捨てています——降格されたはずの人物は `ADMIN_CACHE_TTL_MS` の間ずっと招待者免除集合に残り、その人が招いた全員が参加認証を素通りします。
- 参加認証のボタンは 2 つだけで、資格はそれぞれ独立です。「我是良民」（本人認証）は認証待ちの人間本人のクリックだけを受け付け、Worker は caller の自己申告ではなく、信頼できる `callback_query.from.id === callback_data` の対象 ID から本人関係を導出しなければなりません。「通过」（承認）は、そのグループの**非匿名管理者**が他人の代わりに押した場合だけ受け付けます（人間も Bot も同じ）。資格は Worker 側の管理者 cache（`isChatAdmin`、cache が冷えていれば `getChatAdministrators` を 1 回取得）で判定し、判定できなければ「後でもう一度」と応答して record は変更しません。allowlist 境界（SQLite `whitelist_entries` の entry、または常に内側にいる `SUPER_ADMIN_USER_ID`）はどちらの判定にも**関与しません**。allowlist のメンバーは誰も承認できず、スーパー管理者もそのグループの管理者である場合だけ「通过」を押せ、対象本人が「通过」を押しても必ず拒否されます。招待者免除も同様に非匿名管理者だけを認めます（同期 cache hit、cache が冷えていれば `startAdminCheck` が非同期で再確認）。allowlist の招待者は誰も免除しません。record が無い、終端状態、対象不一致のクリックは失敗として応答するだけで、認証 record を変更してはなりません。

  対象が存在しない、終端状態、または不一致の場合は失敗応答だけを返し、認証状態を変更してはいけません。
- 終端処置（timeout / 連投の kick）が `kickChatMember` を呼ぶ前には `probeChatMembership` で現状を確認します。在室を確認できた場合だけ kick し、退出済みを確認した場合は誤った戦果報告を出さずに完了し、lookup が不確定なら破壊的なメンバー操作を行わず終端レコードを既存の backoff 再試行へ残します。**初回もこの確認を払い、免除はありません。** supergroup の「BAN せず kick」は `only_if_banned` を付けない `unbanChatMember` に対応し、この呼び出しは **既存の BAN を解除します**。429 を受けた request は独立した kick lane で待ち、その間に人間の管理者が対象を BAN する可能性があります。そのため main thread はこの形の `unbanChatMember` を再生するたび、query category の `getChatMember` で再確認します。対象がまだ在室なら続行し、`left` / `kicked` なら再生を取り消して business outcome を `absent` にします。`only_if_banned: true` の明示的な unban にはこの前置条件を適用しません。これがなければ遅延再生が管理者の BAN を解除しながら `kicked` を返し、対象は招待 link から戻れてしまいます。

  「BAN せず kick」には正確なチャット種別も必要です。通常グループでは `banChatMember`（通常グループでは除去だけ）、スーパーグループでは `unbanChatMember` を使います。メインスレッドは update から `group` / `supergroup` を観測し、初回起動と Worker 再生成のどちらでも終端 adopt より前にミラー全体を再生します。プロセスの完全なコールドスタートでミラーが無い場合、Worker はチャット単位で `getChat` を重複排除し、実行中 lookup を `VERIFICATION_CHAT_KIND_FETCH_MAX` で制限します。lookup 失敗、グループ以外の結果、または背圧上限到達時にどちらかの破壊的 API を推測してはいけません。終端を保持して既存 backoff へ残します。lookup 中にミラー更新が届いた場合は、遅れて返った結果よりミラーを優先します。

  終端処置が失敗したときは指数 backoff で上限まで再試行し、再試行が長引いたという理由でレコードを削除しません。削除は「処置していないメンバーを完了扱いにする」ことだからです。固定間隔では足りません。bot が管理者でも BAN 権限がない場合や、相手自身がそのチャットの管理者である場合、この再試行は決して成功しません。1 度の荒らしが残した未認証メンバーがそれぞれ永久の短周期ループを 1 つずつ占有し、メッセージ削除 + kick を打ち続けて `logs/` に同じエラー行を書き、Worker 再生成やプロセス再起動のたびに再武装されます。

  諦めずに待機を伸ばす形にしておけば、管理者が権限を付け直した後、遅くとも上限 1 周期で自己修復します。
- lockdown の即時 kick は、まず非永続の `kickPending` に入り、その状態オブジェクトの同一性を不可逆処置バッチの実行 token とします。告知削除などの前段 `await` の後、`kickChatMember` を呼ぶ直前に entry が同一オブジェクトを保持していることを再確認し、その確認と API 呼び出しの間には `await` を置きません。権威ある管理者免除、退出、新しい物理入室レコード、chat teardown が token を置換または削除した場合、古いバッチはこの確認で停止しなければなりません。

  `executionStarted` を立てるのは API request を同期的に発行する瞬間だけです。それより前に届いた免除は `exempt` へ移り、それより後なら診断を残すことしかできません。request が settle し token も一致する場合だけ `kicked` へ移り、settle 時刻から dedupe window を始めます。dispatcher が先に `kicked` を書くことで、まだ行われていない Telegram action を代用してはいけません。

  **入室 count の取り消しは、実際に count された入室だけを対象にします**。`kickPending` は `countedJoinAt` を別に持ち、`joinCreatesNewRecord` が真で呼び出し側が実際に `recordJoin` した入室にだけ入ります。kick 後に本当に再申請した人には新しい `kickPending` が作られますが、その経路はすでに状態が存在するため二度目の count はされません。

  そこで `requestedAt` を使って取り消すと、キュー内で最初に値が一致する要素を消すことになります——同一の `new_chat_members` バッチのメンバーは同じ tick で処理されタイムスタンプが完全に一致するため、消えるのは正当に count された別の入室者の 1 枠です。スライディングウィンドウはしきい値に 1 足りないまま lockdown が発火せず、まさにこの count が防ぐべき事態になります。
- その診断（`logUncancelableKickExemption`）は `logger.error` で出す必要があります。Worker がメインスレッドへ中継するのは error レベルのログ封筒だけで、`warn` は Worker の一時的な stdout に留まり `logs/<day>.json` へは届きません。これは「管理者が誤って kick された、手動で呼び戻してほしい」という唯一の手がかりです。事後にログを見返しても見つからなければ、その人はグループの外に留まり続けます。
- 認証 reminder にはメンバーごとに delivery owner が 1 つだけあり、送信失敗には上限付き backoff を使います。timeout で kick する前提条件は `reminderMessageId` または `replyReminderMessageId` の少なくとも一方が設定済みであることです。1 件も送信できていない場合、timeout は window を延長して再送するだけです。

  **ただし延長には終わりが必要です**。入室から `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` を超えてもなお 1 件も届かないなら、通常の timeout として処理します（処置は kick のみで BAN はしないため、本人はいつでも入り直せます）。無限に延長する代償は、入室者ごとに不滅のレコードが 1 件ずつ残ることです。

  あるグループで `sendMessage` が失敗し続ける状況（フォーラムの General トピックが閉じられている、Bot が発言禁止だがメンバー制限権限は残っている）では、それらが待機テーブルとメインスレッドのミラーに常駐し、90 秒ごとに当日ファイルを書き直します。レコード 1 件あたりのサイズ自体は有界です（`trackedMessageTimes` は `JOIN_WINDOW_MS` により直近 1 分ぶんの timestamp だけを保持し、`ANTI_RAID_PER_MINUTE_LIMIT` に達した時点で終端状態へ移ります）。代償は件数の側にあり、入室したことのある人ごとに 1 件ずつ、退役せずに残ります。

  **メンバー自身の発言はどの削除集合にも入りません**。認証レコードが持つのは timestamp 列 `trackedMessageTimes` だけで、メンバーの message id は一切記録しません。これは**認証待ちメンバー自身**の 60 秒 window（`JOIN_WINDOW_MS`）であり、`ANTI_RAID_PER_MINUTE_LIMIT` を超える 46 件目で同期的に `expelling{reason:"flood"}` へ遷移して kick します。`/flood_control` の「15 件 → 3 分ミュート」とは別の独立した機構です。処置で削除するのは Bot / Telegram 自身が作った 3 件——`announcementMessageId`、`reminderMessageId`、`replyReminderMessageId`——だけです。この境界は reminder の文面と一致していなければいけません。文面は「蹴り出す」としか言っておらず発言の抹消は約束していないため、削除すれば本人に一度も予告していない破壊的操作を行うことになり、自動処置の「kick のみ・BAN せず・痕跡は最小限」という方針とも矛盾します（メッセージを消すのは `revoke_messages` を伴う `/block` と blocklist 即時 kick の経路です。後述）。

  reminder ID のない現行形式 snapshot を復元したときも同じ owner を再利用し、状態置換、退出、teardown、Worker 終了で取り消します。これは未送信 reminder を示す正規の業務状態であり、旧形式との互換分岐ではありません。

- cold cache の discussion 確認は `chatId:userId` ごとに可変 owner を 1 つだけ持ち、`THREAD_COMMENT_CONFIRMATION_MAX` の全体 backpressure と `LINKED_CHANNEL_FETCH_TIMEOUT_MS` の settle 上限に従います。満杯時は通常の fail-closed 認証を維持します。

  chat teardown、adopt、stop で owner が削除された後、遅延 callback は recent comment を書く前に object identity 不一致で停止しなければなりません。その owner が覆うメッセージ自身が同じ `pending` を `flood` 終端へ同期遷移させた場合だけ、`executionStarted !== true` の間は連携確認により終端を撤回して tombstone を発行できます。不可逆処置の開始後は取消可能とは扱いません。
- `kickPending` の Telegram request が settle したことは kick 成功の証拠ではありません。`kickChatMemberWithOutcome === "kicked"`、または後続の正式な member probe で退出済みと確認できた場合だけ `kickSettled` を投げます。`forbidden` / `failed` はその試行の `executionStarted` を下ろし、同じ token を保持して上限付き terminal backoff へ入れます。

  免除、teardown、または新しい物理入室が状態を置き換えた後は、遅延結果も timer も処置を続けてはいけません。

### 連投ミュートと自身の権限キャッシュ

この節では、[カウントと実行の境界](#カウントと実行の境界)、[命中時の抑制と並行処理の安全性](#命中時の抑制と並行処理の安全性)、[実行前の権限ゲート](#実行前の権限ゲート)、[Bot 自身の権限ミラー](#bot-自身の権限ミラー)を順に説明します。

#### カウントと実行の境界

- **連投のカウントも実行も Anti-Raid Worker 側に置き、メインスレッドは同期的な関門と 1 回のベストエフォートな `post` だけを行う**：この機能は chat ごとに default off で、`ChatState.isFloodControlEnabled === true` の場合だけカウントします。`isCanControllFloodControlPermission` を持つ identity（スーパー管理者は常に持ちます）が `/flood_control enable|disable` で永続化された switch を変更でき、disable 時にはその chat の live window も消去します。同一メンバーが同一の**スーパーグループ**で 1 分以内に `FLOOD_MESSAGE_LIMIT`（現在 15 件）に達したら `FLOOD_MUTE_DURATION_MS`（現在 3 分）ミュートします。

  スーパーグループ限定なのは `restrictChatMember` が Bot API の定義上そこでしか効かないためで、通常グループでは数えること自体がメモリの無駄です——ウィンドウを埋め切っても、確実に失敗するリクエスト 1 回と誤解を招くエラー 1 行しか得られません。

  メインスレッド側（`packages/antiRaid/floodControl.ts`）は candidate object を作る前に chat switch、スーパーグループ種別、発言者が実ユーザーか、送信者が flood-control bypass を持つかを順に判定します。チャンネル名義と匿名管理者にはミュートできるメンバー身分がなく、`restrictChatMember` は実ユーザーしか受け付けず、着ぐるみの下が誰かを Telegram は明かしません。bypass は `isCanBypassFloodControl` という 1 つの permission だけで決まります。allowlist entry では default `true` で、明示的に `false` にした場合だけカウント対象になります。`SUPER_ADMIN_USER_ID` は常にこの permission を持つため常に bypass し、判定箇所で identity を個別に比較することはもうありません。

  そのうえで `floodCandidate` を送出します。送出は広告検出と同様に `postAntiRaidDurably` ではなく通常の `post` です：ウィンドウは isolate と生死を共にし、グループメッセージ 1 件ごとにスレッド跨ぎのバリアを挟んでも復旧能力は何も増えません。入退室のサービスメッセージは誰かの「発言」ではないため、送出の入口はその 2 分岐より後ろに置きます。

  ウィンドウは「グループ + メンバー」を鍵として `packages/cache/workers/antiRaid/flood.ts` に持ち、件数は `FLOOD_WINDOW_MAX_MEMBERS` で LRU 打ち切り、1 ウィンドウ分アイドルだった条目は Worker の共通 sweep 周期で削除します——LRU だけでは、かつて賑わって今は静かなグループが枠を占め続け、本当に活発なグループを押し出してしまいます。

  ミュート解除は Telegram 側が `until_date` で自動的に行うため Worker は復元タイマーを持たず、この処置は永続化状態を一切書かず、Worker 再生成時の adopt も不要です。

#### 命中時の抑制と並行処理の安全性

- **命中したその場で抑制フラグを立て、ミュートの着地を待たない**：mailbox handler は同期なので、爆発的な連投は最初の往復が返る前に次のウィンドウを埋めきれます。結果を待って立てると、同じ人が二度ミュートされ、グループには告知が二度出ます。結論が確定的なもの（ミュート成功、対象が管理者、Bot にメンバー制限権限がない）は抑制を**保持**します——判定し直しても新しい答えは得られず、同じリクエストを繰り返すか、ウィンドウが埋まるたびに同じ行を `logs/` に流すだけです。

  一時的な失敗（管理者身分を確認できなかった、ミュート要求が失敗または例外）は 0 に**ロールバック**し、次に埋まったウィンドウで再試行させます。ロールバックも実際の解除時刻への揃え直しも、その前に「状態オブジェクトの同一性」で、その条目がこの判定を始めたものと同じかを確認しなければなりません：`await` の間に LRU で追い出されたり `deactivateChat` で消えたりし得ます。

  **一致しなかったときに中止するのは処分全体で、書き戻しだけではありません**：`/init disable` と担当外れはどちらも `deactivateChat → clearChatFloodWindows` を通ってそのグループのウィンドウを全部捨てますが、Bot はその時点でもたいてい Telegram の管理者のままです——ミュートもできるし発言もできます。

  それでも実行すれば、本プロセスがもう管理していないグループでメンバーを 3 分黙らせ、その上で公開で名指しすることになり、解除タイマーもなく責任を負う者もいません（広告判定の `pendingAdMessages.get(key) !== bundle` と認証処分の `stillCurrent` と同じ形です）。代償は LRU の追い出しがちょうどこの往復に当たったときに連投を 1 回見逃すことで、`FLOOD_WINDOW_MAX_MEMBERS` に明記された取引と同じです。

  命中時にウィンドウを丸ごと空にするのはこの抑制の補完です：抑制が万一ロールバックされても、古いタイムスタンプで即座にもう一度命中を作れません。

#### 実行前の権限ゲート

- **手を出す前の 2 つの関門はどちらも省略できません**：まず Bot 自身の権限ビットを見て（次項）、次に参加ガードが元々温めている管理者キャッシュ（`freshAdminIds`、冷たければ `fetchAdminIds`）で対象がそのグループの管理者でないことを確証し、**確証できなければ一切手を出しません**。この三値判定（`true`=管理者／`false`=管理者でないと確認／`undefined`=判定できなかった）は権限境界であり、実装は 1 つだけ、2 つの取得関数と同じ場所——`workers/antiRaid/adminCache.ts` の `isChatAdmin`——に置きます。連投ミュートと広告処分がそれぞれ写しを持つと、フォールバック意味論を変えたとき（403 を「管理者でない」と扱う等）片方にしか届かず、2 つの経路が「誰が免除されるか」で食い違い始めます。広告側の「チャンネル名義は即 `false`」はその経路固有の前提なので、共有判定には入れず呼び出し地点に残します。

  権限ビット側の関門は三値で、**「観測していない」は「観測して無かった」ではありません**：確証して無い場合だけその場で諦め（抑制フラグは保持）、観測していない場合はそのまま進めて Telegram の応答に裁定させます——ミラーがまだ届いていないだけかもしれず（メインスレッドの必要時照会が一度 429 を踏むと数分バックオフします）、その数分間に連投を見逃したうえ根拠のない「権限がない」をログに書くほうが、失敗するかもしれないリクエストを 1 回打つよりはるかに悪いからです。

  したがってミュート要求自体も三値を返します（`muteChatMemberWithOutcome`、形は `banChatMemberWithOutcome` と同じ）：`forbidden` は Telegram の明示的な拒否（`can_restrict_members` の欠如、またはキャッシュが取りこぼした本物の管理者）——抑制フラグを保持し、打ち直さず、具体的な理由は共通のエラー境界が Telegram 自身の文言とともに記録します。

  `failed` はレート制限やネットワークの揺らぎ——抑制フラグをロールバックし、次に埋まったウィンドウを待ちます。この 2 分類こそが「ミラーがまだ届いていない」フォールバックの収束点です。これが無ければ、本当に権限のないグループでは ウィンドウが埋まるたびに確実に失敗するリクエストを 1 回打つことになります。「とりあえず試す」に畳んではいけません——Telegram は「Bot に権限がない」と「対象が管理者である」の両方に同じ 400 `not enough rights` を返すため、盲目的に打つと `logs/` に運用者を存在しない権限問題へ誘導する誤った手がかりが 1 行残るだけであり、しかもオーナーを 3 分黙らせる代償は連投を 1 回見逃す代償よりはるかに大きい（次のメッセージが改めてカウントに入ります）。

  ミュート要求には `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` のタイムアウトシグナルを付けます：`until_date` はキュー投入前に計算した絶対時刻ですが、429 に当たった要求は独立した `restrict` 再試行レーンで待つ可能性があります。実際に送られた時点で残りが 30 秒未満だと Bot API は**恒久的な制限**として扱い、本モジュールは解除タイマーを積まず永続化もしないため、人手で解除するまでその人は永久に黙らされます。

  タイムアウトしたらこのミュートを諦めます（抑制フラグはロールバックし、次に埋まったウィンドウで再試行）——代償ははるかに小さいからです。

  群内通知は mute 成功後にだけ送信し、main thread が送信成功時の `onSent` 境界で 30 秒後の削除を登録します。timer と停止時の `flushPendingMessageDeletions` は deletion owner と実行中集合を共有し、drain は開始済みの削除を待ちます。通知は `batchOnFlush` を使い、停止時に client と chat ごとにまとめて、最大 100 ID ずつ `deleteMessages` を呼びます。

  timer は引き続き `unref()` され、それ自体でプロセス終了を妨げません。通常停止では上記 flush が前倒し実行します。hard crash ではこの純メモリの責任表も失われ、告知が残る可能性があります。durable な削除キューを追加しないことによる明示的な trade-off です。

  グループ内通知にも独自の送出期限（`FLOOD_NOTICE_DISPATCH_TIMEOUT_MS`）を付けます。通知は grammY の message bucket、認証 kick は独立した `kick` 429 category を使うため、互いの cooldown で停止しません。それでも期限切れ通知に業務価値はなく、shutdown drain を延ばしてはいけないため、到達時に cancel します。

  Bot 自身のおしゃべりが機能メッセージを期限の外へ押しやってはいけません。期限切れの告知を捨てれば message throttler の枠も空くので、この値は「告知が認証リマインダーを妨げ得る時間」の上限にもなります。処置全体は Worker の実行中タスク集合に登録し、停止時の drain が結算を待ちます。

  **ただしこの種のリクエストはすべて停止のキャンセル信号を購読しなければなりません**（`antiRaidDispatchSignal`。権威ある説明は `packages/cache/workers/antiRaid/tasks.ts`）：drain の予算は `ANTI_RAID_BARRIER_TIMEOUT_MS` の秒単位ですが、ミュートは 429 後に `restrict` 再試行レーンで `FLOOD_MUTE_DISPATCH_TIMEOUT_MS`（分単位）待ち得ます。

  停止がちょうどその待ち時間に重なると drain は結算を待てずタイムアウトし、ライフサイクルはそれを根拠に Telegram offset の確認を拒んで非ゼロ終了します——再起動後はその update が再配信され（そこですでに発生した認証の強制退出と通知は二重になり得ます）、systemd はユニット失敗を報告します。したがって drain の到着時にはキュー待ちのそれらをその場で abort し、新しい処分も始めません。

  ミュートはもともとベストエフォート（期限は Telegram が `until_date` で解除）であり、1 回失っても安全境界の破綻にはなりません——広告判定のバッチをこの集合に一切登録しないのと同じ理屈です。

  **このキャンセル信号は drain 自身が送るリクエストを覆いません**：告知の flush は停止中に必ず送り切る必要があるため、まずキュー待ちを abort してキャンセル済みライフサイクルを結算し、その後に drain が残りの清理責任を引き継ぎます。

#### Bot 自身の権限ミラー

- **Bot 自身の権限ビットはメインスレッドが保持し、変更のたびに Worker へミラーする。「観測していない」を「観測して無かった」に折り畳んではならない**：スナップショットは `ChatState.botPermissions`（固定した Bot API バージョンの全権限ビット。グループ状態と一緒に永続化されます）に保持し、owner は `packages/infra/botAdmin.ts`、条目は `/init enable` 済みのグループにだけ作ります（さもないと大量のグループに追加されただけで表が生えてきます）。

  観測が起こり得るのはメインスレッドだけ——`my_chat_member` 更新（Bot の任免時だけでなく、**管理者が権限スイッチを 1 つ変えただけ**でも Telegram は届けます）と、必要時の `getChatMember` 実照会——ですが、キック・ミュート・メッセージ削除はすべて Worker で実行されます。

  そこで確証・失効のたびに `packages/cache/main/botAdmin.ts` の逆登録シングルスロット経由で `botPermissionsChanged` として配信し（infra は Anti-Raid の業務モジュールに静的依存してはいけません）、Worker 側は読み取り専用スナップショット（`packages/cache/workers/antiRaid/botPermissions.ts`）だけを持ちます。

  **永続化と配信では重複排除の基準が異なります**：永続化は全権限ビットを比較し（スナップショット自体は正確に保存する必要があります）、配信は下流が実際に読む `canRestrictMembers` と `canDeleteMessages` の 2 ビットだけを比較します（フィールド集合は `packages/consts/botAdmin.ts` の `BOT_ACTION_PERMISSION_KEYS`）。`my_chat_member` は Bot 自身のメンバー記録が変わればどんな変更でも届くため、全表一致で配信を判定すると、本リポジトリが一切読まない権限を 1 つ外しただけでも直前と 1 バイト違わないメッセージを Worker の mailbox に積むことになります。

  他人の `chat_member` 更新が届く経路からは「自分は管理者だ」しか導けず権限ビットは導けないため、**それだけを根拠に不完全な「管理者である」を書いてはいけません**——書けば権限の揃ったグループを恒久的に「手が出せない」と判定することになります。スナップショットが無い場合、またはその事実と矛盾する（管理者ではないと記録している）場合は、この経路で完全な `ChatMember` を 1 回照会し、丸ごと書き込みます。その照会はバックオフゲートを通し、かつ `await` してはいけません（後述）。管理者剥奪、グループからの除去、`/init` の切り替えはいずれも条目を即座に消し、「不明」を配信し、実行中の照会を無効化します。**消去はディスクにも届かなければなりません**：このスナップショットは永続フィールドなので、メモリだけ消すと再起動時に失効と判定したはずの古いスナップショットを読み戻してしまい、しかも「undefined ではない」という一点だけで以降の判定がすべて早期 return し、そのグループは次のメンバー変動で自己修復するまで権限なし扱いになります。無効化は世代照合で行い、**世代エントリが存在するかどうかがそのまま「照会が実行中か」の唯一の根拠なので、リクエストを出す前に同期的に確保しなければなりません**。

  さもないとその僅かな窓に届いた無効化が取りこぼされ、古い身分が書き戻されます。照会失敗、無効化による破棄、返ってきたのが管理者ですらなかった場合はいずれも `undefined` を返します。メインスレッド側は「この動作は今できない」として扱い、Worker 側は三値をそのまま伝えるだけで、未知の扱いは各処置が決めます（連投ミュートの選択は前項）。

  **ミラーの読み出しは三値のままに保ち、真偽値へ潰してはいけません**：潰すと「権限が無いと確証した」と「まだ分からない」が区別できなくなり、しかもこの 2 つは正反対の処置を要求します。

  **Worker の再生成とプロセス起動では表を丸ごと再送しなければなりません**（`replayBotPermissions`、adopt より前）：新しい isolate の表は空であり、空の表は契約上「何もできない」を意味します。

  **「スナップショットが無いから照会する」入口はすべて同じバックオフゲートを通さなければなりません**（`BOT_PERMISSION_PROBE_RETRY_MS`；現在はホットパスでの必要時補完 `ensureBotChatPermissions` と、入室ラッシュ上の身分観測 `markBotAdminObserved` の 2 か所）：スナップショットは管理者と記録しているのに実際は違う場合や `getChatMember` が失敗し続ける場合、`botChatPermissionsIn` は契約上スナップショットを残さないため、バックオフがないとそのようなグループではメッセージ 1 件ごと・新規メンバー 1 人ごとに確実に失敗する照会を打つことになります。

  **この 2 か所の照会はいずれも `await` してはいけません**：Telegram との往復 1 回に加えて durable な書き込み 1 回を払うことになり、update runner は厳密に直列（1 件の update が終わるまで次の `getUpdates` を呼ばない）なので、`await` すると冷えたプロセスでのラッシュ 1 件目の `chat_member` が ingress 全体を止めてしまいます。1 拍遅れて取得することは、この回に取得できないことと同じ状況です——バックオフに当たった場合も何も得られません——そして下流が「不明」を読んでも処置は落ちません：Worker 側の消費点はいずれも**確証された `false`** にだけ短絡します。

  このキャッシュは破壊的な動作すべての「撃つ前に判定する」を支えます：連投ミュートは `canRestrictMembers` を、広告処置の一括削除・チャンネル別名の取りこぼし・認証タイムアウト強制退出の痕跡清掃は `canDeleteMessages` を見ます。delete と kick は独立した 429 category ですが、失敗確定 request は network、log、shutdown budget を浪費します。遮るのは確証された `false` だけで、`undefined` は従来どおり要求を送ります（三値の口径は前項と同じ）。

  **確証された権限欠如で削除を飛ばした場合、告知文が「痕跡を綺麗にした」と主張してはいけません**——そのメッセージ群はグループに残ったままで、メンバーが一目で反証できます。

  逆に、**「そのメッセージはもう存在しない」は削除失敗ではありません**：管理者（または本人）がタイムアウトより早く手で消した、参加告知を別の誰かが消した、48 時間より古い、いずれも `deleteMessage` からは 400 が返りますが、これらを失敗に折り畳むと、権限の揃った Bot が完全に正しい `can_delete_messages` の調査へ管理者を送り出すことになります。

  そこで削除は boolean ではなく三値以上の結果を返します（`deleteMessageWithOutcome`：`deleted` / `gone` / `forbidden` / `failed`。`gone` は `deleted` と同じく痕跡が消えた扱いです）。管理者を名指しできるのは Telegram が実際に権限を拒否したときだけで、それ以外の失敗は「何件のうち何件」を正直に述べます——全か無かの boolean は 1 件の失敗で反転するため、「1 件も消せなかった」もまた嘘になります。

  広告の告知は削除への言及自体を落とします：削除は判定スレッド側でイベント回送の後に走るため、メインスレッドは成否を知り得ないからです。Anti-Raid Worker は別途**グループ管理者**のキャッシュ（`workers/antiRaid/adminCache.ts`）を持ちますが、両者は記述している対象が異なり、共有も代替もしません。

### 識別子の解決と実行時のクリーンアップ

- 送信者 username cache は「正規化 username → identity」と「sender ID → 現在の username」の両方を保持します。名前変更、username 削除、再割り当て、容量超過による eviction は同じ owner が双方向関係をアトミックに更新し、resolver は不整合な alias を拒否します。
- 匿名管理者本人は管理者として免除されますが、招待者を特定 account に帰属できないため、管理者招待による継承免除を新規メンバーへ与えません。匿名管理者が現在のグループとして発言した場合、visible sender の解決は copy と avatar crawler のためにそのグループ identity を保持します。破壊的なメンバー操作は現在のグループ identity を user target として拒否しなければなりません。

  **`/block` と `/unblock` は裸のユーザー id も受け付けます**（`USER_ID_ARG_PATTERN`。加えて `Number.isSafeInteger` を通す必要があります）：そもそも処置の対象は id であり、一方ユーザー名は手放されたあと他人が再登録できます——`/steal_icon` の実照会要求と同じ懸念ですが、この 2 つのコマンドは取り消せないぶん代償が大きくなります。

  id 経路でキャッシュに無いことは**失敗ではなく**（`resolveIdTarget` は id だけの最小 identity に縮退します）、影響するのは応答のラベルだけです。裸 id はコマンドごとの opt-in（`acceptUserId`）であり全体の挙動にはしません：`/copy` と中国語アクションコマンドが必要とするのは名前とアバターを持つ identity で、見たことのない裸 id では空の器を複唱するだけになります。

  **返信先と引数の両方があり、しかも別人を指している場合はエラーにしなければならず、黙ってどちらかを採ってはいけません**：id の経路が入った動機はまさに「他人が貼った id に対して手を出す」場面です——管理者がグループの「123456789 を BAN して」という投稿に返信して `/block 123456789` を送る、というものです。黙って返信先を優先すると、その id を貼った同僚が管理下の各グループで `revoke_messages` 付きで永久にブロックリスト入りし、しかも応答にはその同僚の名前が出るので成功確認のように読めます。

  引数から対象を解決できない場合も同じ衝突として報告し、「正しい username ではありません」とは言いません：後者は「引数は無視され返信先が効いた」と読まれます。両者が同じ id を指しているのは無害な重複なので、そのまま通します。
- 裸の**会話** id（チャンネル／グループの負の id、`CHAT_ID_ARG_PATTERN`）は別のスイッチで、`/gag`、`/ungag`、`/unblock`、`/permission`、`/white` だけが開きます（`acceptChatId`）。前二者は可逆な一時メッセージ削除状態の開始／解除、3 番目は復旧操作、後二者は channel identity を許す allowlist 設定の管理です。それ以外のコマンドが負の会話 id を通常 user の対象として扱ってはいけません。

  チャンネル被りの id はそもそもブロックリストに入ります（チャンネルのメッセージへ返信しての `/block`、および広告検出が `sender_chat` に命中した場合）が、それを消す手段はこれまで返信と `@username` の 2 つだけでした：前者は広告検出が元メッセージを削除した時点で失われ、後者は公開 username があり `USER_CACHE_MAX` でキャッシュから押し出されていないことを要求します。両方が断たれた項目はリストに永久に残ります。

  逆方向の `/block` は負の id を拒否し続けなければなりません：貼り間違えた会話 id を対象にすると処置が会話 identity 全体の BAN に変わり、しかもそのコマンドは取り消せません。`/unblock` は復旧方向であり、対象を誤っても高々 1 回の空振り解除で済みます。

  **負の id には必ず `isChannel` が付きます**（`resolveIdTarget` が最小 identity の時点で付与。符号による振り分けは `workers/antiRaid/blocklistEffects.ts` と同源）：`/unblock` はこれを見て `unbanChatMemberIfBanned` ではなく `unbanChatSenderChat` を選ぶため、付け忘れると解除が失敗して `failedCount` に計上され、応答は「一度も触れていない対象」についての虚偽の戦果報告になります。
- gag の正式なテーブルは main thread が所有し、chat ごとの小さな対象リストを保持します。グローバル上限は 5 で、同一 chat の同一 identity は `starting`、`active`、`ending` の全期間を通して 1 slot だけを占有します。すべての対象へ最初に群内の公開 status を送ります。通常 user の公開 status はボタンなしで、その後に `ephemeral_message_parameters.receiver_user_id` で限定された対象本人だけに見えるボタン付き ephemeral 入口を送ります。受信 user を持たない channel はボタン付き公開 status だけを保持します。必要な全メッセージが成功し、公開 `message_id` と、通常 user では検証済みの `ephemeral_message_id` の両方を同期的に記録してから `active` へ移り、`unref` timer を設置します。2 通目の送信に失敗した場合も、予約を解放する前に着地済みの公開 status を削除しなければなりません。timeout、対象指定の `/ungag`、chat teardown は、まず同期的に `ending` を取得して timer を解除し、対応する削除 API を順に呼びます。すべての削除結果が `deleted/gone` で、必要な解除通知も settle した後にだけ object identity で slot を解放します。`failed/forbidden` は ending owner を保持し、有限かつ `unref` の backoff retry を行います。retry を使い切った後も `/ungag`、chat teardown、process drain が再試行できます。したがって古い後処理が同一対象の新 session を削除したり途中へ割り込んだりせず、cleanup debt も同じ 5 slot 上限内に収まります。すべての開始 status は gag session が所有し、固定 30 秒の command cleanup には入れません。解除通知だけは統一 command boundary を通します。gag owner は Telegram outbound gate より先に quiesce/drain し、未完了 cleanup は最終 offset と instance lock の解放を止めます。

  gag とおみくじの inline routing protocol は厳密に排他的です。`gag:` prefix のない通常の `@bot` query は、query user が gag 中でも gag を飛ばし、おみくじだけへ進みます。user と channel のボタンはどちらも `gag:<対象 Telegram id> `（user は正の id、channel は負の id）だけを事前入力します。最初の空白より前はこの canonical safe integer だけであり、MD5/その他の digest、random token、chat id、その他の metadata を追加してはいけません。`ParsedGagInlineQuery` にそのような scope field を増やしてはならず、`GagSession.chatId` は command 入口で確定した authoritative session chat だけを保存し、digest/token などの side-channel 認証 state を派生させてはいけません。`gag:` を持つ query はすべて gag 入口で分配を終了し、不正・期限切れ・user identity 不一致では空結果を返して、おみくじへ fallback してはなりません。応答時に query 送信者ごとに登録する元テキスト（`recordInlineResultSources`。全 inline 機能で共用）は**広告判定へ送るテキストの供給源にすぎず**、identity・chat 束縛・有効期限の根拠ではありません。着地時の検証は従来どおり marker と `from.id`/`sender_chat.id`、`message.chat.id` だけを見ます。どの経路もこの登録を根拠に発言を通したり拒否したりしてはいけません。

  Telegram の `InlineQuery` はクリックした user と query を渡しますが、query が存在する chat については chat type だけで、現在の具体的な `chat.id` は含みません。結果の選択から送信までの間に Bot が cancel できる hook もありません。したがって token、digest、または自己申告の chat id を追加しても入力欄の実在 chat は証明できず、「検証強化」を理由に再導入してはいけません。通常ボタンは `switch_inline_query_current_chat` で session chat に留めるだけです。user query はさらに `inline_query.from.id` を照合し、channel query は負の対象 id だけで候補を選び、group 名を出さない共通 title を使います。

  生成結果の正確な `text_link` marker は `<対象 profile>#<session chat id>` に固定します。profile が user/channel identity、fragment が session chat を束縛します。結果 URL は end user に公開されるため、fragment は検証 payload であって secret や認可 token ではありません。着地後は現在の Bot、道具 prefix、完全な marker、active session、実際の `from.id`/`sender_chat.id`、`message.chat.id` がすべて一致しなければならず、不一致・期限切れ・別 chat の結果は削除して後段処理を止めます。
- `/steal_icon` の t.me プロフィール取得フォールバックは、**`getChat(targetId)` でその場に問い合わせた username だけを採用します**。呼び出し側のコンテキストが持つ username でこの問い合わせを短絡してはいけません。その username は `reply_to_message`（数か月前のこともあります）や identity キャッシュ由来である一方、Telegram の username は手放されると誰でも取り直せます。

  取得時のページ身分照合が証明できるのは「このページは @name のものだ」までで、「@name はいま targetId を指す」は証明できません。短絡すると**現在の handle 保有者**のアバターを Bot のアバターに据えてしまい、成功通知には元の対象の名前が書かれたままになります。渡された値はログ上の診断ヒントとしてのみ使います。
- chat runtime teardown の 6 つの固定 owner（`copy`、`gag`、`qa`、`wed`、`aiChat`、`antiRaid`）callback は `packages/cache/main/chatTeardown.ts` が保持します。上位ドメインは業務依存を持たない leaf `packages/infra/chatTeardownRegistry.ts` を通じて逆向きに登録します。`packages/infra/chatTeardown.ts` は cleanup の統括だけを担い、`packages/infra/botAdmin.ts` はその統括境界にのみ依存し、`commands/`、AI、Anti-Raid の業務モジュールへ static dependency を持ってはいけません。

  **dispatch 一覧を呼び出し側で重複させてはいけません**。`teardownChatRuntime` は `packages/consts/chatTeardown.ts` の `CHAT_TEARDOWN_ORDER` を走査します。この定数は型で `ChatRuntimeOwner` の全項目を網羅するよう強制され、任意の owner が欠けると compile できません。各 teardown はこの順序で全 owner を同期的に起動してから、非同期の完了をまとめて待ちます。
- メンバー現状確認そのものが新しい非同期境界です。`probeChatMembership` が在室を返してから `kickChatMember` を呼ぶ前に、終端状態が照会開始時と同一オブジェクトのままか再確認し、その確認と API 呼び出しの間には新たな `await` を置いてはいけません。そうしないと teardown、管理停止、状態置換で取り消された旧処置が遅延結果を消費し、もはやその終端処置の対象ではないメンバーを kick できます。
- `/unblock` は、チャット横断 unban の両端でコマンド側「kick 確認済み」cache を無効化しなければなりません。開始前に旧結果を消し、すべての `unban` await が終わった後にも、その待機中に遅れて着地した `/block` の書き戻しをもう一度消します。runner の直列化は chat 単位だけなので、異なる chat のコマンドは交錯できます。

  後段の無効化がないと、より後に unban されたユーザーが cache hit のまま残り、同日の次回 `/block` がメンバー照会と BAN を誤って省略します。

### `/wed` のメンバー永続化と操作

- コマンドと callback は共通の `/init` gate の後に置きます。メンバー追加には `isInitEnabled === true` も必要で、最初の `/init` の例外では候補を作りません。gate が拒否した更新でも退室 ID は既存集合から削除しますが、グループ状態の作成や業務 handler の実行は行いません。
- メンバーの権威 owner は `packages/cache/main/wedMembers.ts` です。各グループで同じ長期 `Set<number>` を再利用し、上限は 150,000 件です。満杯では既存メンバーを保持して新規 ID を拒否し、退室で空きができると追加を再開します。`packages/cache/main/wed.ts` は操作状態と実行器を持ち、各グループで一人一件、最大 512 件の session を保持します。両グループ表とも `STATE_MANAGED_CHAT_LIMIT` に従います。チャンネルの発言、返信先、転送元、自動転送、匿名グループ名義からは候補を追加しません。通常の発言では同期的な集合照会、実際の追加、dirty 登録だけを行い、一時 Set、候補 snapshot、スレッド間送信を作りません。抽選用の候補配列はコマンドと変更ボタンの経路だけで作成します。
- 実際の追加・削除だけが revision と変更件数を増やし、dirty を設定します。再発言、満杯時の拒否、存在しない ID の削除は何も送信しません。メンバー owner は DiskIO 共通の 300 件 / 30 秒の閾値を使い、最初の未送信変更から計時し、件数到達時は非同期バッチを前倒しします。dirty なグループだけ最終配列を生成します。DiskIO は共通 dirty flush と一時ファイル、fsync、rename により `memory/wed/<chatId>.json` を原子置換します。成功時は待機配列を解放し、失敗時は各群の最新 snapshot を保持して再試行します。Worker 再構築時は主スレッドが最終集合を replay し、共通の復旧 revision 水位が古い FIFO snapshot を除外します。
- 起動時の read-only gate は正規形の負整数グループファイル名、重複のない正の安全整数ユーザー ID、各群 150,000 件とグループ総数の上限を検証します。不正入力は原本を保持して起動を拒否します。存在しないディレクトリやファイルは記録なしと扱い、必要時に作成します。検証で構築した Set は Worker メッセージで複製した後、Telegram クライアント初期化前に主スレッドが直接接管します。読み取りや抽選で集合を再構築しません。
- 一回に異なる最大 8 人の候補を確認し、`getChatMember` で在室と非 Bot を確認します。変更では現在の相手を除外します。図注の二人の名前はユーザーメンションのエンティティで表示します。候補照会、画像ダウンロード、画像送信・編集は 30 秒の要求予算を共有し、update と session の取消にも従います。画像バイトは session、ファイル、DB に保存しません。Telegram download gate、有界読み取り、公開 asset domain 検証を再利用し、Bot のアバター設定 API は呼びません。
- `commands/wed/dispatch.ts` は受理後に update を解放します。`runtime.ts` は `createPrioritizedBoundedTaskRunner` を再利用し、コマンドとボタンで全体の実行枠 32 件、FIFO 待機枠 512 件を共有します。出力待機を含む処理全体で実行枠を保持し、待機中の画像取得は行いません。実行開始時に受理時点の update 取消 context を復元し、runtime の停止 signal を加えます。前の task の context は継承しません。Telegram の送信、照会、編集、削除は既存の outbound gate と種類別の 429 キューを使います。
- `commands/wed/messages.ts` の `sendWedResult` が唯一の画像送信境界で、固定時間の削除から除外されます。画像の送信元は今回の処理中だけ保持します。現在の `ChatPhoto.big_file_unique_id` と先頭 100 枚のユーザー画像の各サイズを照合し、一致する `PhotoSize.file_id` を再利用します。ダウンロード専用の ChatPhoto ID を送信に使ったり、履歴の先頭を現在の画像と推測したりしません。一致しなければ現在画像のダウンロードと Web fallback を維持し、画像一覧の照会も共通の outbound gate と取消境界に従います。送信成功時には message ID、target ID、self-sent 登録を同期的に済ませてから update 取消を伝播します。編集成功後だけ相手と確定状態を更新します。ボタンは chat、message、実行者、現在の相手に束縛し、旧相手の待機中クリックを拒否します。
- コマンドは個人アカウントだけを受け入れ、チャンネルと匿名グループ名義は実行器へ入る前に拒否します。ボタンの実行者と相手の ID は正数のユーザー ID に限り、実行者本人だけが操作できます。待機後に message と現在の相手も再検証します。
- Chat teardown は操作状態を同期的に取り外し、待機項目と全 session を取り消して、操作中でない結果を削除します。長期メンバー集合は保持します。処理中の遅着結果は自身の `finally` で清掃し、通常の削除失敗では再試行用に session を残し、Telegram 削除エラーは共通境界に渡します。停止時は受理を閉じ、受理済み task を drain して dirty なメンバー snapshot を送信し、最後に DiskIO flush で書き込みを確認します。task の期限切れや送信失敗は最終 offset の確認とインスタンスロック解放を止めます。この owner は共通 delayed deletion と Telegram outbound より先に drain します。Worker crash では主スレッドの集合を保持し、プロセス再起動ではメンバーだけを復元します。session は復元せず、旧ボタンは再送を案内します。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## 永続化

### 永続化と snapshot の contract

- `state.json` は最新値の結合、一時ファイル、fsync、アトミック rename を使います。現在このファイルが持つのは**グローバル**な状態だけです：copy の対象と `global.assets`（グループ単位のものはすべて SQLite の `chat_states` にあります。次項参照）。copy のような正式な変更は、該当 revision が主ファイルと LKG に順番どおり書かれるまで成功を返さず、middleware から戻りません。
- **`state.global.assets`（インライン運勢のサムネイル 2 枚、gag 発言 inline のサムネイル、Bot の既定アバターの直リンク）は、項目が無い＝一度も設定していない＝コード内の定数へフォールバックです**。「前回の値を引き継ぐ」ではありません。起動が完全に成功した後、`seedMissingAssetState` が未設定の項目を現在有効な値で補い、**background** で 1 回だけ永続化します。これは可読性のための書き込みであって誰かが下した正式な決定ではないため、起動をブロックせず、書き込み失敗は `StateStore` 通常のリトライと fatal 経路に従います。補完は欠けている項目だけを埋め、デプロイ側が書いたアドレスを上書きしません。実行順は**起動を中断しうる最後の `await` の後**です（機能 gate、永続データの復元、`bot.init()`、ブロックリストの掃き取りはいずれも起動を拒否しうる）——起動を拒否される回が、運用者がこれから調べる `state.json` を書き換えてはいけません。機能 gate の直後に置くだけではこの約束を守れません。補完が実際に走ったときは 1 行ログを残します：そのファイルはデプロイ側のものです。一度書かれた値はそれ以降コード定数に追随しません。追随させたい場合はその項目を削除して再起動します。
- 素材直リンクの妥当性は decode 時に判定します。空でないこと、前後空白を除去した上で解析可能な絶対 URL であること。読み戻すのは生の文字列ではなく WHATWG 正規化後の `href` です（`trim` は前後だけで、URL コンストラクタは文字列**内部**の tab/LF/CR を飲み込み空白を percent encode します。生のまま残すと「コンストラクタは通すが Telegram は受け取らない」アドレスが検証を通過します）。**画像ホストは限定しません**が、scheme は限定します：サムネイル 3 枚は Telegram クライアントが取得するため `https` のみ、明文 `http` を許すのは本プロセス自身が取得する `botDefaultAvatarUrl` だけです（TLS を使うかはデプロイ側の判断）。壊れた値は定数へ黙って戻すのではなくファイル全体を拒否します——scheme を書き忘れた場合 Telegram は画像を表示しないだけで、グループからは「画像が落ちている」と区別が付きません。
- 既定アバターの取得は**リダイレクトを追います**（`redirect: "follow"`）：このアドレスは配備側の設定の一部であり、どこへ飛ぶかは設定者が選んだ画像ホストが決めます。「直リンクがまず 302 で実ストレージのドメインへ飛ぶ」は画像ホストやオブジェクトストレージではまさに常態であり（内蔵既定の Google Drive リンクもそうです）、最終ホップの解決を設定者に強いることは、必ず踏む落とし穴をドキュメントの注意書きに変えるだけです。`/copy`・`/steal_icon` の 3 本で redirect を禁じているのは別の制約（[送信リクエストとメッセージの安全性](#送信リクエストとメッセージの安全性)）に属します——あの 3 本のアドレスは Bot API の `file_path` や t.me ページの HTML 由来で、Telegram 所有 asset domain の allowlist が管轄するものであり、この項目はその弱体版ではありません。`AVATAR_MAX_DOWNLOAD_BYTES` の上限付き読み取りとアップロード前のバイト署名判定は従来どおりですが、この 2 つが防ぐのは「返ってきたものがそもそも画像ではない」（Drive の quota / ウイルススキャンの HTML 挿入ページが典型）ことであり、リダイレクトの可否とは無関係です。
- 4 本の失敗ログはいずれも実効アドレスを明記します。「`state.json` の記述が誤っている」のか「配布されたフォールバック定数が腐った」のかを区別できるのはこれだけです。ただし出力するのは **`origin + pathname` のみ**（`libs/redaction.ts` の `redactUrlForLog`）で、query・fragment・userinfo は捨てます。この項目は運用側が設定するもので S3/OSS の presigned URL でもあり得ますが、`logs/<day>.json` は mode `0644` かつバックアップ対象であり、同じファイルの `redactSecretsInText` は登録済み env secret しか伏せず query を見ません。取得自体は完全なアドレスを使います——署名を削れば画像はそもそも取得できません。
- 共通 logger は journal、Worker envelope、`logs/` に渡す**前**に 2 段階で redact します。登録済み env secret は値で置換し、SDK/HTTP error 内の `authorization`、`cookie`、`set-cookie`、API key、token、secret、password などの credential field は key で置換します。raw header tuple も対象です。xAI/Cloudflare の response Cookie は process config の値ではないため、後者を env list だけに頼ってはいけません。error object 全体を毎回 deep copy せず既存の JSON serialization traversal を再利用し、request id、rate-limit counter、token count など非機密の診断は残します。
- **`normalizeChatState` が回収するのは「本当に期限切れ」のフィールドだけで、「値が不自然に見える」ものは削除ではなく丸めます。** `quietUntil` の上限判定（`isQuietUntilActive`）は壁時計の巻き戻しのために置かれていますが、`/quiet <上限分>` が書く `quietUntil - now` はちょうど `QUIET_MAX_DURATION_MS` と等しく、許容差がなければ 1 ミリ秒の巻き戻しで上限いっぱいの静粛がその場で無効になります。そこで判定には `QUIET_CLOCK_SKEW_TOLERANCE_MS` の許容差を持たせて通常の NTP step を吸収し、それを超える大きな巻き戻しはこの normalizer が `now + QUIET_MAX_DURATION_MS` へ丸めます——静粛は有効なまま、かつ上限までに必ず終わることが保証され、それこそがこの上限の本来の意味です。フィールドの削除は選べません。この normalizer は `saveState()` のたびに全チャットに対して走るため、一度削れば静粛はメモリと SQLite `chat_states` から同時に消え、時計が戻っても復元できません（巻き戻しに対して「範囲外の項目だけを捨て、窓全体は決して消さない」とする `libs/slidingWindowRateLimit.ts` と同じ判断です）。
- **`ChatState` は正準形状です：全フィールドを一度に作り切り、以後は代入のみで決して `delete` しません**（`libs/chatState.ts` の `createChatState`）。「設定されたことがない」は `undefined` で表し、キーの不在では表しません。エントリのないチャットに `getChatState` が渡す `DEFAULT_CHAT_STATE` も同じ形状でなければならず、さもないと「エントリあり／なし」の間で hidden class が行き来します。これはホット呼び出し地点の形状契約です（AGENTS.md：後からフィールドを増減してはならない）——グループメッセージ 1 通ごとに `getChatState(chatId).isXEnabled` を 4〜6 回読みます（`antiRaid/updateIngress.ts`、`antiRaid/floodControl.ts`、`antiRaid/adCandidate.ts`、`auto/message/index.ts`、`aiChat/availability.ts`）。

  **ディスク形式は変わりません**：`JSON.stringify` は値が `undefined` のキーを飛ばすため、SQLite `chat_states` の JSONB 行には既定値から外れたフィールドだけが残ります（確認済みの `botPermissions` は例外——「管理者でない」は `isAdministrator: false` の完全な snapshot として保存し、「未確認」を表す `undefined` とは別物なので必ず永続化します。`libs/chatState.ts` の `isEmptyChatState` を参照）。したがって空判定は `Object.keys().length` を数えるのではなくフィールドごとに値を見ます（正準形状では常に 11 です）。`clearChatStateField` の「設定されたことがあるか」も同様に `field in chatState` ではなく値で判定します。デコード結果は疎です（行には実在したキーしか含まれません）ので、`chatStates` へ入れる前に `adoptChatState` で正準形状へ移さなければ、ディスク上の形状差がそのままホットパスへ持ち込まれます。書き戻しは必ず `encodeChatStateData` を通り、同じ厳密デコーダがフィールド集合を守ると同時に各チャットのキーを固定順へ並べ替えます。
- AI メモリとスタンプカタログは entity ごとのアトミック snapshot を使います。ログ、運勢、認証待ち状態は末尾切断を修復できる追記型 JSON を使います。各追記 batch は成功応答より前に fsync します。認証完了は tombstone を追記します。東京日付をまたいだ起動では、最新の旧日ファイルを厳格に decode し、当日のより新しい active 値と tombstone を重ねて当日へ原子的に compact します。公開成功後だけ旧日を削除し、旧日が破損していれば新旧双方を変更せず復元を拒否します。

  定常時は東京当日のファイルだけを保持し、件数または byte threshold で active snapshot へ compact します。切断修復では JSON 文字列、escape、括弧の深さからトップレベル member の境界を判定し、object 値末尾のインデントに依存してはいけません。`null` tombstone など primitive 値も完全な最終値として扱います。
- Disk I/O の起動復元は 3 段階です。全 persistence domain を read-only inspect して厳格 decode し、すべて成功した後だけ memory owner と writable SQLite connection を adopt します。temporary/orphan/期限切れ file の清掃と compact は成功応答後に行い、その後で唯一の東京 0 時 maintenance cron を登録します。cron は domain ごとに失敗を分離し、運勢、log、入室 log、広告 sample、認証待ち、一時 allowlist の maintenance をまとめて起動します。既存の起動時・event 経路は fallback として残します。inspect が失敗した場合、どの domain の file や permission も変更せず maintenance cron も残しません。AI Worker の AI memory・sticker protocol hydrate も同じ厳格 decoder を再利用し、不正 payload は item 単位で黙って捨てず初期化または再構築を失敗させます。
- AI メモリの upsert/delete は chat ごとの実行時単調 revision を使います。メインスレッドは未確認の delete tombstone を保持し、Disk I/O Worker は unlink が durable boundary に達したか、より新しい revision が delete を上書きした場合だけ応答します。Worker 再構築では tombstone と最新ミラーを replay し、順序が最終結果を決めないようにします。

  確認済み delete または LRU eviction 後の最初の新 snapshot は直ちに保存し、対応する durable upsert 応答を受けるまでメインスレッドが revision marker を保持して、Disk I/O Worker 再構築後に最新ミラーを replay します。起動復元では SQLite `chat_states` を正本とし、AI が明示的に有効なグループだけを hydrate し、無効グループの残存 snapshot は削除予定にします。

  現行 snapshot の hot message はすべて正の `messageId` を持ち、メッセージ index はそこから再構築して別途永続化しません。

- `chat_member` の入室事実に対応する update を確認してよいのは、`flushDiskIODomain("joinLog")` が `flushed` を返した後だけです。post 成功は durable を意味しません。**ただし「buffer 済みで未書き込み」は「書き込み失敗」と分けて報告しなければなりません。** 永続化 Worker の自己修復中は `diskIORuntime.writable` が false で、`postDiskIO` はメッセージを上限付きの再生 FIFO へ積んで true を返す一方、同じ窓の `requestDiskIOFlush` は書き込み可能な Worker が存在しないというだけで `failed` へ短絡します——それは「今は誰も flush できない」であって「書き込みが壊れた」ではありません。したがって `recordJoinLog` は post の **前に** `isDiskIOBuffering()` を採取し、それを根拠に通します（post の後で尋ねると「buffer に入った」を「送信済み」と読み違えます）。そうしないと、この窓で入室が 1 件あるだけで `updateIngress` が throw し、`bot.catch` が rethrow して `handleUpdate` が reject し、自己修復可能な一過性障害がプロセス全体の非ゼロ終了と一連の update 再配信にまで拡大します。buffer は黙って捨てることではありません。handshake が終われば `activateDiskIOWorker` が順序どおり再生し、再生失敗も buffer 飽和も `stopWorkerAfterLoadFailure` の統一 fatal 停止経路を通ります。

  **この約束は再生区間マークによって果たされます**（`RecoveryReplayRequest`）。拒否フラグが boolean 1 つで足りる根拠は「`recordJoinLog` の post と直後のドメイン flush の間に await がなく、2 つのメッセージは必ず隣接して届く」ことですが、復旧バッファの再生だけがこの前提の唯一の例外です——その post はクラッシュ窓の中で起きており、`recordJoinLog` は buffer に入った時点で既に update を通しています。以後、書けたかどうかを尋ねる者は誰もいません。Worker 自身は「オンライン」と「再生」を見分けられないため、メインスレッドが排出の前後に 1 つずつマークを送って区間を囲みます（排出全体は同期で、オンラインメッセージが割り込む余地はなく、この対が囲むのはまさに再生分だけです）。区間内の書き込み失敗は `recoveryReplayFailed` も返し、メインスレッドはそれを受けて停止し、Telegram に最後の確認点から一括再配信させます。このマークがないと拒否フラグは**無関係な**後続の入室事実の flush に付いてしまい、そちらが巻き添えで再配信される一方、本当に失われた 1 件は何の痕跡も残しません。書き込み失敗時、Worker は元の group を buffer に戻して backoff 再試行し、消去して捨ててはなりません。未 flush の事実は 1,200 件を hard limit とし、飽和時は即座に失敗して未確認 update を再配信させます。**この即時失敗は Worker のメッセージルータで受け止めなければなりません**：例外が `onmessage` を抜けると Bun は永続化スレッドごと終了させ、実行中の flush はすべて失敗として決着し、各ドメインの buffer もスレッドと一緒に失われます。入室事実 1 件の代償としては大きすぎます。ルータは代わりに拒否フラグを記録し、統一 flush の joinLog 出口がそれを一度だけ消費して当該ドメインの失敗として報告します。拒否された事実は buffer に入っていないため、buffer だけを見ると「何も書けていない」状態を flush 成功と報告してしまいます。

  disk 障害を無制限の memory 使用へ変えてはいけません。chat/day の latest-by-user index は LRU で最大 64 個、失敗 backoff table は最大 128 file を常駐させます。どちらも正式な file または次回 retry から安全に再構築でき、永続化成功の証拠にはできません。Telegram が完全に同じ event を再配信した場合は、disk から復元した index が追記前に除外します。

  `/batch_kick` は `[since, now]` の rolling interval を読み、東京深夜をまたぐ場合は 2 つの chat/day file を merge します。「当日」へ切り詰めてはいけません。

  **窓の両端は `joinedAt` と同じ時計から取らなければなりません。** 保存されている `joinedAt` はすべて Telegram の `update.date` 由来です（`antiRaid/updateIngress.ts`）。したがって `/batch_kick` の「現在」はホストの `Date.now()` ではなく、そのコマンドメッセージ自身の `ctx.msg.date` から取ります——2 つの時計をそのまま引き算すると、窓の境界が両者のずれの分だけまるごと移動します。`readJoinLog` は `since`/`now` を各 `joinedAt` との比較にも、どの 1〜2 個の日ファイルを開くかの判断にも使っており、そのファイル名自体が `joinedAt` の東京日付から付けられています。保持期間の側は引き続きホスト時計で判定します（`readJoinLog` 内の `today`）：そちらが問うのは「ディスクに何日分残っているか」であり、Worker 自身の日跨ぎ整理が決めるもので、イベント時刻とは無関係です。

  **「窓の外」の 2 つの側は結末が異なるため、分けて判定しなければなりません。** **古すぎる側**（停止後に Telegram が再配信した数日前の入室）は意図的な黙殺です——rolling 24 時間の窓では元々使い道がなく、失敗として報告すればその update は永久に確認されず再配信され続けます。**本 Worker の当日より先行している側**は「窓で使えない」ではなく「イベント時刻がホスト時計と食い違っている」であり、上記の統一拒否出口へ throw しなければなりません。古すぎる側と同じように黙って return すると `recordJoinLog` が永続化済みとして報告し、その入室は以後 `/batch_kick` から消え、どこにも log が残りません。

  **`/batch_kick` の戦果報告にある「ブロックリストへ引き渡し」は、本当に引き渡さなければなりません。** ブロックリスト命中で即座に return するレコードに対して、このコマンドは何もしていません（探索も除去もせず）。返信で件数を数えるだけです。バッチ終了後に 1 回だけ再スイープを依頼（`requestBlocklistResweep` + `sweepBlockedMembers`）しなければその一文は空手形です——管理者はブロックリスト側の流れが引き取ったと解釈しますが、実際には batch も sweep も再試行も存在しません。典型的な原因は、以前の BAN batch が流量制限下で `complete` と判定されながら実際には効いておらず、当人がまだ部屋にいる、というものです。ディスパッチは `blocked` の合計ではなく「即 return した件数」で判定します。並行 block 後に BAN を打ち直せた経路はすでに当人を押さえており、sweep を起こす必要はありません。バッチにつき 1 回で十分です。`prepareBlocklistSweep` 自身が claim と `nextRetryAt` の門を持つため、レコードごとに呼んでもコマンドの固定小並列プールの中で空回りするだけです。

### グループ状態と `chat_states`

- **グループごとの状態の正本は SQLite の `chat_states` テーブルであり、メインスレッドは容量がちょうど `STATE_MANAGED_CHAT_LIMIT`（25）のホット読み取り用コピーだけを持ちます**（`packages/cache/main/chatState.ts`）。行の中身は `ChatState` の正規形状です：7 つの機能スイッチ、`quietUntil`、`lockdown` の write-ahead レコード、`botPermissions` の完全なスナップショット、`title`、`isProxySendEnabled`。

- **容量ゲートは拒否するだけで、決して追い出しません。** 26 件目を新規作成しようとすると `assertChatStateCapacity` が throw し、起動時に 26 行目を読むと `hydrateChatStateCache` が起動を拒否し、Disk I/O Worker も書き込み側で独立に再検証します（3 つとも互いに依存しません）。したがってキャッシュの追い出し分岐には到達しませんが、これは意図的です——管理中のグループの状態を追い出すと、それは黙って `DEFAULT_CHAT_STATE` として読まれます：全機能オフ、権限は不明、しかもどこにもエラーが出ません。

  追い出しが起こり得ないからこそ、**ホット読み取りは `get` ではなく `peek` を使います**：recency を更新するための `Map.delete` + `Map.set` は何も買えず（chat-state-map-read の実測で 253.0 → 14.1 ns/op）、`getChatStateCache()` の反復順序を読み取り履歴の関数にしてしまいます。その順序は `/block`・`/unblock` の連動 BAN 対象グループ一覧としてそのままユーザーに提示されます。

- **容量超過の拒否は `/init enable` だけのものであり、必ず 1 行の返信でなければなりません。** 新しいグループを管理下に置く入口はこのコマンドだけで、上限を超えた場合は `INIT_CHAT_LIMIT_TEXT` を返します。他のコマンドは新規作成を引き起こしてはいけません——したがって `/send <グループ id>` は対象が既に行を持っていることを要求し、無ければ 1 行の案内だけを返します。容量エラーがコマンドハンドラから逸出すると、それは再配信に駆動される再起動ループです：update は確認されず、プロセスは非ゼロで終了し、Telegram が同じコマンドを再配信し、また throw します。

- **既定値に戻ったレコードは消えなければなりません。** 書き込みの前に必ず `normalizeChatState` を通し（`false` のスイッチは `undefined` に収束し、期限切れの `quietUntil` は回収されます）、その結果 `isEmptyChatState` が真ならキャッシュ条目を削除し、削除の tombstone を書きます。そのため `/init disable` は `title` も一緒に消す必要があります——グループ名は管理中のグループのためだけに記録され（`applyChatTitle` も `isInitEnabled === true` しか認めません）、残したままだとレコードは永遠に空にならず、そのスロットは二度と戻らず、しかも残骸を消せるコマンドはリポジトリのどこにもありません。

- **アクティブな中継先は最大 1 つ**（`isProxySendEnabled`）：書き込み側と起動時の全表復元がそれぞれ独立に検証します。書き込み側は**帰納的**に判定します——この書き込みの前に不変条件は成立しているので、それを壊し得るのは `isProxySendEnabled` を立てる書き込みだけであり、それ以外の書き込みは他の行を走査する必要がありません。

- 永続化は identity テーブルと同じ write-through ＋ 正確な revision ACK です：`persistChatState` は正式な決定のための durable barrier、`saveChatStateInBackground` はタイトル更新や権限スナップショットの失効のような再構築可能な値のための低優先度書き込みです。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

### chat Q&A と `chat_qa`

- **正本は SQLite の `chat_qa` table で、main thread が唯一の hot copy を持ちます**（`packages/cache/main/qa.ts`）。主キーは `(chat_id, q)` の複合キーで、`q` には別途 index があります。1 つの chat で同じ質問に対する答えは 1 つだけ——この一意性を SQLite に直接表現させることで、書き込み側は重複を探し直す必要がなくなります。table 全体は 375 行を超えません（管理対象 chat × `CHAT_QA_MAX_PER_CHAT`）。したがって起動時に一括読み込みし、removal outbox のような paging は行いません。

- **chat ごとの上限は 3 箇所で独立に守ります**：main thread の `setChatQa`、Disk I/O Worker が transaction buffer に入れる前、そして起動時の全 table decode です。3 つは互いに依存しません。database に既にある行は main thread の受け入れ判定を経ていないためで、手動編集や他所から復元した backup は上限超過のデータを持ち込みうる一方、それは `/set_qa` が以後ずっと追加を拒み続ける原因になり、しかも表面からは理由が見えません。

- **form は chat で索引し、開いた本人で認可します**。`/set_qa` は command 側で `isCanControllQaPermission` を確認して `openedById`（可視身分、すなわち `sender_chat ?? from`）を記録します。以降の投稿 message は「可視身分がそれ本人か」だけを検査し、permission を再度引きません。両側は同一の可視身分判定を使う必要があります——command 側の `resolveCommandActor` と投稿側の `visibleSenderChat` は一字一句同じ式です（command context では `ctx.chat === ctx.msg.chat`、`ctx.from === ctx.msg.from`）。ここがずれると、匿名管理者や channel の皮は自分で開いた form を永久に埋められません。**channel の皮が Q&A を設定できるのは、この 2 つが同一の式であり続けることに全面的に依存しています。**

- **フォームの終了は session object の同一性で判定します**。自発メッセージ照合・入力削除・フォーム編集を await した後に現在の session を再確認します。削除前に終了した session は入力を取得しません。削除開始後は入口が入力を保持して下流の再処理を止めますが、終了済み session に項目を書き込んだり受領通知を送ったりしません。現在の session を実際に終了できた呼び出しだけが確定でき、TTL・再作成・teardown・取消後の古い入力は問答を登録できません。

- **フォームの送信と後処理は `qa/notices.ts` に集約します**。送信失敗時は session を終了します。返された message ID を同期的に登録し、終了後の遅延応答は削除境界へ渡します。削除時に ID の所有権を同期的に手放すため、後処理を繰り返しても要求は 1 回です。確定通知の成功・例外のどちらでも後処理します。共通 Telegram 境界の取消とエラー処理に従い、停止取消を回避せず、独自 retry queue も作りません。

- **投稿入口は自分の投稿を弾かなければなりません**。channel では Bot 自身の投稿が `channel_post` としてそのまま返ってきます（`infra/selfSentTracker.ts` 参照）。しかも form の提示本文には `問題:`・`回答:` の 2 行の例が書かれています。`isBotOwnMessage` の関門が無ければ、form は自分の例文で自分を埋めてそのまま登録してしまいます。form 自身の `message_id` でもう一段守ります。同じ理由から、この入口は `message` だけでなく `["message", "channel_post"]` に登録します。channel での投稿は channel post なので、`message` だけを監視すると channel では form を一切埋められません。**同期の `isBotOwnMessage` が覆うのは main thread 自身が送ったもの**（form・受領通知・board）だけです：update runner は厳密に直列なので、それらの `markSelfSent` は跳ね返り update が取得されるより必ず前に済んでいます。Worker が送ったものは proxy 境界で main thread 側に登録されます（[送信リクエストとメッセージの安全性](#送信リクエストとメッセージの安全性) 参照）が、登録の時点は送信レスポンスの到着であり、`channel_post` の跳ね返りとの順序は保証されません。しかも channel post の可視身分は channel 自身であり、channel 身分が開いた form の `openedById` と必ず一致するため、身分による判定でも止まりません。したがって `needsBotOwnMessageWait` + `waitForBotOwnMessage` による有界 rendezvous をもう一段置きます。口径は `auto/message/index.ts`・`commands/cjkAction.ts` と同じです。**これらの判定は重要度ではなくコスト順に並べます**：入口はメッセージ本線上にあるため、最初は chat id をキーにした `Map.get`（数値キー、割り当てゼロ、外れたら即 return）でなければなりません。`isBotOwnMessage` はその後ろです——こちらも割り当てはゼロですが（`infra/selfSentTracker.ts` は複合キー文字列を作らず `(chatId, messageId)` を整数キー 2 段で直接引きます）、1 通あたり最大 2 組を引くため、ここで外れたら即 return する `Map.get` 1 回よりは高価です。thread をまたぐ rendezvous は最も高価なので、安価な判定をすべて通した後・副作用の前に置きます。いずれも `return null` するだけなので、順序は結論を変えず、1 通あたりの支払いだけを変えます。

- **回答内の code block はリテラルの ``` fence として保存します**（`libs/codeFence.ts`）。Telegram client は送信前に fence を `pre` entity へ畳んでしまい、本文には block の中身しか残りません。入口で entity をリテラル fence に戻して保存し、直接応答の出口で本文 + entity に戻して送出します。entity の offset ではなく fence を保存するのは、`chat_qa.data` を単一の文字列に保ち、永続化フォーマットに手を入れないためです。**fence 自体も `CHAT_QA_ANSWER_MAX_CHARS` に数えます**。さもないと「保存できる」と「送信できる」が境界でずれます。

- **form の表示も 1 通あたりの上限に縛られます**。質問と回答はそれぞれ独立した上限（256 / 3840）を持ち、しかも別々の投稿 message から届くため、受信 message 1 通の 4096 文字はその合計を縛れません——両方を上限まで埋めると form 本文は 4216 に達します。form は `editMessageText` 1 通の直接送信で、**ページングはありません**。上限を超えても得られるのは 400 が 1 回と、古い内容のまま固まった form だけで、しかも失敗の戻り値は `editQaForm` が捨てるため誰の目にも触れません。そこで `renderQaFormPrompt` は残り予算に合わせて**回答の表示**を切り詰め、省略記号を付けます。質問は切り詰めません（短く、かつ本人が自分の書いた内容を確認する根拠だからです）。切り詰められるのは表示だけで、正となる値は session に残り、保存に使われるのはそちらです。

- **board は回答を切り詰め、質問は決して切り詰めません**。`/query_qa` は回答を `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` まで詰めて省略記号を付けますが、質問はそのまま列挙します。質問は `/remove_qa` の引数であり、切り詰めた質問をそのまま渡しても何も削除できないからです。ページは `QA_QUERY_PAGE_MAX_ENTRIES`（3 件）ずつ詰め、**長さ予算では詰めません**——予算方式では短い Q&A が 1 ページに収まってしまい、`buildQaBoardKeyboard` は 1 ページのとき `undefined` を返すため、ページ送りのボタン列がまったく現れません。件数を固定すれば長さの門は重ねて要りません。質問は 256 文字に制限され（`database/codec/chatQa.ts` が保存側と復号側の両方で強制）、回答は board の preview 上限で 256 に詰められるため、満杯 3 件のページは 1 通あたりの上限からはるかに手前に収まります。ページ番号は `callback_data` の中にしか存在せず、クリックのたびに hot table から詰め直します。そのため古い board は、再起動後も、件数の増減後も、chat が空になった後でさえ、もう一度押せば現在の事実に収束し、既に存在しない snapshot を描画することはありません。

- **質問文は書き込み時に trim し、hot path では正規化しません。** 直接応答の判定はメッセージ本線上にあり、外れたときのコストがゼロになるよう作られています。登録の無い chat は最初の `Map.get(chatId)` で戻り、`message.text` すら読みません。命中は元の文字列に対する 2 回目の `Map.get` です。この経路の割り当ては「先頭 entity が bot mention」という 1 つの分岐だけに閉じています。username 比較のための 2 回の小文字化と、本文を取る 1 回の切り出しです。**小文字化が効くのは username だけで**（Telegram の username 自体が大文字小文字を区別しません。口径は `infra/updateGate.ts`、`auto/message/facts.ts`、`commands/cjkAction.ts` と同じです）、質問文は一字一句同じであることを要求し続けます。判定は同期のままで、外れたときに promise を割り当てません。

- **直接応答は AI トリガーより前に走り**、`/quiet` でも抑制されません。登録済みの質問をそのまま尋ねる行為は受動トリガーであり、返信や @ mention と同類です（`/quiet` の範囲は「Telegram プロンプトの保持」を参照）。命中したらその場で回答し、そのメッセージの後続処理を打ち切ります。さもないと同じ質問が登録済みの回答を受け取りつつ、AI ラウンドやランダム複読も引き起こします。**打ち切りは、その質問と回答のどちらも AI のローリングメモリに入らないことも意味します**。ローリングメモリは各 payload handler が AI の段で登録しますが、直接応答はその手前で戻るためです。これはコマンドメッセージと同じ口径です——直接応答が返すのは運用者が登録した固定の答えであり、そのラウンドのモデル出力ではありません。

- **model 側の 2 つの照会 tool に mirror は不要です**：`group_qa_query` と `group_qa_answer` が読むデータは、main thread がラウンドごとに元々送っている `trigger` message に載ります（message を単態に保つため、field は常に存在し空のときは `undefined`）。したがって push protocol も worker 再起動後の replay もありません。`group_qa_answer` は曖昧一致を行いません。model が原文を書き換えた場合は not-found を返します。最も近い entry を推測することは、この chat が登録していない回答を登録済みとして提示するのと同じだからです。

- 永続化は identity table と同じ write-through と正確な revision ACK を用い、worker 再構築後は memory 上の最終値から未確認の書き込みを replay します。

### ブロックリストと広告検出

この節では、[正式なブロックリストと block コマンド](#正式なブロックリストと-block-コマンド)、[広告検出の受付・判定・処置](#広告検出の受付判定処置)、[BAN とメッセージ撤回](#ban-とメッセージ撤回)、[blocklist removal outbox](#blocklist-removal-outbox)、[権限回復後の replay](#権限回復後の-replay)を順に説明します。

#### 正式なブロックリストと block コマンド

- `/block` の authoritative list は SQLite `blocklist_entries` table です。main thread は最近参照した identity の有界 LRU と未 ACK final value だけを保持します。blocklist は同期 security boundary のままであり、mutation 前に target の allow/block policy positive/negative state を prefetch し、write path は database revision の post より先に final LRU value を publish します。逆順では 2 step の間に届く join update が新 block を見落とします。entry は自動 expire せず、manual deletion は `/unblock` だけ。各 row は `blockedAt` と Telegram metadata を含む strict complete record です。

  **`/unblock` は既定で完全解除します。** row があれば negative cache と deletion tombstone を publish し、pending batch から id を除去します。row の有無にかかわらず `ChatState.botPermissions?.isAdministrator` が true の全 chat で Telegram BAN を解除します。必要 permission は `isCanUnBlock` で、旧 `all` 引数は解析しません。chat 横断解除は `only_if_banned: true` の `unbanChatMemberIfBanned` を通し、current member の誤 kick を防ぎます。channel identity は `unbanChatSenderChat`。Worker 内ですでに実行中の batch は撤回できず、短い既知 window が残ります。

  **身内は blocklist に入れません。** `isWhitelisted` は恒久 allowlist row と常時 protected のスーパー管理者を覆い、`/block`、`/mute`、`/batch_kick` が同じ境界を使います。一時 membership は広告免除だけを付与し、この恒久保護境界には入りません。`/white enable` も blocklist 中の identity を拒否します。`runProtectedIdentityMutation` は「disjointness check + authoritative identity value publish」を main-thread tail 1 本で直列化します。critical section は identity check と authoritative change だけを含み、Telegram effect と durable confirmation は外に置きます。block path は一時 activity の tombstone を blocklist final value より先に queue し、Disk I/O transaction と startup hydrate は blocklist と 2 種類の allowlist の非交差を独立再検証して、conflict は fail closed です。

  startup は canonical non-zero safe-integer primary key、strict JSONB payload、cross-table reference を全 row で検証します。1 row でも不正なら identity database 全体を拒否し、truncate、drop、guess はしません。`memory/ai/<chatId>.json` のように id で命名する persistence file は canonical decimal filename check を維持し、zero-padding alias の memory collision を防ぎます。

  永続化に失敗したときは `/block` の返信でそれを明言します。

  Worker 側の書き込みエラーは `console.error` であり、設計上 `logs/` には入りません。

  **唯一の例外が日次おみくじの追記停止です。** 連続失敗がしきい値に達すると Worker は追加で `luckAppendStalled` 診断をメインスレッドへ送り、おみくじの owner が `logger.error` を 1 行だけ `logs/` に記録します（エッジトリガーで、1 回の障害期につき 1 行）。報告するのは個々の `write(2)` の失敗ではなく「あるドメインがデータを失い続けている」という事実です。おみくじの欠落は他のどこにも痕跡が残りません——メインスレッドの `dailyLuckCache` は通常どおりヒットするため、利用者には異常が見えないからです。再帰の危険はありません。この log は log ドメインを通り、log ドメイン自身の書き込み失敗は従来どおり `console.error` で終わります。

  **永続化の確認はドメイン単位に絞ります。** 統一 flush（`flushAll`）は 8 ドメインの論理積なので、どれか 1 つが失敗すれば全体の受領は `flushFailed` になります。`/block` が待つべきは `flushDiskIODomain("blocklist")` だけです。そうしないと、あるチャットの `memory/ai/<chat>.json` の所有者がずれているだけで「小さな手帳をディスクに書けなかった」と報告し、実際には壊れていないファイルへ運用者を誘導してしまいます。

  したがって受領は `failedDomains` を運び、メインスレッドが本当に壊れたドメインを名指しします。名指ししなければ、本当の障害について `logs/` には 1 行も入りません。

  **同じ相手への 2 回目の `/block` は、永続化に失敗した後の再試行そのものです。** 対象が blocklist LRU にあっても未 ACK の `blocklist` revision が残る場合、`ensureBlocklistEntryQueued` は最終値を投げ直して確認を待ち直さなければなりません。「LRU にもうある」を理由に `persisted` を true 扱いすると、SQLite にその行がないまま 2 回とも管理者へ成功と伝えることになります。ブロックリストのメンバーが入室した場合は「kick のみ」ではなく必ず ban します。

  kick のみという規則は anti-raid の自動退出で誤爆を防ぐためのものであり、ここにある id はすべて管理者が自分で書き込んだものです。「この Bot はこのチャットで動ける」という論理積（**管理者である && `/init enable` 済み**）が成立している間は、1 回の掃除（`sweepBlockedMembers`）が必要です。ブロック実行時にそのチャットでは権限がなく連鎖 BAN が飛ばされており、入室時の即 kick はそれ以降の入室更新にしか効かず、すでに部屋にいる相手には無力だからです。

  トリガーは特定の update ではなく論理積そのもので、どちらの辺が変わっても対象です。

  **エッジを消費してよいのは処理が着地した瞬間だけで、投げた瞬間ではありません。** `recordBotChatPermissions` は管理者身分を確認するたびに `sweepBlockedMembers` を呼び、「このチャットは掃除済みか」は Worker の `blockedMembersRemoved` 受領に基づいて `blocklistSweepState`（`packages/cache/main/blocklist.ts`）が記帳します。`complete` のときだけ `sweptAt` を記録します。

  身分変化のエッジに掛けてしまうと、1 度の rate limit 失敗がそのまま「その人たちが永久に部屋に居座る」ことになります。再試行も同じ管理者観測に乗るため、入室のたびに届くその更新に対して `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` の待機が必須です。`/init` の切り替え、管理者剥奪、退出はいずれも `forgetChatBlocklistWork` を通り、そのチャットの掃除進捗を破棄する**と同時に実行中の batch も捨てます**。再び担当することになれば改めて 1 回借りを作ります。

  この破棄は状態の永続化より**前**に行わなければなりません。担当を外れたことは Telegram が既に伝えてきた権威ある事実であり、`state.json` が書けなかったからといって取り消されません。永続化が拒否されるとプロセスはそのまま終了し、ディスク上の `botPermissions` snapshot は `isAdministrator: true` のままで起動時の filter も効かず、必ず失敗する処置が再起動と Worker 再生成のたびに投げ直されます。

  同じ理由で、`resolveBotAdminStatus` の「取得できなければ管理者ではないとみなす」は `getChatMember` 自体にしか掛かりません。状態の永続化失敗はそのまま上へ投げる必要があります。「管理者ではない」に畳み込むと呼び出し側が入室ガードを丸ごとスキップし（その `new_chat_members` の一団は認証 window も開かず、メッセージ追跡もされず、timeout kick も来ません）、しかも診断は Telegram API を指し、次の呼び出しはメモリから `true` を読むため、現象を再現できなくなります。

  **`sweptAt` は latch であり、それを開ける経路が必ず要ります。** `requestBlocklistResweep`（`packages/infra/blocklist/sweep.ts`）は「このチャットにまだブロックリストのメンバーが残っている」という信号——`/block` があるチャットで `banChatMember` に失敗した、即 kick の batch の受領が `complete: false` だった——を受けて `sweptAt` を null に戻します。

  これがないと、一度掃除済みのチャットではその相手がプロセス終了まで居座ります。即 kick はそれ以降の入室にしか効かず、掃除は latch に阻まれるからです。batch が実行中の場合、要求は `sweptAt` を直接触らず `resweepRequested` を記録するだけにします。その batch の `complete: true` 受領が要求より後に届くと `sweptAt` を書き戻し、要求が消えてしまうためです。即 kick の失敗による再掃除には待機を付けます。

  ブロックリストの相手は何度も入り直せるため、失敗のたびに即座に再掃除すればブロックリスト長ぶんの判定 request が嵐になります。さらにその待機は、そのチャットで**連続して落ち着かなかった掃除の回数**に応じて `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS` まで線形に伸ばし、`complete` の受領で回数をゼロに戻します。

  **この回数は受領だけでなく、落ち着かなかったすべての経路が進めなければなりません**：`sweepBlockedMembers` の 3 つの降格経路（outbox に登録できない、配信境界で例外、**配信は正常に resolve したのに 1 件も投函されていない**）の後には回数を進めてくれる受領がもう来ません（claim は既に空で、遅れて届いた受領は回数を触らない再掃除要求の経路を通ります）。

  取りこぼすと、実行 owner が投げ続ける間（Worker 使用不能、outbox 満杯）は毎ラウンドが基本間隔で組まれて上限に永久に届かず、しかも 1 ラウンドごとに outbox id 1 つとエラー log 1 行を焼きます。

  **3 つ目が最も見えにくいため、実行 owner は実際に投函した件数を返さなければなりません**（`BlockedMemberRemover` は `Promise<number>` を返します）。並行する `/unblock` が `BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS` の間 outbox を変え続けると、durable な突き合わせは `removeBlockedMembers` のバッチを丸ごと差し止め、純粋な補掃除のバッチは空配列だけになり、配信経路は `length === 0` で早期 return して正常に resolve します——例外も投げず、実行中のメッセージも 1 件もありません。ゼロ配信は例外時と同じ後始末（claim の無効化、`delivery-boundary` の記録、バックオフの前進）を通さなければなりません。「例外が出なかった」だけを見ると claim の `removalId` は元の値のまま、受領は永久に来ず、`prepareBlocklistSweep` はこのチャットに対して以後ずっと早期 return します。プロセスの生存期間中そのチャットは二度と掃除されず、`hydrateBlocklist` + `replayPendingBlockedRemovals` を通るプロセス再起動でしか回収できません。

  **「権限不足」は他の失敗と別枠にします**。バックオフを伸ばしても結局は時間による再試行であり、BAN 権限がない状態では何度試しても同じエラーを再び出力し、さらに O(リスト長) の再スキャンを払うだけです。`banChatMemberWithOutcome`（`packages/infra/telegram/actions.ts`）が Telegram の応答から切り分けます。403 はすべて該当、400 は `not enough rights` を名指しした場合のみ該当します（同じ 400 の「ユーザーが存在しない」を含めてはいけません。

  再試行可能なバッチが、決して来ない承認を待って永久に停止します）。最初に該当した id で残りの試行を打ち切ります。

  **ただし `forbidden` 自体がまだ 2 つの原因を混ぜており、もう一段分ける必要があります**。「対象自身がそのグループの管理者である」場合にも Telegram はまったく同じ 400 `not enough rights` を返すため、`permissionDenied` に混ぜると BAN できない管理者 1 人が**グループ全体**のスキャンを永久に閂で閉じてしまいます（以後スキャンは早期 return、再スキャン要求は拒否、Worker 再生成のたびに replay をスキップし、唯一の解除エッジは「Bot の BAN 権限が変わった」——それは起こりません）。

  そこで Worker は `forbidden` の後に `probeChatAdmin` でその id の身分を 1 回確証します。管理者と確認できたら**その対象だけを決着させ**（名指しのログを 1 行残し、同バッチの残りは通常どおり処理し、バッチも通常どおり落着します）、確証できなければ元の判定を維持します——確証なしにグループ単位の閂を個別再試行へ格下げしません。

  **ただし「このバッチは再投入不要」は「このグループは掃除済み」ではありません**。受領には `complete` と直交する `targetIsAdmin` を別途載せ、メインスレッドはそれを見て `sweptAt` を書かず、そのグループの連続失敗カウントを通常どおり積み増します（積まないと、管理者権限を持ち続けるブロックリスト対象 1 人がリスト全体の再スキャンを 5 分周期に固定してしまいます）。

  この 1 枠がないと、バッチが成功を報告したその瞬間に閂が閉まります——対象が一般メンバーへ降格された後も再スキャンは二度と来ず、それでもボットは「ブロック済み」と称し続けます。本当の権限不足なら受領に `permissionDenied` を載せてメインスレッドへ返します。メインスレッドは印を 2 か所に記録します。

  メモリ上の `blocklistSweepState.permissionBlocked` はそのグループの時間再試行・新規スキャン・Worker 再生成時の replay を止め、durable outbox の該当項目は `missing-permission` になります——これは停止したバッチが持つ唯一の自己説明的な印で、運用者にネットワークやディスクではなく権限付与を指し示します。

  **そのグループにまだスキャン記録がない場合は印を捨てず、最小の記録を補って作らなければなりません**。スキャン記録は `sweepBlockedMembers` だけが作りますが、Bot が最初から `can_restrict_members` を持たないグループこそこの印を最も必要とします。記録できなければ入室即時処置の権限拒否が残らず、`replayPendingBlockedRemovals` が Worker 再生成のたびにその失敗確定バッチを投げ直し、解除エッジには解除すべき記録がありません。

  解除するエッジは 1 つだけ、**確証された BAN 権限の観測**（`my_chat_member` 更新または必要時の `getChatMember`。`packages/infra/botAdmin.ts` と `libs/chatMember.ts` の `canRestrictMembers` を参照）です。権限ビットを取得できない経路（他人の `chat_member` 更新から「自分は管理者だ」と推論するだけの経路）では停止したまま保ちます。「観測できなかった」を「権限がある」と読んではならず、権限がまだ無いと観測した場合も解除しません。「管理者である」ことと「BAN できる」ことは別であり、制限権限を外したまま管理者に昇格させるのがこの状態の最大の原因です。固定間隔では「決して BAN できない相手」を受け止められません。相手自身がそのチャットの管理者である場合や、bot が管理者でも BAN 権限を持たない場合、どの掃除も必ず失敗するため、プロセスが生きている限り 5 分ごとにリスト全体を掃除し続けます。それらは認証 timeout kick と同じ `kick` 429 category に属し、実際の cooldown 中は共に積み上がります。上限も同様に必須です。

  latch には常に開く経路が要り、権限が直った後にプロセス再起動まで待たせてはいけません。

  **処置には状態機械がなく、再送だけが生存手段です。** 各 batch は `trackBlockedRemoval` で採番して `pendingBlockedRemovals` に控え、Anti-Raid Worker の再生成時には表ごと再投入します（重複 ban は冪等ですが、取りこぼしはその人が居座り続けることを意味します）。

  **控えを消してよいのは task が完了したか、正式な状態から不要と判断できるときだけ**で、経路は 3 種類です。`complete: true` の受領、正式な取消（`/unblock` で user を外すか、そのチャットの担当を外れる）、そして同じチャットの掃除 batch が新しい掃除に置き換わったとき（リストは増える一方なので、新しいスナップショットは古い batch の上位集合です）。後ろの 2 つを省くと無制限に増えます。

  BAN 権限のないチャットは待機 window ごとに完全な `userIds` の複製を溜め、Worker 再生成のたびにそれらを全部投げ直します。

  **投げる呼び出しが throw しても task を削除してはいけません。** `post()` が false を返すのは Worker が受け取っていないことだけを示しますが、durable outbox は Telegram update の再配信とは独立した復旧境界です。barrier timeout や永続化失敗では Worker がすでに実行中かもしれず、どの失敗でも控えを消すと process をまたぐ再送根拠が失われます。

  catch が `blocklistSweepState` を書き戻す前には、`removalId` がまだ自分のものかを照合しなければなりません。

  **逆に、落定ではなく「銷帳」でバッチを手放す経路は、その実行中スロットを自分で解放しなければなりません**（`releaseSweepClaim`）：null でない `removalId` は「このグループでバッチが走っている」唯一の証拠で `sweepBlockedMembers` はそれを見て早期 return しますが、銷帳のあとに受領が来ることはありません——そのグループは本プロセス内で二度と sweep できなくなり、`requestBlocklistResweep` でも戻せません（実行中バッチがある間は `resweepRequested` を記録するだけで `removalId` はそのまま残します。

  あの経路は「受領はいずれ来る」を前提にしているからです）。解放するのは `removalId` だけです：`sweptAt` はそのまま（このバッチは掃除できていないので借りは残ります）、`nextRetryAt` も派遣時に書いた backoff のままにして、銷帳が即座に再 sweep を買わないようにします。さもないと、先に届いた受領が書いた `sweptAt` を踏み潰します。

  **「着地しなかった」は必ずログに残し、しかもそのログは `removalId` の照合より前に出します。** 即 kick の batch は掃除進捗と一致せず早期 return するうえ、その経路には認証 window の受け皿がありません。そこでの失敗こそ、その人がまだ部屋にいる理由のすべてです。

  **担当から外れた判定はメインスレッドが権威です。** Worker 側の `blocklistRemovalEpochs` は isolate の中にしか存在せず、再生成でゼロに戻るため、再送の関門にはなりません。Worker 側では 1 件ごとに `BLOCKLIST_REMOVAL_MAX_ATTEMPTS` まで待機付きで再試行します。ブロックリストの入室は認証 window を開かず timeout kick の受け皿もないため、この処置が唯一の機会だからです。

  メンバー判定は**不在が確認できたときだけ**スキップし、判定に失敗した場合は ban します（すでに居ない相手を ban しても冪等ですが、見逃しは黙って通すことになります）。掃除は `BLOCKLIST_SWEEP_BATCH_SIZE` ごとに区切って合間に譲り、1 件ごとにそのチャットの処置世代（`packages/cache/workers/antiRaid/blocklist.ts`）を照合します。`/init disable` や管理者剥奪の後は、実行中の batch を直ちに丸ごと放棄します。

  即 kick の経路は `join` を投げないため、処置メッセージが `joinedAt` と入室アナウンスの id を運び、anti-raid の入室カウントの記録とそのサービスメッセージの削除を Worker が代行します。

  **ただし記録に使うのは `joinedAt` そのものではなく Worker が観測した時刻です。** `joinedAt` はメインスレッドが durable outbox の flush **より前**に取得した値で、Worker が自分の時計で既に記録した入室より必ず古くなります。sliding window は渡された時刻を「現在」として扱い、契約どおり「未来」に来た末尾をすべて時計の巻き戻しとみなして捨てるため、1 回の後追い記録が同じ batch で記録したばかりの本物の入室を消し飛ばし、しきい値に永久に届かなくなります。

  同じ理由で、`joinedAt` が既に `JOIN_WINDOW_MS` の外に出た後追い記録はそのまま捨てます。プロセスをまたぐ再送（起動復旧、Worker 再生成）が運んでくるのは前のプロセスの入室の波であり、現在に揃えれば存在しない入室を 1 件でっち上げることになります。

  **ただし `joinedAt` を運べるのは 1 回の物理的な入室につき 1 度だけです。** 同じ入室は `chat_member` と `new_chat_members` の 2 経路がそれぞれ認領します（どちらも塞ぐ必要があります。入室メッセージを隠したチャットには前者しか届かず、その前者も管理者権限がなければそもそも届きません）。通常の入室は `joinCreatesNewRecord` が重複を除きますが、この経路にはその関門がありません。

  両方に持たせると `recordJoin` が 2 回走り、ブロックリストの相手に対して `ANTI_RAID_PER_MINUTE_LIMIT` が実質半分になり、チャット全体が早々に lockdown へ入って通常メンバーの発言権まで奪われます。

  重複除去は `(chatId, userId)` をキーに `recentBlockedJoinCounts`（`packages/cache/main/antiRaid/blocklistGuard.ts`）で行い、window は `JOIN_WINDOW_MS`、容量は `BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES` で抑えます。アナウンスの id は両方に持たせたままで構いません。アナウンスの削除は冪等だからです。

  **入室即時処置の登録失敗（outbox 満杯、id 空間の枯渇）はその場で降格させ、例外を `claimBlockedJoiner` の外へ出してはいけません**。

  この関数は update middleware の中で動くため、投げればその update が失敗し、offset を保留したまま非ゼロ終了し、systemd が再起動して同じ update を再投入し、また投げます——service を停止して SQLite `pending_blocked_removals` を修復するまで抜けられない再起動ループであり、しかも outbox 満杯自体、たいていは永久に BAN できないバッチが積み上げた結果です。

  降格では名指しでログを残し、そのグループに再スキャンを 1 回負わせたうえで、それでも「ブロックリストとして処理済み」を返します。リスト判定は変わっていないので、代わりに入室認証 window を開いてはいけません。

  **ブロックリスト入り参加者への処置は join を「置き換える」のであって「付け足す」のではないため、処置が取り消されたらその join を戻さなければなりません**（`ClaimBlockedJoinerParams.replacedJoin`）：`claimBlockedJoiner` はヒット時に意図的に `join` を積みません——Worker はこれから kick される相手に認証窓を開かないからです。

  ところがそのバッチは write-ahead flush を待っている最中に並行する `/unblock`（`forgetUserBlocklistRemovals`）で丸ごと消え得ますし、`reconcileBlockedRemovalMessages` は権威 params が消えたメッセージをただ外します：戻さなければ、その参加者は removal も認証窓も持たない状態になります——リマインドもタイムアウト kick もなく、荒らし窓の参加カウントも漏れ、そしてシステム内のどこも彼のために窓を開き直しません（`chat_member` だけの経路ではさらに悪く、バッチ全体が空になり何も送られません）。

  **必要なのは「バッチが権威 mirror から本当に消えた」場合だけです**。突き合わせラウンドを使い切った場合は戻してはいけません——task は durable outbox に残っていて当人はまだ排除予定であり、そこで認証窓を開くのはブロックリストに載ったままの相手を通すことになります。

  **この契約は配信経路全体に及び、`claimBlockedJoiner` だけの話ではありません**。`prepareDurableAntiRaidMessages` が `BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS` を使い切ったときも投げてはいけません——`postAntiRaidDurably` 経由で同じ update middleware から呼ばれるため同じ再起動ループになり、しかも発生条件（並行する `/unblock` が同じバッチを削り続ける）は再投入後もそのまま成立します。

  かといって最後の照合結果をそのまま投げるのも不可です。`/unblock` が取り消したばかりのバッチを含みうるからで、それこそこの照合が防ぐべきものです。正しい降格は、処置メッセージだけを丸ごと外して残りを通常どおり投げ、エラーログを 1 行残し、該当グループに再スキャンを負わせることです。タスク自体は durable outbox に残るので失われません。

  **判定と業務実行順はスレッドで分離します。** 判定はメインスレッドに置きます。リストはメインスレッドの状態で Anti-Raid Worker には複製がなく、しかも join を投げる前に判断する必要があるためです（そうしないと Worker がすぐ退出させる相手のために認証 window を開いてしまいます）。メンバー判定と BAN の業務順は Anti-Raid Worker が所有し、各 Telegram capability request は duplex 境界から main thread へ戻って query / kick の 429 lane に入ります。掃除のコストは常にブロックリスト長ぶんの Bot API request ですが、一方の category の backoff が通常 message や別 category を止めることはありません。

  処置メッセージは同じ batch の join/left と一緒に `postAntiRaidDurably` で投げ、Worker が mailbox を処理し終えてから update を引き渡します。Worker は dispatch 後に業務手順を非同期実行して mailbox を塞がず、実際の Telegram HTTP は main thread の唯一の client だけが開始します。main-thread update handler は batch 全体の完了を待ちません。

  infra 層は Anti-Raid の業務モジュールに静的依存してはならず、実行 owner は `packages/cache/main/blocklist.ts` の 1 スロットへ逆方向登録します（`infra/chatTeardownRegistry.ts` と同じ形です）。

  **`/block` コマンド自身によるチャット横断の連鎖 BAN は、このスレッド分離の明示的な例外です。** メインスレッドで各チャット内の `isChatMember` → `banChatMember` を順番に実行し（既定の `bot.api` 経由）、`runBoundedSettledBatch` がチャット間の並行数を最大 5 に固定して個別に確定します。各結果は chat id、input index、attempt を保持します。予期しない rejection はそのチャットだけを失敗として掃除へ戻し、他チャットですでに確定した結果を捨ててはいけません。返信元として既知の sender-chat メッセージの削除も独立して確定します。戦果報告はチャットごとに「蹴り出した」と「BAN を確認した」を区別する必要があるのに対し、現在の Worker 受領は `complete` しか運ばず、Worker へ投げるとチャット単位の結果が取れないためです。

  コマンドは毎回メンバー状態をリアルタイムに照会し、「以前 kick を確認した」という cache を保持しません。現在不在であることから分かるのは今回の呼び出しで退出させていないことだけで、過去に一度も参加していないとは推測できません。照会結果にかかわらず BAN request は必ず再送し、Telegram に `revoke_messages` を実行させます。

  代償は反復コマンドでもメンバー照会が 1 回増え、そのチャットの update レーンを数秒占有し、単発の失敗をその場で再試行しないことです。低頻度の管理者コマンドでは、チャット横断の古い cache を避けるためこのコストを受け入れます。失敗は `requestBlocklistResweep` が受け止め、BAN に失敗したチャットは再び「1 回借りている」状態となり、次の管理者観測で掃除し直されます。

  この例外は `/block` コマンド自体にのみ適用され、即 kick と掃除は従来どおりすべて Worker へ投げます。

#### 広告検出の受付・判定・処置

- `/ad_detect` の広告検出は**ベストエフォートのヒューリスティック**であり security boundary ではありませんが、処分の重さは `/block` と完全に同じなので境界は厳密に引きます。送出の門は 3 条件の連言です。当該グループが `ChatState.isAdDetectEnabled === true` であること、Bot がそのグループの管理者であること（参加ガードと同じ `resolveBotAdminStatus` 判定を共有します。

  管理者でなければ広告も消せず BAN もできず、判定は quota を焼くだけです）、送信者に広告検出 bypass がないことです。bypass は個別の `isCanBypassAdDetection` permission だけで決まります。false に設定した identity は判定へ送られ、Worker が命中した message bundle を削除することがあります。`SUPER_ADMIN_USER_ID` は常にこの permission を持つため常に bypass し、判定箇所で identity を個別に比較することはもうありません。

  **toggle 自体も同じ critical section 内で読み直します。** 判定は Worker 側で行われ、メインスレッドへ戻ってからも blocklist 書き込みの前に identity の直列化キューを通ります。その隙間に `/ad_detect disable` が入り込むことは十分あり得ますが、それが消せるのは Worker 内でまだ判定していない列だけで、すでに公開された判定には届きません。読み直さなければ、switch を切った後でも人が恒久 blocklist に書かれ、全管理チャットで BAN され、公開告知で名指しされます。確認は `blockUser` の直前に置きます。そこを越えると不可逆で、後から撤回しても実行の伴わない既成事実の entry だけが残るからです。これは想定内の競合結果なので通常 log に記録し、protected sender の警告枠は消費しません。

  **allowlist membership は恒久 blocklist を無条件で保護します。** 判定結果がメインスレッドへ戻ると、処分側は `/white` と `/block` と同じ `runProtectedIdentityMutation` critical section 内で `isProtectedSender` を再確認します。判定中に allowlist へ追加された場合も、もともと allowlist で bypass を無効にしていた場合も、`blockUser`・チャット横断 BAN・BAN 告知を拒否し、Worker がすでに行った当該 bundle の削除だけを残します。現在のグループを皮として使う匿名管理者（`sender_chat.id === chat.id`）は `/block` と同じ理由でスキップします。

  皮の下が誰かを Telegram は明かさず、処分はグループ ID 全体を BAN しようとするだけだからです。

  **連携チャンネルからディスカッショングループへの自動転送（`is_automatic_forward`）と、Bot 自身の投稿の跳ね返り（`isBotOwnMessage`）も一律スキップします**。そのメッセージの送信者はチャンネル自身であり、処分は `userId < 0` の分岐で管理下の各グループに `banChatSenderChat` を打ちます——チャンネル側の宣伝投稿 1 件でコメント欄が根こそぎ壊れ、Bot が自分のチャンネルへ投稿したものが跳ね返ってきた場合は自分のチャンネルをブロックリスト入りさせることさえできます。

  チャンネル投稿の可否はチャンネル管理者が決めることで、ディスカッショングループの広告検出の管轄ではありません。

  **Bot 自身の inline 結果（`via_bot` が自分を指すもの）は、グループに落ちた本文ではなく query の元テキストを送出して判定します——これは全 inline 機能に等しく適用されます**。そのメッセージを送ったのは実在のユーザーですが、本文は丸ごと Bot が描画したものです。gag は `renderGagSpeech` が書記素クラスタ単位でランダムに点を挿入し文字を置換して**生成**したもので、判定規則 B「連絡先やキーワードが意図的に変形されている……見ただけでほぼ true と答えてよい」という単項最強のシグナルにそのまま当たり、発言 prefix に付く隠し profile marker も `t.me` リンクなので規則 C「このグループの外へ連れ出す着地点」まで満たします。おみくじの本文は挨拶・抽選結果・偽造防止レシートで、ユーザーが書いたのは所望事項の一行だけです。描画結果を送出するのは、Bot 自身の体裁を根拠に人を一人ずつ恒久 blocklist 入りさせることに等しくなります。この経路が差し替えるのは送出テキストだけで、message id・送信者 identity・処分は従来どおり、広告と判定されるのも実在のそのメッセージです。

  元テキストは**応答したその瞬間**にしか取得できません（Telegram は inline query の原文をグループに落ちたメッセージへ入れず、両者を結び付けるフィールドも持ちません）。そのため各機能は `answerInlineQuery` の前に `recordInlineResultSources(query 送信者 id, 元テキスト, 今回の結果)` で登録し、広告検出は落ちた本文から取り戻します（`inlineResultSourceOf`）。**新しい inline 機能も必ず同じことを行ってください**。登録しなくてもエラーにはなりませんが、その結果は一律に元テキストを取得できず、したがって一律に広告判定へ入りません。ここに登録される内容は送出テキストの供給源にすぎず、通過・紐付け・認証の根拠にしてはいけません。

  **query 送信者ごとに 1 件だけ、まるごと上書きし、履歴は残しません**。inline query はキーを 1 つ叩くたびに届き、実際に送信され得るのは最後の応答に含まれる結果だけです。1 回の応答に複数の結果がある場合（同一人物が複数のグループで同時に gag 中）は同じ元テキストを共有するため、まとめて登録しなければなりません。容量は `INLINE_RESULT_SOURCE_MAX_AUTHORS` を hard cap とし（inline mode は誰にでも開かれており、同時に入力する人数に他の上界がありません）、満杯時は最も長く登録のない query 送信者から捨てます。落ちた本文は登録済みの結果本文と**一字一句同じ**でなければ認めません——クライアントが 1 つ前のキー入力に対する結果を送ることがあり、送信直後に次の query を開けば登録も上書きされます。どちらの場合も、別のテキストで実在のメッセージを判定するより、元テキストを取得できなかったものとして扱う方が安全です。**元テキストを取得できない場合は一律に判定しません**（未登録・容量で押し出された・発言後にプロセスが再起動した・本文が一致しない）。広告 1 件を見逃す方が、Bot 自身の描画結果を判定へ流し込むよりましです。元テキストが空の応答も同様に登録しません。そうした結果にはユーザーが書いた文字が一つも含まれないからです（素のおみくじ、確率カード、レート制限の通知）。

  **この免除は引用文にも及ばせなければなりません**：ディスカッショングループではトップレベルのコメント 1 件ごとの `reply_to_message` が同じチャンネル投稿であり、投稿自身だけを弾いてその本文を `sampleContext` に写して送出するのは、チャンネル自身の宣伝コピーでコメント投稿者を一人ずつ判定するのと同じです——チャンネルの宣伝 1 件でコメント欄の全員が、一文字も書いていないまま順にブロックリスト入りしかねません。`quote` は返信先メッセージから切り出した抜粋なので、一緒に捨てます。

  **グループ管理者／オーナーは決して処分しません**。処分は `/block` と同じく不可逆（永久リスト + 管理下の各グループでの BAN + `revoke_messages` による直近メッセージの消去）である一方、管理者が提携先のリンクを転送する、冗談で「WeChat 追加して」と言う、それだけで宣伝と読まれ得ます。門は 2 段構えです。

  投入時は Worker 側の管理者キャッシュ（`freshAdminIds`）で既知の管理者を quota の外へ弾き、判定が当たった後は `getChatAdministrators` を基準にもう一度確証します。そこで**確証できない場合は必ず「処分しない」**を選びます（広告 1 件を見逃す代価は、オーナーを誤って BAN する代価よりはるかに小さく、次のメッセージで再投入される頃にはキャッシュも温まっています）。

  **判定も副作用もすべて Anti-Raid Worker スレッドで実行します**。メインスレッドは同期的な門と 1 回の `post` のみを担当し（`postAntiRaidDurably` は使いません。待ち行列は isolate と生死を共にするため、グループメッセージごとにスレッド跨ぎ barrier を張っても復旧能力は何も得られません）、post が拒否されても log だけ残して update は拒否しません。

  **キューが持つのは送信者キー（`chatId:senderId`）だけ**です。同じ送信者が待機中に話した内容は `pendingAdMessages` の同じ bundle へ合流し、二つ目のキュー枠を取りません。待機中の所有権は `pendingAdMessages`、`adDetectQueue`、`queuedAdDetectKeys` の三者で共同表現し、必ず同期して増減させます。

  **これら 3 つに触れてよいかの判定は `packages/states/adDetectAdmission.ts`** に集約しました（投入・再キュー・容量・実行中の 4 つの純粋ゲート）。実行時側は結論を実行するだけです。メッセージ束そのものの整形（切り詰め、上限適用、判定用テキストの組み立て）は `packages/workers/antiRaid/adDetect/bundle.ts` にあり、別の不変条件——追い出してよいのは判定済みの項目だけ——を守ります。

  `AD_DETECT_MAX_PENDING_SENDERS` は異なる 8,192 キーの hard cap です。この数字は「何人受け入れられるか」ではなく「満杯でも生き残れるか」で決めます——1 キー当たりの件数上限（`AD_DETECT_MAX_MESSAGES_PER_SENDER`、15 件）と各エントリの本文／URL／サンプル文脈の上限を掛け合わせたものが Anti-Raid Worker isolate の常駐上限であり、参加認証・ロックダウン・ブロックリスト執行はすべて同じ isolate にいるため、OOM はベストエフォートのヒューリスティックもろとも巻き添えにします。

  この 2 つの数字はセットで調整したものなので、どちらを変えても積を計算し直す必要があります。満杯時は Map、キュー、Set のどれも変更する前に 8,193 個目の新規キーを拒否し、受け入れ済みの古いキーを FIFO 追い出ししてはいけません。同じキーの後続メッセージは既存の 1 キー当たり件数・文字数枠の範囲で引き続き合流します。受け入れ済みキーには、少なくとも 1 回の判定試行を受けるまで待機 TTL がなく、周期 sweep も削除できません。

  担当外れ、`/init disable`、`/ad_detect disable`、Worker 停止だけが正当な cancellation 境界であり、Map、キュー、関連 Set から同時に取り除きます。**「このキーは送出待ちの席を取っている」は `queuedAdDetectKeys` だけが表します**。`adDetectQueue` と同期して増減し、取り出した瞬間に解放され、重複排除・容量・再投入の判断はすべてこの 1 枚を読みます。1 つのキーはキュー内で最大 1 席しか占めないため、キュー長は待機表の 8,192 hard cap に自然に抑えられ、投入関門は独立した容量判定を持つ必要も持ってはいけません。

  `recentlyDisposedAdKeys` は処分経路からしか書かれず、手前に受け入れ関門が一切ないため、`setBoundedMapValue` で同じ 8,192 に直接上限を守り、満杯時は最も古い処分を追い出します。過去の送信者が無制限 Map へ変わることはありません。失効時刻ではなく **処分時刻** を保持します：窓は定数であり、`now` が処分時刻より前であること自体が壁時計の巻き戻しの証拠なので、それを根拠に強制失効させます。さもないと巻き戻しは抑止を「巻き戻し幅 + 窓」まで延ばし、その間その送信者のメッセージは一律無視されます。正しさは読み取り時回収が、上限は hard cap が保証するため、この表は **判定 tick には載せません**——tick は全表走査を一切行わず、死んだ記録は周期 sweep に任せます。

  スケジューラは `AD_DETECT_QUEUE_TICK_MS` ごとに 1 本の全体 FIFO から最大 `AD_DETECT_BATCH_SIZE` キーを取り、さらに全体の `AD_DETECT_MAX_IN_FLIGHT` 関門を通します。どちらもグループ別 quota ではなく、実行中上限で止められた受け入れ済みキーは容量回復までキューに残り、期限切れになりません。90 秒の `AD_DETECT_JUDGED_RETENTION_WINDOW_MS` が制限するのは処分抑止と消費済み文脈だけで、**「同じ人を何秒ごとに判定するか」ではありません**。再投入は `queuedAdDetectKeys` が時計と無関係に塞ぎます。

  `seq > checkedSeq` の未消費エントリは待ち時間にかかわらず残し、窓外で刈り取れるのは `seq <= checkedSeq` の消費済み文脈だけです。**周期 sweep は、未消費内容を持ちながらキューにも実行中にもおらず claim も持たないキーを再投入しなければなりません**——claim を辿る失効回収はそのようなメッセージ列を見つけられず、この保険がないとスケジュール枠を永久に失います。なおこの 90 秒は「同じ人を何秒ごとに判定するか」では **ありません**：claim は送出の瞬間に解放され、判定確定時に未判定の内容が残っていれば直ちに再投入されるため、話し続ける送信者の定常間隔は「1 tick + 分類 1 往復」です。スレッド全体の要求上限は `AD_DETECT_MAX_IN_FLIGHT` と tick 毎の `AD_DETECT_BATCH_SIZE` だけが決めます。provider の quota はこの窓ではなくその 2 つで見積もってください。`checkedSeq` は「ここまで消費済み」を表す単調通し番号であり、刈り取りで戻してはいけません。

  **送出の文字数枠（`AD_DETECT_BUNDLE_MAX_CHARS`）が決めるのは「この tick がどこまで判定するか」だけで、「どのメッセージが判定されるか」ではありません**。未判定の内容は必ず最も古い 1 件から詰め、入り切らない分は次回の判定（確定後の再投入）へ回し、余った枠に隣接する判定済み文脈を足します。通し番号は今回実際に送出した最後の 1 件までしか進められません。逆に最新から遡って詰めるのは誤りです——枠から外れた古いメッセージが通し番号の下に埋もれ、通し番号と一緒に「判定済み」として記録されたうえで刈り取られます。

  1 キー当たりの件数上限（15 件 × 512 文字 = 7,680）は依然としてこの枠（4,096）より広いため、長文の連投 1 回で成立します。それは log の痕跡が一切ない見逃しであり、まさにこの規則が禁じているものです。

  **送信者ごとの件数上限（`AD_DETECT_MAX_MESSAGES_PER_SENDER`）も、押し出せるのは消費済みの項目だけです**。爆発的な連投は最初の tick が来る前に上限を埋められ、そのときは未判定の項目しか捨てるものがありません。本文は残しませんが、メッセージ id は `AdMessageBundle.pendingDeleteIds` へ移す必要があります（上限は `AD_DETECT_MAX_PENDING_DELETE_IDS`。あふれたら最も古い 1 件を捨ててエラーログを残します）。**未判定の本文を捨てること自体にもエラーログが必要です**（送信者ごとに 1 回だけ。上限を超えた後は新しい 1 件ごとにもう 1 件押し出されるため、都度記録すればそれ自体が flood になります）。その内容は二度と分類器へ届かず、本モジュール唯一の内容レベルの見逃しになります。ログがなければ運用側は「判定が緩い」ことしか分からず、モデルが見逃したのか本文がそもそも届かなかったのかを切り分けられません。15 件という上限はこの経路を稀ではなくするため、痕跡を残すことは必須です。

  移さないと、それらは判定にも処分の削除集合にも入りません——判定根拠（`judged`）と現在の列（`entries`）のどちらからも漏れるため、命中後もグループに永久に残ります。チャンネル名義では特にそうです（`banChatSenderChat` に `revoke_messages` はありません）。

  **その結果、和集合は `deleteMessages` の 1 回あたり 100 件という上限を超えうるため、呼び出し側で分割する必要があります**。この API は一括の成否しか返さないので、全 id をそのまま渡すとバッチ全体が拒否されて 1 件も削除されません——id を持ち越さないより悪い結果になります。

  **判定失敗は「今回は判定しなかった」として扱い、その batch は判定済みにします**。true を推測せず、無限 retry もしません（provider 障害を毎秒 request storm にしないためです）。

  **引用部分（`quote`）と返信先の元メッセージは本文と一緒に送出しなければなりません**。広告の最も主流な出し方は「まず完全に正常なメッセージを送って判定を通す → しばらく経ってからそれを**編集**して広告にする → 返信／引用でグループに押し上げる」であり、広告本文はどの新規メッセージの `text` にも存在しません。編集は判定の再投入を起こさないため、「元メッセージは投稿時に判定済み」は編集後の内容には成り立たず、`text` だけを読むとこの経路は検出に対して完全に免疫になります。

  **巻き添えの代償は承知のうえで意図的に受け入れています**：広告を引用して苦情を言った参加者も一緒に判定されます——判定器は「広告を引用して非難している」と「引用で広告を押し上げている」を区別できないため、見逃すよりは誤爆する側に倒し、題材の口径は配備側の `config/ad_samples.json` で詰めます。

  **同じ引用文は列全体で、最初にそれを引き取った 1 件にだけ残します**（`claimSampleContextParts`）：まとめて送出する意味はばらして出された断片を 1 つの提出にそろえることにあり、その出し方はほぼ必ず毎件が同じメッセージへの返信です。件ごとに引用文を複製すると 1 件で「本文 + URL + 文脈」の枠を使い切れてしまい、`AD_DETECT_BUNDLE_MAX_CHARS` の半分近くを重複した引用文が食べるため、1 回で判定されるべき断片が数ラウンドに切られ、モデルは毎回それ単体では無害な断片しか見られません。

  後続のメッセージは自分の本文で従来どおり選ばれ、読むのは同じ完全な引用文です。サンプル側の 1 部は**重複排除しません**——判定は 1 回読めば足りますが、証跡は各メッセージが当時何を引用したかを正直に記録しなければなりません。同じ理由から、本文・URL・文脈の三つがすべて空のときにだけ「判定する内容がない」と見なします：広告を押し上げるメッセージ自身は一文字も打たない（スタンプ、caption のない画像）ことが十分あり得ます。逆に `text_link` エンティティ内の URL は送出テキストへ必ず付加します。

  ハイパーリンクの可視テキストは完全に無害（「ここをクリック」）でも構わず、着地先はエンティティにしか存在しないため、付加しなければ「この群から人を連れ出すか」という最も硬い規則がハイパーリンクに隠れた広告すべてに対して無効化されます。**唯一の例外は Bot 自身の inline 結果（`via_bot` が自分を指すもの）です**。その種のメッセージは明示的な `entities` を付けて送られ、ユーザーが打った文字はただの平文です（Telegram が自動認識した裸の URL は `url` エンティティで、ここで読む `text_link` ではありません）。したがってその `text_link` はすべて Bot 自身が付けたもので、付加すればおみくじの結果ごとに「この群から人を連れ出す着地点」を一つでっち上げることになります。ユーザーが query に打ち込んだリンクは元テキストの中に残り、従来どおり判定に加わります。URL は**本文とは別立てでスレッドを跨ぎ、それぞれ独立した文字数枠を持たせなければなりません**（`AdCandidateMessage.linkUrls`。Worker 側が本文を `AD_DETECT_MESSAGE_MAX_CHARS` で切り詰めた後に連結します）。

  メインスレッドが本文の末尾へ連結してしまうと、Worker の「先頭から残す」切り詰めで落ちるのがまさにその URL です——700 文字の埋め草と「ここをクリック」というアンカーテキストのリンク 1 本で成立する、コストゼロの回避経路になります。付加するのはメッセージ自身が持つ URL でシステム文言を伴わないため、本文に偽造可能な構造を持ち込みません。

  **すでにブロックリストにいる人は再送出しません**（送出の門にある `isUserBlocked`）。処分はすでに積まれており、まだ話せているのは BAN が着地していないだけです。再判定は quota を焼いたうえで前回と同一の処分を得るだけです。

  **ただしメインスレッドでそのまま捨ててよいのは実在ユーザーだけです**。`banChatMember` は `revoke_messages` を伴い、着地時にこの隙間のメッセージも消しますが、チャンネル名義の BAN は `banChatSenderChat` でそのフラグがありません——メインスレッドで捨てると、BAN 着地前に押し込まれた広告には清掃経路が一切なく、log も残さずグループに永久に残ります。

  したがってチャンネル名義は通常どおり Worker へ送り、「すでにリストにいる」という事実を `AdCandidateMessage.blocked` に載せて渡し（ブロックリストはメインスレッドの状態で、Worker に mirror はありません）、送出の門がそれを `deleteStraggler` に変えます——削除はするが判定 quota は消費しません。これは下の `recentlyDisposedAdKeys` による抑止と同じ例外で、覆う窓がより長いだけです。

  あちらは 1 つの重複排除窓しか生きませんが、「リストにいるが BAN が未着地」は窓を跨いで存在し得るうえ、今回の判定だけが生む状態でもありません（即時 kick、再 sweep、前の窓で積まれた removal バッチはいずれも先にリストへ書いてから outbox flush と mailbox barrier を待ちます）。Worker 側にも同一窓内の抑止（`recentlyDisposedAdKeys`）を置きます。

  広告と判定されたキーは処分の送出と同時に記録し、「処分は出た／メインスレッドはまだブロックリストへ書いていない」というスレッド跨ぎの隙間に滑り込んだメッセージを受け止め、各キーは自分の TTL で失効します。BAN が確定した時点でブロックリスト執行側が前倒しで回収しますが、その回収は removal 受領通知の **後** に走らせなければなりません——ベストエフォートの後始末が、既に確定した結果を覆せてはならないからです。先に置くと、そこで 1 回投げただけで受領通知が「未完了」に書き換わり、実際には完走したバッチをメインスレッドが再投入してしまいます。

  **チャンネル身分についてはこの抑止が抑えるのは判定だけで、削除は抑えません**。`banChatSenderChat` に `revoke_messages` はなくその BAN では持って行けず、抑止が効いている間は 2 度目の判定も走らないため、抑止分岐の中で削除を 1 回補わなければ、それらの広告はグループに永久に残ります。

  **再命中で処分一式をやり直してはいけません**。一式は blocklist transaction の durable を 1 回待ち、管理下の各 group へ snapshot revision 付き removal task を登録します。同じ発言者の連投で毎回走らせると、group 数に比例した thread message と database diff を反復します。したがって `blockUser` が false（すでに登録済み）を返したときは、発火した group の 1 batch だけを補い、永続化の確認は待ち直しません。

  entry は初回命中時に blocklist LRU へ書かれ、未 ACK revision も登録済みです。失敗は log に明記され、Disk I/O Worker の再生成時には有界な未 ACK Map から最終値を replay します。他 group の batch は SQLite outbox で再試行を待っています。これは `/block` の再試行意味論と矛盾しません。あちらの再実行はディスクを直した管理者による人為的な再試行、こちらは連投者自身が引き起こすものであり、同じ代価を共有すべきではありません。

  補う 1 バッチも `isInitEnabled && botPermissions.isAdministrator` の filter を通します。2 回の命中の間に管理者権限を失っている可能性があるからです。

  **命中後の処分はブロックリストと同じくスレッドで分担します**。Worker 側はその列のメッセージを削除し、`adDetected` をメインスレッドへ返します。メインスレッドは失ってはならない部分——`blockUser` と `flushDiskIODomain("blocklist")`、続いて `isInitEnabled && botPermissions.isAdministrator` の各グループごとに `trackBlockedRemoval` したバッチを durable outbox 経由で Worker へ戻し、最後にグループ内告知を送る——を担当します。

  **告知は BAN 登録の結果が分かってから送る必要があります**。文面は「見張っているすべてのグループでまとめて BAN した」と断言しますが、登録は 1 グループも成立しないことがあり（outbox 満杯、直前の管理者権限剥奪、`/init disable`）、その場合は誰も退出させられていないので、そのまま送れば事実と反する掲示になります——登録ゼロなら管理者に権限確認を促す文面へ切り替えます。

  **一部のグループだけ登録に失敗した場合も「すべて」と言ってはいけません**：失敗したグループには本人がまだ座っており、手がかりは誰も見ていないエラー log 1 行だけです。したがって文面は実際に BAN できたグループ数を報告し、残りを明示しなければなりません——全滅時にしか効かない番人は、「3 グループのうち 2 つで BAN できなかった」を従来どおり「見張っているすべてのグループでまとめて BAN した」と言い続けます。

  これは Worker 側でメインスレッドへの返送チャネルが閉じているときに告知しないのと同じ理屈で、そちらはメインスレッドがイベントを受け取らないことで自動的に満たされます。告知は `KICK_NOTICE_AUTO_DELETE_MS` 後に自動削除し、恒久的な掲示を残しません。これらメインスレッド側 task は `inFlightAdDisposals`（`packages/cache/main/antiRaid/adDisposal.ts`）に登録し、`drainAntiRaid` の各ラウンドで待機します。

  event ごと途中で捨ててはいけません。

  **この待機もラウンド内の他の各段と同じ残り予算を使い**、尽きたら `timedOut` として決着します。予算なしで待つのは不可です。

  処分の内部では `confirmBlocklistPersisted`（fsync を伴う領域 flush）と `dispatchBlockedRemovals`（outbox の write-ahead 永続化 + mailbox barrier）を通るため、全予算を 0 にする異常終了経路（`EMERGENCY_FLUSH_TIMEOUTS`）は本来即座に決着すべきところ、実際には 15 秒の強制終了線まで引きずられます——プロセスは停止処理の途中で非ゼロ終了し、インスタンスロックは解放されず offset も確認されません。

  **逆に、Worker 側の判定バッチを Anti-Raid の実行中 task 集合へ登録してはいけません**。その集合は停止時 drain の待機対象で、予算は `ANTI_RAID_DRAIN_TIMEOUT_MS` 相当の秒単位ですが、どちらの provider もタイムアウトは **SDK の試行ごと**の期限です。判定リクエスト 1 回は `AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS` / `AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS`（各 30 秒）にそれぞれの SDK 試行回数（`AD_DETECT_OPENAI_REQUEST_MAX_RETRIES` + 1 / `AD_DETECT_GOOGLE_REQUEST_ATTEMPTS`、ともに 3 回）を掛け、さらに `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` の空本文リトライを掛けた時間まで伸び得ます——秒ではなく分の桁です。

  登録すれば、停止時にたまたま判定が実行中であるたびに drain がタイムアウトし、ライフサイクルは Telegram offset の確定を拒否して非ゼロ終了します——ベストエフォートのヒューリスティックのために汚い終了と update の再配信を買うことになります。drain が来たら判定の tick を quiesce するだけ（新規リクエストも削除も告知も行わない）にし、実行中の判定は自然に収束させます。

  **担当外れ、`/init disable`、`/ad_detect disable` はいずれも当該グループの待機列を破棄しなければなりません**。メインスレッドの門は以後のメッセージしか止められず、すでに Worker に並んでいる分が判定を続ければ、スイッチを切った後に人がブロックされます。実行中の判定は状態オブジェクトの同一性で自ら無効化されます（列が消えているため、捕捉した参照が一致しません）。

  **ただしこの後片付けの配信失敗はコマンド自身が受け止め、update handler の外へ逃がしてはいけません**：`post()` が false を返すのは「Worker が再起動予算を使い切って放棄された」「再生成中」の 2 状態だけで、そのどちらでも待機列は古い isolate と一緒に消えており、片付けるものは何も残っていません。

  逆に例外を逃がす代償は実害そのものです——スイッチはすでに永続化済みなのにこの update は失敗と判定され、最終的に offset が確認されず、プロセスは非ゼロ終了し、再起動後 Telegram が同じ `/ad_detect disable` を再配信する一方 Worker は依然として使えないため、再起動ループが溶接されます（`/ai_chat disable` が `invalidateAiChat` に対して行っている扱いと同じです）。

  **プロンプト内の構造規則を厳しくする前に、`config/ad_samples.json` の正例と 1 件ずつ突き合わせなければなりません**：規則は「何をもって広告とするか」、サンプルは「この配備がどの種類を認めるか」を担当しますが、どちらも同じ口径の話です。規則が「通常は該当しない」と言い、サンプル一覧が「同種の話術に当たれば true」と言えば、モデルは互いに矛盾する 2 つの指示を受け取り、損なわれるのは常に再現率です——見逃された広告はどの log にも痕跡を残さないので、誰も気付きません。

  **個人の候補は送信者の名前と本文をまとめて判定します**。Worker は既存の `AdCandidateMessage.meta` から発言時の `firstName` と `lastName` を読み、各フィールドを単一行へ正規化し、サロゲートペアを分断せず `AD_DETECT_SENDER_NAME_MAX_CHARS`（128 UTF-16 コード単位）まで保持します。本文とは別枠で制限し、束全体の予算には含めます。名前が変わらず、既に取り込んだ引用だけを繰り返す場合は再判定せず、改名は再び判定対象にします。名前は entry ごとに固定され、後の改名では変更せず、命中サンプルにも残します。`directText` には本人の名前と非転送の本文が入り、転送者の名前も本人の内容として扱います。名前の宣伝は直接広告として帰属させ、通常の名前だけでは広告としません。名前と本文は user データのみに含め、候補フィルター、ホワイトリスト、管理者の免除は共通の境界を使います。

  **通常の名前（省略可）とリンクだけで構成され、名前にも本文にも宣伝・勧誘・取引の文言がない束は false と判定します**。`vless://`、`vmess://`、`trojan://`、`ss://` もリンクとして扱い、URL の長さ、パラメーター、エンコード、フラグメント名だけでは広告にしません。

  prompt には**必ず「JSON」という語を含めます**。OpenAI 互換分岐は `response_format: json_object`、Google 分岐は structured schema を使います。

  **出力枠は推論 model を前提に余裕を持たせます**。model は `config/agent.json` の `agent.ad_detect.model` から取り、code default はありません。OpenAI 互換推論 token は `max_tokens` を本文と共有するため、`length` の partial JSON を classifier へ渡しません。

  したがって転送層は `length` 終了を個別に検出して log に名指しし、途中の本文を解析器へ渡さず null を返さなければなりません。さもないとこの種の見逃しは痕跡を一切残しません。モデルが見るグループ本文は常にデータであり、`reason` は log と告知文だけに使い、制御フローには一切関与しません。

  **ヒットのたびにバイパスのサンプルを 1 件書きます**（`memory/ad-detected/sample.json`、`workers/diskIO/adSampleFile.ts` 参照）。判定ルールは prompt が固定しますが、この配備がどの題材を認めるかは `config/ad_samples.json` の例だけが決め、その例は実際のヒットからしか集まりません——生の素材がなければ、誤判定は人の記憶に頼って再現するほかありません。これは永続化全体で**唯一の書き込み専用**クラスです。

  サンプル内容は決して読み込まず、起動リカバリでも hydrate しないため、統一 flush の領域リストにも入れません（純粋な診断ファイルの書き込み失敗が `/block` の永続化確認を失敗にしてはいけません）。起動成功後の maintenance と統一東京 0 時 cron は directory entry だけを走査し、最初の書き込み経路も fallback として残します。孤児 temporary file は Worker isolate ごとに最大 1 回、archive 保持期間は東京日付ごとに最大 1 回だけ走査します。切り捨て自己修復を許し、失敗は `console.error` だけ残して捨てます。現行ファイルは 8 MiB 到達時に `sample.<東京日付>[.<正整数連番>].json` へ自動ローテーションし、アーカイブはファイル名の日付に基づいて当日を含む直近 15 東京暦日だけ保持します。

  保持期間 sweep は 1 日最大 1 回で、厳密に一致する通常ファイルだけを削除し、ディレクトリ走査または個別削除の失敗でバイパス追記を止めてはいけません。投函は `blockUser` より前です。その後の各ステップはいずれも例外を投げ得ますが、このサンプルこそ「今回の判定が正しかったか」の唯一の証拠だからです。サンプルはトリガーとなった 1 件ではなく**列全体**を記録します。判定が見ているのは列全体であり、文脈のない 1 行ではモデルが実際に読んだものを再現できません。

  **引用部分と返信先の原文は判定にもサンプルにも入ります**。ただし送出の入口から 2 つの独立したフィールド（`text` と `sampleContext`）で運びます。

  理由は 2 つあり互いに独立です：判定側は本文を `AD_DETECT_MESSAGE_MAX_CHARS` で切り詰めた**後**に連結しなければならず（先に連結してから切るとゼロコストの回避路になります——数百文字の埋め草で引用が枠から押し出されます）、サンプル側は本文に併合されていない原型を残さなければなりません（誤判定を人が確認するとき、どこが本人の言葉でどこが引用かを区別できる必要があります）。連結時は**システム的な語句を一切付けません**（「引用：」のような接頭辞を書かない）。

  理由は URL と同じで、本文に偽造可能な構造を持ち込み、送信者が自分の言葉を他人の発言に見せかけられるようになるからです。

  **モデルに見えない事実はメインスレッドが system 側へ与え、しかも両方の側を明示します**。判定が見るのは送信者自身のメッセージ列だけで、「入ったばかりで認証をまだ通っていない」という構造的シグナルはその転写に存在しません。データを与えずにプロンプトへ書けば、モデルは理由を捏造するだけです。この事実はメインスレッドが認証待ちミラー（`activeVerificationSnapshots`）から同期的に取得し、候補と一緒に送ります。

  メッセージ列では最新値で上書きせず和を取ります——認証は窓の内側で通り得るため、先に広告を出して後から認証した者を洗浄してはならないからです。成立側だけを述べるのも同様に誤りです。モデルは「今回言及がない」を情報欠落と解釈して推測しますが、このシグナルは確証されたときだけ加点してよいものです。事実は system 側に置き、**判定対象の本文へ混ぜてはいけません**。本文は完全にユーザー制御であり、混ぜれば連投者に「自分は新規ではない」と偽装する手段を与えることになります。

#### BAN とメッセージ撤回

- ブロックリストの BAN は必ず `revoke_messages: true` を渡します。`/block`、ブロックリスト対象者の入室即時 kick、管理者になった後の一括掃除、広告検出の命中はすべて単一の `banChatMember` ラッパーを共有し、4 つとも「この人物はこのグループに痕跡を残すべきではない」という同じ判断です。メッセージも一緒に消して初めて処分が完結します。Anti-Raid の自動追放は `kickChatMember`（誤爆防止のため kick のみで BAN しない）を使い、この経路を通らないので影響を受けません。

  チャンネル ID には「メンバー」の概念がなく `banChatSenderChat` にこのパラメータもないため、広告検出は Worker 側で判定根拠となった列を個別に削除します。その削除は皮としてのチャンネルや自ら退出済みのアカウントにも有効です。

#### blocklist removal outbox

- 未完了の blocklist removal batch はプロセス再起動を越えて生存しなければなりません。メインスレッドは Anti-Raid Worker へ removal を送る前に、現在の `pendingBlockedRemovals` snapshot を Disk I/O Worker へ渡し、独立した `blocklistRemovalOutbox` domain で SQLite `pending_blocked_removals` の snapshot revision ACK を待ちます。対応する transaction が durable になった後だけ update を引き渡せます。Worker は新旧 snapshot を主キー単位の upsert/delete へ差分化し、決着のたびにファイル全体を書き直さず、変化した行だけを encode します。

  **再 sweep entry（`probeMembership: true`）は `userIds` を永続化してはいけません**。outbox は「現在の blocklist でこの chat を走査する」という task だけを保存します。dispatch と replay は Disk I/O 境界から主キー昇順の安定 cursor page を読み、1 page は最大 512 id です。前 page の complete receipt を受け取るまで次 page を読まず、最後の page が決着した後だけ durable task を消せます。各 page を読む前に main thread は blocklist write の flush/ACK を確認し、Disk I/O Worker は commit 済み SQLite page に最大 128 件の並行 pending 最終値だけを重ねます。複数 page を完全な `Set` や配列へ組み直してはいけません。どの page でも read または delivery が失敗した場合は outbox task を保持し、今回の claim を解放して backoff を進め、次回は空 cursor から安全に replay します。各 chat task に名簿を固定すると、保存量と structured-clone が chat 数 × blocklist 長へ膨らみ、replay 時には古くなります。逆に `probeMembership: false` task は作成時に確定した空でない `userIds` を固定しなければなりません。両 shape は判別可能 union と strict codec で同時に強制します。

  メインスレッド状態、thread message、Disk I/O snapshot は各 owner が必要とする 1 copy だけを持ちます。受信側は 1 行を一度だけ encode して canonical text を cache し、差分比較で旧行を毎回 stringify + parse してはいけません。診断 field だけの変化は表全体を独立に deep-copy せず、次の正式な snapshot と一緒に書き戻します。ただし alert threshold をまたぐ 1 回だけは即時 durable にします。threshold 到達は診断を強めるだけで、security task を削除しません。

  write-ahead flush の待機中には cancel や trim が競合し得るため、post 前に再照合し、revision が変わっていれば durable 内容が送信予定 message と一致するまで再 flush します。最終照合と同期 post の間に `await` を置いてはいけません。起動時は runner より先に SQLite から復元し、正式な blocklist と `isInitEnabled && botPermissions.isAdministrator` で無効 entry を filter し、最大 `removalId` から counter を初期化して batch replay します。strict decode failure、`BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES` 超過、transaction failure はすべて fail-closed であり、空の outbox として続行してはいけません。

#### 権限回復後の replay

- `can_restrict_members` の回復を正式に確認したら、その chat で権限により freeze された instant-kick / 広告 pending batch を元の `removalId` のまま先に全件 replay し、その後で現時点の full-list sweep を発行します。sweep receipt が決着できるのは自分の ID だけで、古い freeze outbox entry を消してはいけません。

  各 freeze batch は自分自身の `complete` receipt が届くまで残り、sweep failure で先に決着させてもいけません。

### 運勢と AI メモリの復元

- 運勢永続化の東京日付 owner を切り替える前に、前日の追加 buffer を正常に flush しなければなりません。失敗時は旧 owner を維持して日付切り替えを拒否します。**ただし、その切り替えを誘発した新しい日の抽選は保留 buffer へ移して後で補記しなければならず、切り替え失敗と一緒に捨ててはいけません**。メインスレッドの `dailyLuckCache` は既にそれを「今日引いた」として記録し receipt も発行済みで、捨てると disk 復旧後もその日の file に永久に欠落が残り、user もその日はもう引けません。`onDiskIORespawn` の全件 replay がカバーするのは Worker 再生成だけで、「Worker は生きているが書き込めない」状態はカバーしません。保留 buffer には明確な上限があり、溢れたときは最古の 1 件を捨てて 1 行記録します（黙って捨てません）。flush の再試行が成功したら、次の抽選 message を待たずに即座に補記します。対象日に確認済み結果がある場合、key の欠落または別日 key は不整合 backup であり、新しい key を黙って生成せず起動・日付切り替えを拒否します。

  **ただし起動時に「メインスレッドが計算した今日」と資格情報の日付がずれるのはこの類ではなく、起動を拒否してはいけません。** Disk I/O Worker は起動境界で東京日付を 1 回計算し、メインスレッドは `restoreLuckState` でもう 1 回計算するため、00:00 前後に起動したプロセスでは両者が自然に 1 日ずれ得ます。ここで throw すると例外が `ApplicationLifecycle.init()` を抜け（呼び出し側に try/catch はありません）、`run()` が 1 行記録して終了コード 1 で終わります——1 度の日付切り替えで bot が起動できなくなり、プロセスマネージャの再起動を待つことになります。正しい扱いは、この期限切れの資格情報とその日の確認済みレコードを捨てることです。adopt せず cache を空のままにし、運勢を最初に使うときに `ensureLuckCacheFreshForToday` が Worker から当日の key を取り直します（各入口はもともとこれを await します）。同時に「本プロセス内で日付をまたいだ」と記録し、当日の証明を持たない遅れた確認はすべて fail closed にします。
- AI メモリ復元は現在の `AI_MEMORY_HYDRATE_BUFFER_MAX` と `MAX_SUMMARY_ROUNDS`（現在は逐語メッセージ 255 件と cold summary 7 round）以内の version=1 snapshot だけを受け入れます。超過または field 不正は復元時に切り詰めず起動を拒否します。上限を増やす変更は既存 snapshot と互換です。上限を減らす場合は、先に旧プロセスを停止し、同じ厳格 codec で既存の `memory/ai/` をアトミックに書き換え、旧プロセスの停止時 flush が migration 結果を上書きしないようにします。

  現在のメッセージと返信参照の名前・username・転送元・本文・quote は単一行で、空白は通常のスペースだけを許可します。本文は空でなく、参照 text/quote は最大 500 UTF-16 code unit です。切り詰めで生じた末尾スペースや単独 surrogate は保持します。`at` は実在する東京ローカル時刻 `YYYY/MM/DD HH:mm:ss` です。要約と pendingSummary は改行可能です。Disk I/O 復元と AI Worker hydrate は同じ厳密 decoder を通り、不正フィールドを具体的なパスで拒否し、正規化・項目破棄・書き戻しは行いません。

- 起動 hydrate は `AI_MEMORY_MAX_CHATS` で有界です。超過分は容量判定の副作用で削除せず disk に残して 1 回だけ報告します。正式な `chat_states` table 自体が最大 25 群で、現行 AI Worker の 100 群上限を下回ります。
- **AI Worker が再起動予算を使い切って自己修復を諦めたときは、再生可能な identity 注入レコード（`lastInitState.current`）も一緒に消さなければなりません。** `flushAiMemory` はまさにそれを見て「この系統はそもそも起動していないので flush するものはない」と判断し、即座に `flushed` を返します。残したままだと停止時 flush は短絡を通り越して barrier に入り、`post` の失敗で `failed` として決着します。その結果 `flushAllToDisk` は false を返し、`wait()` は最終 offset の確認を拒否し、Telegram は最後の確認以降の update をすべて再配信します——オウム返しやコマンド受領のような非冪等な副作用が二重に走ります。この機能の既定の縮退は「AI 雑談が次の再起動まで静かに止まる」だけであり、停止全体の offset ゲートを巻き添えにしてはいけません。
- メッセージ index（`chatMessageIndexes`）は rolling memory から完全に導出する index で、永続化せず、内側の値は cache と同じ object reference を共有します。登録と削除は、メッセージが hot region に出入りする物理位置、すなわち `rollingMemory.ts` の push・rotation・hydrate でだけ行えます。ほかのモジュールは read-only です。

  そのため index は hot region に残るメッセージだけを常に対象とし、rolling cache 上限で制約され、独立 eviction はありません。Bot 自身が送ったテキストと画像の返信 edge は Telegram が返した実際の `reply_to_message` だけから記録します。生成中またはキュー待ちの間に対象が hot region から外れた場合は、round 開始前に取得した上限付き trigger snapshot を fallback に使い、index の範囲を拡張しません。

  単一 hop の返信と trigger snapshot の本文は `REPLY_REFERENCE_MAX_CHARS` で制限し、現在は最大 500 文字です。正確な引用片と転送元は既存のメッセージフィールドに保持します。

### 確認境界と停止

- Telegram update が確認境界を進められるのは、対応する middleware が完了した後だけです。リアクション同期はその middleware 内で Telegram action の完了を待ちます。Anti-Raid mailbox、アバターの background owner、StateStore、AI Worker、Disk I/O Worker の flush はすべて明示的な上限付き drain を持ちます。重要な flush の失敗は必ず失敗を返し、最終 offset の確認を止め、非ゼロで終了します。

  **停止時に見捨てた update も同じ扱いです。** 停止信号が届いた後、取得ループは実行中の middleware を待ちません（宙吊りになり得るため、排出は lifecycle の上限付き `size()` ループに任せます）。したがって後から失敗した update は runner の明示的な印でしか表現できません。印は `handleUpdate` が throw するのと同じ同期区間で書かれるので、`size()` がゼロになった時点で必ず有効です。

  lifecycle は最終 offset を確認する前にこれを読み、立っていれば offset を確認せず非ゼロで終了して、再起動後に Telegram から再送させます。`task()` が正常に resolve したかだけで判断すると、一度も成功していない update をまとめて確認してしまいます。
- runner の各 `getUpdates` は `limit: 1` に固定し、現在の middleware が成功した後だけ、より高い offset の次 fetch を始めます。後の update が失敗しても、前の非冪等 side effect は独立した確認境界の内側ですでに確定しており、sibling として再配信されません。取得元が limit に反して複数 update を返した場合は、handler を 1 つも実行せず fail closed します。失敗後は次の update を fetch せず、offset も進めません。
- `app/updateFetcher.ts` は公開 `api.getUpdates` を使い、long poll は 30 秒、1 回の取得の再試行窓は 15 時間、指数 backoff は 100 ms から開始し、429 の `retry_after` も待ちます。401/409 は即時失敗です。要求と全 backoff は同じ取消 signal を継承します。runner は現在の middleware の停止 waiter だけを保持し、完了時に解除します。`stop()` は取得を終え、`size()` と `abortActive()` が実行中処理の drain 境界を提供します。
- 関連チャンネルの照会には 15 秒の取消 signal を渡します。Telegram duplex proxy が実行中要求を取り消し、waiter を確定します。失敗・timeout は `undefined` を返し、cache へ書かず、免除を与えません。同一 chat の重複抑制、cache TTL、世代分離はそれぞれの境界を維持します。
- 最終 offset の `getUpdates(timeout: 0)` も network request です。`timeout: 0` が無効にするのは Telegram server 側の long polling だけで、DNS、connection、response read は制限しません。そのため `FINAL_OFFSET_CONFIRM_TIMEOUT_MS` の local `AbortSignal` も必須です。

  確認の reject・timeout、または runner / maintenance / persistence の前提が未完了で skip した場合、この lifecycle gate はプロセス終了まで失敗のまま保持し、非ゼロ終了とします。

  **`runner.task()` 自身が throw した場合も「skip」であり、明示的に失敗として記録しなければなりません。** その例外は確認前の gate 全体を飛ばしますが、gate のフラグは初期値の true のままです。そのため `dispose()` が組み立てる `offsetConfirmed` は true になり、このラウンドは clean な停止と判定されます——診断行は出力されず、運用者が log を grep して見るのは「すべて正常」ですが、実際にはこのラウンドは確認もしておらず update も 1 件失っており、再起動後の重複配信は追跡できません。

  **停止の結末は「clean / not clean」の 2 値ではなく 3 値です**（`packages/app/lifecycle/shutdown.ts` の `classifyShutdown`）：`clean`・`offsetWithheld`・`unsettled`。中間の状態は「すべての owner が排出と flush を終え、Worker も終了しており、最終 offset の gate だけが完了していない」を意味します。`unsettled` とは扱いを分けなければなりません。
  - どちらも非ゼロ終了し、`Shutdown drain/flush results: …` の診断行を出力します。offset 未確認は再起動後に Telegram が再配信することを意味し、運用者に見えなければなりません。
  - しかし **instance lock を保持するのは `unsettled` だけです**。lock を保持する唯一の理由は「まだ共有データディレクトリへ書き込むものが残っているかもしれない」ことであり、`offsetWithheld` では runner は排出済み、各 owner は flush 済み、Worker は終了済みで、その危険はありません。2 値にまとめると、データが完全に永続化された停止でも古い `bot.lock` レコードが残り、「a task did not drain or persistence did not flush」という行が、何も壊れていない Worker とディスクへ運用者を誘導します。解放の前にもう 1 行記録し、この解放が offset の確認を意味しないことを明示します。

  判定には `wait()` 時点の観測ではなく `dispose()` 自身のラウンドの `ShutdownResults` を使います。`wait()` で flush に失敗し、その後 `dispose()` 自身の flush が成功した場合こそ「offset は保留、lock は解放」が正しい組み合わせです。

  後続の `dispose()` が同じ owner を 2 回目の wait で完了できても、この未確認を上書きしてはいけません。処理済み update がなければ API 呼び出しは不要で、gate は成功と扱います。
- Anti-Raid の mailbox barrier が保証するのは、それ以前の message が dispatcher に到達したことだけで、dispatcher が開始した Telegram network side effect の完了は待ちません。update の hot path はこの軽量境界を使い続けます。

  lifecycle drain は別の `drain` message を送り、Worker が登録した in-flight task set が空になるまで待ち、前後の mailbox barrier と persistence flush で上限付き fixed-point reconciliation を行います。通常 barrier の acknowledgement を network 完了と解釈してはいけません。

  chat ごとの blocklist removal epoch はその chat に in-flight removal task がある間だけ保持し、最後の task が settle した時または Worker stop 時に削除します。過去に無効化された chat を Map に永久蓄積してはいけません。
- Anti-Raid の shutdown drain は `inFlightAdDisposals` を最初に snapshot する前に、Worker へ `drain` を送り acknowledgement を受け取らなければなりません。Worker はその message の処理時に広告判定 ticker を同期的に quiesce します。

  同一 Worker port の FIFO により、それ以前に publish された `adDetected` は acknowledgement より先にメインスレッドへ登録済みであり、acknowledgement 後に戻る in-flight verdict は stopping gate によって新しい処置を publish できません。

  この安定境界の後でだけ、メインスレッドの広告処置、persistence flush、receipt barrier、そこから派生した Worker task を順に待ち、必要なら fixed-point reconciliation を続けます。`drainAntiRaid() === "flushed"` は `inFlightAdDisposals` が空であることを必ず含意し、最後の Worker drain 付近で登録された処置をラウンド外へ漏らしてはいけません。

  **前段の受領が取れなかった場合も、そのまま return してはいけません**。Worker が諦めたか再生成中だと `post()` は同期的に失敗し barrier は即 `failed` になりますが、メインスレッド側では処置が `confirmBlocklistPersisted` で止まっている可能性があります——そこはまさに「ブロックは投入済み、まだ書き込まれていない」窓です。そこで return すると書き込み待ちのブロックリストごと失われ、再起動後その送信者はリストに載っていません。

  したがって失敗経路でも残り予算で `inFlightAdDisposals` を 1 回は排出し（受領がない以上、安定した境界もないので、その 1 回はその時点で処理中のものだけを対象とするベストエフォートです）、そのうえで元の失敗理由を呼び出し側へ返します。この救済で戻り値を書き換えてはいけません。
- 実行中の各 Telegram update は cancellation signal を所有します。通常の drain deadline を過ぎると、停止処理は全 handler を abort し、上限付きの settle 時間を与えます。Telegram 呼び出しと正式な state write はその signal を監視しなければなりません。それでも settle しない handler は最終 offset の確認を止め、best-effort dispose 後の非ゼロ終了を強制します。
- 正常・異常停止のどちらでも、まずタイトル、アバター、翻訳、新規 gag、wed、blocklist 再 sweep の入口を quiesce して runner を止め、その後に上限付き drain を行います。6 つの quiesce 呼び出しの失敗は個別に捕捉しなければなりません。1 つが例外を投げても残りを試行し、その回の失敗によって最終 offset の確認とインスタンスロック解放を止めます。後続の `wait()` または `dispose()` は、冪等な 6 つの入口を再試行できます。再 sweep timer は Anti-Raid の network task と outbox write を開始できるため、終端の `dispose()` だけでなく Anti-Raid の前段 drain より先に止めなければなりません。**「quiesce 済み」を cache してはなりません**——`init()` は同じ 6 つの owner を再武装するため、起動中の停止シグナルで成功を latch すると以降の quiesce がすべて短絡され、owner は停止処理の間ずっと仕事を受け付け続けるのに結果はクリーンだと報告されます。

  翻訳 client は最初の実要求でだけ遅延生成し、各 RPC にはプロジェクト共通の短い timeout を設け、drain 後に明示的な `close()` と project parent/client reference の削除を行います。翻訳 drain の timeout や close 失敗も、ほかの重要 owner と同様にインスタンスロック解放を妨げます。正常経路では最終 Telegram offset の確認前に Anti-Raid、gag 通知、wed 処理、統一 delayed deletion を先に drain し、続いて AI を flush、Telegram outbound を drain、Disk I/O と StateStore を flush しなければなりません。

  最終 dispose は「AI を flush → AI を終了 → Telegram outbound を drain → Disk I/O を flush → Anti-Raid と Disk I/O を終了 → StateStore を flush」です。通常 dispose の進行中に fatal error が発生した場合、emergency 経路はその Promise を再利用できますが、既存 drain がプロセスを無期限に保持しないよう、現在の独立した絶対 15 秒の強制終了 deadline を設けます。

  予算超過時は実行中の Telegram 要求、メディア download、429 sleep を abort し、未開始キューを精算します。abort 後はメッセージ送信、アバター変更、グループタイトル書き込みを行いません。異常終了経路の maintenance 予算は 0 なので、各 drain は「予算 0」を正当な入力として扱わなければなりません。idle ならそのまま `flushed`、実行中の作業が残っていれば直ちに abort して `timedOut` として精算し、引数検証で例外を投げてはいけません。

  未完了のタイトル更新も、skip する際に必ず abort します。dispose の各 owner も個別に失敗隔離し、例外は `failed` として集計に参加させます。1 か所の throw が後続 owner、`flushStateToDisk`、インスタンスロックの処理を飛ばすことは許されません。
- lifecycle と Anti-Raid drain のプロセス内経過時間 budget は `packages/libs/monotonicDeadline.ts` が `performance.now()` を使って計算します。wall clock の巻き戻しで drain、cancellation settlement、shutdown の期限を延長してはいけません。業務状態、protocol deadline、永続化する絶対 timestamp はそれぞれの semantics に従って引き続き `Date.now()` を使います。
- Worker flush と mailbox barrier はすべて `packages/libs/flushBarrier.ts` を使い、ID、waiter table、timeout、遅延応答、crash 時の一括精算を管理します。ドメイン cache が resolver Map を再公開してはいけません。
- domain flush が成功へ読み替えられるのは、同じ確認済み flush request で別 domain だけが失敗した場合に限ります。古い global failure state や transport failure を成功へ変換してはいけません。instance lock の release も durability 境界であり、owner 検証または unlink の失敗は caller へ伝播し、lifecycle 上の lock-acquired 状態を維持し、非ゼロ終了を強制します。

### ファイル権限と schema

- project workspace 自体は editor や automation の協業に必要な permission を維持できますが、明示設定した独立 data root は機密データ境界です。root・`memory/`・`logs/` は起動時に `0755` 以下を強制し、group と other の書き込み bit を禁止します。唯一の例外は SQLite `database/` で、migration は setgid 協作 directory を `02770` で作り、主 DB と WAL/SHM は初回作成時に `0660` を使います。起動時は runtime UID 所有、または runtime の有効 group に属し group `rwx` が揃う directory だけを受け入れ、`other` access は引き続き拒否します。owner/group 設定と既存 directory の手動 migration は deployment tool が担い、runtime が暗黙に chmod してはいけません。
- `memory/` の新規成果物は `0644` を既定値とし、既存の `0600`・`0640` などより厳しい mode は adopt、append、compact、atomic replace 後も維持します。起動時は runtime account が実際に read/write できることだけを検証し、permission を自動修復しません。機密性は file/directory permission、deployment isolation、backup 方針で共同管理します。
- **アトミック置換で対象ファイルの permission bit を初期化してはいけません。** async・sync どちらも既存 target の mode を読み取って引き継ぎます。呼び出し側の `mode` は target が存在しないときの初回作成 default に限るため、通常書き込み、compact、key rotation で運用者が収めた permission を黙って広げません。
- 永続化 schema は推測的な自動 migration を行いません。非互換入力は起動を止め、空状態が実データを上書きするのを防ぎます。

### ロックダウンミラーと終端フラグ

- lockdown の永続化ハンドシェイクで使う指紋は `phase`、`intentId`、`announced` で構成します。前 2 つは 1 回の lockdown 意図の安定した同一性です。`announced` は 1 intent につき false から true へ最大 1 回しか変わりませんが、復元後に解除告知を送れるかを決めるため、永続化 acknowledgement が必ず覆わなければなりません。緊急 permission 復元が遅延結果を現 intent のものか判断するときは、引き続き `phase` と `intentId` だけを比較します。告知 flag の永続化は新しい permission intent を作らないからです。どちらの指紋にも `expiresAt` を含めてはいけません。`APPLYING`/`RESTORING` の段階では公開時点の実時計をそのまま入れるため、同じ意図でも 2 回公開すれば（たとえば告知結果の永続化で）値が変わります。

  含めてしまうと、メインスレッドの「保存してからもう一度同じ意図かを見る」照合ループが一致にたどり着かず、1 周ごとに `state.json` と LKG のファイル全体を fsync 付きで書き直します。公開がその書き込みより速いとループは終わらず、指紋も永続化受領も一生生まれません。カウントダウン自体はミラーの `expiresAt` に残り、adopt はそこから残り時間を換算します。このループには保険として周回上限もあります。

  永続化の実行中に新しいイベントが届くと再実行待ちフラグを立てます。上限を使い切った場合、現在の task はエラーログを残して microtask を譲り、その後で最新ミラーから新しい task を自動的に開始します。最後の wake-up を次の外部 lockdown イベントに依存させてはいけません。
- 現行の lockdown ミラーには `phase` と正の `intentId` が必要で、認証待ち active record には `phase` と `trackedMessageTimes` が必要です。reminder ID と `announcementMessageId` は業務上 optional のままで、欠落は reminder がまだ送信成功していないこと、あるいはこの record が入室アナウンスを観測しなかったことだけを表し、復元時にはそれぞれの再送・清掃経路を使います。

  それ以外の欠落・非互換 field は旧プロセス停止中に手動 migration し、production 読み取り経路に互換 logic を残しません。
- **終端通知の 3 flag を独立に永続化します。** `successNoticeSent` は成功報告、`failureNoticeSent` は kick 失敗または `can_restrict_members` 不足、`unconfirmedNoticeSent` は member または chat type の確認不能を記録します。3 種類とも main thread が送信成功から 30 秒後に削除します。各 flag は Worker 再生成や process 再起動後の同種通知の再送を防ぎ、相互に代用できません。flag の設定は新 revision を publish し、終端 retry はその永続化確認を待ちます。

  **kick は成功したのに成功戦報を送れなかった場合、そこで完了扱いにしてはいけません。** 完了は record の削除を意味し、グループからはメンバーが理由もなく消えたように見え、それを説明する唯一の一文は二度と出ません。この経路では backoff の前に `removalConfirmed` を snapshot へ書きます。これも永続化が必須です。無ければ次の回のメンバー確認は「もうグループにいない」としか答えず、終端は「他人が処分した」として黙って完了し、戦報は永久に飲み込まれます。書くのは戦報の送信に失敗したときだけで、通常の 1 周では kick と戦報が同じ周で完了するため追加の書き込みは発生しません。
- **「BAN 権限が無いと確証できたら以後リクエストを出さない」短絡は、片付けが済んでいることを前提とします**（`cleanupSettled`）。`failureNoticeSent` だけを見ると、ネットワークの揺れで 1 度削除に失敗した入室確認の告知はそこで固定されます。以後は毎回この短絡で return し、片付けの処理は二度と実行されず、押せる確認ボタン付きのメッセージが、実際には kick されていないメンバーのためにグループへ永久に残ります。片付けが残っているうちは通常どおり処分全体を通します——kick は `canRestrict` が、戦報は `failureNoticeSent` が、`can_delete_messages` 不足が確証されている場合は削除も mirror が短絡するので、「リクエストを 1 本も出さない」性質は保たれます。このフラグは `executionStarted` と同じく **Worker ローカルの冪等ゲートで、snapshot には入れません**。削除の再実行は冪等ですが、戦報の再送はそうではないからです。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## 互換エントリ

大きなファイルの分割後に残すトップレベル barrel は段階移行だけに使用します。新しい production コードは該当ドメインファイルから import してください。互換エントリは状態を所有せず、設定を解析せず、import 時の副作用を導入しません。

運勢レシートに旧形式の互換分岐は置きません。検証はレシートに埋め込まれた日付が当日の東京日付と一致することを要求し、日次鍵は毎日 0 時に切り替わるため、別の日のレシートは決して検証を通りません。旧形式のレシートは表示ラベル形式のリリース翌日から検証不能になっています。識別、除去、検証はいずれも現行形式だけを受け付けます（ラベル接頭辞 + 固定長 HMAC ダイジェスト + 同じ範囲の `text_link` 実体が運ぶ元レシート）。

**検証経路の decode 失敗は「形式不正」へ正規化しなければなりません**。レシートは丸ごと group message の実体から来ており、長さと文字集合を縛るのは protocol の正規表現だけですが、`Uint8Array.fromBase64` は長さ ≡ 1 (mod 4) の入力に対して `SyntaxError` を投げます。確認 middleware はあらゆる gate より前に位置し、どの chat のどの user からも到達できるため、例外が漏れれば `bot.catch` が再送出し、acknowledged runner は offset 未確認のまま終了し、Telegram が同じ message を再投函します——上記で繰り返し禁じている再投函による再起動ループそのものが、protocol 解析から入り込む形です。したがって検証経路の 3 か所の decode は共通の正規化入口を通し、一律 `undefined` を返します。致命的エラー扱いを保つのは deployment 鍵の decode だけで、そちらは user 入力ではなく設定だからです。

---

<div align="center">

[← 前のページ：03 ディレクトリマップ](03-directory-map.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#04-実行時の正式な不変条件) · [次のページ：05 開発フロー →](05-dev-workflow.md)

</div>
