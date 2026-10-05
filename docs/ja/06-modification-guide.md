# 06 よくある変更手順

<p align="center">
  <a href="../cn/06-modification-guide.md">简体中文</a> · <a href="../en/06-modification-guide.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="05-dev-workflow.md">← 前のページ：05 開発フロー</a> · <a href="07-operations.md">次のページ：07 運用マニュアル →</a>
</p>

---

各レシピでは変更対象のファイルと実装手順を示します。

> [!IMPORTANT]
> **共通の前提条件**：
> - 変更前に [`AGENTS.md`](../../AGENTS.md) を一読すること。
> - デプロイ設定や実際の実行時データを変更する前、または本番データへ書き込む可能性がある本番エントリーポイントを実行する前に、対象ファイルをバックアップします。通常のソース変更と独立した一時データルートでのテストにはデプロイのバックアップ手順は適用しません。
> - コミット前に `bun run lint && bun run typecheck` または完全な `bun run check` を実行します。`master` へのマージ前には `bun run check` の合格が必須です。ドキュメント、README、指標はユーザーが明示的に依頼した場合にのみ更新します。

---

## 並行 batch の追加

- **決定論的セトルメント**：固定かつ相互に依存しない Promise は `Promise.allSettled` ですべての完了を待ち、各 rejection を個別に処理します。**セトルメントをエラーの握りつぶしに使うことは固く禁止**します。
- **動的入力の流量制御**：入力規模が動的に増加する可能性がある場合は、[`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts) を再利用し、明示的な並行ハード上限を設けたうえで、返却される `item/index` から失敗した identity を記録します。入力全体をあらかじめ `map` して一括 Promise 化することは禁止します。
- **有限バックオフ**：ドメインが一時的エラーを識別できる場合にのみ、そのドメインの owner 内で有限バックオフを設定し、エラー種別を限定して各バックオフを記録します。`runBoundedSettledBatch` は各項目を 1 回だけ実行し、再試行は担いません。下位レイヤーですでに再試行されているロジックを重複して重ねてはならず、非冪等な副作用を再試行することは厳禁です。
- **Drain 待機**：登録済みタスクの drain を待つためだけのスナップショット取得であれば、タスクプールの導入は不要です。ただし、スナップショット自体が新規タスクを開始せず、各タスクにエラー隔離が組み込まれていることが前提です。

---

## スラッシュコマンドの追加

1. **Handler の実装**：
   - `packages/commands/` から明示的な戻り値型を持つ `handleXxxCommand` をエクスポート。
   - 権限検証：権限キーによる認可は `rejectUnlessPermitted(ctx, key, rejection)` を使用。スーパー管理者専用の操作は `rejectUnlessSuperAdmin(ctx, rejection)` を使用（`commands/commandActor.ts` を参照）。
   - 文案体系：固定メッセージとフォーマッター関数は `packages/consts/atmosphere/{teasing,plain}/` の対応ドメインファイルに配置し、両バージョンで同一の型定義を使用。メインスレッドは `chatAtmosphere()` により現在のスタイルの文案を読み込みます。
2. **モジュールのエクスポート**：`packages/commands/index.ts` に追加。
3. **コマンドの登録**：
   - [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts) の `commands` サブチェーンに `commands.command("xxx", ...)` を追加。
   - **`bot` へ直接登録することは厳禁**：コマンドはすべて前置チェーンの `:entities:bot_command` ゲートの後ろにある子 Composer に登録します（`app/registerHandlers.ts`）。登録位置は init ゲート、グループ別直列化、プライベートチャットゲート、参加認証ミドルウェアの後方に位置し、これら先行セキュリティ境界を自動的に継承します。
4. **プライベートチャットゲート設定**：コマンドをプライベートチャットでも許可する場合は、[`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) を同期調整する必要があります。現在、プライベートチャットコマンドは `/send` のみが明示的に許可されています。グループ専用コマンドの場合は変更不要です。
5. **メニュー設定**：`packages/consts/atmosphere/{teasing,plain}/commands.ts` の両方の `BOT_COMMANDS` にコマンド説明を追加。
6. **パラメータ定数**：クールダウン、しきい値などの定数は `packages/consts/commands.ts` または対応する `packages/consts/<domain>.ts` に配置し、中国語 JSDoc を付与。
7. **自動テスト**：`test/commands/xxx.test.ts` を作成し、少なくとも権限拒否、引数解析、主要実行パスを検証。
8. **ドキュメント更新**：3 言語の `docs/{cn,en,ja}/09-commands.md` のコマンド表にエントリと権限境界を記載。

