# 06 よくある変更手順

<p align="center">
  <a href="../cn/06-modification-guide.md">简体中文</a> · <a href="../en/06-modification-guide.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="05-dev-workflow.md">← 前のページ：05 開発フロー</a> · <a href="07-operations.md">次のページ：07 運用マニュアル →</a>
</p>

---

このドキュメントでは、機能追加や設定調整を行う際の具体的な変更対象ファイルと実装手順をレシピ形式で示します。

> [!IMPORTANT]
> **開発時の前提条件**：
> - コードを変更する前に、必ず [`AGENTS.md`](../../AGENTS.md) の規約を確認してください。
> - デプロイ設定や実際の稼働データを変更する前、または本番データへ書き込みを行う可能性があるエントリポイントを実行する前に、対象ファイルをバックアップしてください。通常のソースコード変更や、独立した一時データルートを使用するテストの実行時には、デプロイデータのバックアップ手順は不要です。
> - コミット前には必ず `bun run lint && bun run typecheck` または完全な `bun run check` を実行してください。`master` へのマージ前には `bun run check` の合格が必須です。ドキュメント、README、指標の更新は、ユーザーから明示的な指示があった場合にのみ実施します。

---

## 並行 batch の追加

- **決定論的セトルメント**：固定長かつ相互依存のない Promise 群は、`Promise.allSettled` で全件の完了を待機し、個々の rejection を個別に処理します。**セトルメントをエラーの握りつぶし（silent failure）に使用することは厳禁**です。
- **動的入力の流量制御**：入力件数が動的に増加する可能性がある場合は、[`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts) を利用し、明示的な並行数ハード上限を設定した上で、返却される `item / index` から失敗した対象を正確に記録します。入力配列全体を事前に `map` して一括で Promise 化することは禁止します。
- **有界バックオフ**：対象ドメインが一時的エラーを識別できる場合にのみ、そのドメインの owner 内で有限回数のバックオフを設定し、対象エラー種別を限定してログを記録します。`runBoundedSettledBatch` は各項目を 1 回のみ実行し、リトライ責務は負いません。下位レイヤーですでにリトライされている処理を多重にラップしてはならず、非冪等な副作用を不用意に再試行することは厳禁です。
- **Drain 待機**：登録済みタスクの完了（drain）を待機するためにスナップショットを取得する場合、タスクプールの新規導入は不要です。ただし、スナップショット取得自体が新規タスクを開始しないこと、および各タスクに適切なエラー隔離が施されていることが前提となります。

---

## スラッシュコマンドの追加

1. **ハンドラーの実装**：
   - `packages/commands/` 配下にハンドラー関数を作成し、明示的な戻り値型を持つ `handleXxxCommand` をエクスポート。
   - 権限検証：権限キーに基づく認可には `rejectUnlessPermitted(ctx, key, rejection)` を使用。スーパー管理者専用コマンドには `rejectUnlessSuperAdmin(ctx, rejection)` を使用（`commands/commandActor.ts` 参照）。
   - メッセージ文言の管理：固定文言およびフォーマッター関数は `packages/consts/atmosphere/{teasing,plain}/` の該当ドメインファイルに配置し、通常版とメスガキ風で同一の型定義を共有。メインスレッドは `chatAtmosphere()` により現在のスタイルに対応する文言を読み込みます。
2. **モジュールのエクスポート**：`packages/commands/index.ts` にエントリを追加。
3. **コマンドの登録**：
   - [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts) の `commands` サブチェーンに `commands.command("xxx", ...)` を追加。
   - **`bot` インスタンスへ直接登録することは厳禁**：すべてのコマンドは、前置チェーンの `:entities:bot_command` ゲート後方にある子 Composer に登録します（`app/registerHandlers.ts`）。登録位置は `/init` ゲート、プライベートチャットゲート、身元ウォームアップ、参加認証、gag、`/qa` フォーム Ingress より後ろに配置され、先行するセキュリティ境界を自動的に継承します。
4. **プライベートチャットゲート設定**：追加するコマンドをプライベートチャットでも許可する場合は、[`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) のホワイトリストを更新します。現在、プライベートチャットで許可されているコマンドは `/send` のみです。グループ専用コマンドの場合は変更不要です。
5. **メニュー設定**：`packages/consts/atmosphere/{teasing,plain}/commands.ts` の両方の `BOT_COMMANDS` 配列にコマンド説明を追加。
6. **パラメータ定数**：クールダウン、しきい値などの各種パラメータは `packages/consts/commands.ts` または対応する `packages/consts/<domain>.ts` に定義し、中国語 JSDoc を付与。
7. **単体テストの追加**：`test/commands/xxx.test.ts` を作成し、権限拒否、引数バリデーション、正常系の実行パスを網羅。
8. **ドキュメント更新**：3 言語の `docs/{cn,en,ja}/09-commands.md` のコマンド一覧表にエントリと権限仕様を追記。

