# 03 ディレクトリ構成とコード配置

<p align="center">
  <a href="../03-directory-map.md">简体中文</a> · <a href="../en/03-directory-map.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="README.md">📚 開発者ドキュメント TOP</a> · <a href="02-architecture.md">← 前のページ：02 アーキテクチャ</a> · <a href="04-invariants.md">次のページ：04 不変条件 →</a>
</p>

---

このページでは「このコードはどこにあるか」「新しいコードをどこに置くか」を説明します。引用符、引数数の上限、`import type` などのスタイル詳細は ESLint と [`AGENTS.md`](../../AGENTS.md) が規定するため、ここでは繰り返しません。

## ディレクトリの責務

| パス | 責務 | 代表的なファイル |
| :--- | :--- | :--- |
| `packages/app/` | 起動・終了ライフサイクル、有効な機能の起動時前提チェック、handler 登録、コマンドメニュー、update runner | `lifecycle.ts`、`featurePreflight.ts`、`registerHandlers.ts`、`updateRunner.ts` |
| `packages/commands/` | 明示的なコマンド処理。1 コマンド 1 ファイル。トグル系コマンドが共有する権限・設定ゲートは別ファイル | `copy.ts`、`block.ts`、`mute.ts`、`permission.ts`、`white.ts`、`targetResolution.ts`、`configGate.ts` |
| `packages/auto/` | コマンド以外の自動動作：copy、AI の文字起こしとトリガー、リアクション同期 | `message/`、`triggerPolicy.ts` |
| `packages/aiChat/` | AI chat のメインスレッド代理と model capability：Worker 監督、memory mirror、availability、Gemini、sticker、tool、media | `index.ts`、`memoryMirror.ts`、`availability.ts`、`ai/` |
| `packages/antiRaid/` | Anti-Raid のメインスレッド代理と広告 model capability：Worker 監督、durable handoff、update ingress、blocklist／verification／ad／flood orchestration | `index.ts`、`workerBridge.ts`、`durableDelivery.ts`、`updateIngress.ts`、`ai/` |
| `packages/copy/` | copy モードの変換、アバター・リアクション・翻訳の実行キュー、および日本語翻訳が「いま動いているか」の唯一の判定 | `copyModes.ts`、`avatarQueue.ts`、`reactionQueue.ts`、`translate.ts`、`availability.ts` |
| `packages/users/` | 送信者 identity キャッシュ、表示上の送信者判定、ユーザーラベル生成 | `senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts` |
| `packages/states/` | **I/O を行わない**純粋な状態遷移と受け入れ規則：認証、ロックダウン、AI 返信の受け入れ、広告検出の受け入れ | `verification.ts`、`lockdown.ts`、`replyAdmission.ts`、`adDetectAdmission.ts` |
| `packages/config/` | `config/*.json` の厳密な schema。allow/blocklist は起動時、その他は遅延読み込みし、機能単位の可用性も判定 | `whitelist.ts`、`blocklist.ts`、`stickers.ts`、`adSamples.ts`、`readiness.ts` |
| `packages/libs/` | ドメイン非依存の基盤：アトミックファイル、上限付き I/O、並行処理ツール | `flushBarrier.ts`、`linkedQueue.ts`、`text.ts` |
| `packages/workers/` | 3 つの Worker のスレッド内実装 | `aiChatWorker.ts` + `aiChat/`、`antiRaidWorker.ts` + `antiRaid/verification{Runtime,Events,Effects,Reminders}.ts` + `antiRaid/adDetect/` + `antiRaid/{floodControl,botPermissions}.ts`、`diskIOWorker.ts` + `diskIO/` |
| `packages/aiChat/ai/` / `packages/antiRaid/ai/` | model transport と capability を owner feature 配下に置き、thread と lifecycle の所有境界を明確化 | `gemini.ts`、`tools/replyToolset/`、`deepseek.ts` |
| `packages/workers/antiRaid/adDetect/` | 広告検出パイプライン（DeepSeek）：バッチキュー、送信者ごとのメッセージ束の整形、判定、命中時の処分 | `queue.ts`、`bundle.ts`、`classifier.ts`、`disposal.ts` |
| `packages/infra/` | Telegram クライアント、Worker ホスト、logger、環境変数設定 | `telegram/`、`config.ts`、`workerSupervisor.ts` |
| `packages/infra/blocklist/` | メインスレッド側ブロックリスト基盤。同期 membership、durable outbox、チャット掃除に分割し、`infra/blocklist.ts` は互換 export のみを残す | `membership.ts`、`outbox.ts`、`sweep.ts` |
| `packages/infra/storage/` | データルート事前検査、インスタンスロック、StateStore、起動時の清掃 | `dataRoot.ts`、`instanceLock.ts`、`stateStore.ts` |
| `packages/cache/` | プロセス内可変状態コンテナ。**第 1 階層のディレクトリが所有スレッドを表す** | `main/`、`workers/aiChat/`、`perThread/` |
| `packages/consts/` | リテラル定数と調整値をドメイン別に配置 | `commands.ts`、`aiChat/rateLimit.ts`、`antiRaid/` |
| `packages/types/` | モジュール間 protocol、ドメイン型、`types/states/` の状態機械 contract | `chatState.ts`、`lifecycle.ts` |
| `test/` | `packages/` と対応する Bun 単体テスト | `test/commands/copyShared.test.ts` |
| `scripts/` | リポジトリ自己検査スクリプト | `checkProjectConventions.ts` |

## 新しいコードの配置判断

次の順に判断します。

