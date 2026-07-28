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
| `packages/app/` | 起動・終了ライフサイクル、handler 登録、コマンドメニュー、update runner | `lifecycle.ts`、`registerHandlers.ts`、`updateRunner.ts` |
| `packages/commands/` | 明示的なコマンド処理。1 コマンド 1 ファイル | `copy.ts`、`block.ts`、`cjkAction.ts`、`send.ts`、`targetResolution.ts` |
| `packages/auto/` | コマンド以外の自動動作：copy、AI の文字起こしとトリガー、リアクション同期 | `message/`、`triggerPolicy.ts` |
| `packages/aiChat/` | メインスレッド側 AI チャット代理：Worker 監督の入口とメモリミラー | `index.ts`、`memoryMirror.ts` |
| `packages/antiRaid/` | メインスレッド側 Anti-Raid 代理：Worker 監督の入口、ロックダウン復旧、認証待ちミラー受信、ブロックリストの入室判定、広告判定の送出と処分 | `index.ts`、`lockdownMirror.ts`、`verificationMirror.ts`、`blocklistGuard.ts`、`adDetect.ts`、`memberFacts.ts` |
| `packages/copy/` | copy モードの変換と、アバター・リアクション・翻訳の実行キュー | `copyModes.ts`、`avatarQueue.ts`、`reactionQueue.ts`、`translate.ts` |
| `packages/users/` | 送信者 identity キャッシュ、表示上の送信者判定、ユーザーラベル生成 | `senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts` |
| `packages/states/` | **I/O を行わない**認証、ロックダウン、返信受け入れの純粋な状態遷移 | `verification.ts`、`lockdown.ts` |
| `packages/config/` | `config/*.json` の厳密な schema、遅延読み込み、起動時検証 | `stickers.ts`、`reactions.ts`、`mood.ts`、`adSamples.ts` |
| `packages/libs/` | ドメイン非依存の基盤：アトミックファイル、上限付き I/O、並行処理ツール | `flushBarrier.ts`、`linkedQueue.ts`、`text.ts` |
| `packages/workers/` | 3 つの Worker のスレッド内実装 | `aiChatWorker.ts` + `aiChat/`、`antiRaidWorker.ts` + `antiRaid/verification{Runtime,Events,Effects,Reminders}.ts` + `antiRaid/adDetect/`、`diskIOWorker.ts` + `diskIO/` |
| `packages/ai/` | 各モデルの送受信入口と AI 機能：Gemini クライアント、DeepSeek クライアント、画像説明、画像生成、スタンプカタログ、ツール実装 | `gemini.ts`、`deepseek.ts`、`tools/replyToolset/`、`imageGeneration.ts` |
| `packages/workers/antiRaid/adDetect/` | 広告検出パイプライン（DeepSeek）：バッチキュー、判定、命中時の処分 | `queue.ts`、`classifier.ts`、`disposal.ts` |
| `packages/infra/` | Telegram クライアント、Worker ホスト、logger、環境変数設定 | `telegram/`、`config.ts`、`workerSupervisor.ts` |
| `packages/infra/storage/` | データルート事前検査、インスタンスロック、StateStore、起動時の清掃 | `dataRoot.ts`、`instanceLock.ts`、`stateStore.ts` |
| `packages/cache/` | ドメイン別のプロセス内可変状態コンテナ | `aiChat/`、`copy/`、`senderIdentity.ts` |
| `packages/consts/` | リテラル定数と調整値をドメイン別に配置 | `commands.ts`、`aiChat/rateLimit.ts`、`antiRaid/` |
| `packages/types/` | モジュール間 protocol、ドメイン型、`types/states/` の状態機械 contract | `chatState.ts`、`lifecycle.ts` |
| `test/` | `packages/` と対応する Bun 単体テスト | `test/commands/copyShared.test.ts` |
| `scripts/` | リポジトリ自己検査スクリプト | `checkProjectConventions.ts` |

## 新しいコードの配置判断

次の順に判断します。

1. **リテラルなパラメータか？** → `packages/consts/<domain>.ts`。ドメインが大きければ `packages/consts/<domain>/` に分割します。用途と不変条件を説明する中国語 JSDoc を付けます。環境変数由来の設定だけは例外で、`packages/infra/config.ts` に置きます。
2. **モジュール間で共有する型または protocol か？** → `packages/types/<domain>.ts`。状態機械の `State/Event/Effect/Transition/Decision` contract は `packages/types/states/` に置きます。
3. **Map、Set、キュー、timer、singleton など長寿命の可変状態か？** → `packages/cache/<domain>/`。`export let` ではなく holder オブジェクトを使い、いつ格納し、いつ削除し、Worker 再起動後にどう再構築するかを JSDoc に記載します。容量と削除方針は [04 実行時の正式な不変条件](04-invariants.md) を満たす必要があります。
4. **I/O のない、単体テスト可能な純粋状態遷移か？** → `packages/states/`。副作用は Worker 側の interpreter が実行します。
5. **副作用または orchestration か？** → owner に従って配置します。コマンドは `packages/commands/`、自動動作は `packages/auto/`、Worker 内の処理は `packages/workers/<domain>/`、AI 能力は `packages/ai/`、プロセス基盤は `packages/infra/` です。

過去のレビューで削除されたアンチパターンには、業務ファイル内で増殖するモジュールレベル Map、利用箇所に散在する定数、Disk I/O Worker を迂回して Worker が `fs` で共有ディレクトリへ直接書く処理があります。

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
