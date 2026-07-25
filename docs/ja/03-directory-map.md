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
| `src/app/` | 起動・終了ライフサイクル、handler 登録、コマンドメニュー、update runner | `lifecycle.ts`、`registerHandlers.ts`、`updateRunner.ts` |
| `src/commands/` | 明示的なコマンド処理。1 コマンド 1 ファイル | `copy.ts`、`kick.ts`、`send.ts`、`targetResolution.ts` |
| `src/auto/` | コマンド以外の自動動作：copy、AI の文字起こしとトリガー、リアクション同期 | `message/`、`triggerPolicy.ts` |
| `src/aiChat/` | メインスレッド側 AI チャット代理：Worker 監督の入口とメモリミラー | `index.ts`、`memoryMirror.ts` |
| `src/antiRaid/` | メインスレッド側 Anti-Raid 代理：Worker 監督の入口、ロックダウン復旧、認証待ちミラー受信 | `index.ts`、`lockdownMirror.ts`、`verificationMirror.ts` |
| `src/copy/` | copy モードの変換と、アバター・リアクション・翻訳の実行キュー | `copyModes.ts`、`avatarQueue.ts`、`reactionQueue.ts`、`translate.ts` |
| `src/users/` | 送信者 identity キャッシュ、表示上の送信者判定、ユーザーラベル生成 | `senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts` |
| `src/states/` | **I/O を行わない**認証、ロックダウン、返信受け入れの純粋な状態遷移 | `verification.ts`、`lockdown.ts` |
| `src/config/` | `config/*.json` の厳密な schema、遅延読み込み、起動時検証 | `stickers.ts`、`reactions.ts`、`mood.ts` |
| `src/libs/` | ドメイン非依存の基盤：アトミックファイル、上限付き I/O、並行処理ツール | `flushBarrier.ts`、`linkedQueue.ts`、`text.ts` |
| `src/workers/` | 3 つの Worker のスレッド内実装 | `aiChatWorker.ts` + `aiChat/`、`antiRaidWorker.ts` + `antiRaid/verification{Runtime,Events,Effects,Reminders}.ts`、`diskIOWorker.ts` + `diskIO/` |
| `src/ai/` | Gemini クライアント、画像説明、画像生成、スタンプカタログ、ツール実装 | `gemini.ts`、`tools/replyToolset/`、`imageGeneration.ts` |
| `src/infra/` | Telegram クライアント、Worker ホスト、logger、環境変数設定 | `telegram/`、`config.ts`、`workerSupervisor.ts` |
| `src/infra/storage/` | データルート事前検査、インスタンスロック、StateStore、起動時の清掃 | `dataRoot.ts`、`instanceLock.ts`、`stateStore.ts` |
| `src/cache/` | ドメイン別のプロセス内可変状態コンテナ | `aiChat/`、`copy/`、`senderIdentity.ts` |
| `src/consts/` | リテラル定数と調整値をドメイン別に配置 | `commands.ts`、`aiChat/rateLimit.ts`、`antiRaid/` |
| `src/types/` | モジュール間 protocol、ドメイン型、`types/states/` の状態機械 contract | `chatState.ts`、`lifecycle.ts` |
| `test/` | `src/` と対応する Bun 単体テスト | `test/commands/copyShared.test.ts` |
| `scripts/` | リポジトリ自己検査スクリプト | `checkProjectConventions.ts` |

## 新しいコードの配置判断

次の順に判断します。

1. **リテラルなパラメータか？** → `src/consts/<domain>.ts`。ドメインが大きければ `src/consts/<domain>/` に分割します。用途と不変条件を説明する中国語 JSDoc を付けます。環境変数由来の設定だけは例外で、`src/infra/config.ts` に置きます。
2. **モジュール間で共有する型または protocol か？** → `src/types/<domain>.ts`。状態機械の `State/Event/Effect/Transition/Decision` contract は `src/types/states/` に置きます。
3. **Map、Set、キュー、timer、singleton など長寿命の可変状態か？** → `src/cache/<domain>/`。`export let` ではなく holder オブジェクトを使い、いつ格納し、いつ削除し、Worker 再起動後にどう再構築するかを JSDoc に記載します。容量と削除方針は [04 実行時の正式な不変条件](04-invariants.md) を満たす必要があります。
4. **I/O のない、単体テスト可能な純粋状態遷移か？** → `src/states/`。副作用は Worker 側の interpreter が実行します。
5. **副作用または orchestration か？** → owner に従って配置します。コマンドは `src/commands/`、自動動作は `src/auto/`、Worker 内の処理は `src/workers/<domain>/`、AI 能力は `src/ai/`、プロセス基盤は `src/infra/` です。

過去のレビューで削除されたアンチパターンには、業務ファイル内で増殖するモジュールレベル Map、利用箇所に散在する定数、Disk I/O Worker を迂回して Worker が `fs` で共有ディレクトリへ直接書く処理があります。

## 互換エントリ（barrel）の規約

大きなファイルをサブモジュールへ分割した後、元ファイルは純粋な `export * from` 互換エントリにします。例：`src/consts/aiChat/` に対する `src/consts/aiChat.ts`。規則は次のとおりです。

- 互換エントリは古い import を段階移行するためだけに存在します。**新しいコードは必ずドメインのサブファイルから直接 import します。**
- 互換エントリは状態を所有せず、設定を解析せず、import 時の副作用を導入しません。
- `src/types/index.ts` も同様で、テストと段階移行のためだけに残します。
- パッケージ内の `index.ts` は別物です。メインスレッド代理のようなモジュールでは入口そのものが実装であり（`src/aiChat/index.ts`、`src/antiRaid/index.ts`）、同じパッケージのサブモジュールと合わせて 1 つのパッケージを構成します。上記 3 条の対象外です。

## テストのミラー構造

`test/` は `src/` のパスに対応します。`src/workers/diskIO/verificationFiles.ts` を変更するなら `test/workers/diskIO/verificationFiles.test.ts` を使います。新規モジュールのテストも同じ構造で作成してください。共通テスト補助は `test/libs/helpers.ts` に置き、全体の分離方式は [05 開発フロー](05-dev-workflow.md#テスト分離) を参照してください。

---

<div align="center">

[← 前のページ：02 アーキテクチャ](02-architecture.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#03-ディレクトリ構成とコード配置) · [次のページ：04 不変条件 →](04-invariants.md)

</div>