### 非 ASCII のコマンド名

`/咬` や `/贴贴` などの漢字アクションコマンド（1〜2 文字の漢字によるアクション指示）を追加する場合は、[`cjkAction.ts`](../../packages/commands/cjkAction.ts) の専用パイプラインに従います：

- **`bot.hears` によるマッチング**：Telegram は ASCII コマンドに対してのみ `bot_command` エンティティを生成します。漢字コマンドはメッセージ本文に対して `hears(正規表現, ...)` でマッチングさせ、`cjkActions` サブ Composer（正規表現は `^\/` で開始。`CJK_ACTION_COMMAND_PATTERN` 参照）に登録して、通常メッセージへのフォールバック直前で捕捉します。
- **独立したターゲット解決**：`resolveCommandTarget` に `ResolveCommandTargetParams` を渡して対象を解決します。一致しない形式の場合は `next()` を呼び出して後続へ通過させ、update を勝手に消費してはなりません。
- **`message.text` のみ受け付け**：caption 付きメディアなどの場合は `next()` で通過させ、通常のメッセージパイプラインへ戻します。
- **先行パイプラインの補完**：自動メッセージパイプラインより前に登録されるため、`isBotOwnMessage`、`needsBotOwnMessageWait`、`waitForBotOwnMessage` を明示的に呼び出して Bot 自身の発言を適切に扱い、`updateCachedIdentity` を介して送信者キャッシュを更新する必要があります。
- **メッセージの保持ポリシー**：アクション成功の結果メッセージは長期保持対象となるため、`sendCommandMessage` の呼び出し時に `preserveInGroup: true` とトリガートピックの `messageThreadId` を明示します。引数エラー時の警告や `/x` の使い方案内は通常の 30 秒自動削除に従います。
- **メニュー表示とプレースホルダー**：Telegram のコマンドメニューは ASCII のみを受け付けます。メニュー上ではプレースホルダー `/x` を通じて構文を示し、使い方を案内するハンドラー（`handleCjkActionUsageCommand`）を登録して、通常メッセージへ誤ってフォールバックしないようにします。
- **スライディングウィンドウによるレート制限**：漢字アクションコマンドにはメニューの入力支援がないため、乱用を防ぐスライディングウィンドウ型レート制限（`CJK_ACTION_RATE_LIMIT_WINDOW_MS` と `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW`、`libs/slidingWindowRateLimit.ts` を再利用）を適用する必要があります。

---

## 応答にリンクや書式を付ける

メッセージ送信時のフォーマットは、リッチテキストとプレーンテキストの二者択一です（`entities` と `parseMode` は型レベルで排他関係にあります。[`packages/infra/telegram/actions/messages.ts`](../../packages/infra/telegram/actions/messages.ts) の `SendMessageFormat` を参照）：

- **MarkdownV2 モード**：
  - `sendMessage` または `sendCommandMessage` に `parseMode: MARKDOWN_V2_PARSE_MODE` を指定。
  - 送信する本文は**例外なくすべて** [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) を経由してエスケープおよび構築します（プレーンテキスト部は `escapeMarkdownV2`、太字 / コードブロック / リンク等は専用ビルダー関数を使用）。
  - 動的なユーザー名、モデルの出力、固定文案をエスケープ処理なしで直接文字列結合してはなりません。パースエラーが発生した場合は通常の送信エラーとして扱い、エスケープなしのプレーンテキストへ勝手にフォールバックさせてはなりません。
  - 単体テストでは `test/helpers/markdownV2.ts` の参照パーサーを用いてパース結果の妥当性を検証します。
- **Entities 明示指定**：
  - 呼び出し側がテキストをセグメントごとに組み立て、`entities` の UTF-16 code unit オフセットを厳密に計算。
  - 絵文字などのサロゲートペア文字は 2 単位を消費することに注意してください。長さ 0 のエンティティを指定してはなりません。

---

## 別の言語にする：i18n はやらないので fork してください

本 Bot が出力するユーザー向け固定文言はすべて簡体中国語であり、`packages/consts/atmosphere/` 内で通常版とメスガキ風の 2 系統を提供しています。

