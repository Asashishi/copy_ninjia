# 06 よくある変更手順

<p align="center">
  <a href="../06-modification-guide.md">简体中文</a> · <a href="../en/06-modification-guide.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="README.md">📚 開発者ドキュメント TOP</a> · <a href="05-dev-workflow.md">← 前のページ：05 開発フロー</a> · <a href="07-operations.md">次のページ：07 運用マニュアル →</a>
</p>

---

各項目では変更するファイルと順序を示します。共通の前提は、編集前に [`AGENTS.md`](../../AGENTS.md) を読むこと、`state.json`、`memory/`、`bot.lock` などの実行時データを変更する場合や間接的に書き込むコード経路を実行する場合は先にバックアップすること、最後に `bun run check` をすべて通すこと、必要に応じてルート README を同期することです。

## スラッシュコマンドの追加

1. **Handler**：`packages/commands/` に 1 ファイル作成し、`function` 宣言で `handleXxxCommand` を明示的な戻り値型付きで export します。権限 gate は既存パターンを参照します。許可ユーザーは `block.ts`、スーパー管理者は `superAdminToggle.ts` / `switchMood.ts`、プライベートチャット限定は `send.ts` です。後者は本人以外またはプライベートチャット以外ならエラーを返さず静かに return します。
2. **Export**：`packages/commands/index.ts` に追加します。
3. **登録**：[`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts) に `bot.command("xxx", ...)` を追加します。登録位置は init gate、グループ単位の直列化、プライベートチャット gate、参加認証 middleware より後なので、新しいコマンドは自動的にそれらの semantics を得ます。handler で gate 判定を重複させないでください。
4. **プライベートチャット gate**：新しいコマンドをプライベートチャットで使う場合は、[`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) も変更し、gate テストを追加します。現在、プライベートチャットのスラッシュコマンドは `/send` だけを明示的に許可しているため、handler 登録だけでは到達しません。グループ専用コマンドは変更不要です。
5. **メニュー**：Telegram のコマンドメニューに表示するなら [`packages/consts/commands.ts`](../../packages/consts/commands.ts) の `BOT_COMMANDS` に追加します。`/send` のような hidden command は追加しません。
6. **パラメータ定数**：cooldown、threshold などは `packages/consts/commands.ts` または該当ドメインの consts に置き、中国語 JSDoc を付けます。
7. **テスト**：`test/commands/xxx.test.ts` を追加し、少なくとも権限拒否、引数解析、主要経路を検証します。
8. **ドキュメント**：3 言語すべてのルート README の「コマンドと権限」table に行を追加します。

### 非 ASCII のコマンド名

`/咬` や `/贴贴` のような漢字アクションコマンド（アクション語は漢字 1~2 文字）は別経路です。実装例は [`cjkAction.ts`](../../packages/commands/cjkAction.ts) です。

