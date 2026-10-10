# 03 ディレクトリ構成とコード配置

<p align="center">
  <a href="../cn/03-directory-map.md">简体中文</a> · <a href="../en/03-directory-map.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="02-architecture.md">← 前のページ：02 アーキテクチャ</a> · <a href="04-invariants.md">次のページ：04 不変条件 →</a>
</p>

---

このドキュメントでは、「どの機能のコードがどこにあるか」「新しいコードをどこに配置すべきか」を整理します。コーディングスタイルや引数の上限数、`import type` などの詳細ルールは ESLint および [`AGENTS.md`](../../AGENTS.md) で定義されているため、ここでは配置と責務に焦点を当てます。

## ディレクトリの責務

- **`LICENSES/`**
  - **内容**：プロジェクトの MIT [`LICENSE`](../../LICENSES/LICENSE)、漢字異体字データの [`Unicode-3.0.txt`](../../LICENSES/Unicode-3.0.txt)、および Opus 音声エンコード関連の [`audio-encode-opus-MIT.txt`](../../LICENSES/audio-encode-opus-MIT.txt) と [`libopus-BSD.txt`](../../LICENSES/libopus-BSD.txt)。
- **`packages/app/`**
  - **責務**：起動・停止ライフサイクル、既存デプロイ設定の起動時バリデーション、`config/` ホットリロードの監視と伝播、ハンドラー登録、コマンドメニュー初期化、update runner、各種ライフサイクルの依存注入（composition）。
  - **代表ファイル**：`lifecycle.ts`、`lifecycle/`（`maintenance.ts`、`shutdown.ts`）、`lifecycleDependencies.ts`、`configReload.ts`、`registerHandlers.ts`、`updateRunner.ts` / `updateFetcher.ts`。`ApplicationLifecycleDependencies` は composition オブジェクトから型推論して同階層に配置。
- **`packages/commands/`**
  - **責務**：明示的なコマンドハンドラーを機能単位で集約。同一コマンドのサブコマンドはその内部で分岐。トグル系コマンドで共有される権限・設定ゲートは共通モジュールに分離。
  - **代表ファイル**：`copy.ts`、`icon.ts`、`mood.ts`、`qa.ts`、`block.ts`、`hImage.ts` と `hImage/`（抽選・追加）、`info.ts`、`deferredCommands.ts`（`/h_image`、`/info`、`/send` の非同期音声合成、`/batch_kick`、`/block enable` の横断 BAN で共用される遅延コマンドエグゼキューター）、`blocklistFanOut.ts`（全グループ横断 BAN のファンアウト）、`mute.ts`、`batchKick.ts`、`targetResolution.ts`、`configGate.ts`、`arguments.ts`。インラインおみくじ機能も同様に `luckChallenge/`（`cache.ts`、`draw.ts`、`key.ts`、`rateLimit.ts`、`receipt.ts`、`rendering.ts`、`telegramAdapter.ts`。`index.ts` は薄い公開ファサード）に分割。規模の大きい gag 機能はコマンド受付を `gag.ts` に残し、ライフサイクル、インライン、純粋描画を `gag/runtime.ts`、`gag/inline.ts`、`gag/rendering.ts` に分離。
- **`packages/auto/`**
  - **責務**：リピート、AI トリガーおよび文字起こし、リアクション同期など、明示的なスラッシュコマンド以外の自動応答パイプライン。
  - **代表ファイル**：`message/`（発火ポリシーの `triggerPolicy.ts` を含む）、`reactionSync.ts`。
- **`packages/aiChat/`**
  - **責務**：メインスレッド側の AI 会話プロキシおよびモデル機能の抽象化。Worker 監視、メモリミラー、起動時・ホットリロード時のステート投入、利用可能判定、プロバイダ実装（`gemini/`、`openai/`、`anthropic/`）のルーティング、スタンプ、ツール、メディア処理。
  - **代表ファイル**：`workerBridge.ts`、`hydration.ts`、`messageIngress.ts`、`botImages.ts`（Bot 自身の送信画像のプレースホルダー自己記録）、`voiceSynthesis.ts`（`/send` や cron からの音声合成ジョブ待機・解決）、`webDigest.ts`（cron による Web ダイジェスト生成待機・解決）、`memoryMirror.ts`、`stickerMirror.ts`（スタンプ目録スナップショットのメインスレッドミラー）、`workerJob.ts`（AI Worker へのキャンセル可能ジョブ発行基盤）、`availability.ts`、`provider.ts`（機能ごとのプロバイダファサード）、`providerLanes.ts`（プロトコル・エンドポイント別のクォータレーン管理）、`capabilityClient.ts`（共通クライアント基盤）、`gemini/`、`openai/`、`anthropic/`、`ai/`。`index.ts` は薄い公開エクスポートのみ提供。
