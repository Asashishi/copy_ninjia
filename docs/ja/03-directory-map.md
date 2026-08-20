# 03 ディレクトリ構成とコード配置

<p align="center">
  <a href="../cn/03-directory-map.md">简体中文</a> · <a href="../en/03-directory-map.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="conntent-table.md">📚 開発者ドキュメント TOP</a> · <a href="02-architecture.md">← 前のページ：02 アーキテクチャ</a> · <a href="04-invariants.md">次のページ：04 不変条件 →</a>
</p>

---

このページでは「このコードはどこにあるか」「新しいコードをどこに置くか」を説明します。引用符、引数数の上限、`import type` などのスタイル詳細は ESLint と [`AGENTS.md`](../../AGENTS.md) が規定するため、ここでは繰り返しません。

## ディレクトリの責務

- **`packages/app/`**
  - **責務**：起動・終了ライフサイクル、すでに存在するデプロイ入力の起動時検証入口、handler
    登録、コマンドメニュー、update runner、ライフサイクル副作用の composition。
  - **代表的なファイル**：`lifecycle.ts`、`lifecycleDependencies.ts`、`featurePreflight.ts`、
    `registerHandlers.ts`、`updateRunner.ts`。`ApplicationLifecycleDependencies` は composition object
    から推論して同じ場所に置き、共有型レイヤーから `app/` への逆依存を避けます。
- **`packages/commands/`**
  - **責務**：明示的なコマンド処理。1 コマンド 1 ファイル。トグル系コマンドが
    共有する権限・設定ゲートは別ファイル。
  - **代表的なファイル**：`copy.ts`、`block.ts`、`mute.ts`、`batchKick.ts`、
    `targetResolution.ts`、`configGate.ts`。規模の大きい gag domain は command admission を
    `gag.ts` に残し、lifecycle、inline、純粋 rendering を `gag/runtime.ts`、
    `gag/inline.ts`、`gag/rendering.ts` に分割します。
- **`packages/auto/`**
  - **責務**：copy、AI の文字起こしとトリガー、リアクション同期など、
    コマンド以外の自動動作。
  - **代表的なファイル**：`message/`、`triggerPolicy.ts`。
- **`packages/aiChat/`**
  - **責務**：AI chat のメインスレッド代理と model capability。Worker 監督、
    memory mirror、availability、provider 実装パッケージ（`gemini/`、`openai/`）と選択、sticker、tool、media を含む。
  - **代表的なファイル**：`workerBridge.ts`、`messageIngress.ts`、`memoryMirror.ts`、
    `availability.ts`、`provider.ts`、`gemini/`、`openai/`、`ai/`。
    `index.ts` は薄い公開入口だけを提供。
- **`packages/antiRaid/`**
  - **責務**：Anti-Raid のメインスレッド代理と広告 model capability。Worker 監督、
    durable handoff、update ingress、blocklist／verification／ad／flood orchestration。
  - **代表的なファイル**：`workerBridge.ts`、`durableDelivery.ts`、`updateIngress.ts`、
    `adCandidate.ts`、`ai/`。`index.ts` は薄い公開入口だけを提供。
- **`packages/copy/`**
  - **責務**：copy モード変換、アバター・リアクション・翻訳の実行キュー、
    および日本語翻訳が「いま動いているか」の唯一の判定。
  - **代表的なファイル**：`copyModes.ts`、`avatarQueue.ts`、`reactionQueue.ts`、
    `translate.ts`、`availability.ts`。
- **`packages/users/`**
  - **責務**：送信者 identity キャッシュ、表示上の送信者判定、ユーザーラベル生成。
  - **代表的なファイル**：`senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts`。
- **`packages/states/`**
  - **責務**：**I/O を行わない**純粋な状態遷移と、認証・ロックダウン・AI 返信・
    広告検出の受け入れ規則。
  - **代表的なファイル**：`verification.ts` と `verification/`（`join`/`pending`/`terminal`/`disable` の 4 区分）、`lockdown.ts`、`replyAdmission.ts`、
    `adDetectAdmission.ts`。