- **`bot.hears` で照合する。** Telegram は ASCII コマンドにしか `bot_command` entity を付けないため `bot.command` では永久に一致しません。`bot.hears(正規表現, ...)` でメッセージ原文に対して照合し、フォールバックの `bot.on(["message", "channel_post"], ...)` より前に登録します。そうしないと通常メッセージとして AI/copy pipeline に流れます。
- **対象解決は別の入口を通る。** この handler が受け取るのは `CommandContext` ではなく素の `Context` なので、[`targetResolution.ts`](../../packages/commands/targetResolution.ts) の `resolveCommandTarget` に `ResolveCommandTargetParams` を直接渡します。自分宛でない形（`/咬@OtherBot`、caption だけのメッセージ、異常なメッセージ形態）は `next()` で通し、update を黙って握り潰してはいけません。
- **`message.text` だけを見る。** `bot.hears` は text と caption の両方に一致しますが、画像付きメッセージを受理するとそれは `handleIncomingMessage` に届かなくなり、その画像が AI のローリングメモリと視覚パイプラインに入りません。
- **パイプラインの前提を自分で用意する。** 登録位置は自動パイプラインより**前**なので、そのパイプラインの自己送信ガードと `cacheSender` の恩恵を受けられません。handler 自身が `isBotOwnMessage` で Bot 自身のメッセージを除外し（さもないとチャンネルの跳ね返りが自問自答の連投ループになります）、送信者 ID のキャッシュも自分で行う必要があります。
- **`BOT_COMMANDS` メニューには入れられない。** BotFather のコマンド名も ASCII 限定（ラテン文字・数字・アンダースコア、最長 32 文字）です。`setMyCommands` はリスト全体を一括送信するので、1 件でも不正な名前が混ざるとメニュー全体が `BOT_COMMAND_INVALID` で失敗します。登録失敗はログに残るだけで起動を止めないため、メニューが黙って消えます。メニューで使い方を見せたい場合は ASCII のプレースホルダー項目（既存の `/x`）を追加し、構文は description に書きます。
- **プレースホルダーにも handler が要る。** メニューをタップすると実際にコマンドが送信されるため、登録しないとフォールバックに到達し、通常メッセージとして AI/copy pipeline に流れてしまいます。かといって何もしない空の handler にすると、タップした人には完全な沈黙しか返りません。使い方を 1 行返してチェーンを終了させます。
- **自前のグローバル rate limit を備える。** これらのコマンドはコマンドメニューという自然な制約を持たず、アクション語は誰でもその場で作れます。window と上限は `packages/consts/commands.ts`、タイムスタンプ列は `packages/cache/main/<domain>.ts` に置き、判定は [`libs/slidingWindowRateLimit.ts`](../../packages/libs/slidingWindowRateLimit.ts) を再利用します（呼び出し側が渡した列をその場で更新する純関数で、自身は状態を持ちません）。

## 応答にリンクや書式を付ける

`sendMessage` は `parse_mode` を一切設定しません。表示名やメッセージ本文に含まれる記号が書式やリンクに化ける余地を残さないためです。リッチテキストが本当に必要な場合は、呼び出し側がテキストを段ごとに組み立て、`entities` の offset を自分で計算して `sendMessage` に渡します（[`infra/telegram/actions.ts`](../../packages/infra/telegram/actions.ts) 参照）。offset は Telegram の UTF-16 code unit 基準で、これは JavaScript の `String#length` と同一です。表示名の emoji（surrogate pair）は自然に 2 単位となり、追加の換算は不要です。長さ 0 の entity はメッセージ全体が拒否される原因になるため、空の段に entity を付けてはいけません。実装例は `cjkAction.ts` の `buildActionMessage` です。

## 別の言語にする：i18n はやらないので fork してください

ユーザー向けの文言は簡体中国語のみです。本リポジトリは i18n レイヤーを提供も受け入れもしません。文言は差し替え可能な辞書項目ではないからです。

- 多くの応答は断片の連結で組み立てられ、同時に Telegram `entities` の UTF-16 オフセットを算出しています（前節参照）。言語が変われば語順も長さも、そもそも文を分けるべきかどうかも変わり、オフセットは全て計算し直しになります。key-value の語彙表では受け止められません。
- `/咬` のような中国語アクションコマンドは中国語の字形そのものに依存しています（「スラッシュコマンドの追加」末尾を参照）。翻訳した時点で同じ操作ではなくなります。
- ペルソナ・ツール説明・プロンプト（[`prompt/persona.md`](../../prompt/persona.md)、`packages/consts/aiChat/prompts/`）は中国語で書かれており、モデルの出力言語もそれらが決めています。

別の言語が必要なら fork して自分で書き換えてください。production コードには中国語を含む文字列リテラルが 58 ファイルに約 486 箇所、さらに `prompt/persona.md` と `config/*.json` があります。上流に抽象レイヤーを立てて 1 項目ずつ埋めるより、fork 全体を AI に vibe させる方が手間も少なく、オフセット計算のようなロジックを複雑にせずに済みます。作業後は通常どおり `bun run check` を実行してください。

## 動作パラメータの調整

パラメータはすべて `packages/consts/` に集約されているため、値の変更で業務コードを編集する必要はありません。主な場所は次のとおりです。