- **`packages/antiRaid/`**
  - **責務**：メインスレッド側の Anti-Raid プロキシ。Worker 監視、確実なメッセージ配信（durable delivery）、update 受付、広告候補の収集・判定・処分、ブラックリスト／認証／スパム（flood）防御のオーケストレーション。
  - **代表ファイル**：`workerBridge/`（`controller.ts`、`events.ts`、`observers.ts`、`replay.ts`）、`durableDelivery.ts`、`updateIngress.ts`、`adCandidate.ts`、`adDetect.ts`。`index.ts` は薄い公開エクスポートのみ提供。
- **`packages/cron/`**
  - **責務**：`cron.json` による定期タスクのメインスレッドスケジューリング（Bun ネイティブ cron、1 回限り実行、ランダム間隔の再スケジュール）、タスクの順次実行と再試行、単一 Telegram 送信境界へのディスパッチ。
  - **代表ファイル**：`scheduler.ts`、`run.ts`、`delivery.ts`、`targets.ts`（`chat_id: ["all"]` や `["except", ...]` の権限検証）。設定パーサーは `packages/config/cron.ts`、実行時状態は `packages/cache/main/cron.ts`。
- **`packages/copy/`**
  - **責務**：メッセージリピート、テキスト変換、アバター同期キュー。
  - **代表ファイル**：`echo.ts`、`copyModes.ts`、`avatarQueue.ts`。
- **`packages/translate/`**
  - **責務**：グループ別翻訳セッション、状態復元、正規表現による言語判定、Google Cloud 翻訳クライアントの遅延初期化。
  - **代表ファイル**：`state.ts`、`recovery.ts`、`message.ts`、`language.ts`、`client.ts`。
- **`packages/users/`**
  - **責務**：送信者身元キャッシュ、表示用送信者判定、ユーザーラベル生成、名簿・広告判定が共用するメタデータ・メッセージ内容・発信元解決。
  - **代表ファイル**：`senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts`、`identityMetadata.ts`、`messageContent.ts`、`messageOrigin.ts`。
- **`packages/states/`**
  - **責務**：**I/O を一切行わない**純粋な状態遷移ロジック。参加認証、ロックダウン、AI 返信受付、広告判定受付、一時広告バイパスのルールセット。
  - **代表ファイル**：`verification.ts` と `verification/`（`join` / `pending` / `terminal` / `disable` フェーズ、永続化スナップショットから状態を再構築する `adopt.ts`）、`lockdown.ts` と `lockdown/`（`apply` / `persistence` / `restore` / `announcement` / `adopt` フェーズ）、`replyAdmission.ts`、`adDetectAdmission.ts`、`temporaryAdBypass.ts`。
- **`packages/config/`**
  - **責務**：デプロイ設定 `config/{static,dynamic}/*.json` の厳格なスキーマ検証、プロセススナップショット作成、ホットリロード判定、機能ごとの readiness（利用可能）判定。ID ポリシーの永続化データは扱いません。
  - **代表ファイル**：`bot.ts`、`botInput.ts`、`layout.ts`、`agent.ts`、`agentCapability.ts`、`assets.ts`、`cron.ts`、`mood.ts`、`stickers.ts`、`adSamples.ts`、`googleAuth.ts`、`readiness.ts`、`reload.ts`。