- **`packages/config/`**
  - **責務**：deployment `config/*.json` の厳密 schema と process snapshot、feature 単位の readiness 判定。identity policy はここに置きません。
  - **代表的なファイル**：`telegram.ts`、`agent.ts`、`stickers.ts`、`adSamples.ts`、`readiness.ts`。
- **`packages/database/`**
  - **責務**：共有 SQLite（identity policy と chat state）の schema、codec、行検証、Drizzle interaction boundary。runtime handle は Disk I/O Worker だけが owner です。
  - **代表的な path**：`schema/`（`migrations/` を含む）、`codec/identity.ts`、`codec/chatState.ts`、`interact/`（`connection.ts`、`transaction.ts`、`identityPolicy.ts`、`chatState.ts`、`migration.ts`、`inspection.ts`）、`validation/storageRows.ts`。
- **`packages/libs/`**
  - **責務**：アトミックファイル、上限付き I/O、並行処理ツールなど、
    ドメイン非依存の基盤。
  - **代表的なファイル**：`flushBarrier.ts`、`linkedQueue.ts`、`acknowledgedBatchQueue.ts`、
    `boundedSettledBatch.ts`、`monotonicDeadline.ts`、`text.ts`。
- **`packages/workers/`**
  - **責務**：3 つの Worker のスレッド内実装。
  - **代表的なファイル**：`aiChatWorker.ts`、`antiRaidWorker.ts`、`diskIOWorker.ts`、
    `aiChat/`、`antiRaid/verificationEffects/`、`diskIO/storageDatabase.ts` と `diskIO/storageDatabase/`、`diskIO/verification{Codec,Recovery,Writes}.ts`。
- **`packages/aiChat/ai/` / `packages/antiRaid/ai/`**
  - **責務**：model transport と capability を owner feature 配下に置き、
    thread と lifecycle の所有境界を明確化。
  - **代表的なファイル**：`tools/replyToolset/`、`utils/`、`provider.ts`。AI chat の
    model 送受信はここではなく、vendor ごとの `packages/aiChat/{gemini,openai}/` にあります。
- **`packages/workers/antiRaid/adDetect/`**
  - **責務**：provider routed 広告検出パイプライン。バッチキュー、送信者ごとの
    メッセージ束の整形、判定、命中時の処分を含む。
  - **代表的なファイル**：`queue.ts`、`bundle.ts`、`classifier.ts`、`disposal.ts`。
- **`packages/infra/`**
  - **責務**：main thread 唯一の Telegram client と outbound gate、duplex Worker host、
    logger、メインスレッド側 I/O proxy。
  - **代表的なファイル**：`telegram/`、`diskIO.ts`、`identityStorage.ts`、
    `supervisedWorker.ts`、`workerSupervisor.ts`。
- **`packages/infra/blocklist/`**
  - **責務**：メインスレッド側ブロックリスト基盤。identity 判定、同期 membership、
    durable outbox、チャット掃除に分割。
  - **代表的なファイル**：`membership.ts`、`outbox.ts`、`sweep.ts`、`sweepScheduler.ts`。
- **`packages/infra/storage/`**
  - **責務**：データルート事前検査、インスタンスロック、業務 state facade、注入可能な `state.json` 永続化境界、起動時の清掃。
  - **代表的なファイル**：`dataRoot.ts`、`instanceLock.ts`、`stateStore.ts`、`statePersistence.ts`。
    前者は業務メモリと snapshot、後者は厳密 decode、latest-only write、retry、flush を担当します。
- **`packages/cache/`**
  - **責務**：プロセス内可変状態コンテナ。**第 1 階層のディレクトリが
    所有スレッドを表す**。
  - **代表的なディレクトリ**：`main/`、`workers/aiChat/`、`workers/antiRaid/`、
    `workers/diskIO/`、`perThread/`。