1. **リテラルなパラメータか？** → `packages/consts/<domain>.ts`。ドメインが大きければ `packages/consts/<domain>/` に分割します。用途と不変条件を説明する中国語 JSDoc を付けます。環境変数由来の設定だけは例外で、`packages/infra/config.ts` に置きます。
2. **モジュール間で共有する型または protocol か？** → `packages/types/<domain>.ts`。状態機械の `State/Event/Effect/Transition/Decision` contract は `packages/types/states/` に置きます。
3. **Map、Set、キュー、timer、singleton など長寿命の可変状態か？** → `packages/cache/`。**まず所有スレッドのディレクトリを選び**（下記参照）、その中でドメイン別にファイルを分けます。`export let` ではなく holder オブジェクトを使い、いつ格納し、いつ削除し、Worker 再起動後にどう再構築するかを JSDoc に記載します。容量と削除方針は [04 実行時の正式な不変条件](04-invariants.md) を満たす必要があります。
4. **I/O のない、単体テスト可能な純粋状態遷移か？** → `packages/states/`。副作用は Worker 側の interpreter が実行します。
5. **副作用または orchestration か？** → owner に従って配置します。コマンドは `packages/commands/`、自動動作は `packages/auto/`、Worker 内の処理は `packages/workers/<domain>/`、model capability は owner feature の `ai/` 子 directory、process 基盤は `packages/infra/` です。

過去のレビューで削除されたアンチパターンには、業務ファイル内で増殖するモジュールレベル Map、利用箇所に散在する定数、Disk I/O Worker を迂回して Worker が `fs` で共有ディレクトリへ直接書く処理があります。

## スレッド別に分けたキャッシュ

`packages/cache/` の第 1 階層は、その状態をどのスレッドが所有するかを宣言します。スレッド間はメッセージのみでやり取りしメモリを共有しないため、同じ cache モジュールを 2 つのスレッドが import すれば、それは互いに無関係な 2 つのインスタンスです。

| ディレクトリ | 所有者 | 内容 |
| :--- | :--- | :--- |
| `main/` | メインスレッド | コマンドと自動パイプラインの状態、`StateStore` のメモリミラー、Disk I/O ホスト、および **Worker のメインスレッド側プロキシとミラー**（`main/aiChat.ts`、`main/antiRaid/`） |
| `workers/aiChat/` | AI 雑談 Worker | ローリングメモリ、返信の受理判定、機嫌、ステッカーカタログとセット、Gemini クライアント |
| `workers/antiRaid/` | Anti-Raid Worker | 認証/ロックダウンの状態機械、連投ウィンドウ、広告検出キュー、DeepSeek クライアント |
| `workers/diskIO/` | Disk I/O Worker | 各ドメインの書き込みバッファと dirty マーカー |
| `perThread/` | 各スレッドに 1 つずつ | Telegram クライアント、デプロイ設定 singleton、自己送信メッセージ登録。同じモジュールを各スレッドが独立に実体化するもので、そもそも共有を意図していません |

`main/antiRaid/` と `workers/antiRaid/` は**何一つ共有しない別々の状態**である点に注意してください。正式な状態機械は Worker の中にあり、メインスレッド側はクラッシュ再生のための純粋なデータにすぎません。ディレクトリを間違えるのはスタイルの問題ではありません。書き込んだ内容が相手側から永遠に読めなくなります。`bun run check:conventions` が実際のモジュールグラフでこの所有関係を照合し（[04 実行時の正式な不変条件](04-invariants.md#スレッドと状態の帰属) を参照）、違反時は import 連鎖を全て出力します。

`packages/aiChat/ai/` のように複数スレッドで再利用されるドメインコードには注意が必要です。メインスレッドしか使わない純関数が Worker 専有のキャッシュと同じファイルにあると、メインスレッドがその関数を import しただけでキャッシュまで実体化されます。実例が [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts) です。メインスレッドのメッセージパイプラインが AI Worker のステッカーセットキャッシュに触れずにステッカー説明を組み立てられるよう、`sets.ts` から切り出しました。

## 互換エントリ（barrel）の規約

大きなファイルをサブモジュールへ分割した後、元ファイルは純粋な `export * from` 互換エントリにします。例：`packages/consts/aiChat/` に対する `packages/consts/aiChat.ts`。規則は次のとおりです。

- 互換エントリは古い import を段階移行するためだけに存在します。**新しいコードは必ずドメインのサブファイルから直接 import します。**
- 互換エントリは状態を所有せず、設定を解析せず、import 時の副作用を導入しません。
- `packages/types/index.ts` も同様で、テストと段階移行のためだけに残します。
- パッケージ内の `index.ts` は別物です。メインスレッド代理のようなモジュールでは入口そのものが実装であり（`packages/aiChat/index.ts`、`packages/antiRaid/index.ts`）、同じパッケージのサブモジュールと合わせて 1 つのパッケージを構成します。上記 3 条の対象外です。

## テストのミラー構造

`test/` は `packages/` のパスに対応します。`packages/workers/diskIO/verificationFiles.ts` を変更するなら `test/workers/diskIO/verificationFiles.test.ts` を使います。新規モジュールのテストも同じ構造で作成してください。共通テスト補助は `test/libs/helpers.ts` に置き、全体の分離方式は [05 開発フロー](05-dev-workflow.md#テスト分離) を参照してください。

---

<div align="center">

[← 前のページ：02 アーキテクチャ](02-architecture.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#03-ディレクトリ構成とコード配置) · [次のページ：04 不変条件 →](04-invariants.md)

</div>