- **`packages/database/`**
  - **責務**：共有 SQLite（identity ポリシーとグループ状態）のスキーマ定義、codec、行バリデーション、Drizzle 接続境界。ランタイムハンドルは Disk I/O Worker のみが排他的に所有。
  - **代表ディレクトリ・ファイル**：`schema/`（`migrations/` を含む）、`codec/identity.ts`、`codec/chatState.ts`、`codec/chatQa.ts`、`codec/temporaryAdBypass.ts`、`interact/`（`connection.ts`、`transaction.ts`、`identityPolicy.ts`、`chatState.ts`、`chatQa.ts`、`temporaryAdBypass.ts`、`aiContext.ts`、`migration.ts`、`initialization.ts`、`inspection.ts`）、`validation/storageRows.ts`。
- **`packages/libs/`**
  - **責務**：アトミックファイル操作、有界キュー、並行制御など、ドメインに依存しない共通ユーティリティ群。
  - **代表ファイル**：`flushBarrier.ts`、`linkedQueue.ts`、`acknowledgedBatchQueue.ts`、`boundedResponse.ts`、`boundedSettledBatch.ts`、`monotonicDeadline.ts`、`text.ts`、`errorMessage.ts`（catch した `unknown` を文面または Error に正規化する唯一の境界）、`telegramMarkdown.ts`（Telegram MarkdownV2 エスケープの唯一の境界）、`webDigest.ts` と `webDigestMarkdown.ts`（Web ダイジェスト JSON のデコードと MarkdownV2 整形）、`webDigestUrls.ts`（ダイジェスト用 URL 許可リスト）、`workerRequestTable.ts`（メインスレッドから Worker へのリクエスト管理テーブル：リクエスト ID、待機プロミス、タイムアウト、キャンセル、Worker 異常終了時の解決）。
- **`packages/workers/`**
  - **責務**：3 つの Worker スレッド内部の実装ロジック。
  - **代表ファイル**：`aiChatWorker.ts`、`antiRaidWorker.ts`、`diskIOWorker.ts`、`businessWorkerPort.ts`（業務 Worker 共通のスレッド通信ポート：Telegram プロキシ、双方向出站、受信ルーティング）、`aiChat/`、`antiRaid/verificationEffects/`、`diskIO/storageDatabase.ts` と `diskIO/storageDatabase/`、`diskIO/verification{Codec,Recovery,Writes}.ts`。
- **`packages/aiChat/ai/`**
  - **責務**：各機能に帰属するモデルとツールの実装。
  - **代表ファイル**：`tools/replyToolset/`、`tools/webSearch.ts`（`web_search` 関数ツールのエグゼキューター）、`webDigest.ts`（cron ダイジェスト生成）、`utils/`、`stickers/`、`voiceSynthesis.ts`（音声合成の実装）、`ttsUsage.ts`（音声合成の日次利用カウント）。各モデルベンダーの直接通信はここではなく、`packages/aiChat/{gemini,openai,anthropic}/` に配置。
- **`packages/workers/antiRaid/adDetect/`**
  - **責務**：プロバイダルーティングされる広告判定パイプライン。バッチキュー、送信者ごとのメッセージバンドル、分類判定、命中時の処分実行。
  - **代表ファイル**：`queue.ts`、`queueState.ts`、`verdict.ts`（判定と処分のオーケストレーション）、`bundle.ts`、`classifier.ts`、`disposal.ts`、`config.ts`（メインスレッドからの設定スナップショット受信）、`ai/`（`provider.ts` が設定に応じて `google.ts`、`openai.ts`、`anthropic.ts` のいずれかを選択）。
- **`packages/infra/`**
  - **責務**：メインスレッド側の唯一の Telegram クライアントと送信ゲート、Worker 監視ホスト、ロガー、メインスレッド I/O プロキシ、画像ライブラリ・ファイル管理。
  - **代表ディレクトリ・ファイル**：
    - `telegram/`（`telegram/avatar/`、`telegram/actions/` を含む）
    - `diskIO.ts` と `diskIO/`（`businessWrite.ts`、`diagnosticChannel.ts`、`fatal.ts`、`host.ts`、`observers.ts`、`recovery.ts`、`requests.ts`、`storageAdmission.ts`、`transport.ts`）
    - `identityStorage.ts` と `identityStorage/`（`read.ts`、`shared.ts`、`sweep.ts`、`write.ts`）
    - `logger.ts` と `logger/`（`forwarding.ts`、`redaction.ts`、`serialization.ts`）
    - `supervisedWorker.ts`、`workerSupervisor.ts`
    - `aiCacheUsage.ts`（Prompt キャッシュ消費量集計）
    - `geminiContextCache.ts`（Gemini コンテキストキャッシュ再利用ロジック）
    - `randomImage.ts`、`mediaGroups.ts`
    - `telegram/fileDownload.ts`、`telegram/commandPhotos.ts`、`commandExecutor.ts`