| 調整対象 | ファイル |
| :--- | :--- |
| AI トリガー確率、レート制限、並列数、キュー | `packages/consts/aiChat/rateLimit.ts` |
| AI メモリ容量、snapshot 周期、要約 backpressure | `packages/consts/aiChat/memory.ts` |
| メディア説明長、実行 slot、LRU 容量 | `packages/consts/aiChat/media.ts` |
| 画像生成 cooldown と byte 上限 | `packages/consts/aiChat/imageGeneration.ts` |
| ムード時間とコマンド timeout | `packages/consts/aiChat/mood.ts` |
| ツール action・lookup 上限、モデル名、request timeout | `packages/consts/aiChat/tools.ts` |
| 認証 window、spam threshold、追記・compaction 方針 | `packages/consts/antiRaid/` |
| copy cooldown、`/quiet` 範囲、username 規則、アクションコマンドの rate limit | `packages/consts/commands.ts` |
| 送信者ごとのランダムトリガー cooldown | `packages/consts/auto.ts` |

手順：定数を変更 → 不変条件の変更も含めて中国語 JSDoc を更新 → ルート README がその値を引用していないか確認し 3 言語を同期 → `bun run check`。

> [!WARNING]
> **容量定数はディスクデータと結び付いている場合があります。** `AI_MEMORY_HYDRATE_BUFFER_MAX` や `MAX_SUMMARY_ROUNDS` を小さくする前に、[04 実行時の正式な不変条件](04-invariants.md#永続化) の規則に従い、旧プロセスを停止して既存の `memory/ai/` snapshot をアトミックに書き換えてください。容量を変更する前にこの section を確認します。

## AI ツールの追加

1. **名前定数**：[`packages/consts/tools.ts`](../../packages/consts/tools.ts) にツール名を定義します。目に見える副作用がある場合は `ACTION_TOOL_NAMES` に含めるべきか確認します。
2. **定義**：stateless な静的 query tool の `ToolDefinition` は [`packages/aiChat/ai/tools/index.ts`](../../packages/aiChat/ai/tools/index.ts) に置きます。chat context、動的 schema、round ごとの状態が必要な action tool は `packages/aiChat/ai/tools/replyToolset/` に definition builder を置きます。reply toolset orchestrator がドメイン定義を SDK の `FunctionDeclaration` に変換します。
3. **実装**：`packages/aiChat/ai/tools/` に実行 logic を実装します。Telegram 向けの副作用はメインスレッドのプロキシ経由で実行し、Worker が Bot instance を直接保持してはいけません。
4. **登録**：静的 query tool は `packages/aiChat/ai/tools/index.ts` の dispatch へ、action tool は `packages/aiChat/ai/tools/replyToolset/` の definitions、dispatch、round 状態へ接続します。
5. **予算**：表示される副作用 tool は統一 action budget に含め、既定では per-tool call cap を追加しません。ドメイン固有の理由がある場合だけ独立制限を設けます。現在の対象はスタンプパック表示、Google Search、round ごとに各 1 回成功できるスタンプ・リアクション・生成画像です。custom function 全体の round 単位 loop guard は引き続き適用します。[04](04-invariants.md#worker-と状態の所有権) を参照してください。
6. **Prompt**：必要なら `packages/consts/aiChat/prompts/` に利用規則を追加します。transcript 形式に関わる場合は `transcript.ts` の共通 template を再利用し、両側で同じ形式を手書きしません。
7. **テスト + 文書**：`test/aiChat/ai/` または対応する feature／Worker パスにテストを追加し、必要ならルート README のツール行を更新します。

## 汎用 JSON API 呼び出しの追加

1. [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts) の `JSON_API_ALLOWED_ORIGINS` に正確な HTTPS origin を明示的に追加します。任意 host、HTTP、credential を含む URL へ広げてはいけません。
2. [`packages/libs/httpFetch.ts`](../../packages/libs/httpFetch.ts) の上限付き JSON reader を再利用します。redirect は無効のままにし、response body と error log の上限を維持します。
3. origin、redirect、過大 response、失敗 log のテストを追加します。Telegram avatar crawler は独立した media 経路であり、JSON API 追加のために接続先を変えたり制限したりしません。

## ペルソナまたは JSON 設定の変更

- ペルソナ：[`prompt/persona.md`](../../prompt/persona.md) を変更し、再起動で反映します。transcript 形式、identity marker、返信先判定に関わる実行時 interaction rule はコードから注入し、ペルソナファイルには置きません。
- deployment 固有の変更は Git ignore 対象の `config/` だけに行います。`config_example/` は clean deployment 用 template で、schema または default example が変わるときだけ同期します。`whitelist.json` と `blocklist.json` は network 接続前に厳密ロードし、前者は `/white` と `/permission` が atomic rewrite します。`stickers.json`、`reactions.json`、`mood.json`、`ad_samples.json` は feature ごとに遅延検証します。スタンプパックは最大 5 個、mood の重みは正の整数で合計 100、広告例文は空文字・重複不可で最大 500 件です。構造変更では先に `packages/config/` の schema と `packages/types/` の型を更新してから JSON を変更します。

## 環境変数の追加

1. `packages/infra/config.ts` で宣言・解析し、必須か空でもよいか、形式検証もここで定義します。解析失敗は起動を拒否します。
2. [`.env.example`](../../.env.example) にコメント付きの例を追加します。
3. 3 言語のルート README にある「設定」section と [01 環境構築](01-getting-started.md#env-の設定) の変数 table を同期します。

## 実行時 cache の追加

1. `packages/cache/<所有スレッド>/<domain>` に置き（スレッドディレクトリは [03 ディレクトリ案内](03-directory-map.md#スレッド別に分けたキャッシュ) を参照）、ファイル先頭で owner モジュールを示します。可変 singleton は `{ current: T | null }` のような holder object を使います。
2. 各 export にライフサイクル JSDoc を付けます。いつ格納し、いつ削除し、Worker crash/restart 後にどう再構築するかを記載します。
3. 容量上限と削除方針を定め、[04 実行時の正式な不変条件](04-invariants.md#worker-と状態の所有権) の長寿命コンテナ要件、すなわち bounded、owner あり、再構築可能を満たすか確認します。
4. 停止時に flush または精算する必要があるなら `packages/libs/flushBarrier.ts` を使い、新しい resolver Map を作りません。

## 永続化 schema の変更

[`AGENTS.md`](../../AGENTS.md) と [04](04-invariants.md#永続化) の絶対規則は、**旧形式の互換 logic をコードに残さず、実行時の自動 migration を行わない**ことです。非互換入力は起動を拒否します。したがって手順は次のとおりです。

1. `packages/types/` の永続化型と validator を変更し、新形式を厳密に検証します。
2. `test/infra/storage/`、`test/workers/diskIO/` などのテストを追加または変更し、`bun run test:fault-injection` を実行します。
3. **旧プロセスを停止**し、`bot.lock` が解放されたことを確認します。
4. `state.json`、`state.json.bak`、影響する `memory/` snapshot を新形式へ手動 migration します。migration 前にコピーでバックアップします。
5. 新版をデプロイして起動します。state の 2 コピーが両方無効と出た場合は migration が不完全です。プログラムは元ファイルを変更しないため、修正してから再起動します。
6. `.corrupt` 隔離ファイルと `logs/` を確認し、復元異常がないと確認した後で一時バックアップを削除します。

## Worker 間 protocol の変更

スレッド間メッセージ protocol は `packages/types/` が所有します。変更時は、型定義、対応する `packages/infra/` または `packages/cache/main/` のメインスレッド側プロキシ、`packages/workers/<domain>/` の Worker 側処理という 3 か所を同期します。request/acknowledgement 型のやり取りは [04](04-invariants.md#worker-と状態の所有権) にある「waiter を先に登録してから送信し、timeout/crash を統一精算する」形式に従います。`/switch_mood` の handshake が実装例です。

---

<div align="center">

[← 前のページ：05 開発フロー](05-dev-workflow.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#06-よくある変更手順) · [次のページ：07 運用マニュアル →](07-operations.md)

</div>
