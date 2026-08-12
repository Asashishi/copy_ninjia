# 05 開発フローと品質ゲート

<p align="center">
  <a href="../cn/05-dev-workflow.md">简体中文</a> · <a href="../en/05-dev-workflow.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="conntent-table.md">📚 開発者ドキュメント TOP</a> · <a href="04-invariants.md">← 前のページ：04 不変条件</a> · <a href="06-modification-guide.md">次のページ：06 変更レシピ →</a>
</p>

---

## コマンド早見表

| コマンド | 用途 |
| :--- | :--- |
| `bun run start` | ロングポーリングを開始 |
| `bun run lint` / `lint:fix` | ESLint の検査 / 自動修正 |
| `bun run typecheck` | 完全 strict mode で `tsc --noEmit` を実行 |
| `bun run test` | ファイル分離を強制して全テストを実行 |
| `bun run test:coverage` | テスト + 全ソースコードのカバレッジ |
| `bun run check:conventions` | `scripts/checkProjectConventions.ts` でリポジトリ規約を検査 |
| `bun run check` | conventions + lint + typecheck + coverage。**コミット前に必須** |
| `bun run test:fault-injection` | 決定論的 fault injection suite |
| `bun run perf:join-log` | 入室ログ 250,000 件上限で独立 process の比較 benchmark を実行 |
| `bun run release:check` | frozen lockfile install + check + fault injection。リリース前に必須 |
| `bun run audit:release` | moderate 以上の依存関係脆弱性を監査 |

## 品質ゲートの基準