- **`packages/infra/identityPolicy/`**
  - **責務**：ホワイトリスト権限、一時広告免除、ブラックリスト排他制御を司るメインスレッド側の読み取り境界。
  - **代表ファイル**：`whitelist.ts`、`temporaryAdBypass.ts`、`coordination.ts`。
- **`packages/infra/blocklist/`**
  - **責務**：メインスレッド側ブラックリスト基盤。身元判定、同期メンバーシップ、durable outbox、グループ定期クリーンアップ、退会アカウント検知。
  - **代表ファイル**：`membership.ts`、`outbox.ts`、`participantInvalid.ts`、`sweep.ts`、`sweepEligibility.ts`、`sweepReplay.ts`、`sweepRetryState.ts`、`sweepScheduler.ts`。
- **`packages/infra/storage/`**
  - **責務**：データルート事前検査、インスタンス排他ロック、業務ステートファサード、`memory/global/state.json` 永続化境界（データルート直下の旧 `state.json` の拒否を含む）、起動時クリーンアップ。
  - **代表ファイル**：`dataRoot.ts`、`instanceLock.ts`、`stateStore.ts`、`statePersistence.ts`、`cleanup.ts`。`stateStore.ts` は業務メモリとスナップショット、`statePersistence.ts` は厳格デコード、最新値専用書き込み、リトライ、flush を担当。
- **`packages/cache/`**
  - **責務**：プロセス内可変状態コンテナ。**第 1 階層のディレクトリが状態を所有するスレッドを明示**。
  - **代表ディレクトリ**：`main/`、`workers/aiChat/`、`workers/antiRaid/`、`workers/diskIO/`、`perThread/`。
- **`packages/consts/`**
  - **責務**：リテラル定数、設定しきい値、UI メッセージ文字列テーブルをドメイン別に集約。
  - **代表ファイル**：`atmosphere/{teasing,plain}/`、`commands.ts`、`whitelist.ts`、`aiChat/rateLimit.ts`、`antiRaid/`、`diskIO/`。
- **`packages/types/`**
  - **責務**：モジュール間インターフェース型、ドメイン型、`types/states/` のステートマシン契約型。
  - **代表ファイル**：`chatState.ts`、`commands.ts`、`lifecycle.ts`、`diskIO/`（`messages.ts`、`replies.ts`）。
- **`test/`**
  - **責務**：`packages/` と 1 対 1 で対応する Bun 単体テストスイート。
  - **代表ファイル**：`test/commands/copyShared.test.ts`。