### 非 ASCII のコマンド名

`/咬` や `/贴贴` などの漢字アクションコマンド（アクション語は 1〜2 文字の漢字）は、[`cjkAction.ts`](../../packages/commands/cjkAction.ts) の専用実装パスを参照します：

- **`bot.hears` によるマッチング**：Telegram は ASCII コマンドに対してのみ `bot_command` エンティティを生成します。漢字コマンドはメッセージ本文に対して `hears(正規表現, ...)` でマッチングさせ、`cjkActions` サブ Composer 上（`^\/` で始まる）に登録し、通常メッセージのフォールバックより前に配置します。
- **独立したターゲット解決**：`resolveCommandTarget` に `ResolveCommandTargetParams` を直接渡します。一致しない形式は `next()` で通過させ、update を握りつぶしてはなりません。
- **`message.text` のみ受け付け**：画像付きメッセージはこのパスを通さないようにし、ビジョンパイプラインや AI 記憶の迂回を防ぎます。
- **先行パイプラインの補完**：自動パイプラインより前に登録されるため、`isBotOwnMessage` を自ら呼び出して Bot 自身のメッセージを除外し、ユーザー名キャッシュへ発信者を自ら記録する必要があります。
- **明示的な保持セマンティクス**：アクション成功の結果は長期保持されるため、`sendCommandMessage` の呼び出し時に `preserveInGroup: true` を明示します。引数検証失敗などは 30 秒自動削除のままです。
- **メニューとプレースホルダー**：Telegram のコマンドメニューは ASCII のみを受け付けます。メニュー内では ASCII プレースホルダー `/x` を用いて構文を示し、通常メッセージへのフォールバックを防ぐための空ハンドラーを登録します。
- **グローバルスライディングウィンドウ制限**：漢字アクションコマンドにはメニューの制約がないため、スライディングウィンドウによるレート制限（例: 90 秒間に 450 回、`libs/slidingWindowRateLimit.ts` を再利用）を併用する必要があります。

---

## 応答にリンクや書式を付ける

リッチテキストとプレーンテキストの二者択一です（`entities` と `parseMode` は型レベルで排他、[`packages/infra/telegram/actions.ts`](../../packages/infra/telegram/actions.ts) を参照）：

- **MarkdownV2 モード**：
  - `sendMessage` または `sendCommandMessage` に `parseMode: MARKDOWN_V2_PARSE_MODE` を指定。
  - 本文は**すべて** [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) を経由してエスケープおよび構築（通常テキストは `escapeMarkdownV2`、太字/コードブロック/リンクなどは対応する組み立て関数を呼び出し）。
  - 動的ニックネーム、モデル出力、固定文案を**エスケープを経ずに直接文字列結合することは厳禁**です。予約文字が 1 つでもエスケープ漏れすると、メッセージ全体が拒否されます。
  - 単体テストでは `test/helpers/markdownV2.ts` の参照パーサーを用いてパース結果を検証します。
- **Entities 明示指定**：
  - 呼び出し側がテキストをセグメントごとに組み立て、`entities` の UTF-16 code unit オフセットを計算。
  - サロゲートペア文字（emoji など）は 2 単位を占めます。長さ 0 のエンティティはメッセージ全体の拒否につながります。

---

## 別の言語にする：i18n はやらないので fork してください

ユーザーに見える固定文案はすべて簡体中国語であり、`packages/consts/atmosphere/` でメスガキ風と通常版を提供しています。