- 文言テーブルは固定文字列とフォーマッター関数で構成され、Telegram entities のオフセットは最終描画後のテキストから計算されます。
- `/咬` などのアクションコマンドの解析対象文言と表示文言は個別に管理されています。
- AI ペルソナは、デフォルトで `packages/consts/aiChat/prompts/persona.ts` が使用され、`prompt/persona.md` が存在する場合はカスタムファイルが優先されます。
- `send_voice` ツールの説明文は、デフォルトで `agent.tts.bot_language` に応じた内蔵定義（`packages/consts/aiChat/prompts/tools.ts` の `VOICE_LANGUAGE_PROMPTS`）が使用され、`prompt/voice_tool.md` が存在する場合はカスタムファイルが優先されます。
- 別の言語で Bot を運用したい場合は、リポジトリを自身で fork し、上記の文言モジュールおよび設定を対象言語向けに直接書き換えるアプローチを推奨します。

---

## 動作パラメータの調整

すべての業務パラメータは `packages/consts/` 配下に集約されており、パラメータの変更に伴ってロジックコード自体を改変する必要はありません：

| 調整対象 | 対象ファイル |
| :--- | :--- |
| AI トリガー確率、レート制限、並行数、キュー上限 | `packages/consts/aiChat/rateLimit.ts` |
| AI 会話メモリ容量、スナップショット周期、要約バックプレッシャー | `packages/consts/aiChat/memory.ts` |
| メディア解説の最大長、実行スロット数、LRU キャッシュ容量 | `packages/consts/aiChat/media.ts` |
| 画像生成クールダウンおよびバイト数上限 | `packages/consts/aiChat/imageGeneration.ts` |
| ムード（感情）持続時間と切り替えタイムアウト | `packages/consts/aiChat/mood.ts` |
| ツールアクション / クエリ上限、タイピングと誤字演出の間隔 | `packages/consts/aiChat/tools.ts` |
| 音声文字起こしの長さ / サイズ上限とプレースホルダー文言 | `packages/consts/aiChat/voice.ts` |
| 音声ツールのターン上限、セリフ / 口調の文字数上限、1 日の利用枠 | `packages/consts/aiChat/voiceMessage.ts` |
| リクエストタイムアウト、リトライ回数、サンプリングおよび安全性設定 | `packages/consts/aiChat/gemini.ts`、`packages/consts/aiChat/openai.ts`、`packages/consts/aiChat/anthropic.ts` |
| **モデル名、プロバイダ、API キー、エンドポイント** | **定数ではありません**：`config/dynamic/agent.json` で機能ごとに設定 |
| OpenAI 互換画像プロトコル / 画像サイズ設定 | `config/dynamic/agent.json` の `agent.image.image_protocol` |
| 参加認証ウィンドウ、連投判定しきい値、追記 / コンパクション方針 | `packages/consts/antiRaid/` |
| リピートクールダウン、/quiet 適用範囲、アクションコマンドレート制限 | `packages/consts/commands.ts` |
| ランダム発話の発言者クールダウン | `packages/consts/auto.ts` |

**パラメータ変更フロー**：定数を変更 → 対応する中国語 JSDoc を更新 → コミット前ゲートを実行。ユーザーから文書更新の明示的な依頼があった場合にのみ README 等の関連箇所を同期します。`master` へのマージ前には `bun run check` を実行してください。