- **`scripts/`**
  - **責務**：リポジトリ自己検査、ビルド・リリース、性能ベンチマーク、インストーラー、停止中専用のデータマイグレーション。
  - **自己検査・ゲート**：`checkProjectConventions.ts` と `conventions/`、`checkCoverageMetrics.ts` と `coverageSummary.ts`、`checkInstallScriptSyntax.ts`、`checkInstallIsolation.ts` と `installIsolation/`。
  - **ビルド・リリース**：`build.ts`、`binary.ts`（バイナリエントリ）、`checkBinary.ts`、`checkBinaryMigrations.ts`、`release.ts` と `release/`。
  - **性能ベンチマーク**：`perf/identityDatabase.ts`、`perf/joinLog.ts`、`perf/hotPaths.ts`、`perf/hotPathProfileGate.ts`、`perf/hotPaths/gateResult.ts`（`performance-result.json` のゲートセクション厳格パース）、`perf/performanceResult.ts`（同ファイルの共有書き込み境界。各ベンチマークは自身のセクションのみを更新）、リリース時専用の全量ベンチマーク `perf/fullSuite.ts` と `perf/fullSuite/`、ならびにベンチマーク間で共用される `fixtures/copyTree.ts`（ディレクトリツリー複製）と `fixtures/pathBoundary.ts`（書き込みパス境界検証）。
  - **インストーラー**：`install.sh` は対象ワークツリーを特定し、そのバージョンのインストーラーへ処理を委譲。`scripts/install/` 配下の shell モジュール群は構文と可読性を一括確認した上で順次ロード。`installSources.ts` は構文検証および分離テスト用フィクスチャへ同一のモジュールリストを提供。
  - **コールドマイグレーション**：`migrateChatPersonaRemoval.ts` はバージョン 16.3.2 が出力した停止時バックアップ（移行元スキーマ `CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION`）のみを受け付け、データベースの複製を現行スキーマ（`IDENTITY_DATABASE_SCHEMA_VERSION`）へ移行し、`chat_states.ai_persona` と `isCanConfigAiPrompt` を削除して `Asia/Tokyo` タイムゾーンマーカーを書き込みます。移行元ディレクトリは読み取り専用で保護され、`ready.json` が完了マーカーとなります。`migrations/files.ts` と `migrations/cli.ts` はパス判定や引数パースを共通化しており、起動依存グラフには含まれません。
  - **ファイルハッシュ計算**：`fileSha256.ts` は `Bun.file(path).stream()` と `Bun.CryptoHasher` を用いて SHA-256 16進ハッシュをストリーミング計算し、リリース検証、マイグレーション、テスト用フィクスチャで共用されます。

`scripts/migrations/active.ts` は、ビルド・配布物検証・規約検査で共通利用される有効なマイグレーション一覧です。バイナリ配布版にもこの一覧に含まれる CLI が内包されており、`BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/<エントリ>.js` の形式で実行できます。配置と運用手順は [07 運用手順](07-operations.md) を参照してください。

`botInput.ts` はインストーラーとランタイムが共用する厳格な設定ファイル読み込みエントリであり、モジュール import 時にはディスクの読み込みやキャッシュへの格納を行いません。`bot.ts` は実行時スナップショットを管理し、読み込み前に `layout.ts` で `config/static/` と `config/dynamic/` のディレクトリ構造を検査します。`libs/inflight.ts` は実行中タスクの有界待機ロジックを共通化し、受付・キャンセル・タイムアウトのポリシーは各ドメイン owner が個別に管理します。`infra/backgroundTasks.ts` はバックグラウンドタスクのエラーログ記録と完了後の自動解放を担当します。グループ単位の各種機能トグルコマンドは、`commands/superAdminToggle.ts` の認証、設定ゲート、状態更新、永続化、メッセージ応答の実行シーケンスを共用します。

`commands/wed.ts` は wed 機能のステートマシン、`wed/dispatch.ts` はコマンド受付、`wed/chats.ts` はグループごとのキャッシュ管理・LRU 追放・セッション掃除、`wed/members.ts` はメンバー増減イベントの監視、`wed/runtime.ts` は有界実行器とアプリケーションライフサイクルの橋渡しを担当し、`wed/rendering.ts` が結果画像の純粋描画ロジックを担います。操作ステートと実行器ハンドルは `cache/main/wed.ts`、各グループの長期メンバー集合および変更通知ウィンドウは `cache/main/wedMembers.ts` に配置されます。`wed/persistence.ts` は起動時の引き継ぎ（adopt）、バッチ保存、Worker 再構築時のリプレイを統括します。`workers/diskIO/wedMemberFiles.ts` はファイルの厳格検証とアトミック置換を実行し、書き込み待ちスナップショットは `cache/workers/diskIO/wed.ts` が排他的に保持します。アバター画像の取得と出力は `infra/telegram/` を再利用します。

`wed/memberReview.ts` は Disk I/O Worker の深夜メンテナンス通知を受け取り、Bot の初期化完了後に登録グループの全メンバーを順次再確認します。起動時の受付状態、進捗カウンタ、照会対象は `cache/main/wedMemberReview.ts` が保持します。再確認タスクは既存の wed ランタイムに登録され、停止時はキャンセル後にドレインされます。退会メンバーの削除と永続化は `wed/persistence.ts` を再利用します。

## 新しいコードの配置判断

新しいロジックを追加する際は、以下の優先順で配置場所を決定します：

