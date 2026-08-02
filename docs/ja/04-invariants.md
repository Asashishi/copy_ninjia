# 04 実行時の正式な不変条件

<p align="center">
  <a href="../04-invariants.md">简体中文</a> · <a href="../en/04-invariants.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="README.md">📚 開発者ドキュメント TOP</a> · <a href="03-directory-map.md">← 前のページ：03 ディレクトリマップ</a> · <a href="05-dev-workflow.md">次のページ：05 開発フロー →</a>
</p>

---

このページは、モジュールやライフサイクルをまたぐ**正式な制約**を記録します。旧 `docs/architecture.md` の後継です。ソースコメントでは局所的な不変条件を説明し、`@see ../../docs/04-invariants.md` のようにここを参照してください。起動や永続化の説明全体を複数のモジュールへ重複させてはいけません。以下のいずれかに関わる変更では、コードより先にこのページを更新します。

案内用の説明は [02 アーキテクチャ概要](02-architecture.md)、これらの制約に触れる変更手順は [06 よくある変更手順](06-modification-guide.md) を参照してください。

> [!TIP]
> このページは実装とレビューで参照する制約の完全版であり、先頭から順番に読み通す必要はありません。下のナビゲーションから対象領域へ進んでください。長い項目では、段落冒頭の太字が通常、その段落で守るべき結論を示します。

## クイックナビゲーション