- 文案テーブルは固定文字列とフォーマッター関数を保持し、Telegram entities オフセットは最終レンダリングテキストから計算します。
- `/咬` などのアクションコマンドの解析文案と表示文案は個別に管理します。
- AI ペルソナはデフォルトで `packages/consts/aiChat/prompts/persona.ts` を使用し、`prompt/persona.md` が存在する場合はカスタムファイルを採用します。
- `send_voice` のツール説明はデフォルトで `agent.tts.bot_language` に応じて `packages/consts/aiChat/prompts/tools.ts` の `VOICE_LANGUAGE_PROMPTS` を使用し、`prompt/voice_tool.md` が存在する場合はカスタムファイルを採用します。
- 他言語をサポートしたい場合は、リポジトリを自ら fork し、上記の文案モジュールと設定を完全に差し替えることを推奨します。

---

## 動作パラメータの調整

すべての業務パラメータは `packages/consts/` に集約されており、パラメータの変更に伴う業務ロジックの修正は不要です：

| 調整対象 | 対象ファイル |
| :--- | :--- |
| AI トリガー確率、レート制限、並列数、キュー | `packages/consts/aiChat/rateLimit.ts` |
| AI メモリ容量、スナップショット周期、要約バックプレッシャー | `packages/consts/aiChat/memory.ts` |
| メディア解説長、実行スロット、LRU 容量 | `packages/consts/aiChat/media.ts` |
| 画像生成クールダウンとバイト上限 | `packages/consts/aiChat/imageGeneration.ts` |
| ムード持続時間とスイッチタイムアウト | `packages/consts/aiChat/mood.ts` |
| ツールアクション/クエリ上限、タイピングと誤字テンポ | `packages/consts/aiChat/tools.ts` |
| 音声文字起こしの長さ/サイズ上限とプレースホルダー文案 | `packages/consts/aiChat/voice.ts` |
| 音声ツールのターン上限、セリフ/口調長、1 日の利用枠 | `packages/consts/aiChat/voiceMessage.ts` |
| リクエストタイムアウト、再試行回数、サンプリングと安全設定 | `packages/consts/aiChat/gemini.ts`、`packages/consts/aiChat/openai.ts` |
| **モデル名、provider、key、エンドポイント** | **定数ではありません**：`config/dynamic/agent.json` で能力ごとに設定 |
| OAI 互換画像プロトコル / サイズプロファイル | `config/dynamic/agent.json` の `agent.image.image_protocol` |
| 認証ウィンドウ、連投しきい値、追記/コンパクション方針 | `packages/consts/antiRaid/` |
| リピートクールダウン、/quiet 範囲、アクションコマンドレート制限 | `packages/consts/commands.ts` |
| ランダムトリガーの発言者クールダウン | `packages/consts/auto.ts` |

**変更フロー**：定数を変更 → 対応する中国語 JSDoc を更新 → コミット前ゲートを実行。ユーザーから文書更新の明示的な依頼がある場合に、README の関連箇所を同期します。`master` へのマージ前に `bun run check` を実行します。