1. **リテラル定数、しきい値、またはユーザー向け表示文言か？** → `packages/consts/<domain>.ts`（規模が大きい場合は `packages/consts/<domain>/`）。用途と不変条件を説明する中国語 JSDoc を付与します。コマンドの返信テキストはハンドラー内に直接記述せず、必ずコマンド固有の定数テーブルに定義してください。設定 JSON の解析スキーマは `packages/config/<domain>.ts` に配置し、環境変数の読み込みは `packages/consts/paths.ts` の実行時パス解決のみに限定します。
2. **モジュール間で共有される型定義またはプロトコルか？** → `packages/types/<domain>.ts`。ステートマシンの `State/Event/Effect/Transition/Decision` 契約型は `packages/types/states/` に配置します。
3. **Map、Set、AsyncLocalStorage、キュー、タイマー、シングルトンなど長期生存する可変状態か？** → `packages/cache/`。**必ずその状態を所有するスレッドのディレクトリを選択し**（後述）、ドメインごとにファイルを分割します。`export let` による直接公開は禁止し、holder オブジェクト（`{ current: T | null }`）を使用します。JSDoc には格納・破棄の契機、Worker 再起動時の再構築手順を明記してください。保持件数とクリーンアップポリシーは [04 実行時の正式な不変条件](04-invariants.md) の制約を満たす必要があります。
4. **I/O を伴わない、単体テスト可能な純粋状態遷移ロジックか？** → `packages/states/`。副作用の実行は Worker 側のインタープリターに委譲します。
5. **副作用を伴う実行処理またはオーケストレーションか？** → 責務の所有者に応じて配置します。ユーザーコマンドは `packages/commands/`、自動応答は `packages/auto/`、Worker 内部のロジックは `packages/workers/<domain>/`、モデル機能は該当ドメインの `ai/` サブディレクトリ、インフラ共通基盤は `packages/infra/` に配置します。

モジュールレベルで安易にグローバル Map を宣言すること、定数を呼び出し側のコード内に散在させること、Disk I/O Worker を迂回して Worker が `fs` で共有ディレクトリに直接書き込むことは厳禁です。

## スレッド別に分けたキャッシュ

`packages/cache/` の第 1 階層ディレクトリは、その状態を排他的に所有するスレッドを表します。スレッド間はシリアライズされたメッセージ通信のみを行いメモリを共有しないため、同じキャッシュモジュールを 2 つのスレッドが import した場合、それぞれ独立した無関係な別インスタンスが生成されます。

- **`main/`**
  - **所有スレッド**：メインスレッド。
  - **管理内容**：コマンドおよび自動パイプラインの実行状態、`stateStore.ts` ファサードが管理するグローバル `memory/global/state.json` ミラー、`assets.ts` の `config/dynamic/assets.json` アセットスナップショット、`chatState.ts` の `chat_states` インメモリキャッシュ（`Map`、最大 `STATE_MANAGED_CHAT_LIMIT` グループ。グループ別翻訳セッションを含む）、Disk I/O ホスト、および **各 Worker のメインスレッド側プロキシ・ミラー**（`main/aiChat.ts`、`main/antiRaid/`）。
- **`workers/aiChat/`**
  - **所有スレッド**：AI 会話 Worker。
  - **管理内容**：ローリング会話メモリ、返信受付判定カウンタ、Bot 送信画像への返信時に使用する画像説明補完タスク、感情ステート、スタンプ目録とセット情報、メインスレッドから委託された進行中の音声合成・ダイジェスト生成ジョブ、音声合成の日次利用枠、および各モデルプロバイダのクライアントシングルトン。
- **`workers/antiRaid/`**
  - **所有スレッド**：Anti-Raid Worker。
  - **管理内容**：参加認証およびロックダウンのステートマシン、スパム検知用スライディングウィンドウ、広告判定キュー、各広告検出クライアント。
- **`workers/diskIO/`**
  - **所有スレッド**：Disk I/O Worker。
  - **管理内容**：ドメインごとの書き込みバッファ、インデックス、dirty フラグ、期限切れの定期フラッシュをまとめるコレクション（`timedFlush.ts`）。