- **`packages/consts/`**
  - **責務**：リテラル定数、調整値、ユーザーに見える文言テーブルをドメイン別に配置。
  - **代表的なファイル**：`commands.ts`、`aiChat/rateLimit.ts`、`antiRaid/`。
- **`packages/types/`**
  - **責務**：モジュール間 protocol、ドメイン型、`types/states/` の状態機械 contract。
  - **代表的なファイル**：`chatState.ts`、`commands.ts`、`lifecycle.ts`、`diskIO.ts`。
- **`test/`**
  - **責務**：`packages/` と対応する Bun 単体テスト。
  - **代表的なファイル**：`test/commands/copyShared.test.ts`。
- **`scripts/`**
  - **責務**：リポジトリ自己検査、性能 benchmark、停止中だけ実行する明示 data migration。
  - **代表的なファイル**：`checkProjectConventions.ts` と `conventions/`、`migrateIdentityStorageToSqlite.ts`、`migrateChatStateToSqlite.ts`、`storageDatabaseIntegrity.ts`、`perf/identityDatabase.ts`、`perf/joinLog.ts`、`perf/hotPaths.ts`、`perf/hotPathProfileGate.ts`、およびリリース時のみ実行する全量 benchmark の `perf/fullSuite.ts` と `perf/fullSuite/`。

## 新しいコードの配置判断

次の順に判断します。

1. **リテラルなパラメータ、またはユーザーに見える文言か？** → `packages/consts/<domain>.ts`。ドメインが大きければ `packages/consts/<domain>/` に分割します。用途と不変条件を説明する中国語 JSDoc を付けます。コマンドの応答や提示は handler 内で組み立てず、コマンドごとの文言テーブルに収めます。deployment JSON の解析と検証は `packages/config/<domain>.ts` に置き、process environment は `packages/consts/paths.ts` の runtime path override だけが読みます。
2. **モジュール間で共有する型または protocol か？** → `packages/types/<domain>.ts`。状態機械の `State/Event/Effect/Transition/Decision` contract は `packages/types/states/` に置きます。
3. **Map、Set、キュー、timer、singleton など長寿命の可変状態か？** → `packages/cache/`。**まず所有スレッドのディレクトリを選び**（下記参照）、その中でドメイン別にファイルを分けます。`export let` ではなく holder オブジェクトを使い、いつ格納し、いつ削除し、Worker 再起動後にどう再構築するかを JSDoc に記載します。容量と削除方針は [04 実行時の正式な不変条件](04-invariants.md) を満たす必要があります。
4. **I/O のない、単体テスト可能な純粋状態遷移か？** → `packages/states/`。副作用は Worker 側の interpreter が実行します。
5. **副作用または orchestration か？** → owner に従って配置します。コマンドは `packages/commands/`、自動動作は `packages/auto/`、Worker 内の処理は `packages/workers/<domain>/`、model capability は owner feature の `ai/` 子 directory、process 基盤は `packages/infra/` です。

過去のレビューで削除されたアンチパターンには、業務ファイル内で増殖するモジュールレベル Map、利用箇所に散在する定数、Disk I/O Worker を迂回して Worker が `fs` で共有ディレクトリへ直接書く処理があります。

## スレッド別に分けたキャッシュ

`packages/cache/` の第 1 階層は、その状態をどのスレッドが所有するかを宣言します。スレッド間はメッセージのみでやり取りしメモリを共有しないため、同じ cache モジュールを 2 つのスレッドが import すれば、それは互いに無関係な 2 つのインスタンスです。

- **`main/`**
  - **所有者**：メインスレッド。
  - **内容**：コマンドと自動パイプラインの状態、`stateStore.ts` facade が管理するグローバル `state.json` ミラーと `chatState.ts` の `chat_states` LRU（容量 25）、
    Disk I/O ホスト、および **Worker のメインスレッド側プロキシとミラー**
    （`main/aiChat.ts`、`main/antiRaid/`）。
