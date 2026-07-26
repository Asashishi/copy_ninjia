# 05 開発フローと品質ゲート

<p align="center">
  <a href="../05-dev-workflow.md">简体中文</a> · <a href="../en/05-dev-workflow.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="README.md">📚 開発者ドキュメント TOP</a> · <a href="04-invariants.md">← 前のページ：04 不変条件</a> · <a href="06-modification-guide.md">次のページ：06 変更レシピ →</a>
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
| `bun run release:check` | frozen lockfile install + check + fault injection。リリース前に必須 |
| `bun run audit:release` | moderate 以上の依存関係脆弱性を監査 |

## 品質ゲートの基準

- **カバレッジの分母は全ソースコード**：`bun run check` はすべての production runtime モジュールを分母に入れます。どのテストからも到達しないモジュールは 0% として計算します。関数・行カバレッジのしきい値はどちらも 90% なので、テストなしの新規モジュールは全体カバレッジを直接下げます。
- **ESLint + 完全 strict な tsc**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` をすべて有効化しています。production コードでは `any` を禁止し、テストだけを例外とします。
- **明示的な型注釈は lint で強制**：production コード（`index.ts`、`packages/`、`scripts/`）の変数・引数・分割代入は `@typescript-eslint/typedef`、関数とコールバックの戻り値型は `@typescript-eslint/explicit-function-return-type` で強制し、いずれも文脈からの推論を認めません。`for...of` / `for...in` のループ変数は TypeScript の構文上注釈を付けられないため、ルール側が自動的に除外します。初期化子がすでにアロー関数である const も対象外です。テストファイルはこの制約を受けません。
- **規約検査**：`check:conventions` はコード配置などのリポジトリ規約を lint より先に検査します。

### このドキュメント版の実測値

`bun run test:coverage`：**1032 tests / 132 files / 8870 `expect()` calls**。全ソースコードの**関数カバレッジは 94.44%、行カバレッジは 96.46%**です。ルート README の Coverage badge は行カバレッジを表示します。

## テスト分離

テストは必ず `bun run test`、つまり `bun test --isolate` から実行し、2 層で保護します。

1. **ファイル分離**：Bun はテストファイルごとに新しい global object を作成するため、`mock.module` とモジュールレベル状態がほかのテストファイルを汚染しません。`--parallel` は有効にしていないので、各ファイルが別プロセスを占有するとは説明しません。
2. **一時データルート**：`test/preload.ts` は production モジュールがロードされる前に isolate ごとの独立した一時データルートを注入します。mock されていない実ファイル I/O も一時ディレクトリだけを読み書きし、production の `state.json`、`bot.lock`、`logs/`、`memory/` には触れません。終了後に一時ディレクトリを削除します。

単一ファイルの debug で `bun test` を直接使うことはできますが、merge 前には必ず完全な `bun run check` を通してください。

### テスト作成の規約

- `packages/` のパスを反映します：`packages/foo/bar.ts` → `test/foo/bar.test.ts`。
- 共通 helper は `test/libs/helpers.ts` に置きます。テスト間で可変なモジュール状態を共有しないでください。分離機構によって、`--isolate` なしで実行されるまで問題が隠れる可能性があります。
- 実ファイル I/O を行うテストも、preload の一時データルートによって安全です。ただし `infra/storage` 周辺の mock 境界には注意してください。`infra/diskIO` だけを mock して `infra/storage` を実物のままにすると、実際の `saveStateInBackground` に到達する可能性があります。これは [`AGENTS.md`](../../AGENTS.md) が実行時ファイルの事前バックアップを求める状況です。

## Fault injection suite

`bun run test:fault-injection` は crash recovery と永続化境界を重点的に検証します。ライフサイクル失敗、update runner の確認境界、StateStore と cleanup、AI/Anti-Raid Worker のミラーとライフサイクル、Disk I/O の追記・snapshot・ログファイル、flush barrier などが対象です。完全な一覧は [`package.json`](../../package.json) の script 定義を参照してください。[04 実行時の正式な不変条件](04-invariants.md) に関わる経路を変更した場合、この suite は必ず成功しなければなりません。

## コミット手順

1. 開発は `dev` ブランチで行い、`master` へ直接コミットしません。`master` へのマージは squash のみで、1 つの変更セットを 1 コミットにまとめます。ブランチ規約は [`AGENTS.md`](../../AGENTS.md) の「分支与提交」を参照してください（ここでは繰り返しません）。
2. 開発中にユーザーがパラメータを変更する場合があります。編集直前にファイルを再度読み、未コミットの変更を上書きしないでください。
3. コミット前に `git diff --stat` 全体を確認し、無関係なファイルを混ぜません。
4. `bun run check` がすべて成功することを確認します。
5. Conventional Commits 形式（`feat(ai): ...`、`fix(runtime): ...`、`docs: ...`）を使い、subject は英語にします。
6. 各コミットは人間と AI の共同レビュー後にだけリポジトリへ入れます。ルート README の「Pure AI Development」で説明するプロジェクト規約です。

### README 指標の更新

ルート README の badge と、上記のテスト数、assertion 数、カバレッジは実測値です。テスト、production モジュール、カバレッジ定義が変わった場合は次のように更新します。

```bash
bun run test:coverage 2>&1 | tail -5           # テスト数、ファイル数、expect() 数
bun run test:coverage 2>&1 | grep 'All files'  # 関数・行カバレッジ
```

3 言語の README にある Tests / Coverage badge、各 README「純 AI 開発」節の「プロジェクト品質」が参照する [`docs/assets/coverage_light.svg`](assets/coverage_light.svg) と [`coverage_dark.svg`](assets/coverage_dark.svg)（banner と同様、1 組を 3 言語の README が共用します。両テーマのファイルの数値と、3 つの README の `<img alt>` 内の同等の文言を必ず一緒に更新してください。図は画像として読み込まれるため SVG 内部の `<title>`/`aria-label` は読み上げに届かず、alt が唯一の入口です）、そして 3 言語の本文にある「このドキュメント版の実測値」を同期します。いずれも同じ実測値なので、1 か所直したら全部直します。Coverage badge は常に `All files` の行カバレッジを使います。確率、容量、時間など README 内の動作値は `packages/consts/` と一致させます。詳細は [06 よくある変更手順](06-modification-guide.md#動作パラメータの調整) を参照してください。

## リリース

このリポジトリは GitHub Actions に依存しません。リリース環境では `bun run release:check` を明示的な build または pre-deploy step としてください。ネットワーク接続可能な環境では `bun run audit:release` も実行します。ネットワーク失敗は監査未完了を意味し、脆弱性が 0 件という意味ではありません。CVE を無視する場合は理由と期限を記録します。永続化構造を変更するリリースでは、先に [06 よくある変更手順](06-modification-guide.md#永続化-schema-の変更) の migration を実行してください。

---

<div align="center">

[← 前のページ：04 不変条件](04-invariants.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#05-開発フローと品質ゲート) · [次のページ：06 変更レシピ →](06-modification-guide.md)

</div>