- **`perThread/`**
  - **所有スレッド**：スレッドごとに独立して 1 つずつ生成。
  - **管理内容**：Telegram クライアントホルダー（メインスレッドの実体アダプタ、または Worker 側の双方向プロキシ）、Worker 応答待機テーブル、デプロイ設定シングルトン、自己送信メッセージ記録、update キャンセルコンテキスト、Prompt キャッシュ使用量の集計先。各スレッドが独立してインスタンス化し、スレッド間の共有は意図していません。

`main/antiRaid/` と `workers/antiRaid/` は**メモリを共有しない全く別の状態**である点に十分留意してください。公式なステートマシンは Worker 内にのみ存在し、メインスレッド側が保持する情報はクラッシュ復旧用のバックアップデータにすぎません。配置ディレクトリを誤ると、片方のスレッドで更新した値がもう一方のスレッドから永久に読み取れなくなります。このスレッド帰属規則は `bun run check:conventions` によって実際のモジュール依存グラフに基づき自動検証されます（詳細は [04 実行時の正式な不変条件](04-invariants.md#スレッドと状態の帰属) を参照）。違反があった場合は関連する import チェーンがすべて報告されます。

`packages/aiChat/ai/` のように複数スレッドから再利用されるドメインコードでは、キャッシュの混入に細心の注意が必要です。メインスレッドからしか呼ばれない純粋関数が Worker 専有のキャッシュと同じファイルに定義されていると、メインスレッドがその関数を import しただけで意図しないキャッシュが実体化してしまいます。代表例が [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts) です。メインスレッドのメッセージ処理は純粋な説明関数のみを利用し、`sets.ts` が管理するスタンプセットキャッシュは AI Worker のみが専有します。

## 互換エントリ（barrel）の規約

肥大化したファイルを複数のサブモジュールに分割した際、移行元のファイルは状態を持たない薄い互換 export エントリとして残すことができます（例：`packages/infra/telegram/actions/` に対する `packages/infra/telegram/actions.ts`、`packages/workers/diskIO/storageDatabase/` に対する `packages/workers/diskIO/storageDatabase.ts`）。その際の運用規則は以下のとおりです：

- 互換エントリは、既存の import を段階的に移行するためにのみ存在します。**新規コードを作成する際は、必ず対象ドメインの具体的なサブファイルを直接 import してください。**
- 互換エントリ自体が可変状態を保持したり、設定ファイルをパースしたり、モジュール import 時に副作用を発生させてはなりません。
- パッケージ直下の `index.ts` は、外部の呼び出し元が真に単一の公開 API サーフェスを必要とする場合にのみ配置します。現行の `packages/aiChat/index.ts`、`packages/antiRaid/index.ts`、`packages/infra/telegram/index.ts` は薄い明示的エクスポートのみで構成され、内部状態を持ちません。`infra/telegram/index.ts` は既存の業務モジュールが使用する client、通常アクション、コマンド受領シンボルのみを再エクスポートしており、新しいコードは `client`、`actions/*`、`commandMessages` などの末端モジュールを直接 import します。aiChat および antiRaid のプロダクション内部は各 owner の末端モジュールを直接 import しており、いずれの公開エントリも無制限な `export *` は行いません。

## テストのミラー構造

`test/` ディレクトリは原則として `packages/` の階層構造と 1 対 1 で対応させます。ただし、密接に関連するサブドメイン群は 1 つのドメインテストファイルに集約できます。たとえば `packages/workers/diskIO/` 配下の `verificationCodec.ts`、`verificationRecovery.ts`、`verificationWrites.ts` は、`test/workers/diskIO/verificationFiles.test.ts` でまとめて検証します。それ以外の新規モジュールの単体テストは、本番コードと同じディレクトリ階層に作成してください。ドメイン横断で利用されるテストダブル、フィクスチャ、テストハーネスは `test/helpers/` に、ドメイン非依存の汎用ヘルパーは `test/helpers/common.ts` に配置します。テスト環境の分離メカニズムについては [05 開発フロー](05-dev-workflow.md#テスト分離) を参照してください。

---

<div align="center">

[← 前のページ：02 アーキテクチャ](02-architecture.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#03-ディレクトリ構成とコード配置) · [次のページ：04 不変条件 →](04-invariants.md)

</div>