- **`workers/aiChat/`**
  - **所有者**：AI 雑談 Worker。
  - **内容**：ローリングメモリ、返信の受理判定、機嫌、ステッカーカタログとセット、
    両 provider のクライアント singleton。
- **`workers/antiRaid/`**
  - **所有者**：Anti-Raid Worker。
  - **内容**：認証/ロックダウンの状態機械、連投ウィンドウ、広告検出キュー、
    Google/OpenAI 広告検出クライアント。
- **`workers/diskIO/`**
  - **所有者**：Disk I/O Worker。
  - **内容**：各ドメインの書き込みバッファ、index、dirty マーカー。
- **`perThread/`**
  - **所有者**：各スレッドに 1 つずつ。
  - **内容**：Telegram capability holder（main thread の実 adapter または Worker の duplex proxy）、
    Worker duplex waiter、デプロイ設定 singleton、自己送信メッセージ登録。同じモジュールを
    各スレッドが独立に実体化し、共有を意図しません。

`main/antiRaid/` と `workers/antiRaid/` は**何一つ共有しない別々の状態**である点に注意してください。正式な状態機械は Worker の中にあり、メインスレッド側はクラッシュ再生のための純粋なデータにすぎません。ディレクトリを間違えるのはスタイルの問題ではありません。書き込んだ内容が相手側から永遠に読めなくなります。`bun run check:conventions` が実際のモジュールグラフでこの所有関係を照合し（[04 実行時の正式な不変条件](04-invariants.md#スレッドと状態の帰属) を参照）、違反時は import 連鎖を全て出力します。

`packages/aiChat/ai/` のように複数スレッドで再利用されるドメインコードには注意が必要です。メインスレッドしか使わない純関数が Worker 専有のキャッシュと同じファイルにあると、メインスレッドがその関数を import しただけでキャッシュまで実体化されます。実例が [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts) です。メインスレッドのメッセージパイプラインが AI Worker のステッカーセットキャッシュに触れずにステッカー説明を組み立てられるよう、`sets.ts` から切り出しました。

## 互換エントリ（barrel）の規約

大きなファイルをサブモジュールへ分割した後、元ファイルは状態を持たない薄い互換 export 入口にできます。例：`packages/infra/telegram/actions/` に対する `packages/infra/telegram/actions.ts`、または分割した認証ファイル domain に対する `verificationFiles.ts`。規則は次のとおりです。

- 互換エントリは古い import を段階移行するためだけに存在します。**新しいコードは必ずドメインのサブファイルから直接 import します。**
- 互換エントリは状態を所有せず、設定を解析せず、import 時の副作用を導入しません。
- `packages/types/index.ts` も同様で、テストと段階移行のためだけに残します。
- パッケージ内の `index.ts` は、呼び出し側が単一 package surface を本当に必要とする場合だけ安定した公開入口にします。現在の `packages/aiChat/index.ts` と `packages/antiRaid/index.ts` は薄い明示的 export のみで、状態を所有しません。production 内部は引き続き owner の leaf module を直接 import し、無制限な `export *` surface を避けます。

## テストのミラー構造

`test/` は原則として `packages/` のパスに対応しますが、同じ分割 domain は domain-level test を共有できます。たとえば `packages/workers/diskIO/verificationCodec.ts`、`verificationRecovery.ts`、`verificationWrites.ts` は `test/workers/diskIO/verificationFiles.test.ts` でまとめて検証します。それ以外の新規モジュールのテストは同じ directory structure で作成してください。共通テスト補助は `test/libs/helpers.ts` に置き、全体の分離方式は [05 開発フロー](05-dev-workflow.md#テスト分離) を参照してください。

---

<div align="center">

[← 前のページ：02 アーキテクチャ](02-architecture.md) · [📚 開発者ドキュメント TOP](conntent-table.md) · [⬆️ トップへ戻る](#03-ディレクトリ構成とコード配置) · [次のページ：04 不変条件 →](04-invariants.md)

</div>