| 範囲 | トピック |
| --- | --- |
| [起動と import の境界](#起動と-import-の境界) | [起動順序とリソース取得](#起動順序とリソース取得) · [任意の資格情報と設定の縮退](#任意の資格情報と設定の縮退) · [データルートとバックグラウンドタスク](#データルートとバックグラウンドタスク) · [送信リクエストとメッセージの安全性](#送信リクエストとメッセージの安全性) |
| [Worker と状態の所有権](#worker-と状態の所有権) | [スレッドと状態の帰属](#スレッドと状態の帰属) · [状態機械の contract](#状態機械の-contract) · [AI チャットの実行時](#ai-チャットの実行時) · [AI プロンプトと transcript](#ai-プロンプトと-transcript) · [参加認証と終端処置](#参加認証と終端処置) · [連投ミュートと自身の権限キャッシュ](#連投ミュートと自身の権限キャッシュ) · [識別子の解決と実行時のクリーンアップ](#識別子の解決と実行時のクリーンアップ) |
| [永続化](#永続化) | [永続化と snapshot の contract](#永続化と-snapshot-の-contract) · [ブロックリストと広告検出](#ブロックリストと広告検出) · [運勢と AI メモリの復元](#運勢と-ai-メモリの復元) · [確認境界と停止](#確認境界と停止) · [ファイル権限と schema](#ファイル権限と-schema) · [ロックダウンミラーと終端フラグ](#ロックダウンミラーと終端フラグ) |
| [互換エントリ](#互換エントリ) | トップレベル barrel と運勢 receipt の形式 |

## 起動と import の境界

### 起動順序とリソース取得

- production モジュールを import しても Worker、timer、ネットワーク要求、共有ディレクトリへの書き込みを開始しません。
- メインプロセスは実行時データルートを再帰的に作成し、書き込み、ファイル fsync、hard link、アトミック rename、ディレクトリ fsync を事前検査してから `bot.lock` を取得します。root と機密トップレベルの `memory/`、`logs/` は実ディレクトリでなければならず、`lstat` がシンボリックリンクを返した場合は fail closed します。`COPY_NINJIA_DATA_ROOT` を明示設定した場合は mode が `0750` 以下であることも要求し、既存ディレクトリは検証するだけで自動 chmod は行いません。続いてトップレベルの孤立した一時ファイルを削除し、`state.json` を厳密に復元します。ここまではすべてネットワーク接続や Worker 作成より前です。

  その後に Telegram クライアントと Disk I/O Worker を初期化し、`memory/` を復元し、handler・コマンドメニュー・`bot.init()` の handshake を完了します。最後に AI/Anti-Raid Worker を初期化して hydrate し、acknowledgement-safe runner を開始します。
- 初期化失敗と正常終了はどちらも `ApplicationLifecycle` に合流し、実際に取得したリソースだけを解放または flush します。

### 任意の資格情報と設定の縮退

- 設定 parser 自体は I/O を行いません。`getStickerConfig()`、`getReactionConfig()`、`getMoodConfig()`、`getAdSampleConfig()` は業務上の初回利用時に遅延読み込みされます。

  **メインプロセスが起動時にまとめて事前読み込みしてはなりません**。4 つのファイルはいずれもチャットごとの opt-in でデフォルト無効な機能に属し、そこで throw すると壊れたスタンプ許可リスト 1 つで copy、抽選、入室認証、ブロックリストが同時に停止し、さらに systemd が再起動ループに入ります。検証は各機能の enable 分岐で行います（`packages/config/readiness.ts` が機能単位で判定を集約し、`packages/commands/configGate.ts` が拒否文面を統一します）。

  壊れていてもそのトグルだけを拒否し、返信では該当ファイルを名指しし、ログには英語の診断を残し、ほかの機能はそのまま動きます。すでに有効だったチャットは実行時ゲート（`aiChat/availability.ts`、`antiRaid/adDetect.ts` の `buildAdCandidate`）が止めるため、読めない設定を掴んだ Worker がクラッシュループすることもありません。判定は**失敗も含めて**プロセス単位でキャッシュします。

  このゲートはメッセージごとに通るため、失敗をキャッシュしなければ 1 メッセージにつき 1 回の `readFileSync` になります。代償として、ファイルを直しても反映は再起動後であり、4 つの loader の単一インスタンス方針と一致します。設定を無条件に読む唯一の箇所は Disk I/O Worker の起動復元（`memory/stickers/` の突き合わせにスタンプ許可リストが要る）であり、読めない場合は**突き合わせ自体をスキップ**しなければなりません。

  空の許可リストへ退化させるのは厳禁で、そうすると許可リストに無い永続ファイルをすべて孤児として削除してしまいます。
- `config/whitelist.json` と `config/blocklist.json` は前項の optional file ではありません。前者は同期 authorization と insider protection、後者は静的 enforcement boundary です。どちらも network 接続や Worker 作成より前に厳密ロードし、欠落、未知 field、不正 ID は起動を拒否します。

  `/white` と `/permission` は実際に変化した場合だけ allowlist 全体を atomic rewrite し、永続化成功後に新しい main-thread cache を公開します。read path は常にその memory copy だけを参照します。起動時には allowlist の元 byte の SHA-256 も記録し、各 command rewrite の直前に再検証します。外部編集または読み取り不能を検出した場合は、古い cache で黙って上書きせず mutation と update を失敗させます。静的 blocklist は read-only のまま動的な `memory/blocklist/blocklist.json` layer と memory 上で union し、`/unblock` は静的 entry を削除できません。

  `/permission query` と `/permission help` は read-only entry point です。allowlist の user／channel は command sender identity で同じ memory snapshot を読み、`query` は default 適用後の自身の完全な permission だけを返し、target を受け取らず write もしません。`help` はスーパー管理者の従来の access も維持します。permission の変更は引き続きスーパー管理者だけが実行できます。グループ内では `help` だけを長期保持し、`query`、拒否、usage hint は共通の 30 秒 cleanup に従います。
- **モジュール評価時に `requireEnv` してよいのは、プロセス全体が欠かせない資格情報だけです**（`TELEGRAM_BOT_TOKEN`、`SUPER_ADMIN_USER_ID`）。チャットごとの opt-in でデフォルト無効な機能だけが使う鍵は `optionalEnv` を通します。

  `packages/infra/config.ts` はほぼすべての入口パスから import されるため、そこで throw するとプロセスは更新の取得を始める前に終了し、systemd が再起動ループに入ります——誰も有効化していない機能の鍵が 1 つ無いだけで、copy、抽選、入室認証、ブロックリストがまとめて停止します。2 つの AI 鍵はどちらも後者であり、**変数名には担当する機能を必ず先頭に付けます**（`AI_CHAT_GEMINI_API_KEY`、`AD_DETECT_DEEPSEEK_API_KEY`）。

  `.env` を読む人は「この鍵が欠けるとどの機能が止まるか」を一目で判断できる必要があり、将来同じベンダーが 2 つの機能を担当することも十分あり得るため、ベンダー名を基準にすると区別できなくなります。`AD_DETECT_DEEPSEEK_API_KEY` が未設定なら `/ad_detect enable` を拒否し、すでに有効なチャットも判定対象の投入を止めます。

  `AI_CHAT_GEMINI_API_KEY` が未設定なら AI Worker 自体を起動せず、`/ai_chat enable`、`/query_mood`、`/switch_mood` を拒否し、すでに有効なチャットへのメッセージ投入とトリガーも止めます。2 つの鍵は役割が重ならず、互いにフォールバックしません。Gemini は AI 雑談エージェント専用、DeepSeek は広告検出専用です。

  **日本語翻訳も同様で、唯一の判定入口は `packages/copy/availability.ts`** です（`g-auth.json` が使えること + チャットごとの opt-in）。`/ja_copy` と自動 copy の ja 変換は必ずここを通します。この経路の劣化は**サイレント**だからです——`translateToJapanese` は失敗時に null を返すだけで、呼び出し側は未翻訳の原文をそのまま送出し、グループからは「翻訳サービスが一時的に不調」と区別が付きません。設定事故が何日も隠れ続けることになります。

  コマンド経路は `g-auth.json` を名指しして拒否し、自動経路は通常の copy に退化します。どちらも「翻訳したふり」をしてはなりません。

  **AI 雑談が「いま動いているか」の判定は `packages/aiChat/availability.ts` ただ 1 か所**（資格情報の有無とチャットごとの opt-in の論理積）であり、新しい呼び出し箇所は必ずここを通します。この論理積を各呼び出し箇所に書き下すと、いずれどこかがチャット側のスイッチだけを見るようになります。それが起動時の hydrate 経路で起きるとデータ損失です——その経路は「このチャットは無効」をディスク上の記憶を削除する根拠として扱い、資格情報が無いときはすべてのチャットが無効に見えるからです。

  **したがって資格情報が欠けている場合、`hydrateAiMemory` / `hydrateStickerCatalog` は丸ごと早期 return し、1 件も削除してはなりません**。`memory/` 配下のスナップショットは鍵が戻るまでそのまま保持します。
- **降格が許されるのは「誰も有効化していない」場合だけで、「有効なまま」なら起動を拒否します。** `state.json` の `isAIChatEnabled` / `isAdDetectEnabled` / `isJATranslationEnabled` は管理者が明確に入れたスイッチであり、黙って「何もしない」状態へ格下げすると、外からは Bot がある再起動を境に反応しなくなったようにしか見えず、痕跡は誰も読まないログ 1 行だけです。

  そこで `packages/app/featurePreflight.ts` が `loadState` の後、Telegram クライアントと任意の Worker より前に一度だけ照合します。いずれかのチャットで有効なままの任意機能は資格情報とデプロイ設定が揃っていなければならず、欠けていればチャット id・欠落項目・無効化コマンド名を添えて throw し、`ApplicationLifecycle` の失敗経路がインスタンスロックを解放します。

  この位置は `loadState` より前（チャット状態をまだ読めない）にも Worker 作成より後（失敗時に解放すべき資源がロックだけで済まなくなる）にも動かせません。報告するのは最初に壊れた機能 1 つだけです。3 つ同時に壊れる確率は「1 つ直して再起動」より遥かに低く、まとめて出すと本当に直すべき 1 つが埋もれます。

### データルートとバックグラウンドタスク

- `state.json`、`bot.lock`、`logs/`、`memory/` はすべて 1 つの実行時データルートから導出します。production の既定値はプロジェクトルートです。テスト preload は production モジュールを import する前に isolate ごとの一時ルートを注入し、実ファイル I/O が production キャッシュへアクセスできないようにします。
- 低優先度のグループタイトル保守は、コマンドメニュー、`bot.init()`、Worker hydrate、acknowledgement-safe runner の準備完了後にだけ開始します。title owner の `getChat` は現在最大 15 並列で、履歴補完が共有 throttler を先頭から占有する量を制限し、ライフサイクルの quiesce/abort signal を受け取ります。

### 送信リクエストとメッセージの安全性

- 汎用 JSON API request は `JSON_API_ALLOWED_ORIGINS` に明記した HTTPS origin だけを許可し、redirect を無効にします。新しい caller は allowlist を明示的に拡張しなければなりません。

  Telegram avatar download は Telegram 所有 asset domain suffix の独立 allowlist を使いますが、HTTPS・credential 禁止・DNS label 境界という同じ URL policy を再利用します。Bot API `file.getUrl()` の主経路と `t.me` の page/image fallback はどちらも redirect を無効にし、読み取り上限を維持します。JSON allowlist へ接続したり、任意の HTTPS 画像を受け付ける形へ戻したりしてはいけません。
- 送信メッセージには `parse_mode` を一切設定しません。表示名やメッセージ本文は純テキストとしてのみ連結し、書式やリンクとして解釈される余地を残してはいけません。リッチテキストが必要な場合は、呼び出し側がテキストを段ごとに組み立て、`entities` を自ら与えます（offset は Telegram の UTF-16 code unit 基準で、JavaScript の `String#length` と同一。長さ 0 の entity はメッセージ全体が拒否されます）。

  新しい送信経路がこの制約を迂回するために `parse_mode` を使ってはいけません。
- グループ内の非機能的な command text は `sendCommandMessage` を通し、送信成功から 30 秒後に削除します。private chat は対象外です。ユーザーが明示的に許可した `/permission help` と成功した CJK action result だけが `preserveInGroup: true` で長期保持できます。action command の対象 validation failure と `/x` の使い方提示は引き続き自動削除します。新しい例外は呼び出し箇所とテストの両方で明示しなければなりません。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## Worker と状態の所有権

### スレッドと状態の帰属

- メインスレッドは Telegram runner と Worker 監視ハンドルを所有します。`StateStore` は `state.json` のメモリミラー、latest-only のアトミック書き込み、上限付き失敗リトライ、終了時 flush を排他的に管理します。リトライ上限の超過は fatal durability failure であり、runner を停止して update の確認を続けてはいけません。
- AI Worker はグループチャットメモリ、返信の受け入れ、メディア説明パイプライン、グループごとのムード、スタンプカタログ生成の実行時状態を排他的に所有します。
- Anti-Raid Worker は認証・ロックダウン状態機械とタイマーを排他的に所有し、メインスレッドは復元可能なミラーだけを持ちます。
- Disk I/O Worker はログ、AI メモリ、スタンプカタログ、運勢、認証待ちデータの永続化を排他的に所有し、1 つの Worker スレッド内で共有ディレクトリへの読み書きを直列化します。`state.json` は明示的な例外で、メインスレッドの `StateStore` が非同期に管理します。業務 Worker は共有ディレクトリへ直接書き込みません。
- 長寿命の Map、Set、キュー、timer には、対応する `packages/cache/` モジュールと業務ライフサイクルモジュールが共同で容量、削除、Worker 再構築の意味を定義しなければなりません。
- **キャッシュの所有スレッドはディレクトリ名で宣言し、実際のモジュールグラフで照合します。** `packages/cache/` の第 1 階層が所有者です。`main/` はメインスレッド専有、`workers/aiChat|antiRaid|diskIO/` は各 Worker スレッド専有、`perThread/` は「各スレッドが個別に 1 つずつ持ち、互いに無関係」な状態（Telegram クライアント、デプロイ設定 singleton、自己送信メッセージ登録）です。

  スレッド間はメッセージのみでやり取りしメモリは共有しないため、**あるスレッド専有の状態を別スレッドが import するのは常に誤り**です。相手の isolate が受け取るのは同じコードの別インスタンスで、書き込んでも所有者側からは永遠に読めません。静的には何も見えず、実行時は「なぜかキャッシュが当たらない」としてしか現れません。

  `bun run check:conventions` が 4 つのスレッドエントリ（`index.ts` と 3 つの `*Worker.ts`）から実行時 import の閉包をたどって照合し（`import type` と `new Worker(new URL(...))` は辺として数えません）、違反時は import 連鎖を全て出力します。唯一の適用除外は `packages/cache/main/diskIO.ts` です。

  `infra/logger.ts` が `infra/diskIO.ts` の `relayLogMessage` に静的に依存し、かつ 4 スレッドとも log を書ける必要があるためで、Worker 側のそれは初期値のまま一度も読み書きされません（理由は当該ファイルのモジュール冒頭コメント）。
- 業務 Worker と独立した Disk I/O ホストは、同期的な `postMessage` の拒否を明示的な失敗へ統一します。request 型の送信は waiter と timer を即座に削除し、ログだけは console へ fallback し、重要業務の拒否は fatal とします。Disk I/O の runtime recovery は不可分な 1 つの handshake です。

  load 成功後、各 domain は登録順に現世代の scoped transport だけを使って mirror を replay し、非同期処理をすべて await します。その後で復旧窓の上限付き business FIFO を排出し、最後にだけ writable を公開できます。listener の `false`、throw、reject、timeout、または scoped post の拒否は現世代を終了させる fatal failure です。

  旧世代 listener の遅延 settlement が新しい世代へ書き込んだり、activate したりしてはいけません。処理または永続化の確認が必要な caller は `false` を失敗として扱い、対応する Telegram update を確認してはいけません。

### 状態機械の contract

- 状態機械の `State/Event/Effect/Transition/Decision` contract はすべて `packages/types/states/` が所有します。`packages/states/` は I/O のない純粋な状態遷移だけを実装し、interpreter と cache は前者の型へ直接依存します。

  **形態は 2 種類あり、判定対象に永続化すべき離散状態があるかで選びます**。`verification` と `lockdown` にはあり（PENDING/ACTIVE のような状態を Map に保存し、後続イベントが参照します）、`transition(state, event) → {next, effects}` の状態機械形態を取ります。

  `replyAdmission` と `adDetectAdmission` にはなく（規則は呼び出し側が算出済みのスカラーだけを受け取り、コンテナとタイマーは実行時モジュールに残ります）、純粋関数の集合という形態を取ります。後者を無理に状態機械へ押し込むと、「この 1 件」と「スレッド全体で何件」が同じ状態オブジェクトに同居し、両者のライフタイムはまったく異なるため、かえって読みにくくなります。
- **ロックダウンの解除告知は、封鎖を実際に告知していた場合にだけ送ります**（`LockdownState.announced`）。`RESTORING` への入口は 2 つあります。通常の期限切れ・手動解除（`ACTIVE` 由来、告知済み）と、`setChatPermissions` が throw した後の補償照合（`applyResult(!ok)`、未告知）です。このフラグが無いと、後者の経路が成功した際に「制限を解除しました」をグループへ送ってしまい、封鎖告知を一度も受け取っていないチャットには前後の脈絡がない一文になります。

  `announced` は `ACTIVE` から `RESTORING` へ引き継がれ、`RESTORING ──再度しきい値超過──> ACTIVE` の戻り経路でも保持されます（その遷移は封鎖告知を再送しないため、そこで true にリセットしてはいけません）。メモリ上だけに存在し `state.json` には入れません。

  永続化レコードの形は `{phase,intentId,originalPermissions,expiresAt}` であり、告知文 1 つのためにディスク形式を変える価値はないので、`adopt` では phase ごとに最も一般的な側を採ります。`reportUnlock` は告知とは別件で、どの経路でも発行します——メインスレッドが永続化レコードを消すために必要だからです。

### AI チャットの実行時

- `/query_mood` と `/switch_mood` は、メインスレッドの request/waiter と AI Worker acknowledgement による handshake を共有します。前者は任意のグループメンバーが現在有効な mood を強制再抽選なしで読み取り、後者だけが `isCanSwitchMood` を確認して再抽選します。メインスレッドは送信前に waiter を登録し、timeout、Worker crash、再起動断念、停止時に統一して精算します。request は絶対 deadline を持ち、Worker は読み取りまたは再抽選の前に期限切れ request を拒否します。request ID、chat ID、期待する event type がすべて一致する `moodQueried` / `moodSwitched` acknowledgement だけが結果を証明します。その後の Telegram reply 失敗を query または再抽選失敗へ書き換えてはいけません。
- AI チャットの invalidate は、完了を待てる cancellation 境界です。各チャットで最初の generation-sensitive task を受け入れると、その Worker isolate 内で二度と再利用しない一意 epoch を割り当てます。

  invalidate は現在の epoch を同期的に削除し、旧 generation を abort して未開始作業を消去した後、その epoch に登録された返信 round、rate-limit 通知、media description、memory compaction の task が settle するのを待ってから `chatInvalidated` 応答を返します。

  **この待機には上限が必要です**（`AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS`。メインスレッド側の `AI_CHAT_INVALIDATE_TIMEOUT_MS` より明確に短くすること）。

  登録された task がすべて abort を受け取れるわけではありません——memory compaction と media description の 2 本は、現在この generation の `AbortSignal` を受け取って Gemini request へ伝播しておらず、resampling interval と SDK request timeout を合わせると最悪で数分走ります。`Promise.race` 用の unref expiry timer は、task と timeout のどちらが先に完了しても `finally` で clear し、完了済み invalidate の closure と Promise を deadline まで保持してはいけません。

  上限なしで待つと、`/ai_chat disable` がミラーブロックの rotation と重なった一度だけでメインスレッドが先に reject し、その例外が grammY のミドルウェアへ抜けます——その update は失敗扱いになり、最終 offset は保留され、再起動後に Telegram が同じコマンドを再配信します。時間切れでは降格して先へ進み、エラーログを 1 行残します。正しさは待機に依存していません——登録された task はすべて generation を自己照合し、無効化後は何も書き込めません。

  遅延 task は副作用のない epoch 照合だけを行い、entry 回収後やチャット再有効化後に古い token が復活することはありません。したがって epoch Map は過去のチャット総数ではなく現在の active work と同程度に保たれます。メインスレッドが invalidate 完了を報告できるのは、メモリ削除の永続化と Worker の確認応答が両方成功した後だけです。
- Gemini の transport、network、429、5xx retry は公式 `@google/genai` SDK の `retryOptions` だけが所有します（現在は最大 5 attempts）。1 回の request が `failureKind: "request"` で失敗した後、caller が full request retry をもう一層重ねてはいけません。domain-level resampling は SDK request が成功しても model response が使用不能または異常終了した場合（`failureKind: "response"`）、あるいは normalize 後の text が空の場合だけに許可し、request 数、latency、一時 allocation の乗算を防ぎます。
- AI 返信は、成功したテキスト、スタンプ、リアクション、画像だけを 1 つの統一 action budget に計上します。モデル向け prompt 上限は 8、実行側 hard cap は 11 です。スタンプ、リアクション、生成画像はそれぞれ最大 1 回だけ成功でき、その他の action tool に per-tool call cap はありません。スタンプパック表示と Google Search は独立した lookup cap を持ち、custom function call 全体にも round 単位の loop guard があります。

  成功 action が 0 件の場合だけ、最終本文を `send_message` から fallback 送信します。意図的に表示するすべての文字列は、モデルがこのツールを明示的に呼び出して送らなければなりません。並行枠が埋まって queue に入った直接 trigger は、追い出し実行中に rate limit の関門に拒否されたら queue の先頭に留め、そこで排出を止めなければなりません。rate limit はそのチャットの window 内の回数だけを見ており、どの trigger かとは無関係です。

  最初の 1 件が拒否されたなら後続もすべて拒否されますし、拒否では並行カウントが増えないため、そのまま進めると 1 回の同期 tick で @ メンションと返信の queue を丸ごと捨てることになり、その全員が 1 件も返信を受け取れません。
- AI 返信の受け入れは 2 つの独立した関門で、その間には「キューに入って補走を待つ」という長さの読めない中間状態が挟まります。並行関門（`admitTrigger`）はトリガー到着時に判定し、レート関門（`admitRound`）はラウンドを実際に始める直前に 5 分スライディング窓で判定します。

  **キューが空でない間は、並行枠が空いていても必ずキューへ入れます**。キューは FIFO であり、すでに 1 ラウンド待った人たちの前に新しいトリガーを割り込ませると、その意味論がまるごと反転します——窓が開いた瞬間に最初に走るのは到着したばかりの 1 件で、キューの人たちは数分待たされたままです。

  **キューにはラウンド終了に依存しない駆動源も必要です**。通常の排出はラウンドの `onFinished` コールバックでしか起きませんが、レート関門に弾かれたトリガーはそもそも task を作らないため、そのコールバックは永遠に来ません。実行中のラウンドが順に終わるとキューに触れる者はいなくなり、最大 `REPLY_TRIGGER_QUEUE_MAX` 件の @メンションがスナップショット（本文断片、画像参照）ごと無期限にメモリへ留まり、無関係なトリガーがたまたま 1 ラウンド完走するまで解けません。そこで駆動源は 3 つあります。

  ラウンドの `onFinished`、**新しいトリガーをキューへ入れた直後に 1 回試すもの**、そして AI Worker の保守 tick による補助的な排出（`drainPendingReplyQueues`）です。入れた直後の 1 回は省けません——直前の排出がレート関門で止まると、そのグループは「実行中ゼロ + キュー非空」のまま留まり、以降の @メンションはただ後ろに積まれるだけで、先頭の人たちは 30 秒の保守 tick を丸ごと待たされます。

  3 つとも**窓に本当に余裕があるときだけ押します**（`drainReplyQueueIfWindowAllows`）。飽和したグループではラウンドが次々と終わり続けるため、3 つのうち 1 つでもゲートを外すと「たまの空回り」ではなく飽和している間ずっと毎分 1 行の通知になります。

  **溢れ通知の送出はキュー押し出しとは別経路でなければなりません**（`flushOverflowNotice` と `drainReplyQueueIfWindowAllows`）：`enqueueOverflow` がグループに負っているその 1 行は窓に余裕があるかどうかに関係なく出す必要があり、同じ関数にまとめると、ゲートを付ければ通知が永久に飲み込まれ、外せば上の連投が戻ってきます。

  窓がまだ満杯のグループは飛ばします——無駄に 1 回試すたびにレート制限の案内（自体 60 秒のクールダウン付き）が送られ、毎分 1 行グループに流すことになるからです。先に入れてから押すので、順番は先着順のままです。
- メインスレッドの random AI activity table は全グループメッセージが通る JIT hot path です。既存 chat の hit は固定 shape の `AiReplyActivityEntry`（`timestamps`、`lastAccessSequence`、`lastObservedAt`）をその場で更新し、`Map.delete` + `Map.set` で並べ直したり、一時的な compound key や projection object を allocation したりしてはいけません。満杯の table へ新しい chat を挿入する cold path だけが最大 500 entries を scan して LRU を選びます。window timestamp、capacity、eviction order、wall-clock rollback protection は性能変更でも維持する semantics です。
- ホワイトリストのスタンプパック目録の突き合わせを、Worker の `init` 受信時 1 回だけにしてはいけません。

  `generatePackCatalog` は `getStickerSet` に失敗するとそのパックを丸ごと諦めますが、systemd 管理のプロセスは数週間動き続け得ます——初回デプロイ（`memory/stickers/` が空）で数秒のネットワーク不調に当たると `catalogs` は永久に空になり、`view_sticker_pack` と `send_sticker` の 2 つの tool がすべての返信で null を返します。

  そこで保守 tick が `STICKER_CATALOG_RETRY_INTERVAL_MS` ごとに、**目録が空、またはパック要約が欠けている**パックだけを再試行します（`retryIncompleteStickerCatalogs`）。

  **1 枚単位の説明生成失敗の記録（`failedEntries`）も同様に TTL 付きの negative cache でなければならず、恒久的なラッチにしてはいけません**（`STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS`）：`getStickerSet` は成功しても vision endpoint が丸ごと使えない（quota 枯渇、鍵のローテーション直後、media task の飽和）とパック内の全枚数がこの表に入り、恒久ラッチだと上の再試行が毎周期正しくそのパックを選び直しても `generatePackCatalog` は 1 枚ずつその場でスキップし続けます——目録は永久に埋まらず、それはこの再試行が防ぐはずだった結末そのものです。

  `failedPacks` が `STICKER_SET_FAILURE_RETRY_MS` を使うのと同じ理由で、2 段ある失敗記録の片方だけが自己修復するのは許されません。正常化した後は毎回の空判定だけでリクエストは飛びません。間隔を保守 tick 自体ではなく分単位にするのは、パック名の設定ミスのように決して直らない場合、再試行のたびにエラーログが 1 行増えるからです。

### AI プロンプトと transcript

- AI 返信のウェブ検証説明は、その round の検索進捗に応じて 3 つの状態を切り替えます。未検索なら「検索すべき条件」と「行動前に検証する」ルールを示し、検索済みで残枠がある場合は結果の使用規律と不足分の再検索に切り替え、枠を使い切った場合も結果の使用規律を保ったうえで「見つからなかったとき」の締め方を示します。3 状態は同じ規律を共有します——検索結果は既存の認識より優先され、結果に無い具体情報を記憶から補ってはいけません——どの状態でもこれを省略できません。

  モデルから見える prompt には、Google Search が統一 action budget に計上されないことを明記し、action を節約するために検証を省略させないようにします。サーバー側検索を観測した後の tool round はより低い sampling temperature を使います。検索とその round の最初の本文生成は同一リクエスト内で起きるため予測できず、その round は通常の返信 temperature のままです。
- AI 返信の最初の Gemini 入力は、1 つの `user Content` 内に順序付きの 3 つの `text Part` を維持します。すなわち、読み取り専用の参照メモリ、読み取り専用の現在会話、今回の返信タスクです。各 section はモデルから見える開始・終了タグと、先頭の責務説明 1 行だけで囲みます。データと命令の区別、偽造 boundary の無効化、内部構造の非開示という共通の prompt injection 防止規則は `systemInstruction` に 1 回だけ記載し、各 section で繰り返しません。

  ツール呼び出し後の履歴は実際の `model/user` role で追加し、参照資料を過去の会話 turn に見せかけてはいけません。system prompt は独立した `GenerateContentConfig.systemInstruction` field でだけ送信し、通常会話の `contents` へ連結しません。
- メモリの階層（`【最热记忆】`、`【较早逐字记录】`、`【冷记忆】`、`【唤起者重点记录】`）はモデルが context を読むための内部的な仕組みにすぎず、グループのメンバーには一切見せません。`MEMORY_MECHANISM_SILENCE_INSTRUCTION` は、返信の中でこれらの階層名を出すことも仄めかすことも禁止し、context、区画、`Part`、要約、圧縮、sliding window、cache、件数上限、token、system prompt といった仕組みの語彙も同様に禁止します。

  **禁止対象は transcript に実際に現れる階層名を 1 つずつ名指しする必要があります。** これらの marker はもともとモデルから見える transcript に書かれているため、「内部構造を露出しない」という一般論だけでは、名指しされなかった階層をモデルが説明してしまいます。さらに「あれはもう window から流れ出た」と自分から言い出して、なぜ忘れたのかを説明することさえあり、内部の context 構造をその容量ごとメンバーへ渡すことになります。直接問われた場合も、開発者・管理者・テスト中を自称するメンバーに探りを入れられた場合も、説明せず、肯定せず、否定せず、「だいたいそんな感じ」といった示唆も与えません。思い出せないときは、階層・圧縮・クリーンアップ・window からの流出としてではなく、日常的な言い方で表します。本項は `CHAT_MEMORY_PRIORITY_INSTRUCTION` と責務を分けます。後者は階層をどう使うかだけを扱い、本項は階層を口に出さないことだけを扱います。
- グループチャット transcript の行内 marker（返信引用、転送元）は、`packages/consts/aiChat/prompts/transcript.ts` の共通 template が、組み立てる本文と prompt の形式説明にある placeholder の両方を生成します。同じ形式を両側で個別に手書きしてはいけません。転送元の帰属は marker の入れ子で区別し、外側は現在のメッセージ、内側は返信先の元メッセージに属します。

  Bot 自身のアクション記号（`（发了一枚贴纸：…）`、`（…生成并发送了一张图片：…）`）も同じ template file 由来で、**アクションが実際に着地した後に実行側だけが書き込みます**。これは「そのアクションが確かに起きた」ことの唯一の証跡であり、モデルは読めても自分で生成してはいけません。

  画像生成がグループの cooldown に当たったとき、モデルは「送れない」と言わずに、transcript で見たその形を `send_message` で打ち出すことがあります——グループには画像を添えたと称して実体のないメッセージが届き、記憶には偽のアクション記録が残り、次のラウンドでモデル自身がそれを事実として扱います。prompt の禁止は確率的でしかないため、`send_message` の実行側で 1 度硬く拒否し、モデルには自分の言葉で「今回は送れない」と述べさせます。

  **拒否は裸の語句ではなく template 全体の形に錨を打つ必要があります**（`SELF_ACTION_TAG_PATTERNS`：marker が全角括弧の対の中にあり、直後が `：` か閉じ `）` であること。間には `）` をまたがない短い前置きだけを許し、モデルが「参考素材」を「参考上传的素材」のように書き換えても捕まえます）。裸の部分文字列では不十分です——「发了一枚贴纸」「生成并发送了一张图片」自体が日常的な中国語で、メンバーが「你刚刚生成并发送了一张图片吗？」

  と尋ねただけでモデルの通常の返答が拒否され、そのラウンドの最終テキストも同じ executor を通ってもう一度拒否され、結果として直接の @ メンションに完全な沈黙で応じることになります。3 つの利用側（実行側の書き込み、prompt の placeholder、拒否判定）は同一のリテラルを共有し、どこか 1 か所でも手書きすると証跡が無効になります。複数階層の返信チェーンにおける各 hop の形式、転送元、`[仅回复快照]` marker も同じドメイン template を再利用します。

  返信タスクにチェーンを追加するのは 2 階層以上の場合だけです。snapshot-only の末尾では、元メッセージが逐語 transcript から既に外れていることを明示し、完全な原文をモデルが参照できると示唆してはいけません。

### 参加認証と終端処置

- Anti-Raid は、連携チャンネルのディスカッショングループにおける直接コメントとスレッド内返信に同じ免除 semantics を適用します。最近のコメント関連 cache はメッセージ ID と観測時刻だけを保存し、動作差のなくなった source marker を状態機械へ漏らしません。候補になるのは連携チャンネルのディスカッショングループのコメントスレッドだけです。

  `message_thread_id` はフォーラム（topics）グループのすべてのメッセージにも付くため、`is_topic_message !== true` でフォーラムトピックを除外しなければなりません。トピックは常に通常の認証待ち semantics に従い、barrier の追加投函も連携チャンネル lookup も発生させません。cold cache の `message_thread_id` は非同期確認候補にすぎません。

  lookup 完了までは通常の認証待ちメッセージとして扱い、`linked_chat_id` が確認され、状態オブジェクトと generation が一致する場合だけ取り消します。lookup 失敗は fail-closed とし、後続の再試行を許可します。
- 人間メンバーの参加認証は本人のクリックだけを受け付けます。Worker は caller の自己申告ではなく、信頼できる `callback_query.from.id === callback_data` の対象 ID から本人関係を導出しなければなりません。クリックしたユーザーが `config/whitelist.json` に含まれていても、別の人間を認証できません。代行保証の唯一の例外は、現在の認証待ち snapshot が `isBot === true` で、クリックしたユーザーが同じ allowlist に含まれる場合です。

  対象が存在しない、終端状態、または不一致の場合は失敗応答だけを返し、認証状態を変更してはいけません。
- 終端処置（timeout / 連投の kick）が `kickChatMember` を呼ぶ前には `probeChatMembership` で現状を確認します。在室を確認できた場合だけ kick し、退出済みを確認した場合は誤った戦果報告を出さずに完了し、lookup が不確定なら破壊的なメンバー操作を行わず終端レコードを既存の backoff 再試行へ残します。lockdown 中に到着直後の join update から同期的に出る `kickMember` は、その update 自体が在室の証拠なので重複 lookup を払いません。

  終端処置が失敗したときは指数 backoff で上限まで再試行し、再試行が長引いたという理由でレコードを削除しません。削除は「処置していないメンバーを完了扱いにする」ことだからです。固定間隔では足りません。bot が管理者でも BAN 権限がない場合や、相手自身がそのチャットの管理者である場合、この再試行は決して成功しません。1 度の荒らしが残した未認証メンバーがそれぞれ永久の短周期ループを 1 つずつ占有し、メッセージ削除 + kick を打ち続けて `logs/` に同じエラー行を書き、Worker 再生成やプロセス再起動のたびに再武装されます。

  諦めずに待機を伸ばす形にしておけば、管理者が権限を付け直した後、遅くとも上限 1 周期で自己修復します。
- lockdown の即時 kick は、まず非永続の `kickPending` に入り、その状態オブジェクトの同一性を不可逆処置バッチの実行 token とします。告知削除などの前段 `await` の後、`kickChatMember` を呼ぶ直前に entry が同一オブジェクトを保持していることを再確認し、その確認と API 呼び出しの間には `await` を置きません。権威ある管理者免除、退出、新しい物理入室レコード、chat teardown が token を置換または削除した場合、古いバッチはこの確認で停止しなければなりません。

  `executionStarted` を立てるのは API request を同期的に発行する瞬間だけです。それより前に届いた免除は `exempt` へ移り、それより後なら診断を残すことしかできません。request が settle し token も一致する場合だけ `kicked` へ移り、settle 時刻から dedupe window を始めます。dispatcher が先に `kicked` を書くことで、まだ行われていない Telegram action を代用してはいけません。

  **入室 count の取り消しは、実際に count された入室だけを対象にします**。`kickPending` は `countedJoinAt` を別に持ち、`joinCreatesNewRecord` が真で呼び出し側が実際に `recordJoin` した入室にだけ入ります。kick 後に本当に再申請した人には新しい `kickPending` が作られますが、その経路はすでに状態が存在するため二度目の count はされません。

  そこで `requestedAt` を使って取り消すと、キュー内で最初に値が一致する要素を消すことになります——同一の `new_chat_members` バッチのメンバーは同じ tick で処理されタイムスタンプが完全に一致するため、消えるのは正当に count された別の入室者の 1 枠です。スライディングウィンドウはしきい値に 1 足りないまま lockdown が発火せず、まさにこの count が防ぐべき事態になります。
- その診断（`logUncancelableKickExemption`）は `logger.error` で出す必要があります。Worker がメインスレッドへ中継するのは error レベルのログ封筒だけで、`warn` は Worker の一時的な stdout に留まり `logs/<day>.json` へは届きません。これは「管理者や許可リストのメンバーが誤って kick された、手動で呼び戻してほしい」という唯一の手がかりです。事後にログを見返しても見つからなければ、その人はグループの外に留まり続けます。
- 認証 reminder にはメンバーごとに delivery owner が 1 つだけあり、送信失敗には上限付き backoff を使います。timeout で kick する前提条件は `reminderMessageId` または `replyReminderMessageId` の少なくとも一方が設定済みであることです。1 件も送信できていない場合、timeout は window を延長して再送するだけです。

  **ただし延長には終わりが必要です**。入室から `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` を超えてもなお 1 件も届かないなら、通常の timeout として処理します（処置は kick のみで BAN はしないため、本人はいつでも入り直せます）。無限に延長する代償は、入室者ごとに不滅のレコードが 1 件ずつ残ることです。

  あるグループで `sendMessage` が失敗し続ける状況（フォーラムの General トピックが閉じられている、Bot が発言禁止だがメンバー制限権限は残っている）では、それらが待機テーブルとメインスレッドのミラーに常駐し、90 秒ごとに当日ファイルを書き直し、`messageIds` はそのメンバーの発言数だけ増え続けます。同じ理由で `messageIds` にも `VERIFICATION_TRACKED_MESSAGE_IDS_MAX` の上限を置きます。

  通常の window では到達しません（連投は 46 件目で同期的に kick へ遷移します）。この退化経路だけを抑えるためのもので、超過時は最も古い id を落とします。

  **入室アナウンスはこのキューに入れません**。`announcementMessageId` として別に保持し、切り詰めの対象外です。混ぜると上限到達時に最初に押し出されるのは必ずそれ（常に最も古い 1 件）であり、処置経路以外にそれを削除する場所はありません——reminder が送れず記録が繰り返し延長されるまさにこの退化経路では、メンバーが数百件発言して上限を埋められるため、ボット自身が作ったアナウンスがグループに永遠に残ります。処置時はアナウンスを先に削除し、その後で追跡した発言を削除します。

  reminder ID のない現行形式 snapshot を復元したときも同じ owner を再利用し、状態置換、退出、teardown、Worker 終了で取り消します。これは未送信 reminder を示す正規の業務状態であり、旧形式との互換分岐ではありません。

- cold cache の discussion 確認は `chatId:userId` ごとに可変 owner を 1 つだけ持ち、`THREAD_COMMENT_CONFIRMATION_MAX` の全体 backpressure と `LINKED_CHANNEL_FETCH_TIMEOUT_MS` の settle 上限に従います。満杯時は通常の fail-closed 認証を維持します。

  chat teardown、adopt、stop で owner が削除された後、遅延 callback は recent comment を書く前に object identity 不一致で停止しなければなりません。その owner が覆うメッセージ自身が同じ `pending` を `flood` 終端へ同期遷移させた場合だけ、`executionStarted !== true` の間は連携確認により終端を撤回して tombstone を発行できます。不可逆処置の開始後は取消可能とは扱いません。
- `kickPending` の Telegram request が settle したことは kick 成功の証拠ではありません。`kickChatMemberWithOutcome === "kicked"`、または後続の正式な member probe で退出済みと確認できた場合だけ `kickSettled` を投げます。`forbidden` / `failed` はその試行の `executionStarted` を下ろし、同じ token を保持して上限付き terminal backoff へ入れます。

  免除、teardown、または新しい物理入室が状態を置き換えた後は、遅延結果も timer も処置を続けてはいけません。
- `messageIds` の容量制約は通常メッセージ、重複入室告知、original/reply reminder の遅延着地を含む全 write ingress に適用します。すべて同じ bounded append helper を通し、通常メッセージ経路だけを切り詰めてはいけません。

### 連投ミュートと自身の権限キャッシュ

この節では、[カウントと実行の境界](#カウントと実行の境界)、[命中時の抑制と並行処理の安全性](#命中時の抑制と並行処理の安全性)、[実行前の権限ゲート](#実行前の権限ゲート)、[Bot 自身の権限ミラー](#bot-自身の権限ミラー)を順に説明します。

#### カウントと実行の境界

- **連投のカウントも実行も Anti-Raid Worker 側に置き、メインスレッドは同期的な関門と 1 回のベストエフォートな `post` だけを行う**：この機能は chat ごとに default off で、`ChatState.isFloodControlEnabled === true` の場合だけカウントします。スーパー管理者または `isCanControllFloodControlPermission` を持つ allowlist identity が `/flood_control enable|disable` で永続化された switch を変更でき、disable 時にはその chat の live window も消去します。同一メンバーが同一の**スーパーグループ**で 1 分以内に `FLOOD_MESSAGE_LIMIT`（現在 15 件）に達したら `FLOOD_MUTE_DURATION_MS`（現在 3 分）ミュートします。

  スーパーグループ限定なのは `restrictChatMember` が Bot API の定義上そこでしか効かないためで、通常グループでは数えること自体がメモリの無駄です——ウィンドウを埋め切っても、確実に失敗するリクエスト 1 回と誤解を招くエラー 1 行しか得られません。

  メインスレッド側（`packages/antiRaid/floodControl.ts`）は candidate object を作る前に chat switch、スーパーグループ種別、発言者が実ユーザーか、送信者が flood-control bypass を持つかを順に判定します。チャンネル名義と匿名管理者にはミュートできるメンバー身分がなく、`restrictChatMember` は実ユーザーしか受け付けず、着ぐるみの下が誰かを Telegram は明かしません。`SUPER_ADMIN_USER_ID` は常に bypass し、allowlist identity は個別の `isCanBypassFloodControl` に従います。この permission は default `true` で、明示的に `false` にした場合だけカウント対象になります。

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

- **手を出す前の 2 つの関門はどちらも省略できません**：まず Bot 自身の権限ビットを見て（次項）、次に参加ガードが元々温めている管理者キャッシュ（`freshAdminIds`、冷たければ `fetchAdminIds`）で対象がそのグループの管理者でないことを確証し、**確証できなければ一切手を出しません**。

  権限ビット側の関門は三値で、**「観測していない」は「観測して無かった」ではありません**：確証して無い場合だけその場で諦め（抑制フラグは保持）、観測していない場合はそのまま進めて Telegram の応答に裁定させます——ミラーがまだ届いていないだけかもしれず（メインスレッドの必要時照会が一度 429 を踏むと数分バックオフします）、その数分間に連投を見逃したうえ根拠のない「権限がない」をログに書くほうが、失敗するかもしれないリクエストを 1 回打つよりはるかに悪いからです。

  したがってミュート要求自体も三値を返します（`muteChatMemberWithOutcome`、形は `banChatMemberWithOutcome` と同じ）：`forbidden` は Telegram の明示的な拒否（`can_restrict_members` の欠如、またはキャッシュが取りこぼした本物の管理者）——抑制フラグを保持し、打ち直さず、具体的な理由は共通のエラー境界が Telegram 自身の文言とともに記録します。

  `failed` はレート制限やネットワークの揺らぎ——抑制フラグをロールバックし、次に埋まったウィンドウを待ちます。この 2 分類こそが「ミラーがまだ届いていない」フォールバックの収束点です。これが無ければ、本当に権限のないグループでは ウィンドウが埋まるたびに確実に失敗するリクエストを 1 回打つことになります。「とりあえず試す」に畳んではいけません——Telegram は「Bot に権限がない」と「対象が管理者である」の両方に同じ 400 `not enough rights` を返すため、盲目的に打つと `logs/` に運用者を存在しない権限問題へ誘導する誤った手がかりが 1 行残るだけであり、しかもオーナーを 3 分黙らせる代償は連投を 1 回見逃す代償よりはるかに大きい（次のメッセージが改めてカウントに入ります）。

  ミュート要求には `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` のタイムアウトシグナルを付けます：`until_date` はキュー投入前に計算した絶対時刻ですが、要求はグループごとのスロットリングバケットを通らなければなりません。実際に送られた時点で残りが 30 秒未満だと Bot API は**恒久的な制限**として扱い、本モジュールは解除タイマーを積まず永続化もしないため、人手で解除するまでその人は永久に黙らされます。

  タイムアウトしたらこのミュートを諦めます（抑制フラグはロールバックし、次に埋まったウィンドウで再試行）——代償ははるかに小さいからです。

  グループ内通知はミュートが実際に着地した後にだけ送り（文面が主張しているのはまさに「もう黙らせた」ことです）、ミュート解除の瞬間に自動削除して恒久的な告知を残しません——この自動削除は登録済みの削除待ち表（`scheduleNoticeDeletion`）に支えられ、停止時の drain の前に `flushPendingNoticeDeletions` がその場で実行します（**クライアント＋グループ単位で `deleteMessages` にまとめなければなりません**：同一グループの削除はすべて同じスロットリングバケットに並ぶため、1 件ずつ送ると N 件で少なくとも N 秒かかるのに対し drain の予算は秒単位です——同じグループで数人が 3 分以内に続けて連投すれば告知は 4 件たまり、それだけで drain がタイムアウトします。

  皮肉なことに、それを引き起こすのは停止をより綺麗にするために足したこの後片付けそのものです。まとめる理由は広告処置の一括削除と同じで、速度ではなく**リクエスト本数**です）。素の `setTimeout` は Worker の isolate の中で生きているため、クラッシュ再生成やプロセス再起動で告知ごと失われ、名指しの告知がグループに恒久的に残ってしまいます。

  グループ内通知にも独自の送出期限（`FLOOD_NOTICE_DISPATCH_TIMEOUT_MS`）を付けます：通知は認証の強制退出・歓迎文・リマインダーと同じ**グループ単位 FIFO** のスロットリングキューを共有するため、協調襲撃では数十件の告知が前に並び、認証の `kickChatMember` はそれらが送り終わるのを待つしかありません——未認証の襲撃アカウントは `VERIFICATION_TIMEOUT_MS` を生き延び、グループにはメンバーを名指しする Bot のメッセージが数十件増えるだけです。

  Bot 自身のおしゃべりが安全動作を窓の外へ押しやってはいけません。期限切れの告知を捨てればその枠も空くので、この値は同時に「告知が認証動作を妨げ得る上限」でもあります。処置全体は Worker の実行中タスク集合に登録し、停止時の drain が結算を待ちます。

  **ただしこの種のリクエストはすべて停止のキャンセル信号を購読しなければなりません**（`antiRaidDispatchSignal`。権威ある説明は `packages/cache/workers/antiRaid/tasks.ts`）：drain の予算は `ANTI_RAID_BARRIER_TIMEOUT_MS` の秒単位ですが、ミュートは設計上スロットリングバケットの中で `FLOOD_MUTE_DISPATCH_TIMEOUT_MS`（分単位）待ち得ます。

  停止がちょうどその待ち時間に重なると drain は結算を待てずタイムアウトし、ライフサイクルはそれを根拠に Telegram offset の確認を拒んで非ゼロ終了します——再起動後はその update が再配信され（そこですでに発生した認証の強制退出と通知は二重になり得ます）、systemd はユニット失敗を報告します。したがって drain の到着時にはキュー待ちのそれらをその場で abort し、新しい処分も始めません。

  ミュートはもともとベストエフォート（期限は Telegram が `until_date` で解除）であり、1 回失っても安全境界の破綻にはなりません——広告判定のバッチをこの集合に一切登録しないのと同じ理屈です。

  **このキャンセル信号は drain 自身が送るリクエストを覆いません**：告知の flush は停止中に必ず送り切る必要があり、キュー待ちを先に abort するのはまさにその枠を空けるためです。

#### Bot 自身の権限ミラー

- **Bot 自身の権限ビットはメインスレッドが保持し、変更のたびに Worker へミラーする。「観測していない」を「観測して無かった」に折り畳んではならない**：`packages/cache/main/botAdmin.ts` の `botChatPermissions` が `can_restrict_members` と `can_delete_messages` を保持し、owner は `packages/infra/botAdmin.ts`、条目は `/init enable` 済みのグループにだけ作ります（さもないと大量のグループに追加されただけで表が生えてきます）。

  観測が起こり得るのはメインスレッドだけ——`my_chat_member` 更新（Bot の任免時だけでなく、**管理者が権限スイッチを 1 つ変えただけ**でも Telegram は届けます）と、必要時の `getChatMember` 実照会——ですが、キック・ミュート・メッセージ削除はすべて Worker で実行されます。

  そこで確証・失効のたびに `packages/cache/main/botAdmin.ts` の逆登録シングルスロット経由で `botPermissionsChanged` として配信し（infra は Anti-Raid の業務モジュールに静的依存してはいけません）、Worker 側は読み取り専用スナップショット（`packages/cache/workers/antiRaid/botPermissions.ts`）だけを持ちます。

  他人の `chat_member` 更新が届く経路からは「自分は管理者だ」しか導けず権限ビットは導けないため、表に書かず配信もしません——書けば権限の揃ったグループを恒久的に「手が出せない」と判定することになります。管理者剥奪、グループからの除去、`/init` の切り替えはいずれも条目を即座に消し、「不明」を配信し、実行中の照会を無効化します。無効化は世代照合で行い、**世代エントリが存在するかどうかがそのまま「照会が実行中か」の唯一の根拠なので、リクエストを出す前に同期的に確保しなければなりません**。

  さもないとその僅かな窓に届いた無効化が取りこぼされ、古い身分が書き戻されます。照会失敗、無効化による破棄、返ってきたのが管理者ですらなかった場合はいずれも `undefined` を返します。メインスレッド側は「この動作は今できない」として扱い、Worker 側は三値をそのまま伝えるだけで、未知の扱いは各処置が決めます（連投ミュートの選択は前項）。

  **ミラーの読み出しは三値のままに保ち、真偽値へ潰してはいけません**：潰すと「権限が無いと確証した」と「まだ分からない」が区別できなくなり、しかもこの 2 つは正反対の処置を要求します。

  **Worker の再生成とプロセス起動では表を丸ごと再送しなければなりません**（`replayBotPermissions`、adopt より前）：新しい isolate の表は空であり、空の表は契約上「何もできない」を意味します。

  ホットパスでの必要時補完（`ensureBotChatPermissions`）には**バックオフが必須**です（`BOT_PERMISSION_PROBE_RETRY_MS`）：`state.json` は管理者と記録しているのに実際は違う場合や `getChatMember` が失敗し続ける場合、`botChatPermissionsIn` は契約上キャッシュを残さないため、バックオフがないとそのようなグループでは 1 件ごとに確実に失敗する照会を打つことになります。

  このキャッシュは破壊的な動作すべての「撃つ前に判定する」を支えます：連投ミュートは `canRestrictMembers` を、広告処置の一括削除・チャンネル別名の取りこぼし・認証タイムアウト強制退出の痕跡清掃は `canDeleteMessages` を見ます——これらの削除は強制退出と同じスロットリングキューを共有するため、襲撃時には確実に失敗する 400 が数十回、本物の強制退出を認証ウィンドウの外へ押しやります。遮るのは確証された `false` だけで、`undefined` は従来どおり要求を送ります（三値の口径は前項と同じ）。

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
- 裸の**会話** id（チャンネル／グループの負の id、`CHAT_ID_ARG_PATTERN`）は別のスイッチで、**`/unblock` だけが開きます**（`acceptChatId`）。

  チャンネル被りの id はそもそもブロックリストに入ります（チャンネルのメッセージへ返信しての `/block`、および広告検出が `sender_chat` に命中した場合）が、それを消す手段はこれまで返信と `@username` の 2 つだけでした：前者は広告検出が元メッセージを削除した時点で失われ、後者は公開 username があり `USER_CACHE_MAX` でキャッシュから押し出されていないことを要求します。両方が断たれた項目はリストに永久に残ります。

  逆方向の `/block` は負の id を拒否し続けなければなりません：貼り間違えた会話 id を対象にすると処置が会話 identity 全体の BAN に変わり、しかもそのコマンドは取り消せません。`/unblock` は復旧方向であり、対象を誤っても高々 1 回の空振り解除で済みます。

  **負の id には必ず `isChannel` が付きます**（`resolveIdTarget` が最小 identity の時点で付与。符号による振り分けは `workers/antiRaid/blocklistEffects.ts` と同源）：`/unblock` はこれを見て `unbanChatMemberIfBanned` ではなく `unbanChatSenderChat` を選ぶため、付け忘れると解除が失敗して `failedCount` に計上され、応答は「一度も触れていない対象」についての虚偽の戦果報告になります。
- `/steal_icon` の t.me プロフィール取得フォールバックは、**`getChat(targetId)` でその場に問い合わせた username だけを採用します**。呼び出し側のコンテキストが持つ username でこの問い合わせを短絡してはいけません。その username は `reply_to_message`（数か月前のこともあります）や identity キャッシュ由来である一方、Telegram の username は手放されると誰でも取り直せます。

  取得時のページ身分照合が証明できるのは「このページは @name のものだ」までで、「@name はいま targetId を指す」は証明できません。短絡すると**現在の handle 保有者**のアバターを Bot のアバターに据えてしまい、成功通知には元の対象の名前が書かれたままになります。渡された値はログ上の診断ヒントとしてのみ使います。
- chat runtime teardown の 3 つの固定 owner callback は `packages/cache/main/chatTeardown.ts` が保持します。上位ドメインは `packages/infra/chatTeardown.ts` を通じて逆向きに登録し、`packages/infra/botAdmin.ts` は `commands/`、AI、Anti-Raid の業務モジュールへ static dependency を持ってはいけません。
- メンバー現状確認そのものが新しい非同期境界です。`probeChatMembership` が在室を返してから `kickChatMember` を呼ぶ前に、終端状態が照会開始時と同一オブジェクトのままか再確認し、その確認と API 呼び出しの間には新たな `await` を置いてはいけません。そうしないと teardown、管理停止、状態置換で取り消された旧処置が遅延結果を消費し、もはやその終端処置の対象ではないメンバーを kick できます。
- `/unblock` は、チャット横断 unban の両端でコマンド側「kick 確認済み」cache を無効化しなければなりません。開始前に旧結果を消し、すべての `unban` await が終わった後にも、その待機中に遅れて着地した `/block` の書き戻しをもう一度消します。runner の直列化は chat 単位だけなので、異なる chat のコマンドは交錯できます。

  後段の無効化がないと、より後に unban されたユーザーが cache hit のまま残り、同日の次回 `/block` がメンバー照会と BAN を誤って省略します。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## 永続化

### 永続化と snapshot の contract

- `state.json` は最新値の結合、一時ファイル、fsync、アトミック rename を使います。コマンドスイッチ、中継、copy、権限、退出状態などの正式な変更は、該当 revision が主ファイルと LKG に順番どおり書かれるまで成功を返さず、middleware から戻りません。グループタイトルなど再構築可能な metadata だけは background の eventual consistency で保存できます。
- AI メモリとスタンプカタログは entity ごとのアトミック snapshot を使います。ログ、運勢、認証待ち状態は末尾切断を修復できる追記型 JSON を使います。各追記 batch は成功応答より前に fsync します。認証完了は tombstone を追記します。東京日付をまたいだ起動では、最新の旧日ファイルを厳格に decode し、当日のより新しい active 値と tombstone を重ねて当日へ原子的に compact します。公開成功後だけ旧日を削除し、旧日が破損していれば新旧双方を変更せず復元を拒否します。

  定常時は東京当日のファイルだけを保持し、件数または byte threshold で active snapshot へ compact します。切断修復では JSON 文字列、escape、括弧の深さからトップレベル member の境界を判定し、object 値末尾のインデントに依存してはいけません。`null` tombstone など primitive 値も完全な最終値として扱います。
- AI メモリの upsert/delete は chat ごとの実行時単調 revision を使います。メインスレッドは未確認の delete tombstone を保持し、Disk I/O Worker は unlink が durable boundary に達したか、より新しい revision が delete を上書きした場合だけ応答します。Worker 再構築では tombstone と最新ミラーを replay し、順序が最終結果を決めないようにします。

  確認済み delete または LRU eviction 後の最初の新 snapshot は直ちに保存し、対応する durable upsert 応答を受けるまでメインスレッドが revision marker を保持して、Disk I/O Worker 再構築後に最新ミラーを replay します。起動復元では `state.json` を正本とし、AI が明示的に有効なグループだけを hydrate し、無効グループの残存 snapshot は削除予定にします。

  現行 snapshot の hot message はすべて正の `messageId` を持ち、返信チェーン index はそこから再構築して別途永続化しません。

- `chat_member` の入室事実に対応する update を確認してよいのは、`flushDiskIODomain("joinLog")` が `flushed` を返した後だけです。post 成功は durable を意味しません。書き込み失敗時、Worker は元の group を buffer に戻して backoff 再試行し、消去して捨ててはなりません。未 flush の事実は 1,200 件を hard limit とし、飽和時は即座に失敗して未確認 update を再配信させます。**この即時失敗は Worker のメッセージルータで受け止めなければなりません**：例外が `onmessage` を抜けると Bun は永続化スレッドごと終了させ、実行中の flush はすべて失敗として決着し、各ドメインの buffer もスレッドと一緒に失われます。入室事実 1 件の代償としては大きすぎます。ルータは代わりに拒否フラグを記録し、統一 flush の joinLog 出口がそれを一度だけ消費して当該ドメインの失敗として報告します。拒否された事実は buffer に入っていないため、buffer だけを見ると「何も書けていない」状態を flush 成功と報告してしまいます。

  disk 障害を無制限の memory 使用へ変えてはいけません。chat/day の latest-by-user index は LRU で最大 64 個、失敗 backoff table は最大 128 file を常駐させます。どちらも正式な file または次回 retry から安全に再構築でき、永続化成功の証拠にはできません。Telegram が完全に同じ event を再配信した場合は、disk から復元した index が追記前に除外します。

  `/batch_kick` は `[since, now]` の rolling interval を読み、東京深夜をまたぐ場合は 2 つの chat/day file を merge します。「当日」へ切り詰めてはいけません。

### ブロックリストと広告検出

この節では、[正式なブロックリストと block コマンド](#正式なブロックリストと-block-コマンド)、[広告検出の受付・判定・処置](#広告検出の受付判定処置)、[BAN とメッセージ撤回](#ban-とメッセージ撤回)、[blocklist removal outbox](#blocklist-removal-outbox)、[権限回復後の replay](#権限回復後の-replay)を順に説明します。

#### 正式なブロックリストと block コマンド

- `/block` の正式リストは `memory/blocklist/blocklist.json` に置き、同じディレクトリの `removals.json` は未完了のチャット別処置を持つ outbox にすぎず、リストの複製ではありません。ブロックリストは同期的なセキュリティ境界です。書き込みは必ずメインスレッドのメモリ Map（`packages/cache/main/blocklist.ts`）を先に更新し、その後で永続化メッセージを投げます。

  逆順にすると、2 つのステップの間に届いた入室更新がまだ記録されていないリストを参照し、その相手が入ってきてしまいます。判定はメモリのみを読み、スレッド間の往復はしません。入室更新はその場で判断する必要があるためです。リストに自動 eviction はなく、人手の出口は `/unblock` ただ 1 つです。コードは依然として `isBlocked: false` のような墓標レコードを受け付けません——起動時の厳格な検証がファイル全体を拒否するため、解除はエントリごと削除する必要があります。

  **`/unblock` はファイル全体の書き直ししかできません。** ブロックリストのファイルは追記型（末尾の `\n}` を位置指定で上書きする方式）で「1 件だけ削除する」書き方が存在しないため、手順は「まずメインスレッドのメモリ Map からその id を削除し、削除後の**Map 全体**を Disk I/O Worker へ投げて原子的に書き直す（tmp + fsync + rename）」になります。順序が重要なのは `/block` と同じ理由です。

  2 つのステップの間に届いた入室更新はまだ解除されていないリストを読み、その相手が無駄に即 kick されてしまいます。これはディスクから読み戻す構造が「居るか居ないか」ではなく**完全なレコード**であることも要求します。`blockedUserIds` が `BlockedUserRecord` を保持するのはそのためで、`true` だけにすると次の書き直しで他の全員の `blockedAt` が消し飛びます。書き直し後は追記カーソルと Worker 側の既知 id 集合を必ずリセットします。

  ファイル長が変わっており、古いカーソルはもう末尾の `\n}` を指していないため、それに従って追記すると JSON が壊れます。Disk I/O Worker の再生成後は、そのプロセスで 1 度でも解除していれば（`sessionUnblockedIds` が非空なら）差分の再投入ではなく全体の書き直しが必須です。追記では削除を取り消せず、新しい Worker がファイルから読み戻したエントリはまだ残っているからです。

  `sessionBlockedAt` と `sessionUnblockedIds` は互いに排他でなければなりません（ブロック時は後者から、解除時は前者から削る）。さもないと同じ id が両方の表に載り、再投入の順序でリストに載っているかどうかが決まってしまいます。

  **`/unblock` は既定で完全解除します。** 対象が動的リストにあれば削除し、その後 `ChatState.botIsAdmin` が true の全チャットで Telegram の BAN を解除します。対象が動的リストにいなくてもチャット横断解除は実行します。必要な permission は `isCanUnBlock` だけで、`SUPER_ADMIN_USER_ID` は引き続き明示的に通します。旧 `all` 引数は解析せず、互換 alias としても残しません。静的 `config/blocklist.json` の identity は、リストや Telegram API に触れる前に fail closed します。コマンドはデプロイ設定を書き換えられず、チャット BAN だけ解除すると矛盾した状態になるためです。

  **チャット横断の BAN 解除は必ず `unbanChatMemberIfBanned`（`only_if_banned: true` 付き）を通します。** Bot API の `unbanChatMember` は「現在メンバーである」相手に対してはチャットから退出させる意味になり、`kickChatMember` の「kick のみ」はまさにこれを利用しています。このフラグなしで一括解除すると、普通に在室していた人たちを次々と追い出してしまいます。

  チャンネルの外見にはメンバーという概念がないため `unbanChatSenderChat` を使い、この罠はありません。解除時には `pendingBlockedRemovals` の実行中 batch からもその id を取り除きます（空になった batch は丸ごと消し込む）。

  さもないと Worker 再生成時の再送が古い batch を持ち出し、解除したばかりの相手を再び BAN します。すでに投げて Worker 内で走っている batch は取り消せず（判定はメインスレッドの状態で Worker に複製がない）、その短い窓は既知のトレードオフです。

  **身内はブロックできません。** `SUPER_ADMIN_USER_ID` と `config/whitelist.json` は `/block` の入口で弾きます。起動時にも、それら protected identity と静的設定・復元した動的ブロックリストの交差を拒否します。`/white enable` もまだブロック中の identity を拒否し、先に `/unblock` するよう案内します。これらは独立した事前 check だけではありません。`runProtectedIdentityMutation` はメインスレッドの `protectedIdentityMutationQueue` を使い、`/white` の「membership 確認 + allowlist の atomic write と publish」を `/block` および広告命中による動的 blocklist 追加と直列化します。この境界がないと、非同期の allowlist 書き込み中に block が割り込み、同じ identity が両方に残って次回起動が必ず失敗します。critical section に含めるのは identity check と正式状態の変更だけで、Telegram の副作用と後続の永続化確認は外に置きます。

  起動時の復元では 1 件でも形が不正なら起動を拒否します。1 件取りこぼすことは、その相手の再入室を許すことと同じだからです。

  したがってブロックリストは追記型ファイルの中で唯一、**末尾の自動修復を許さない**ファイルです（`openAppendOnlyFile(..., repair=false)`）。ログ・おみくじ・保留中の認証は末尾の断片を切り捨てても正しさを損ないませんが、ブロックリストで切り捨てられた 1 件は部屋に戻される 1 人です。起動を拒否し、バイト列をそのまま残して人手の復旧を待ちます。id のキーは `String(Number(key)) === key` で元に戻せなければなりません。

  `Number` は `0x1f4`・`1e3`・`7.0`・`""` も受け付け、いずれも安全な整数でありながら別人を指します。ファイルは `PERSISTED_FILE_MODE` で作成します。`memory/blocklist/` には owner が 2 つあるため、正式リスト側が掃除するのは自分の `.blocklist.json.*.tmp` だけで、`removals.json` 側の一時ファイルには触れません。永続化に失敗したときは `/block` の返信でそれを明言します。

  Worker 側の書き込みエラーは `console.error` であり、設計上 `logs/` には入りません。

  **永続化の確認はドメイン単位に絞ります。** 統一 flush（`flushAll`）は 8 ドメインの論理積なので、どれか 1 つが失敗すれば全体の受領は `flushFailed` になります。`/block` が待つべきは `flushDiskIODomain("blocklist")` だけです。そうしないと、あるチャットの `memory/ai/<chat>.json` の所有者がずれているだけで「小さな手帳をディスクに書けなかった」と報告し、実際には壊れていないファイルへ運用者を誘導してしまいます。

  したがって受領は `failedDomains` を運び、メインスレッドが本当に壊れたドメインを名指しします。名指ししなければ、本当の障害について `logs/` には 1 行も入りません。

  **同じ相手への 2 回目の `/block` は、永続化に失敗した後の再試行そのものです。** 対象がすでにメモリ Map にあっても `sessionBlockedAt` に残っている（このプロセスで追加され、まだ落ちていない可能性がある）場合は、永続化メッセージを投げ直して確認を待ち直さなければなりません。「Map にもうある」を理由に `persisted` を true 扱いすると、ファイルにその記録がないまま 2 回とも管理者へ成功と伝えることになります。ブロックリストのメンバーが入室した場合は「kick のみ」ではなく必ず ban します。

  kick のみという規則は anti-raid の自動退出で誤爆を防ぐためのものであり、ここにある id はすべて管理者が自分で書き込んだものです。「この Bot はこのチャットで動ける」という論理積（**管理者である && `/init enable` 済み**）が成立している間は、1 回の掃除（`sweepBlockedMembers`）が必要です。ブロック実行時にそのチャットでは権限がなく連鎖 BAN が飛ばされており、入室時の即 kick はそれ以降の入室更新にしか効かず、すでに部屋にいる相手には無力だからです。

  トリガーは特定の update ではなく論理積そのもので、どちらの辺が変わっても対象です。

  **エッジを消費してよいのは処理が着地した瞬間だけで、投げた瞬間ではありません。** `recordBotAdminStatus` は管理者身分を確認するたびに `sweepBlockedMembers` を呼び、「このチャットは掃除済みか」は Worker の `blockedMembersRemoved` 受領に基づいて `blocklistSweepState`（`packages/cache/main/blocklist.ts`）が記帳します。`complete` のときだけ `sweptAt` を記録します。

  身分変化のエッジに掛けてしまうと、1 度の rate limit 失敗がそのまま「その人たちが永久に部屋に居座る」ことになります。再試行も同じ管理者観測に乗るため、入室のたびに届くその更新に対して `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` の待機が必須です。`/init` の切り替え、管理者剥奪、退出はいずれも `forgetChatBlocklistWork` を通り、そのチャットの掃除進捗を破棄する**と同時に実行中の batch も捨てます**。再び担当することになれば改めて 1 回借りを作ります。

  この破棄は状態の永続化より**前**に行わなければなりません。担当を外れたことは Telegram が既に伝えてきた権威ある事実であり、`state.json` が書けなかったからといって取り消されません。永続化が拒否されるとプロセスはそのまま終了し、ディスク上の `botIsAdmin` は `true` のままで起動時の filter も効かず、必ず失敗する処置が再起動と Worker 再生成のたびに投げ直されます。

  同じ理由で、`isBotAdminIn` の「取得できなければ管理者ではないとみなす」は `getChatMember` 自体にしか掛かりません。状態の永続化失敗はそのまま上へ投げる必要があります。「管理者ではない」に畳み込むと呼び出し側が入室ガードを丸ごとスキップし（その `new_chat_members` の一団は認証 window も開かず、メッセージ追跡もされず、timeout kick も来ません）、しかも診断は Telegram API を指し、次の呼び出しはメモリから `true` を読むため、現象を再現できなくなります。

  **`sweptAt` は latch であり、それを開ける経路が必ず要ります。** `requestBlocklistResweep`（`packages/infra/blocklist/sweep.ts`）は「このチャットにまだブロックリストのメンバーが残っている」という信号——`/block` があるチャットで `banChatMember` に失敗した、即 kick の batch の受領が `complete: false` だった——を受けて `sweptAt` を null に戻します。

  これがないと、一度掃除済みのチャットではその相手がプロセス終了まで居座ります。即 kick はそれ以降の入室にしか効かず、掃除は latch に阻まれるからです。batch が実行中の場合、要求は `sweptAt` を直接触らず `resweepRequested` を記録するだけにします。その batch の `complete: true` 受領が要求より後に届くと `sweptAt` を書き戻し、要求が消えてしまうためです。即 kick の失敗による再掃除には待機を付けます。

  ブロックリストの相手は何度も入り直せるため、失敗のたびに即座に再掃除すればブロックリスト長ぶんの判定 request が嵐になります。さらにその待機は、そのチャットで**連続して落ち着かなかった掃除の回数**に応じて `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS` まで線形に伸ばし、`complete` の受領で回数をゼロに戻します。

  **この回数は受領だけでなく、落ち着かなかったすべての経路が進めなければなりません**：`sweepBlockedMembers` の 2 つの降格経路（outbox に登録できない、配信境界で例外）の後には回数を進めてくれる受領がもう来ません（claim は既に空で、遅れて届いた受領は回数を触らない再掃除要求の経路を通ります）。

  取りこぼすと、実行 owner が投げ続ける間（Worker 使用不能、outbox 満杯）は毎ラウンドが基本間隔で組まれて上限に永久に届かず、しかも 1 ラウンドごとに outbox id 1 つとエラー log 1 行を焼きます。

  **「権限不足」は他の失敗と別枠にします**。バックオフを伸ばしても結局は時間による再試行であり、BAN 権限がない状態では何度試しても同じエラーを再び出力し、さらに O(リスト長) の再スキャンを払うだけです。`banChatMemberWithOutcome`（`packages/infra/telegram/actions.ts`）が Telegram の応答から切り分けます。403 はすべて該当、400 は `not enough rights` を名指しした場合のみ該当します（同じ 400 の「ユーザーが存在しない」を含めてはいけません。

  再試行可能なバッチが、決して来ない承認を待って永久に停止します）。最初に該当した id で残りの試行を打ち切ります。

  **ただし `forbidden` 自体がまだ 2 つの原因を混ぜており、もう一段分ける必要があります**。「対象自身がそのグループの管理者である」場合にも Telegram はまったく同じ 400 `not enough rights` を返すため、`permissionDenied` に混ぜると BAN できない管理者 1 人が**グループ全体**のスキャンを永久に閂で閉じてしまいます（以後スキャンは早期 return、再スキャン要求は拒否、Worker 再生成のたびに replay をスキップし、唯一の解除エッジは「Bot の BAN 権限が変わった」——それは起こりません）。

  そこで Worker は `forbidden` の後に `probeChatAdmin` でその id の身分を 1 回確証します。管理者と確認できたら**その対象だけを決着させ**（名指しのログを 1 行残し、同バッチの残りは通常どおり処理し、バッチも通常どおり落着します）、確証できなければ元の判定を維持します——確証なしにグループ単位の閂を個別再試行へ格下げしません。

  **ただし「このバッチは再投入不要」は「このグループは掃除済み」ではありません**。受領には `complete` と直交する `targetIsAdmin` を別途載せ、メインスレッドはそれを見て `sweptAt` を書かず、そのグループの連続失敗カウントを通常どおり積み増します（積まないと、管理者権限を持ち続けるブロックリスト対象 1 人がリスト全体の再スキャンを 5 分周期に固定してしまいます）。

  この 1 枠がないと、バッチが成功を報告したその瞬間に閂が閉まります——対象が一般メンバーへ降格された後も再スキャンは二度と来ず、それでもボットは「ブロック済み」と称し続けます。本当の権限不足なら受領に `permissionDenied` を載せてメインスレッドへ返します。メインスレッドは印を 2 か所に記録します。

  メモリ上の `blocklistSweepState.permissionBlocked` はそのグループの時間再試行・新規スキャン・Worker 再生成時の replay を止め、durable outbox の該当項目は `missing-permission` になります——これは停止したバッチが持つ唯一の自己説明的な印で、運用者にネットワークやディスクではなく権限付与を指し示します。

  **そのグループにまだスキャン記録がない場合は印を捨てず、最小の記録を補って作らなければなりません**。スキャン記録は `sweepBlockedMembers` だけが作りますが、Bot が最初から `can_restrict_members` を持たないグループこそこの印を最も必要とします。記録できなければ入室即時処置の権限拒否が残らず、`replayPendingBlockedRemovals` が Worker 再生成のたびにその失敗確定バッチを投げ直し、解除エッジには解除すべき記録がありません。

  解除するエッジは 1 つだけ、**確証された BAN 権限の観測**（`my_chat_member` 更新または必要時の `getChatMember`。`packages/infra/botAdmin.ts` と `libs/chatMember.ts` の `canRestrictMembers` を参照）です。権限ビットを取得できない経路（他人の `chat_member` 更新から「自分は管理者だ」と推論するだけの経路）では停止したまま保ちます。「観測できなかった」を「権限がある」と読んではならず、権限がまだ無いと観測した場合も解除しません。「管理者である」ことと「BAN できる」ことは別であり、制限権限を外したまま管理者に昇格させるのがこの状態の最大の原因です。固定間隔では「決して BAN できない相手」を受け止められません。相手自身がそのチャットの管理者である場合や、bot が管理者でも BAN 権限を持たない場合、どの掃除も必ず失敗するため、プロセスが生きている限り 5 分ごとにリスト全体を掃除し続けることになり、しかもそれらは認証 timeout kick と同じ rate limit queue を共有します。上限も同様に必須です。

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

  この関数は update middleware の中で動くため、投げればその update が失敗し、offset を保留したまま非ゼロ終了し、systemd が再起動して同じ update を再投入し、また投げます——`memory/blocklist/removals.json` を手で直すまで抜けられない再起動ループであり、しかも outbox 満杯自体、たいていは永久に BAN できないバッチが積み上げた結果です。

  降格では名指しでログを残し、そのグループに再スキャンを 1 回負わせたうえで、それでも「ブロックリストとして処理済み」を返します。リスト判定は変わっていないので、代わりに入室認証 window を開いてはいけません。

  **ブロックリスト入り参加者への処置は join を「置き換える」のであって「付け足す」のではないため、処置が取り消されたらその join を戻さなければなりません**（`ClaimBlockedJoinerParams.replacedJoin`）：`claimBlockedJoiner` はヒット時に意図的に `join` を積みません——Worker はこれから kick される相手に認証窓を開かないからです。

  ところがそのバッチは write-ahead flush を待っている最中に並行する `/unblock`（`forgetUserBlocklistRemovals`）で丸ごと消え得ますし、`reconcileBlockedRemovalMessages` は権威 params が消えたメッセージをただ外します：戻さなければ、その参加者は removal も認証窓も持たない状態になります——リマインドもタイムアウト kick もなく、荒らし窓の参加カウントも漏れ、そしてシステム内のどこも彼のために窓を開き直しません（`chat_member` だけの経路ではさらに悪く、バッチ全体が空になり何も送られません）。

  **必要なのは「バッチが権威 mirror から本当に消えた」場合だけです**。突き合わせラウンドを使い切った場合は戻してはいけません——task は durable outbox に残っていて当人はまだ排除予定であり、そこで認証窓を開くのはブロックリストに載ったままの相手を通すことになります。

  **この契約は配信経路全体に及び、`claimBlockedJoiner` だけの話ではありません**。`prepareDurableAntiRaidMessages` が `BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS` を使い切ったときも投げてはいけません——`postAntiRaidDurably` 経由で同じ update middleware から呼ばれるため同じ再起動ループになり、しかも発生条件（並行する `/unblock` が同じバッチを削り続ける）は再投入後もそのまま成立します。

  かといって最後の照合結果をそのまま投げるのも不可です。`/unblock` が取り消したばかりのバッチを含みうるからで、それこそこの照合が防ぐべきものです。正しい降格は、処置メッセージだけを丸ごと外して残りを通常どおり投げ、エラーログを 1 行残し、該当グループに再スキャンを負わせることです。タスク自体は durable outbox に残るので失われません。

  **判定と実行はスレッドで分離します。** 判定はメインスレッドに置きます。リストはメインスレッドの状態で Anti-Raid Worker には複製がなく、しかも join を投げる前に判断する必要があるためです（そうしないと Worker がすぐ退出させる相手のために認証 window を開いてしまいます）。一方でメンバー判定と BAN の request はすべて Anti-Raid Worker へ投げ、その `joinVerificationApi` queue で実行します。認証 timeout の kick とまったく同じ経路です。

  ブロックリスト該当者の一斉復帰も昇格時の掃除も「まとまった退出 request」であり、既定クライアントに載せると通常コマンドと AI 応答が遅くなり、メインスレッドで走らせるとそのチャットの update レーンを塞ぎます（Bot API にメンバー列挙の手段はないため、掃除のコストは常にブロックリスト長ぶんの getChatMember 呼び出しです）。

  処置メッセージは同じ batch の join/left と一緒に `postAntiRaidDurably` で投げ、Worker が mailbox を処理し終えてから update を引き渡します。実際のネットワーク request はそのスレッドの慣例どおり事後に直列実行し、mailbox を塞ぎません。

  infra 層は Anti-Raid の業務モジュールに静的依存してはならず、実行 owner は `packages/cache/main/blocklist.ts` の 1 スロットへ逆方向登録します（`infra/chatTeardown.ts` と同じ形です）。

  **`/block` コマンド自身によるチャット横断の連鎖 BAN は、このスレッド分離の明示的な例外です。** メインスレッドで `isChatMember` + `banChatMember` を直列に呼びます（既定の `bot.api` 経由）。戦果報告はチャットごとに「蹴り出した」と「事前に BAN した」を区別する必要があるのに対し、現在の受領は `complete` しか運ばず、Worker へ投げるとチャット単位の結果が取れないためです。

  メインスレッドは `confirmedKickedUserIdsByChat` で反復コマンドの request を減らせますが、記録できるのは `isChatMember === true` を確認し、その後の BAN も成功した `(chatId, userId)` だけです。退出確認、lookup 失敗、事前 BAN は記録しません。cache は東京暦日の切り替わりで遅延全消去し、`/unblock` は対象 user を先に無効化します。また `blocklist.json` や `removals.json` から復元してはいけません。

  両者には未着地の再試行・再 kick semantics があり、それを API skip に使うと在室者を黙って残すためです。代償は、1 回のコマンドがそのチャットの update レーンを数秒占有すること、および 1 回の呼び出し失敗が再試行されないことです。後者は `requestBlocklistResweep` が受け止めます。BAN に失敗したチャットは再び「1 回借りている」状態に戻され、次の管理者観測で掃除し直されます。

  この例外は `/block` コマンド自体にのみ適用され、即 kick と掃除は従来どおりすべて Worker へ投げます。

#### 広告検出の受付・判定・処置

- `/ad_detect` の広告検出は**ベストエフォートのヒューリスティック**であり security boundary ではありませんが、処分の重さは `/block` と完全に同じなので境界は厳密に引きます。送出の門は 3 条件の連言です。当該グループが `ChatState.isAdDetectEnabled === true` であること、Bot がそのグループの管理者であること（参加ガードと同じ `isBotAdminIn` 判定を共有します。

  管理者でなければ広告も消せず BAN もできず、判定は quota を焼くだけです）、送信者に広告検出 bypass がないことです。`SUPER_ADMIN_USER_ID` は常に bypass し、allowlist identity は個別の `isCanBypassAdDetection` permission に従います。false に設定した identity は判定へ送られ、Worker が命中した message bundle を削除することがあります。

  **allowlist membership は恒久 blocklist を無条件で保護します。** 判定結果がメインスレッドへ戻ると、処分側は `/white` と `/block` と同じ `runProtectedIdentityMutation` critical section 内で `isProtectedSender` を再確認します。判定中に allowlist へ追加された場合も、もともと allowlist で bypass を無効にしていた場合も、`blockUser`・チャット横断 BAN・BAN 告知を拒否し、Worker がすでに行った当該 bundle の削除だけを残します。現在のグループを皮として使う匿名管理者（`sender_chat.id === chat.id`）は `/block` と同じ理由でスキップします。

  皮の下が誰かを Telegram は明かさず、処分はグループ ID 全体を BAN しようとするだけだからです。

  **連携チャンネルからディスカッショングループへの自動転送（`is_automatic_forward`）と、Bot 自身の投稿の跳ね返り（`isBotOwnMessage`）も一律スキップします**。そのメッセージの送信者はチャンネル自身であり、処分は `userId < 0` の分岐で管理下の各グループに `banChatSenderChat` を打ちます——チャンネル側の宣伝投稿 1 件でコメント欄が根こそぎ壊れ、Bot が自分のチャンネルへ投稿したものが跳ね返ってきた場合は自分のチャンネルをブロックリスト入りさせることさえできます。

  チャンネル投稿の可否はチャンネル管理者が決めることで、ディスカッショングループの広告検出の管轄ではありません。

  **この免除は引用文にも及ばせなければなりません**：ディスカッショングループではトップレベルのコメント 1 件ごとの `reply_to_message` が同じチャンネル投稿であり、投稿自身だけを弾いてその本文を `sampleContext` に写して送出するのは、チャンネル自身の宣伝コピーでコメント投稿者を一人ずつ判定するのと同じです——チャンネルの宣伝 1 件でコメント欄の全員が、一文字も書いていないまま順にブロックリスト入りしかねません。`quote` は返信先メッセージから切り出した抜粋なので、一緒に捨てます。

  **グループ管理者／オーナーは決して処分しません**。処分は `/block` と同じく不可逆（永久リスト + 管理下の各グループでの BAN + `revoke_messages` による直近メッセージの消去）である一方、管理者が提携先のリンクを転送する、冗談で「WeChat 追加して」と言う、それだけで宣伝と読まれ得ます。門は 2 段構えです。

  投入時は Worker 側の管理者キャッシュ（`freshAdminIds`）で既知の管理者を quota の外へ弾き、判定が当たった後は `getChatAdministrators` を基準にもう一度確証します。そこで**確証できない場合は必ず「処分しない」**を選びます（広告 1 件を見逃す代価は、オーナーを誤って BAN する代価よりはるかに小さく、次のメッセージで再投入される頃にはキャッシュも温まっています）。

  **判定も副作用もすべて Anti-Raid Worker スレッドで実行します**。メインスレッドは同期的な門と 1 回の `post` のみを担当し（`postAntiRaidDurably` は使いません。待ち行列は isolate と生死を共にするため、グループメッセージごとにスレッド跨ぎ barrier を張っても復旧能力は何も得られません）、post が拒否されても log だけ残して update は拒否しません。

  **キューが持つのは送信者キー（`chatId:senderId`）だけ**です。同じ送信者が待機中に話した内容は `pendingAdMessages` の同じ bundle へ合流し、二つ目のキュー枠を取りません。待機中の所有権は `pendingAdMessages`、`adDetectQueue`、`queuedAdDetectKeys` の三者で共同表現し、必ず同期して増減させます。

  **これら 3 つに触れてよいかの判定は `packages/states/adDetectAdmission.ts`** に集約しました（投入・再キュー・容量・実行中の 4 つの純粋ゲート）。実行時側は結論を実行するだけです。メッセージ束そのものの整形（切り詰め、上限適用、判定用テキストの組み立て）は `packages/workers/antiRaid/adDetect/bundle.ts` にあり、別の不変条件——追い出してよいのは判定済みの項目だけ——を守ります。

  `AD_DETECT_MAX_PENDING_SENDERS` は異なる 11,500 キーの hard cap です。この数字は「何人受け入れられるか」ではなく「満杯でも生き残れるか」で決めます——1 キー当たりの件数上限と各エントリの本文／URL／サンプル文脈の上限を掛け合わせたものが Anti-Raid Worker isolate の常駐上限であり、参加認証・ロックダウン・ブロックリスト執行はすべて同じ isolate にいるため、OOM はベストエフォートのヒューリスティックもろとも巻き添えにします。

  満杯時は Map、キュー、Set のどれも変更する前に 11,501 個目の新規キーを拒否し、受け入れ済みの古いキーを FIFO 追い出ししてはいけません。同じキーの後続メッセージは既存の 1 キー当たり件数・文字数枠の範囲で引き続き合流します。受け入れ済みキーには、少なくとも 1 回の判定試行を受けるまで待機 TTL がなく、周期 sweep も削除できません。

  担当外れ、`/init disable`、`/ad_detect disable`、Worker 停止だけが正当な cancellation 境界であり、Map、キュー、関連 Set から同時に取り除きます。`recentlyEnqueuedAdKeys` と `recentlyDisposedAdKeys` も 11,500 の hard cap を持ち、窓ごとにローテーションするため、過去の送信者が無制限 Set へ変わることはありません。

  スケジューラは `AD_DETECT_QUEUE_TICK_MS` ごとに 1 本の全体 FIFO から最大 `AD_DETECT_BATCH_SIZE` キーを取り、さらに全体の `AD_DETECT_MAX_IN_FLIGHT` 関門を通します。どちらもグループ別 quota ではなく、実行中上限で止められた受け入れ済みキーは容量回復までキューに残り、期限切れになりません。90 秒の `AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS` が制限するのは再投入と消費済み文脈だけです。

  `seq > checkedSeq` の未消費エントリは待ち時間にかかわらず残し、窓外で刈り取れるのは `seq <= checkedSeq` の消費済み文脈だけです。窓の切り替え時には未消費内容を持つキーを再投入します。`checkedSeq` は「ここまで消費済み」を表す単調通し番号であり、刈り取りで戻してはいけません。

  **送出の文字数枠（`AD_DETECT_BUNDLE_MAX_CHARS`）が決めるのは「この tick がどこまで判定するか」だけで、「どのメッセージが判定されるか」ではありません**。未判定の内容は必ず最も古い 1 件から詰め、入り切らない分は次回の判定（窓の切り替え時の再投入）へ回し、余った枠に隣接する判定済み文脈を足します。通し番号は今回実際に送出した最後の 1 件までしか進められません。逆に最新から遡って詰めるのは誤りです——枠から外れた古いメッセージが通し番号の下に埋もれ、通し番号と一緒に「判定済み」として記録されたうえで刈り取られます。

  1 キー当たりの件数上限（45 件 × 512 文字）はこの枠の数倍広いため、長文の連投 1 回で成立します。それは log の痕跡が一切ない見逃しであり、まさにこの規則が禁じているものです。

  **送信者ごとの件数上限（`AD_DETECT_MAX_MESSAGES_PER_SENDER`）も、押し出せるのは消費済みの項目だけです**。爆発的な連投は最初の tick が来る前に上限を埋められ、そのときは未判定の項目しか捨てるものがありません。本文は残しませんが、メッセージ id は `AdMessageBundle.pendingDeleteIds` へ移す必要があります（上限は `AD_DETECT_MAX_PENDING_DELETE_IDS`。あふれたら最も古い 1 件を捨ててエラーログを残します）。

  移さないと、それらは判定にも処分の削除集合にも入りません——判定根拠（`judged`）と現在の列（`entries`）のどちらからも漏れるため、命中後もグループに永久に残ります。チャンネル名義では特にそうです（`banChatSenderChat` に `revoke_messages` はありません）。

  **その結果、和集合は `deleteMessages` の 1 回あたり 100 件という上限を超えうるため、呼び出し側で分割する必要があります**。この API は一括の成否しか返さないので、全 id をそのまま渡すとバッチ全体が拒否されて 1 件も削除されません——id を持ち越さないより悪い結果になります。

  **判定失敗は「今回は判定しなかった」として扱い、そのバッチは判定済みにします**。true を推測してはならず（ネットワークの一時不調で人を永久にブロックすることになります）、無限にリトライしてもいけません（DeepSeek 側の障害時に毎秒 1 バッチのリクエスト嵐になります）。応答の解析は真の boolean `true` だけを受け付け、`"true"`・`1`・`yes` はすべて「判定なし」です。

  **引用部分（`quote`）と返信先の元メッセージは本文と一緒に送出しなければなりません**。広告の最も主流な出し方は「まず完全に正常なメッセージを送って判定を通す → しばらく経ってからそれを**編集**して広告にする → 返信／引用でグループに押し上げる」であり、広告本文はどの新規メッセージの `text` にも存在しません。編集は判定の再投入を起こさないため、「元メッセージは投稿時に判定済み」は編集後の内容には成り立たず、`text` だけを読むとこの経路は検出に対して完全に免疫になります。

  **巻き添えの代償は承知のうえで意図的に受け入れています**：広告を引用して苦情を言った参加者も一緒に判定されます——判定器は「広告を引用して非難している」と「引用で広告を押し上げている」を区別できないため、見逃すよりは誤爆する側に倒し、題材の口径は配備側の `config/ad_samples.json` で詰めます。

  **同じ引用文は列全体で、最初にそれを引き取った 1 件にだけ残します**（`claimSampleContextParts`）：まとめて送出する意味はばらして出された断片を 1 つの提出にそろえることにあり、その出し方はほぼ必ず毎件が同じメッセージへの返信です。件ごとに引用文を複製すると 1 件で「本文 + URL + 文脈」の枠を使い切れてしまい、`AD_DETECT_BUNDLE_MAX_CHARS` の半分近くを重複した引用文が食べるため、1 回で判定されるべき断片が数ラウンドに切られ、モデルは毎回それ単体では無害な断片しか見られません。

  後続のメッセージは自分の本文で従来どおり選ばれ、読むのは同じ完全な引用文です。サンプル側の 1 部は**重複排除しません**——判定は 1 回読めば足りますが、証跡は各メッセージが当時何を引用したかを正直に記録しなければなりません。同じ理由から、本文・URL・文脈の三つがすべて空のときにだけ「判定する内容がない」と見なします：広告を押し上げるメッセージ自身は一文字も打たない（スタンプ、caption のない画像）ことが十分あり得ます。逆に `text_link` エンティティ内の URL は送出テキストへ必ず付加します。

  ハイパーリンクの可視テキストは完全に無害（「ここをクリック」）でも構わず、着地先はエンティティにしか存在しないため、付加しなければ「この群から人を連れ出すか」という最も硬い規則がハイパーリンクに隠れた広告すべてに対して無効化されます。URL は**本文とは別立てでスレッドを跨ぎ、それぞれ独立した文字数枠を持たせなければなりません**（`AdCandidateMessage.linkUrls`。Worker 側が本文を `AD_DETECT_MESSAGE_MAX_CHARS` で切り詰めた後に連結します）。

  メインスレッドが本文の末尾へ連結してしまうと、Worker の「先頭から残す」切り詰めで落ちるのがまさにその URL です——700 文字の埋め草と「ここをクリック」というアンカーテキストのリンク 1 本で成立する、コストゼロの回避経路になります。付加するのはメッセージ自身が持つ URL でシステム文言を伴わないため、本文に偽造可能な構造を持ち込みません。

  **すでにブロックリストにいる人は再送出しません**（送出の門にある `isUserBlocked`）。処分はすでに積まれており、まだ話せているのは BAN が着地していないだけです。再判定は quota を焼いたうえで前回と同一の処分を得るだけです。

  **ただしメインスレッドでそのまま捨ててよいのは実在ユーザーだけです**。`banChatMember` は `revoke_messages` を伴い、着地時にこの隙間のメッセージも消しますが、チャンネル名義の BAN は `banChatSenderChat` でそのフラグがありません——メインスレッドで捨てると、BAN 着地前に押し込まれた広告には清掃経路が一切なく、log も残さずグループに永久に残ります。

  したがってチャンネル名義は通常どおり Worker へ送り、「すでにリストにいる」という事実を `AdCandidateMessage.blocked` に載せて渡し（ブロックリストはメインスレッドの状態で、Worker に mirror はありません）、送出の門がそれを `deleteStraggler` に変えます——削除はするが判定 quota は消費しません。これは下の `recentlyDisposedAdKeys` による抑止と同じ例外で、覆う窓がより長いだけです。

  あちらは 1 つの重複排除窓しか生きませんが、「リストにいるが BAN が未着地」は窓を跨いで存在し得るうえ、今回の判定だけが生む状態でもありません（即時 kick、再 sweep、前の窓で積まれた removal バッチはいずれも先にリストへ書いてから outbox flush と mailbox barrier を待ちます）。Worker 側にも同一窓内の抑止（`recentlyDisposedAdKeys`）を置きます。

  広告と判定されたキーは処分の送出と同時に記録し、「処分は出た／メインスレッドはまだブロックリストへ書いていない」というスレッド跨ぎの隙間に滑り込んだメッセージを受け止め、窓の切り替えで一緒に消えます。

  **チャンネル身分についてはこの抑止が抑えるのは判定だけで、削除は抑えません**。`banChatSenderChat` に `revoke_messages` はなくその BAN では持って行けず、抑止が効いている間は 2 度目の判定も走らないため、抑止分岐の中で削除を 1 回補わなければ、それらの広告はグループに永久に残ります。

  **再命中で処分一式をやり直してはいけません**。一式の代価は fsync を伴うブロックリスト永続化 1 回に加え、管理下の各グループごとの BAN バッチ（各バッチが outbox 全体の deep copy とファイル書き込みを要求）であり、グループ数で増幅されて O(n^2) の書き込みになります。したがって `blockUser` が false（すでに登録済み）を返したときは、発火したグループの 1 バッチだけを補い、永続化の確認は待ち直しません。

  エントリは初回命中時に in-memory Map へ書かれ永続化も投げ済みで（失敗していれば log に名指しされ、Disk I/O Worker の再生成時に本プロセス追加分は replay されます）、他グループのバッチは outbox で再試行を待っています。これは `/block` の再試行意味論と矛盾しません。あちらの再実行はディスクを直した管理者による人為的な再試行、こちらは連投者自身が引き起こすものであり、同じ代価を共有すべきではありません。

  補う 1 バッチも `isInitEnabled && botIsAdmin` の filter を通します。2 回の命中の間に管理者権限を失っている可能性があるからです。

  **命中後の処分はブロックリストと同じくスレッドで分担します**。Worker 側はその列のメッセージを削除し、`adDetected` をメインスレッドへ返します。メインスレッドは失ってはならない部分——`blockUser` と `flushDiskIODomain("blocklist")`、続いて `isInitEnabled && botIsAdmin` の各グループごとに `trackBlockedRemoval` したバッチを durable outbox 経由で Worker へ戻し、最後にグループ内告知を送る——を担当します。

  **告知は BAN 登録の結果が分かってから送る必要があります**。文面は「見張っているすべてのグループでまとめて BAN した」と断言しますが、登録は 1 グループも成立しないことがあり（outbox 満杯、直前の管理者権限剥奪、`/init disable`）、その場合は誰も退出させられていないので、そのまま送れば事実と反する掲示になります——登録ゼロなら管理者に権限確認を促す文面へ切り替えます。

  **一部のグループだけ登録に失敗した場合も「すべて」と言ってはいけません**：失敗したグループには本人がまだ座っており、手がかりは誰も見ていないエラー log 1 行だけです。したがって文面は実際に BAN できたグループ数を報告し、残りを明示しなければなりません——全滅時にしか効かない番人は、「3 グループのうち 2 つで BAN できなかった」を従来どおり「見張っているすべてのグループでまとめて BAN した」と言い続けます。

  これは Worker 側でメインスレッドへの返送チャネルが閉じているときに告知しないのと同じ理屈で、そちらはメインスレッドがイベントを受け取らないことで自動的に満たされます。告知は `KICK_NOTICE_AUTO_DELETE_MS` 後に自動削除し、恒久的な掲示を残しません。これらメインスレッド側 task は `inFlightAdDisposals`（`packages/cache/main/antiRaid/adDisposal.ts`）に登録し、`drainAntiRaid` の各ラウンドで待機します。

  event ごと途中で捨ててはいけません。

  **この待機もラウンド内の他の各段と同じ残り予算を使い**、尽きたら `timedOut` として決着します。予算なしで待つのは不可です。

  処分の内部では `confirmBlocklistPersisted`（fsync を伴う領域 flush）と `dispatchBlockedRemovals`（outbox の write-ahead 永続化 + mailbox barrier）を通るため、全予算を 0 にする異常終了経路（`FATAL_FLUSH_TIMEOUTS`）は本来即座に決着すべきところ、実際には 15 秒の強制終了線まで引きずられます——プロセスは停止処理の途中で非ゼロ終了し、インスタンスロックは解放されず offset も確認されません。

  **逆に、Worker 側の判定バッチを Anti-Raid の実行中 task 集合へ登録してはいけません**。その集合は停止時 drain の待機対象で、予算は `ANTI_RAID_BARRIER_TIMEOUT_MS` 相当の秒単位ですが、判定リクエスト 1 回は `DEEPSEEK_REQUEST_TIMEOUT_MS`（30 秒）に空本文リトライを掛けた時間まで伸び得ます。

  登録すれば、停止時にたまたま判定が実行中であるたびに drain がタイムアウトし、ライフサイクルは Telegram offset の確定を拒否して非ゼロ終了します——ベストエフォートのヒューリスティックのために汚い終了と update の再配信を買うことになります。drain が来たら判定の tick を quiesce するだけ（新規リクエストも削除も告知も行わない）にし、実行中の判定は自然に収束させます。

  **担当外れ、`/init disable`、`/ad_detect disable` はいずれも当該グループの待機列を破棄しなければなりません**。メインスレッドの門は以後のメッセージしか止められず、すでに Worker に並んでいる分が判定を続ければ、スイッチを切った後に人がブロックされます。実行中の判定は状態オブジェクトの同一性で自ら無効化されます（列が消えているため、捕捉した参照が一致しません）。

  **ただしこの後片付けの配信失敗はコマンド自身が受け止め、update handler の外へ逃がしてはいけません**：`post()` が false を返すのは「Worker が再起動予算を使い切って放棄された」「再生成中」の 2 状態だけで、そのどちらでも待機列は古い isolate と一緒に消えており、片付けるものは何も残っていません。

  逆に例外を逃がす代償は実害そのものです——スイッチはすでに永続化済みなのにこの update は失敗と判定され、最終的に offset が確認されず、プロセスは非ゼロ終了し、再起動後 Telegram が同じ `/ad_detect disable` を再配信する一方 Worker は依然として使えないため、再起動ループが溶接されます（`/ai_chat disable` が `invalidateAiChat` に対して行っている扱いと同じです）。

  **プロンプト内の構造規則を厳しくする前に、`config/ad_samples.json` の正例と 1 件ずつ突き合わせなければなりません**：規則は「何をもって広告とするか」、サンプルは「この配備がどの種類を認めるか」を担当しますが、どちらも同じ口径の話です。規則が「通常は該当しない」と言い、サンプル一覧が「同種の話術に当たれば true」と言えば、モデルは互いに矛盾する 2 つの指示を受け取り、損なわれるのは常に再現率です——見逃された広告はどの log にも痕跡を残さないので、誰も気付きません。

  求人詐欺の類が特に踏みやすいです：それらの正例には連絡先が一切なく（誘導は相手から DM させる形）、「三点セット」を全部同時に揃う必要があると書くと一覧の正例が十数件まとめて false になります。プロンプトには**必ず「JSON」という語を含めます**。リクエストは `response_format: json_object` を使い、DeepSeek はプロンプトが json に言及しているかをサーバー側で検証し、なければ 400 で判定全体が失敗します。

  **出力枠は推論モデルを前提に余裕を持たせます**。`AD_DETECT_MODEL` は推論モデルで、reasoning token が `max_tokens` を本文と共有します。枠が足りないと JSON が途中で切れるのではなく、推論が枠を使い切って本文が 1 文字も出ず（`finish_reason=length` かつ content が空）、呼び出し側には「今回は判定なし」としか見えないまま広告が素通りします。

  したがって転送層は `length` 終了を個別に検出して log に名指しし、途中の本文を解析器へ渡さず null を返さなければなりません。さもないとこの種の見逃しは痕跡を一切残しません。モデルが見るグループ本文は常にデータであり、`reason` は log と告知文だけに使い、制御フローには一切関与しません。

  **ヒットのたびにバイパスのサンプルを 1 件書きます**（`memory/ad-detected/sample.json`、`workers/diskIO/adSampleFile.ts` 参照）。判定ルールは prompt が固定しますが、この配備がどの題材を認めるかは `config/ad_samples.json` の例だけが決め、その例は実際のヒットからしか集まりません——生の素材がなければ、誤判定は人の記憶に頼って再現するほかありません。これは永続化全体で**唯一の書き込み専用**クラスです。

  プロセスは決して読み込まず、起動リカバリも触れないため、統一 flush の領域リストにも入れません（純粋な診断ファイルの書き込み失敗が `/block` の永続化確認を失敗にしてはいけません）。切り捨て自己修復を許し、失敗は `console.error` だけ残して捨てます。現行ファイルは 8 MiB 到達時に `sample.<東京日付>[.<正整数連番>].json` へ自動ローテーションし、アーカイブはファイル名の日付に基づいて当日を含む直近 15 東京暦日だけ保持します。

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

- 未完了の blocklist removal batch は、現行形式の durable outbox `memory/blocklist/removals.json` に保持します。メインスレッドは Anti-Raid Worker へ removal を送る前に、独立した `blocklistRemovalOutbox` flush domain で outbox snapshot を永続化しなければなりません。

  **durable の境界はその flush であって snapshot message 自体ではありません**：Worker は受信時に mirror を差し替えて dirty を立てるだけで、書き込みは統一 flush で起きます。

  message ごとにその場で書くと、N グループ分の sweep が順に登録／清算するだけで outbox 全体の `tmp + fsync + rename` が N 回走り、しかもその outbox 自体が登録済みグループ数に比例して育ちます——本文書が禁じている O(n^2) の書き込み増幅そのものであり、確認を待たない経路（バッチ清算、失敗カウンタ、起動時の突き合わせ）にまで fsync を負わせていました。

  **再 sweep のエントリ（`probeMembership: true`）は `userIds` を永続化してはいけません**：outbox が記録するのは「ブロックリストでこのグループを一度さらう」という**タスク**であり、名簿は投函と replay のその瞬間に現在の `blockedUserIds` から算出します（`materializeRemovalParams`）。

  id リストを凍らせて持たせると害が 3 つあります——書き込み量が「グループ数 × 名簿長」で増幅する（N グループ分の再 sweep エントリは同じ内容を持つので、合計は本文書が禁じる O(n²) の書き込みそのものです）、`removals.json` が永続化全体で唯一「ブロックリスト長に比例して育つ」ファイルになり、しかもそれは起動リカバリのクリティカルパス上にある、そして replay 時にはその snapshot が既に古い可能性がある——Worker 再生成後にさらうべきは**その時点**の名簿です。

  逆に即時 kick と広告処分（`probeMembership: false`）は名簿を**必ず**タスクと一緒に凍結します：あれは「今このグループにいると分かっているこの数人」であり、名簿の現在の中身とは無関係で、算出し直せば無関係な人まで巻き込みます。2 つの形態は判別可能 union（`PendingBlockedRemovalParams`）で型レベルに分けてあり、再 sweep が名簿を持つ・kick が名簿を欠く、のどちらもコンパイルを通りません。

  codec も同様に拒否し、`userIds` を持ったままの再 sweep エントリには例外を投げます——移行し切れていない v1 エントリである可能性が高いためです。したがって `/unblock` は**凍結名簿を持つバッチだけを書き換えます**。再 sweep エントリは触る必要がありません（算出される名簿には解除された本人が最初から入りません）。ファイル版は v1 から v2 へ上がり、codec は現行版しか受け付けません：移行漏れは起動の時点で止まらなければなりません。

  同じ理由から、この snapshot はメインスレッド・スレッド跨ぎ・書き込みの 3 箇所で**必要な 1 部だけ**を保ちます：`postDiskIO` は既に structured clone を行い、受信側の `decodeEntry` は全フィールドを組み直し、直列化は読むだけなので、どこであれ手書きの deep copy を足せば「グループ数 × リスト長」をもう一度複製することになります。正式なリストの `blocklist` domain と統合すると、一方のファイル障害がもう一方の結果まで誤判定させます。

  receipt または supersession ごとに snapshot を更新し、起動時に正式な chat/blocklist 状態で filter して復元し、Worker 再構築後は全 pending entry を 1 回の outbox flush と mailbox barrier でまとめて replay します。

  write-ahead flush の待機中にも正式な cancel や trim は発生し得るため、post 前に再照合し、durable な内容がこれから送る message と一致するまで変更後の snapshot を再 flush しなければなりません。最終照合と同期 post の間に `await` を置いてはいけません。各 entry は作成時刻、確認済み失敗回数、直近の失敗分類も保持し、alert threshold 到達時は log を強化するだけで task を削除しません。

  診断 field（失敗回数・失敗分類）だけが変わったときに完全な snapshot を単独で queue してはいけません。1 回の replay では「落ち着かなかった」受領が N 件返り、1 件ごとに完全 snapshot を queue すれば全表の deep copy とファイル全体の fsync が O(n^2) 回——replay 経路自身が避けている形そのものです。

  これらの値は次の権威ある snapshot（完了受領、`/unblock`、担当外れ、新しい batch の write-ahead、Worker 再生成時の replay）が一緒に書き戻します。即座に永続化するのは **alert threshold をまたいだその 1 回だけ**で、「この batch は警告に値するほど失敗している」という判断自体を再起動後も残します。上限付き outbox は security task を黙って evict せず、超過分を拒否します。

#### 権限回復後の replay

- `can_restrict_members` の回復を正式に確認したら、その chat で権限により freeze された instant-kick / 広告 pending batch を元の `removalId` のまま先に全件 replay し、その後で現時点の full-list sweep を発行します。sweep receipt が決着できるのは自分の ID だけで、古い freeze outbox entry を消してはいけません。

  各 freeze batch は自分自身の `complete` receipt が届くまで残り、sweep failure で先に決着させてもいけません。

### 運勢と AI メモリの復元

- 運勢永続化の東京日付 owner を切り替える前に、前日の追加 buffer を正常に flush しなければなりません。失敗時は旧 owner を維持して日付切り替えを拒否します。対象日に確認済み結果がある場合、key の欠落または別日 key は不整合 backup であり、新しい key を黙って生成せず起動・日付切り替えを拒否します。
- AI メモリ復元は現在の `AI_MEMORY_HYDRATE_BUFFER_MAX` と `MAX_SUMMARY_ROUNDS` に従い、snapshot の末尾から最新データを残します。現在は逐語メッセージ 149 件と cold summary 7 round です。容量定数を変更してデプロイする前に、旧プロセスを停止し、同じ復元 logic で既存の `memory/ai/` をアトミックに書き換えます。旧プロセスの停止時 flush が migration 結果を上書きしないようにしてください。
- 返信チェーン index（`chatReplyChainIndexes`）は rolling memory から完全に導出する index で、永続化せず、内側の値は cache と同じ object reference を共有します。登録と削除は、メッセージが hot region に出入りする物理位置、すなわち `rollingMemory.ts` の push・rotation・hydrate でだけ行えます。ほかのモジュールは read-only です。

  そのため index は hot region に残るメッセージだけを常に対象とし、rolling cache 上限で制約され、独立 eviction はありません。Bot 自身が送ったテキストと画像の返信 edge は Telegram が返した実際の `reply_to_message` だけから記録します。生成中またはキュー待ちの間に対象が hot region から外れた場合は、round 開始前に取得した上限付き trigger snapshot を fallback に使い、index の範囲を拡張しません。

  モデルに見せる追跡深度、各 chain node の本文、trigger snapshot はそれぞれ `REPLY_CHAIN_MAX_DEPTH`、`REPLY_CHAIN_NODE_MAX_CHARS`、`REPLY_REFERENCE_MAX_CHARS` で制限され、現在は 15 hop、500 文字、500 文字です。

### 確認境界と停止

- Telegram update が確認境界を進められるのは、対応する middleware が完了した後だけです。Anti-Raid mailbox、リアクション・アバターの background owner、StateStore、AI Worker、Disk I/O Worker の flush はすべて明示的な上限付き drain を持ちます。重要な flush の失敗は必ず失敗を返し、最終 offset の確認を止め、非ゼロで終了します。

  **停止時に見捨てた update も同じ扱いです。** 停止信号が届いた後、取得ループは実行中の middleware を待ちません（宙吊りになり得るため、排出は lifecycle の上限付き `size()` ループに任せます）。したがって後から失敗した update は runner の明示的な印でしか表現できません。印は `handleUpdate` が throw するのと同じ同期区間で書かれるので、`size()` がゼロになった時点で必ず有効です。

  lifecycle は最終 offset を確認する前にこれを読み、立っていれば offset を確認せず非ゼロで終了して、再起動後に Telegram から再送させます。`task()` が正常に resolve したかだけで判断すると、一度も成功していない update をまとめて確認してしまいます。
- runner の各 `getUpdates` は `limit: 1` に固定し、現在の middleware が成功した後だけ、より高い offset の次 fetch を始めます。後の update が失敗しても、前の非冪等 side effect は独立した確認境界の内側ですでに確定しており、sibling として再配信されません。取得元が limit に反して複数 update を返した場合は、handler を 1 つも実行せず fail closed します。失敗後は次の update を fetch せず、offset も進めません。
- 最終 offset の `getUpdates(timeout: 0)` も network request です。`timeout: 0` が無効にするのは Telegram server 側の long polling だけで、DNS、connection、response read は制限しません。そのため `FINAL_OFFSET_CONFIRM_TIMEOUT_MS` の local `AbortSignal` も必須です。

  確認の reject・timeout、または runner / maintenance / persistence の前提が未完了で skip した場合、この lifecycle gate はプロセス終了まで失敗のまま保持し、非ゼロ終了として instance lock の clean release を止めます。後続の `dispose()` が同じ owner を 2 回目の wait で完了できても、この未確認を上書きしてはいけません。処理済み update がなければ API 呼び出しは不要で、gate は成功と扱います。
- Anti-Raid の mailbox barrier が保証するのは、それ以前の message が dispatcher に到達したことだけで、dispatcher が開始した Telegram network side effect の完了は待ちません。update の hot path はこの軽量境界を使い続けます。

  lifecycle drain は別の `drain` message を送り、Worker が登録した in-flight task set が空になるまで待ち、前後の mailbox barrier と persistence flush で上限付き fixed-point reconciliation を行います。通常 barrier の acknowledgement を network 完了と解釈してはいけません。

  chat ごとの blocklist removal epoch はその chat に in-flight removal task がある間だけ保持し、最後の task が settle した時または Worker stop 時に削除します。過去に無効化された chat を Map に永久蓄積してはいけません。
- Anti-Raid の shutdown drain は `inFlightAdDisposals` を最初に snapshot する前に、Worker へ `drain` を送り acknowledgement を受け取らなければなりません。Worker はその message の処理時に広告判定 ticker を同期的に quiesce します。

  同一 Worker port の FIFO により、それ以前に publish された `adDetected` は acknowledgement より先にメインスレッドへ登録済みであり、acknowledgement 後に戻る in-flight verdict は stopping gate によって新しい処置を publish できません。

  この安定境界の後でだけ、メインスレッドの広告処置、persistence flush、receipt barrier、そこから派生した Worker task を順に待ち、必要なら fixed-point reconciliation を続けます。`drainAntiRaid() === "flushed"` は `inFlightAdDisposals` が空であることを必ず含意し、最後の Worker drain 付近で登録された処置をラウンド外へ漏らしてはいけません。

  **前段の受領が取れなかった場合も、そのまま return してはいけません**。Worker が諦めたか再生成中だと `post()` は同期的に失敗し barrier は即 `failed` になりますが、メインスレッド側では処置が `confirmBlocklistPersisted` で止まっている可能性があります——そこはまさに「ブロックは投入済み、まだ書き込まれていない」窓です。そこで return すると書き込み待ちのブロックリストごと失われ、再起動後その送信者はリストに載っていません。

  したがって失敗経路でも残り予算で `inFlightAdDisposals` を 1 回は排出し（受領がない以上、安定した境界もないので、その 1 回はその時点で処理中のものだけを対象とするベストエフォートです）、そのうえで元の失敗理由を呼び出し側へ返します。この救済で戻り値を書き換えてはいけません。
- 実行中の各 Telegram update は cancellation signal を所有します。通常の drain deadline を過ぎると、停止処理は全 handler を abort し、上限付きの settle 時間を与えます。Telegram 呼び出しと正式な state write はその signal を監視しなければなりません。それでも settle しない handler は最終 offset の確認を止め、best-effort dispose 後の非ゼロ終了を強制します。
- 正常・異常停止のどちらでも、まずタイトル、リアクション、アバター、翻訳の入口を quiesce して runner を止め、その後に上限付き drain を行います。4 つの quiesce 呼び出しの失敗は個別に捕捉しなければなりません。1 つが例外を投げても残りを試行し、その回の失敗によって最終 offset の確認とインスタンスロック解放を止めます。後続の `wait()` または `dispose()` は、冪等な 4 つの入口を再試行できます。**「quiesce 済み」を cache してはなりません**——`init()` は同じ 4 つの owner を再武装するため、起動中の停止シグナルで成功を latch すると以降の quiesce がすべて短絡され、owner は停止処理の間ずっと仕事を受け付け続けるのに結果はクリーンだと報告されます。

  翻訳 client は最初の実要求でだけ遅延生成し、各 RPC にはプロジェクト共通の短い timeout を設け、drain 後に明示的な `close()` と project parent/client reference の削除を行います。翻訳 drain の timeout や close 失敗も、ほかの重要 owner と同様にインスタンスロック解放を妨げます。正常経路では最終 Telegram offset の確認前に AI、Disk I/O、StateStore を順番に flush しなければなりません。

  最終 dispose は「AI を flush → AI を終了 → Disk I/O を flush → Anti-Raid と Disk I/O を終了 → StateStore を flush」です。通常 dispose の進行中に fatal error が発生した場合、emergency 経路はその Promise を再利用できますが、既存 drain がプロセスを無期限に保持しないよう、現在の独立した絶対 15 秒の強制終了 deadline を設けます。

  予算超過時は実行中の Telegram 要求、メディア download、429 sleep を abort し、未開始キューを精算します。abort 後はメッセージ送信、アバター変更、グループタイトル書き込みを行いません。異常終了経路の maintenance 予算は 0 なので、各 drain は「予算 0」を正当な入力として扱わなければなりません。idle ならそのまま `flushed`、実行中の作業が残っていれば直ちに abort して `timedOut` として精算し、引数検証で例外を投げてはいけません。

  未完了のタイトル更新も、skip する際に必ず abort します。dispose の各 owner も個別に失敗隔離し、例外は `failed` として集計に参加させます。1 か所の throw が後続 owner、`flushStateToDisk`、インスタンスロックの処理を飛ばすことは許されません。
- lifecycle と Anti-Raid drain のプロセス内経過時間 budget は `packages/libs/monotonicDeadline.ts` が `performance.now()` を使って計算します。wall clock の巻き戻しで drain、cancellation settlement、shutdown の期限を延長してはいけません。業務状態、protocol deadline、永続化する絶対 timestamp はそれぞれの semantics に従って引き続き `Date.now()` を使います。
- Worker flush と mailbox barrier はすべて `packages/libs/flushBarrier.ts` を使い、ID、waiter table、timeout、遅延応答、crash 時の一括精算を管理します。ドメイン cache が resolver Map を再公開してはいけません。
- domain flush が成功へ読み替えられるのは、同じ確認済み flush request で別 domain だけが失敗した場合に限ります。古い global failure state や transport failure を成功へ変換してはいけません。instance lock の release も durability 境界であり、owner 検証または unlink の失敗は caller へ伝播し、lifecycle 上の lock-acquired 状態を維持し、非ゼロ終了を強制します。

### ファイル権限と schema

- project workspace 自体は editor や automation の協業に必要な permission を維持できますが、明示設定した独立 data root は機密データ境界です。起動時に `0750` 以下を強制し、group write とすべての `other` permission を禁止します。owner/group 設定と既存 directory の手動 migration は deployment tool が担い、runtime が暗黙に chmod してはいけません。
- `memory/` の成果物は一律 `0644` ですが、`other` bit は `other` が traverse できない親 data root 内に封じられます。機密性は data-root permission、deployment isolation、backup 方針で共同管理します。
- 永続化 schema は推測的な自動 migration を行いません。非互換入力は起動を止め、空状態が実データを上書きするのを防ぎます。

### ロックダウンミラーと終端フラグ

- lockdown の永続化ハンドシェイクで使う指紋は `phase` と `intentId` だけで構成します。この 2 つが 1 回の lockdown 意図の同一性そのものです。`expiresAt` を含めてはいけません。lockdown 発動中はしきい値を超える入室のたびに Worker が `lockdown` イベントを再送し、その `expiresAt` はその瞬間の実時計から計算されるため毎回変わります。

  含めてしまうと、メインスレッドの「保存してからもう一度同じ意図かを見る」照合ループが一致にたどり着かず、1 周ごとに `state.json` と LKG のファイル全体を fsync 付きで書き直します。入室がその 2 回の書き込みより速いとループは終わらず、指紋も永続化受領も一生生まれません。カウントダウン自体はミラーの `expiresAt` に残り、adopt はそこから残り時間を換算します。このループには保険として周回上限もあります。

  使い切ってもこのチャットのハンドシェイクが止まってエラーログが 1 行残るだけで、次の lockdown イベントで再び入ってきます。
- 現行の lockdown ミラーには `phase` と正の `intentId` が必要で、認証待ち active record には `phase` と `trackedMessageTimes` が必要です。reminder ID と `announcementMessageId` は業務上 optional のままで、欠落は reminder がまだ送信成功していないこと、あるいはこの record が入室アナウンスを観測しなかったことだけを表し、復元時にはそれぞれの再送・清掃経路を使います。

  それ以外の欠落・非互換 field は旧プロセス停止中に手動 migration し、production 読み取り経路に互換 logic を残しません。
- **終端 record の「告知済み」フラグはすべて snapshot に入れます**。`expelling` record は互いに代替できない 3 つを持ちます——`successNoticeSent`（成功戦報。30 秒後に自動削除）、`failureNoticeSent`（kick できない、`can_restrict_members` 不足）、`unconfirmedNoticeSent`（在室かどうか確認できなかった）。

  後ろ 2 つは自動削除されないため、永続化しないと Worker 再生成やプロセス再起動のたびに同じ相手について 1 通ずつ増え、グループに積み上がります。3 つを 1 枠にまとめることもできません。探索の一時失敗が先に送られると、BAN 権限不足を名指しする唯一の診断が永久に抑え込まれ、メンバーはグループに残ったまま管理者はネットワークの問題へ誘導されます。フラグを立てたら新しい revision を publish して書き込ませ、終端リトライはその revision の受領を待ちます。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## 互換エントリ

大きなファイルの分割後に残すトップレベル barrel は段階移行だけに使用します。新しい production コードは該当ドメインファイルから import してください。互換エントリは状態を所有せず、設定を解析せず、import 時の副作用を導入しません。

運勢レシートに旧形式の互換分岐は置きません。検証はレシートに埋め込まれた日付が当日の東京日付と一致することを要求し、日次鍵は毎日 0 時に切り替わるため、別の日のレシートは決して検証を通りません。旧形式のレシートは表示ラベル形式のリリース翌日から検証不能になっています。識別、除去、検証はいずれも現行形式だけを受け付けます（ラベル接頭辞 + 固定長 HMAC ダイジェスト + 同じ範囲の `text_link` 実体が運ぶ元レシート）。

---

<div align="center">

[← 前のページ：03 ディレクトリマップ](03-directory-map.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#04-実行時の正式な不変条件) · [次のページ：05 開発フロー →](05-dev-workflow.md)

</div>