- **カバレッジの分母は全ソースコード**：`bun run check` はすべての production runtime モジュールを分母に入れます。どのテストからも到達しないモジュールは 0% として計算します。関数・行カバレッジのしきい値はどちらも 90% なので、テストなしの新規モジュールは全体カバレッジを直接下げます。
- **ESLint + 完全 strict な tsc**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` をすべて有効化しています。production コードでは `any` を禁止し、テストだけを例外とします。
- **明示的な型注釈は lint で強制**：production コード（`index.ts`、`packages/`、`scripts/`）の変数・引数・分割代入は `@typescript-eslint/typedef`、関数とコールバックの戻り値型は `@typescript-eslint/explicit-function-return-type` で強制し、いずれも文脈からの推論を認めません。`for...of` / `for...in` のループ変数は TypeScript の構文上注釈を付けられないため、ルール側が自動的に除外します。初期化子がすでにアロー関数である const も対象外です。テストファイルはこの制約を受けません。
- **規約検査**：`check:conventions` はコード配置、Markdown のローカルリンク先、tracked 非スクリプトファイルの実行権限を lint より先に検査します。

### このドキュメント版の実測値

`bun run test:coverage`：**2245 tests / 234 files / 32766 `expect()` calls**。全ソースコードの**関数カバレッジは 95.66%、行カバレッジは 96.62%**です。3 言語の各プロジェクト README の Coverage badge は行カバレッジを表示します。

## テスト分離

テストは必ず `bun run test`、つまり `bun test --isolate` から実行し、4 層で保護します。

1. **ファイル分離**：Bun はテストファイルごとに新しい global object を作成するため、`mock.module` とモジュールレベル状態がほかのテストファイルを汚染しません。`--parallel` は有効にしていないので、各ファイルが別プロセスを占有するとは説明しません。
2. **一時データルート**：`test/preloadEnv.ts` は production モジュールがロードされる前に isolate ごとの独立した一時データルートを注入します。mock されていない実ファイル I/O も一時ディレクトリだけを読み書きし、production の `state.json`、`bot.lock`、`logs/`、`memory/`、`database/` には触れません。終了後に一時ディレクトリを削除します。**path 注入を別 file に分けている**のは、ESM が import を同 file の文より先に評価するためです。`test/preload.ts` が production モジュールを static import した時点で、file 内に書いた環境変数の代入はすでに手遅れになり、`CONFIG_ROOT` は開発機の実デプロイディレクトリを指してしまいます。
3. **読み取り専用の設定ルート**：同じ注入は `COPY_NINJIA_CONFIG_ROOT` をリポジトリ内の `config_example/` に向けます（`packages/consts/paths.ts` の `CONFIG_ROOT` を参照）。デプロイ用の `config/` はバージョン管理外なので、この層はクリーンな checkout でもテストが走ることを保証しつつ、テストとテスト Worker が開発機の実 Telegram / feature 設定を読むのを防ぎます。identity database は前項の一時 data root で隔離されます。この環境変数はテスト専用でデプロイ用のスイッチではないため、README の環境変数表には載せません。
4. **agent 設定 snapshot**：`agent.json` は runtime path が disk から読まない唯一のデプロイ入力です（実 process では main thread が parse し、各 Worker へ init message で渡します。[04 実行時の権威的制約](04-invariants.md) を参照）。テスト isolate はその message を受け取らないため、`test/preload.ts` が同じ `config_example/agent.json` を isolate の holder へ一度 adopt します——「snapshot はすでに届いている」と等価です。未設定の経路を検証する test は自分で holder を空にします。

単一ファイルの debug で `bun test` を直接使うことはできますが、merge 前には必ず完全な `bun run check` を通してください。

### テスト作成の規約

- `packages/` のパスを反映します：`packages/foo/bar.ts` → `test/foo/bar.test.ts`。
- 共通 helper は `test/libs/helpers.ts` に置きます。テスト間で可変なモジュール状態を共有しないでください。分離機構によって、`--isolate` なしで実行されるまで問題が隠れる可能性があります。
- 実ファイル I/O を行うテストも、preload の一時データルートによって安全です。ただし `infra/storage` 周辺の mock 境界には注意してください。`infra/diskIO` だけを mock して `infra/storage` を実物のままにすると、実際の `saveStateInBackground` に到達する可能性があります。これは [`AGENTS.md`](../../AGENTS.md) が実行時ファイルの事前バックアップを求める状況です。

## Fault injection suite

`bun run test:fault-injection` は crash recovery と永続化境界を重点的に検証します。ライフサイクル失敗、update runner の確認境界、StateStore と cleanup、AI/Anti-Raid Worker のミラーとライフサイクル、Disk I/O の追記・snapshot・ログファイル、flush barrier などが対象です。完全な一覧は [`package.json`](../../package.json) の script 定義を参照してください。[04 実行時の正式な不変条件](04-invariants.md) に関わる経路を変更した場合、この suite は必ず成功しなければなりません。

## 入室ログ性能 benchmark

`bun run perf:join-log` は入力を容量 250,000 件、overflow 300 件、warm-up 10,000 件に固定し、snapshot と capacity の baseline/current をそれぞれ 5 個の独立 Bun process で実行します。出力には完全な Bun version/revision、所要時間の中央値と範囲、強制 GC 前後の JSC heap/object 変化を記録します。baseline は最適化前の Map 全体 copy、全件 sort、完全な JSON 文字列生成を、同一 Bun build 内の前後比較専用として固定したものです。`Bun.gc(true)` はこの benchmark にしか存在せず、production control flow には入りません。入室 index、容量裁剪、snapshot serialization、分割 atomic write を変更した場合は必ず実行し、差が 5 sample の範囲に表れる noise より十分大きいことを確認します。

## Identity database 性能 benchmark

`bun run perf:identity-database` は一時 data root / SQLite で 4 つの production path を測ります。identity 8 件単位の 2 table cold read、128 row の明示 transaction write、main thread の 8,196-entry LRU hot read、Worker・JSONB transaction・exact ACK を通る write-through です。各 operation を warm-up してから 5 個の独立 Bun process で sample し、Bun version/revision、throughput、batch latency、sample range / coefficient of variation、強制 GC 前後の JSC heap・extra memory・object・GC time を報告します。`--single-process` は同じ measurement process 内で各 operation を 3 回反復し、round 間の retained growth を調べますが、独立 process 比較の代わりではありません。`Bun.gc(true)` は計時外の診断専用です。identity LRU、cold prefetch、encoding、transaction batch、ACK、Worker replay を変えた場合に実行し、同じ Bun build の差を sample noise と heap/GC の両方で判断します。

## コミット手順

1. 開発は `dev` ブランチで行い、`master` へ直接コミットしません。`master` へのマージは squash のみで、1 つの変更セットを 1 コミットにまとめます。ブランチ規約は [`AGENTS.md`](../../AGENTS.md) の「分支与提交」を参照してください（ここでは繰り返しません）。
2. 開発中にユーザーがパラメータを変更する場合があります。編集直前にファイルを再度読み、未コミットの変更を上書きしないでください。
3. コミット前に `git diff --stat` 全体を確認し、無関係なファイルを混ぜません。
4. `bun run check` がすべて成功することを確認します。
5. Conventional Commits 形式（`feat(ai): ...`、`fix(runtime): ...`、`docs: ...`）を使い、subject は英語にします。
6. 各コミットは人間と AI の共同レビュー後にだけリポジトリへ入れます。ルート README の「Pure AI Development」で説明するプロジェクト規約です。

### README 指標の更新

3 言語の各プロジェクト README の badge と、上記のテスト数、assertion 数、カバレッジは実測値です。テスト、production モジュール、カバレッジ定義が変わった場合は次のように更新します。

```bash
bun run test:coverage 2>&1 | tail -5           # テスト数、ファイル数、expect() 数
bun run test:coverage 2>&1 | grep 'All files'  # 関数・行カバレッジ
```

以下はいずれも同じ実測値なので、1 か所直したら全部直します。

- **3 言語の README にある Tests / Coverage badge。** Coverage badge は常に `All files` の行カバレッジを使います。
- **カバレッジ図**：各 README「純 AI 開発」節の「プロジェクト品質」が参照する [`pictures/coverage_light.svg`](../../pictures/coverage_light.svg) と [`pictures/coverage_dark.svg`](../../pictures/coverage_dark.svg)。banner と同様、1 組を 3 言語の README が共用するため、両テーマのファイルの数値を一緒に更新します。
- **3 つの README の `<img alt>` 内の同等の文言。** 図は画像として読み込まれるため SVG 内部の `<title>` / `aria-label` は読み上げに届かず、alt が唯一の入口です。
- **3 言語の本文にある「このドキュメント版の実測値」。**

カバレッジとは別に、同じく静かに古くなる実測値が 2 組あります。

- **中国語の文字列リテラル数**（現在およそ 805 ソース行 / 78 ファイル）：3 言語 README の「言語について」注記と、3 言語の [06 よくある変更手順](06-modification-guide.md)「i18n を行わない」節に出てきます。ユーザー向け文言を増減したら数え直します。コメントを除き、TypeScript AST の文字列／template literal ノードが跨るソース行を数えます。backtick を grep で数えないでください——正規表現リテラル内の backtick が計数を狂わせます。
- **動作値**（確率、容量、時間）：README 内のこれらの数値は `packages/consts/` と一致させます。詳細は [06 よくある変更手順](06-modification-guide.md#動作パラメータの調整) を参照してください。

## リリース

このリポジトリは GitHub Actions に依存しません。リリース環境では `bun run release:check` を明示的な build または pre-deploy step としてください。ネットワーク接続可能な環境では `bun run audit:release` も実行します。ネットワーク失敗は監査未完了を意味し、脆弱性が 0 件という意味ではありません。CVE を無視する場合は理由と期限を記録します。永続化構造を変更するリリースでは、先に [06 よくある変更手順](06-modification-guide.md#永続化-schema-の変更) の migration を実行してください。

`master` への squash merge ごとに GitHub Release を 1 つ作成します。

1. remote tag を同期し、`gh release list` で現在の Latest Release tag を取得します。tag は `v` prefix を付けない `MAJOR.MINOR.PATCH` 形式に限定します。変更セット全体で最も高い semantic impact に従い、breaking change は `MAJOR`（`1.0.9` → `2.0.0`）、後方互換の新機能は `MINOR`（`1.0.9` → `1.1.0`）、修正・性能改善・refactoring・documentation のみの場合は `PATCH`（`1.0.9` → `1.0.10`）を増やします。
2. `master` の squash commit を push した後、その commit を指す immutable な annotated version tag を作成して push します。既存 tag の上書き、移動、再利用は禁止です。
3. `gh release create <tag> --verify-tag --target master ...` で英語の Release を作成します。Release notes は前回の Latest Release tag から現在の `master` までの差分だけを対象とし、少なくとも Highlights、Compatibility / Migration Notes、Validation を含めます。gate の数値は今回の実測値だけを使います。
4. tag の push 後に Release 作成が失敗した場合は、version を再度増やさず同じ tag で再試行します。`master`、tag、Release のすべてを確認してから、[`AGENTS.md`](../../AGENTS.md) の手順に従って `dev` を `master` に揃えます。

---

<div align="center">

[← 前のページ：04 不変条件](04-invariants.md) · [📚 開発者ドキュメント TOP](conntent-table.md) · [⬆️ トップへ戻る](#05-開発フローと品質ゲート) · [次のページ：06 変更レシピ →](06-modification-guide.md)

</div>