> [!WARNING]
> **容量関連の定数は永続化データと密結合している場合があります**：
> `AI_MEMORY_HYDRATE_BUFFER_MAX` や `MAX_SUMMARY_ROUNDS` などの定数を縮小する前に、[04 実行時の正式な不変条件](04-invariants.md#永続化) の仕様に従い、プロセス停止状態で SQLite トランザクションを介して既存の `chat_states.ai_context` スナップショットを更新する必要があります。起動時のバリデーションは、新しい容量上限を超える既存スナップショットをエラーとして拒否します。

---

## provider の任意能力を追加する

各モデル機能の契約は、独立した最小インターフェース（`AiTextProvider`、`AiSummaryProvider`、`AiMediaProvider`、`AiImageProvider`、`AiSpeechProvider`、`AiWebSearchProvider`、`AiStructuredTextProvider`）に分離されており、`AiChatProvider` によって集約されます：

1. **契約の宣言**：[`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) でオプショナルプロパティとして宣言し、`this: void` を明示。
2. **実装の提供**：対応するプロバイダパッケージ内でのみ実装を追加し、その `index.ts` からエクスポート。非対応のベンダーではプロパティ自体を宣言しません（undefined を維持）。
3. **機能の判定**：呼び出し側は常に `provider.someCapability === undefined` で判定し、ベンダー名によるハードコード判定（例: `provider.name !== "gemini"`）を行ってはなりません。
4. **欠落時のフォールバック**：グレースフルに縮退可能な機能（音声文字起こし等）はプレースホルダーを維持してログを記録し、一時的に別ベンダーへ切り替えることは禁止します。縮退できない機能（音声合成等）はツールそのものをツールセットへマウントしません。
5. **動的なツールセット構築**：ツール一覧はターンごとに動的生成され、対応する機能設定や実装が存在しない場合は、定義とエグゼキューターの両方がツールセットから自動除外されます。

---

## AI ツールの追加

1. **識別名定数の定義**：[`packages/consts/tools.ts`](../../packages/consts/tools.ts) でツール名を宣言。可視副作用を伴うツールは `ACTION_TOOL_NAMES` に登録。
2. **ツール定義の作成**：静的な情報照会ツールは `TOOL_DECLARATIONS` に追加。アクションツールは `packages/aiChat/ai/tools/replyToolset/` で definition builder を提供。中立な `AiToolDefinition` は、各プロバイダパッケージによりベンダー固有のスキーマへオンデマンド変換されます。
3. **実行ロジックの実装**：`packages/aiChat/ai/tools/` 配下に実行ロジックを実装。Telegram に対する副作用は、メインスレッドのプロキシを経由して実行します。
4. **ディスパッチ登録**：照会ツールは `tools/index.ts` の `callTool` に接続。アクションツールは `replyToolset/orchestrator.ts` のツール組み立ておよび `execute` ディスパッチャーに接続。
5. **予算制御**：可視副作用ツールは統一アクション予算（実行側のハード上限 `HARD_MAX_ACTIONS_PER_REPLY`）に組み込みます。ターンごとの個別上限は、明確なドメイン制約（`MAX_STICKERS_PER_REPLY`、`MAX_GENERATED_IMAGES_PER_REPLY`、`MAX_VOICES_PER_REPLY` 等）がある場合にのみ適用します。
6. **プロンプト仕様の更新**：`packages/consts/aiChat/prompts/` にルール説明を追記。メッセージ文字起こし形式に関わる場合は `transcript.ts` を再利用。
7. **検証とドキュメント**：`test/aiChat/ai/` に単体テストを追加し、3 言語のドキュメントでツール説明を同期。

---

## 汎用 JSON API 呼び出しの追加

1. [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts) の `JSON_API_ALLOWED_ORIGINS` に、接続を許可する HTTPS Origin を明示的に追加。任意のホストや HTTP プロトコルへの許可緩和は厳禁です。
2. [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts) の有界 JSON リーダー関数を再利用。HTTP リダイレクトは無効を維持し、レスポンスボディとエラーログの長さを厳格に制限します。
3. Origin 検証、リダイレクト拒否、サイズ上限超過、例外処理に対する単体テストを追加。

---

## ペルソナまたは JSON 設定の変更

- **ペルソナ管理**：内蔵ペルソナは `packages/consts/aiChat/prompts/persona.ts` に配置されています。カスタムペルソナを適用する場合は、プロジェクトルートに `prompt/persona.md`（サンプルは [`prompt_example/persona.md`](../../prompt_example/persona.md)）を配置してプロセスを再起動します。システム通知のトーンスタイルの決定規則については [01 環境構築](01-getting-started.md#telegram-identity-の設定) を参照してください。
- **ボイスツール説明文の管理**：内蔵の説明文は `packages/consts/aiChat/prompts/tools.ts` の `VOICE_LANGUAGE_PROMPTS`（`en` / `zh` / `ja` それぞれ 1 つずつ）に配置されています。プロジェクトルートに `prompt/voice_tool.md` を配置すると、再起動後にその本文が `send_voice` の説明文全体を置き換えます。引数の仕様やその他のボイス関連ルールは、引き続き `bot_language` に基づいて選択されます。サンプルは [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md) を参照してください。
- **プロンプトサンプルの保守**：`prompt_example/` はリリースパッケージに同梱されます。`test/config/promptExamples.test.ts` は、2 つのサンプルファイルが `loadPromptFile` を通過すること、`voice_tool.md` のクォータ案内・1 ターンの送信件数・文字数上限がコード定数と完全一致すること、セリフ言語が `config_example/dynamic/agent.json` の `bot_language` と一致することを自動検証します。`MAX_VOICES_PER_REPLY`、`VOICE_TEXT_MAX_CHARS`、`VOICE_TONE_MAX_CHARS` やサンプルの `bot_language` を変更する際は、サンプルファイルも同期して更新してください。
- **設定ファイル**：開発作業時は、Git 管理から除外されている `config/` ディレクトリ内のファイルのみを編集します。`config_example/` は初期テンプレートとしてのみ使用してください。
  - `config/dynamic/` はホットリロードに対応しています（`assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`）。
  - `config/static/` の変更反映にはプロセスの再起動が必要です（`bot.json`、`g-auth.json`）。
- **リアクションとリスト**：リアクション emoji は `AI_REACTION_EMOJIS` によってホワイトリスト制限されています。ブラックリストおよびホワイトリストのマスター（権威）ストレージは SQLite であり、JSON 設定では管理しません。

---

## deployment JSON 設定の追加

1. `packages/config/<domain>.ts` で厳格なスキーマパーサーを定義（必須 / 任意、値の範囲、未知のキーの拒否）。
2. `config_example/static/` または `config_example/dynamic/` に機密情報を除外したサンプル JSON を配置し、`config_example/README/` の 3 言語版を更新。
3. ホットリロードが必要な設定の場合は、`packages/config/reload.ts` に読み込みとスナップショット配信ハンドラーを登録。
4. 3 言語の環境構築ドキュメントに設定項目の説明を同期。

---

## 実行時 cache の追加

1. `packages/cache/<owner スレッド>/<domain>.ts` に配置し、ファイル先頭の JSDoc を `/** owner: <main|perThread|workers/<スレッド>> ...` で開始（配置ディレクトリと完全一致していることを `bun run check:conventions` が照合）。可変シングルトンは `{ current: T | null }` holder オブジェクトを使用。
2. すべてのエクスポートに JSDoc を記述：ライフサイクル、値の格納契機、破棄戦略、Worker クラッシュ時の再構築手順を明記。
3. 容量上限を明確に定め、有界性、単一所有者、再構築可能性の不変条件を満たすこと。
4. プロセス停止時のディスクフラッシュに関わるキャッシュは、すべて `packages/libs/flushBarrier.ts` に登録。

---

## 永続化 schema の変更

> [!CAUTION]
> **重要原則**：コードベース内に**旧フォーマットの後方互換ロジックを残さず、実行時の自動移行も行いません**。形式が不正なデータが存在する場合、システムは起動を直ちに拒否します。

1. `packages/types/` 内の永続化型定義と厳格バリデーションロジックを更新。
2. テストケースを更新し、`bun run test:fault-injection` を実行して合格を確認。
3. **既存プロセスを停止**し、`bot.lock` が解放されたことを確認。
4. ワークツリー外にバックアップを取得した上で、既存の `memory/global/state.json` および関連データを新フォーマットへ手動移行。
5. 新バージョンを起動して整合性を検証。検証に失敗した場合は、不足フィールドを特定して修正。
6. supervisor の再起動サイクルを少なくとも 2 回分監視し、安定稼働を確認した後に一時バックアップを削除。

---

## SQLite table を追加する

実行時にはテーブルの自動マイグレーションを行いません。スキーマ構造が一致しない場合、システムは起動を拒否します：

1. `packages/database/schema/<domain>.ts` でテーブルスキーマを宣言し、`schema/storage.ts` に登録。
2. `schema/migrations/000N_<name>.sql` を作成し、`migrations/meta/_journal.json` を更新。
3. 一時データベース上でマイグレーションを実行し、`__drizzle_migrations` から実際の `created_at` と `hash` を取得して `packages/consts/identityStorage.ts` に記録、`IDENTITY_DATABASE_SCHEMA_VERSION` を 1 加算。
4. 停止時専用のコールドマイグレーションスクリプトを作成し、`scripts/migrations/active.ts` に新しい移行ステップ（エッジ）を登録して、置き換えられた古いエッジを削除。
5. 移行スクリプト内では、対象バージョンの歴史的スキーマを厳格に使用して移行元データをデコード。
6. 生成された移行成果物が双方向ハッシュ検証を通過した後に `ready.json` 完了マーカーを書き出し。
7. データの永続化は、Write-Through トランザクションフローに厳格に準拠。

---

## Worker 間 protocol の変更

スレッド間メッセージプロトコルは `packages/types/` が一元管理します。プロトコルを変更する際は、以下の各モジュールを同時に更新します：
1. `packages/types/` の型定義。
2. メインスレッド側のプロキシ（`packages/infra/` または `packages/cache/main/`）。
3. Worker 側のハンドラー実装（`packages/workers/<domain>/`）。
リクエスト / レシート型の通信パターンでは、Waiter の事前登録、タイムアウト時および Worker クラッシュ時の一元的な完了解決パターンを厳格に順守してください。

---

<div align="center">

[← 前のページ：05 開発フロー](05-dev-workflow.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#06-よくある変更手順) · [次のページ：07 運用マニュアル →](07-operations.md)

</div>