> [!WARNING]
> **容量関連定数はディスクデータと結合している場合があります**：
> `AI_MEMORY_HYDRATE_BUFFER_MAX` や `MAX_SUMMARY_ROUNDS` などの定数を小さくする前に、[04 実行時の正式な不変条件](04-invariants.md#永続化) の仕様に従って停止状態で SQLite トランザクション経由で既存の `chat_states.ai_context` スナップショットを書き換える必要があります。そうしない場合、新バージョン起動時に旧フォーマットデータが拒否されます。

---

## provider の任意能力を追加する

能力契約は 6 つの独立した最小インターフェース（`AiTextProvider`、`AiSummaryProvider`、`AiMediaProvider`、`AiImageProvider`、`AiSpeechProvider`、`AiWebSearchProvider`）に分割され、`AiChatProvider` により集約されます：

1. **契約宣言**：[`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) でオプショナルメンバーとして宣言し、`this: void` を明示的に付与。
2. **実装の注入**：サポートする実装パッケージ内にのみ追加し、その `index.ts` からエクスポート。非対応のベンダーは**キー自体を宣言しないでください**（undefined を維持）。
3. **能力判定**：呼び出し側は一貫して `provider.someCapability === undefined` で判定し、**ベンダー名で判定することは絶対に避けてください**（例: `provider.name !== "gemini"`）。
4. **欠落時のフォールバック方針**：グレースフルに縮退可能なもの（音声文字起こしなど）はプレースホルダーを維持してログを記録し、一時的に他社ベンダーへ切り替えることは禁止します。縮退できないもの（音声合成など）はツール自体をマウントしません。
5. **動的着脱**：ツールはターンごとに組み立てられ、対応する能力設定や実装が欠落している場合は、定義とエグゼキューターの両方を同時に除外します。

---

## AI ツールの追加

1. **名前定数**：[`packages/consts/tools.ts`](../../packages/consts/tools.ts) でツール名を宣言。副作用のあるツールは `ACTION_TOOL_NAMES` に登録。
2. **ツール定義**：静的クエリツールは `TOOL_DECLARATIONS` に追加。アクションツールは `packages/aiChat/ai/tools/replyToolset/` で definition builder を提供。中立な `AiToolDefinition` は実装パッケージによりベンダー固有スキーマへオンデマンド変換されます。
3. **実行ロジック**：`packages/aiChat/ai/tools/` に実行ロジックを実装。Telegram への副作用はメインスレッドのプロキシ経由で実行。
4. **ディスパッチ登録**：静的ツールは `tools/index.ts` の `callTool` に接続。アクションツールは `replyToolset/` の definitions および dispatch パイプラインに接続。
5. **予算制御**：可視副作用ツールは統一アクション予算（ハード上限 11）に組み込み。ターンごとの個別制限は明確なドメイン制約（スタンプ、画像生成、音声が各 1 回など）にのみ適用。
6. **プロンプト仕様**：`packages/consts/aiChat/prompts/` にルール説明を追記。文字起こし形式に関わる場合は `transcript.ts` を再利用。
7. **検証とドキュメント**：`test/aiChat/ai/` に単体テストを追加し、3 言語ドキュメントでツール説明を同期。

---

## 汎用 JSON API 呼び出しの追加

1. [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts) の `JSON_API_ALLOWED_ORIGINS` に許可する HTTPS Origin を明示的に追加。任意の Host や HTTP プロトコルへの緩和は厳禁。
2. [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts) の有界 JSON リーダーを再利用。リダイレクトは無効を維持し、レスポンスボディとエラーログの長さを厳格に制限。
3. Origin 検証、リダイレクト遮断、レスポンス上限超過、エラー処理に対する単体テストを追加。

---

## ペルソナまたは JSON 設定の変更

- **ペルソナ管理**：内蔵人設は `packages/consts/aiChat/prompts/persona.ts` に配置。カスタム人設はプロジェクトルートに `prompt/persona.md`（例は [`prompt_example/persona.md`](../../prompt_example/persona.md)）を配置することで、再起動後にグローバルに適用されます。通知は明示した `atmosphere` を優先し、省略時はカスタム人設で通常版を使います。
- **ボイスツール説明の管理**：内蔵説明は `packages/consts/aiChat/prompts/tools.ts` の `VOICE_LANGUAGE_PROMPTS`（`en` / `zh` / `ja` 各 1 份）に配置。プロジェクトルートに `prompt/voice_tool.md` を配置すると、再起動後にその本文で `send_voice` の説明全体を置き換えます。引数の説明とその他のボイス関連文言は引き続き `bot_language` で選ばれます。例は [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md) を参照。
- **プロンプト例の管理**：`prompt_example/` はリリースパッケージに同梱されます。`test/config/promptExamples.test.ts` は、2 つの例が `loadPromptFile` を通ること、`voice_tool.md` の残量案内・1 ターンの件数・`text` / `tone` の長さ上限がコード定数と一致すること、セリフ言語が `config_example/dynamic/agent.json` の `bot_language` と一致することを要求します。`MAX_VOICES_PER_REPLY`、`VOICE_TEXT_MAX_CHARS`、`VOICE_TONE_MAX_CHARS` または例の `bot_language` を変えるときは例も合わせて更新します。
- **設定ファイル**：開発時は Git 除外対象の `config/` のみを編集。`config_example/` はテンプレートとしてのみ使用。
  - `config/dynamic/` はホットリロードに対応（`assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`）。
  - `config/static/` は再起動後に反映（`bot.json`、`g-auth.json`）。
- **リアクションとリスト**：リアクション emoji は `AI_REACTION_EMOJIS` により制限。ブラックリスト・ホワイトリストの権威ストレージは SQLite であり、JSON では管理しません。

---

## deployment JSON 設定の追加

1. `packages/config/<domain>.ts` で厳格なパーサーを宣言（必須/任意、範囲、未知のキーの拒否）。
2. `config_example/static/` または `config_example/dynamic/` に機密情報を除いたサンプルを置き、`config_example/README/` の 3 言語版を更新。
3. ホットリロードが必要な場合は、`packages/config/reload.ts` に読み込みとスナップショット配信を登録。
4. 3 言語の環境構築ドキュメントを同期。

---

## 実行時 cache の追加

1. `packages/cache/<owner スレッド>/<domain>.ts` に配置し、ファイル 1 行目を `/** owner: <main|perThread|workers/<スレッド>>。…` で始める（ディレクトリと一致させ、`bun run check:conventions` が照合）。可変シングルトンは `{ current: T | null }` を使用。
2. すべてのエクスポートに JSDoc を記述：ライフサイクル、格納タイミング、クリーンアップ戦略、Worker 再構築方法を明記。
3. 容量上限を明確化し、有界、所有者あり、再構築可能という不変条件の要件を満たすこと。
4. 停止時の flush に関わるものは一律 `packages/libs/flushBarrier.ts` に組み込み。

---

## 永続化 schema の変更

> [!CAUTION]
> **絶対準則**：コード内に**旧フォーマットの互換ロジックを残さず、実行時自動移行も行いません**。不正なフォーマットは起動を直ちに拒否します。

1. `packages/types/` 内の永続化型と厳格検証ロジックを修正。
2. テストを追加・修正し、`bun run test:fault-injection` を実行。
3. **旧プロセスを停止**し、`bot.lock` が解放されたことを確認。
4. 外部バックアップを取得した後、手動で既存の `memory/global/state.json` および関連ファイルを新フォーマットへ移行。
5. 新バージョンを起動して検証。検証に失敗した場合は、不足フィールドを特定して修正。
6. 少なくとも 2 回の supervisor 再起動サイクルを観察し、動作が安定していることを確認してから一時バックアップを削除。

---

## SQLite table を追加する

実行時はデータベースの自動移行を行わず、テーブル構造が一致しない場合は起動を拒否します：

1. `packages/database/schema/<domain>.ts` でテーブル構造を宣言し、`schema/storage.ts` に登録。
2. `schema/migrations/000N_<name>.sql` を作成し、`migrations/meta/_journal.json` を更新。
3. 一時データベースで移行を実行し、`__drizzle_migrations` から実際の `created_at` と `hash` を読み取って `packages/consts/identityStorage.ts` に記入し、`IDENTITY_DATABASE_SCHEMA_VERSION` を 1 加算。
4. 停止時コールド移行スクリプトを作成し、`scripts/migrations/active.ts` に新たな移行辺を登録し、置き換えられた旧辺を削除。
5. 移行スクリプト内では、対象バージョンの歴史的スキーマを厳格に使用して移行対象データをデコード。
6. 独立した生成物が双方向ハッシュ検証をパスした後に `ready.json` を生成。
7. データの永続化は Write-Through トランザクションフローに準拠。

---

## Worker 間 protocol の変更

スレッド間メッセージプロトコルは `packages/types/` が管轄します。プロトコル変更時は以下の 3 箇所を同期して更新します：
1. `packages/types/` の型定義。
2. メインスレッド側プロキシ（`packages/infra/` または `packages/cache/main/`）。
3. Worker 側のハンドラー関数（`packages/workers/<domain>/`）。
リクエスト/レシート型のやり取りは、Waiter 事前登録、タイムアウト/クラッシュ時の一元的な向き先精算パターンに従います。

---

<div align="center">

[← 前のページ：05 開発フロー](05-dev-workflow.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#06-よくある変更手順) · [次のページ：07 運用マニュアル →](07-operations.md)

</div>
