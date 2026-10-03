# 05 開発フローと品質ゲート

<p align="center">
  <a href="../cn/05-dev-workflow.md">简体中文</a> · <a href="../en/05-dev-workflow.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="04-invariants.md">← 前のページ：04 不変条件</a> · <a href="06-modification-guide.md">次のページ：06 変更レシピ →</a>
</p>

---

## コマンド早見表

| コマンド | 役割 | 説明 |
| :--- | :--- | :--- |
| `bun run start` | ロングポーリング起動 | 本番環境エントリポイント |
| `bun run lint`<br>`bun run lint:fix` | ESLint 検査 / 自動修正 | コード規約を厳格に検査。ゲートでは一貫してキャッシュなしの `lint` を使用 |
| `bun run lint:fast` | ローカルキャッシュ付き ESLint | `--cache` 付き。ローカルの開発デバッグループでのみ使用 |
| `bun run typecheck` | TypeScript 型検査 | `tsc --noEmit --incremental`、完全 strict モード。増分情報は `tsconfig.tsbuildinfo` にキャッシュ |
| `bun run test` | 全量テスト | ファイル分離を強制（`bun test --isolate`） |
| `bun run test:random` | ランダム順全量テスト | 固定シードによるランダム順全量テスト。テスト間の状態残留やモック漏れの検出に使用 |
| `bun run test:coverage` | テスト + カバレッジ | 全量テストを実行し、全ソースコードのカバレッジ指標を集計 |
| `bun run check:install-script-syntax` | インストールスクリプト構文検査 | `bash -n` で `install.sh` と宣言済みの shell モジュールを解析し、実処理は実行しない |
| `bun run check:install-isolation` | インストーラー隔離検証 | 専用一時ルートで実際の `install.sh` フィクスチャを実行し、ロールバック、中断再開、バックアップ保持、認証情報隔離を検証 |
| `bun run check:conventions` | リポジトリ規約自検 | `scripts/checkProjectConventions.ts` を実行し、定数、キャッシュ帰属、リンク、アーキテクチャ境界を検証 |
| `bun run check` | **全量統合ゲート** | 構文 + インストール隔離 + 規約自検 + lint + typecheck + カバレッジ + ランダム順テスト + ホットパスゲート（`master` マージ前必須） |
| `bun run check:coverage` | カバレッジ指標突合 | 3 言語 README、ドキュメント、SVG バッジの数値と実測値の一致を検証 |
| `bun run test:fault-injection` | 決定論的障害注入スイート | プロセスクラッシュ、異常停止、DB 瞬断、Worker 再生成時の復元整合性を検証 |
| `bun run perf:hot-paths` | ホットパス独立プロセス測定 | 単一ホットパスシナリオの測定（`--profile` によるサンプリング分析対応） |
| `bun run perf:hot-path-gate` | **ホットパス性能ゲート** | 厳選 12 ホットパスシナリオのメモリ/GC/JIT ハードゲート（`check` に組み込み済み） |
| `bun run perf:join-log` | 入室ログ性能ベンチマーク | 25 万件規模の入室ログ容量/スナップショット/追記記帳の独立プロセス比較ベンチマーク |
| `bun run perf:identity-database` | ID データベースベンチマーク | ID データベースの 6 項目にわたるコールド/ホット読み書きの独立プロセスベンチマーク |
| `bun run perf:full` | 全量性能ベンチマークスイート | 6 セクションで各 3 ラウンドの独立子プロセスを実行（`--write-doc` で 09 ドキュメントへ書き戻し） |
| `bun run perf:review` | 専門性能再検証 | ホットスポット、AI 返信/ペイロード/音声エンコード、完全コマンドチェーン、Disk I/O Worker 負荷を網羅 |
| `bun run build -- --version <tag>` | バイナリパッケージ構築 | プレフィックスなしのバージョン番号指定が必須。`dist/` 配布物と SHA-256 を出力 |
| `bun run release:check -- --version <tag>` | リリース前全量自検 | frozen lockfile + check + カバレッジ突合 + 障害注入 + バイナリ構築検証 |
| `bun run release:build -- --version <tag>` | 正式リリースパッケージ構築 | クリーンな `dev` ブランチ上で現在のプラットフォームの資産をネイティブ構築。他のプラットフォームはそれぞれ対応環境で構築 |
| `bun run release:verify -- --version <tag> --platforms <一覧>` | 配布パッケージ検証 | 全対象プラットフォームのパッケージ、SHA-256、バージョン、Git tree の一致を検証 |
| `bun run release:publish -- --version <tag> --platforms <一覧> --notes-file <ファイル>` | GitHub へ公開 | リモート参照を検証し、下書き作成、資産アップロードと検証を経て Latest として公開 |
| `bun run audit:release` | 依存関係セキュリティ監査 | 依存関係の脆弱性をスキャン（moderate 以上） |

---

## 品質ゲートの基準

- **インストーラー起動の隔離**：フィクスチャは独立した一時設定・データルートを使用し、システム管理、依存関係インストール、ネットワーク送信をモック化して、実際の `index.ts`、Worker、終了時の永続化を実行します。各 Worker は Bun `preload` でネットワーク代替を読み込み、天気には固定応答を返し、他の要求は拒否します。読み込み完了、ポーリング開始、SIGTERM 時の排空、ロックファイル削除を検証します。
- **ファイル長と走査範囲**：手書き TS・JS・shell ファイルは 1,024 行を超えると拒否し、512 行を超えたら分割を検討します。追跡済みファイルと未 stage の新規ファイルが対象で、Git が無視するデプロイデータは走査しません。インストーラーの構文検査は `install.sh` と宣言された全 shell モジュールを対象とします。
- **カバレッジの分母は全ソースコード**：`bun run check` はすべての本番ランタイムモジュールを分母に入れます。どのテストからも到達しないモジュールは 0% として計算します。関数・行カバレッジのしきい値はどちらも 95% であり、テストなしの新規モジュールは全体カバレッジを直接引き下げます。
- **ESLint + 完全 strict な tsc**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` をすべて有効化しています。本番コードでは `any` を禁止し、テストファイルのみを例外とします。
- **型 import は独立して宣言**：ソース・スクリプト・テストは独立した `import type` を使用します。ESLint の `no-restricted-syntax` が `import { value, type Shape }` などの inline type specifier を拒否します。
- **明示的な型注釈は lint で強制**：本番コード（`index.ts`、`packages/`、`scripts/`）の変数・引数・分割代入は `@typescript-eslint/typedef`、関数とコールバックの戻り値型は `@typescript-eslint/explicit-function-return-type` で強制し、いずれも文脈からの推論を認めません。`for...of` / `for...in` のループ変数は TypeScript の構文上注釈を付けられないため、ルール側が自動的に除外します。初期化子がすでにアロー関数である const も対象外です。テストファイルはこの制約を受けません。
- **規約自検（`check:conventions`）**：
  - **構造とリンク**：コード配置、ローカル Markdown リンク、ドキュメント内の名指しファイルの存在性、tracked ファイルの実行権限を検査。
  - **境界隔離**：定数とキャッシュ帰属（`packages/cache/<owner>/` スレッド単一所有権境界）を照合し、実際のモジュールグラフに基づいて Worker と Telegram 能力の隔離を検証。
  - **呼び出し安全**：`packages/workers/` 配下で生成される各タイマーハンドルの `unref()`、Node API 互換モジュールと `Buffer` ホワイトリストの検査、引数読み取りにおける `Bun.argv` の強制。
  - **ゲート突合**：Telegram 提示メッセージ削除例外、現在のコールド移行エントリ、障害注入スイート一覧、package.json の直接依存宣言、14 か所のカバレッジ宣言、性能記録を静的に突合。テスト内で大文字定数とリテラルを直接比較することを禁止。

---

### 依存関係のリリース待機期間

依存関係のインストールでは、`bunfig.toml` の 7 日間リリース待機期間（`minimumReleaseAge = 604800`）を常に使用します：
- 公開から 7 日未満の厳密なバージョンを一時的にパッケージ単位で除外できるのは、利用者がリスクを理解したうえで承認し、上流ソース、npm integrity、インストールスクリプトを検証した場合のみです。インストール完了後は直ちに除外を削除し、パッケージ名、理由、削除時刻を記録します。
- 現在の Bun ランタイムと `@types/bun` はともに 1.4.2 に固定されています。`packageManager` と `install.sh` がランタイムバージョンを共同でロックします。
- `bun run typecheck` は `@typescript/native`（`npm:typescript@~7.0.2`）が提供する TypeScript 7.0.2 コンパイラを使用します。`typescript` 依存関係は `npm:@typescript/typescript6@^6.0.2` を使用し、ロックファイルでは `@typescript/typescript6` 6.0.2 に解決されます。このパッケージは `@typescript/old` を介して TypeScript 6.0.3 のコンパイラ API を ESLint と規約検査に提供します。現在の `typescript-eslint` は 8.70.1 です。

---

### Bun の実行境界

- **実行モード**：プロジェクトは `bunfig.toml` で `run.bun = true` を設定しており、Node shebang を持つ依存 CLI も現在の Bun で実行されます。
- **画像コーデック**：Bun 内蔵の `Bun.Image` で画像変換を処理します（`packages/infra/image.ts`）：
  - JPEG/PNG はそのまま透過し、WebP/GIF は透明度を保って PNG に変換。GIF は先頭フレームを取得し、アニメーション WebP は先頭の `ANMF` フレームを静的 WebP に詰め直してからデコード。
  - 1 枚あたりのデコード画素数上限は `VISION_TRANSCODE_MAX_PIXELS`（8K UHD、7680×4320）で、超過時は拒否。コーデックは Bun ランタイムに同梱され、ネイティブ C++ モジュールへの依存は不要です。
- **ネイティブファイル I/O**：ファイル内容の書き込みと削除は `Bun.write` と `Bun.file` を優先使用。排他的書き込みは `Bun.write(Bun.file(handle.fd), content)` と fsync、アトミック rename を組み合わせて使用。ディレクトリ走査、パス、同期永続化、権限、hard link などは `node:` 互換モジュールを使用。
- **性能ベンチマーク校正**：ランタイム更新後は、同一の Bun version/revision を対象に性能校正を再実測する必要があります。

---

### このドキュメント版の実測値

`bun run test:coverage`：**5920 tests / 502 files / 320978 `expect()` calls**。全ソースコードの**関数カバレッジは 98.14%、行カバレッジは 98.54%**です。3 言語の各プロジェクト README の Coverage badge は行カバレッジを表示します。

---

## テスト分離

テストは必ず `bun run test`（すなわち `bun test --isolate`）で実行し、4 層の全自動分離保護を受けます：

1. **ファイルコンテキスト分離**：Bun はテストファイルごとに新しい global object を作成するため、`mock.module` やモジュールレベルのグローバル状態がテストファイルを跨いで汚染することはありません。
2. **一時データルート注入**：`test/preloadEnv.ts` は本番モジュールがロードされる前に、各分離環境へ独立した一時データルート（`mktemp -d`）を注入します。実ファイル I/O は本番ディレクトリ（`state.json`、`bot.lock`、`logs/`、`memory/`、`database/`）に一切触れず、テスト終了後に自動クリーンアップされます。
3. **独立した設定ルート**：`config_example/` を一時データルート配下の `config/` へ完全に複製し、`COPY_NINJIA_CONFIG_ROOT` 環境変数を通じてテスト用設定コピーを読み込ませます。認証情報はテスト用プレースホルダー値に自動置換されます。
4. **設定スナップショット同期**：`test/preload.ts` はテスト用コピー内の `agent.json`、`ad_samples.json`、`mood.json`、`stickers.json`、Bot の口調とタイムゾーン、ペルソナを一括してテスト isolate の holder へ adopt し、メインスレッドのメッセージ注入をシミュレートします。

### 主要テストスイートの分布

- **インストールとアップグレードテスト**：`test/scripts/installStartup.test.ts`、`test/scripts/installMigration.test.ts` がインストールスクリプト、空データベース初期化、メジャーバージョン間アップグレードを検証。
- **コールド移行テスト**：`test/scripts/migrateChatPersonaRemoval.test.ts` が 16.3.2 の schema v11 系譜だけを受け付けること、v11 → v13 のデータベース移行（Asia/Tokyo のタイムゾーンマーカーを含む）、移行前後の本番起動検証を確認。
- **メディアと出站テスト**：`test/aiChat/ai/mediaAdmission.test.ts`、`test/aiChat/ai/imageDescription.test.ts`、`test/infra/telegramWorkerCapabilities.test.ts` がマルチモーダル認識と Telegram 双方向出站ゲートを検証。
- **統一送信の統合テスト**：`test/infra/telegramOutboundIntegration.test.ts` は実際の client 初期化、throttler、送信 gate を使い、最内層の network response だけを置き換えます。メインスレッド、context、両 Worker、cron の同一 chat FIFO、category ごとの 429 再送、対象権限の問い合わせ、デフォルトアバターとファイル download の共有 backoff、cancel、停止時の drain を検証します。
- **セキュリティとログテスト**：`test/infra/loggerSecurity.test.ts` が認証情報のマスキングを検証。

---

## 障害注入スイート

`bun run test:fault-injection` は、アプリケーション/Worker ライフサイクル、ロック復元、返信容量とキャンセル、認証情報スナップショット、Telegram 出站と遅延削除の停止時排空、グループ teardown、入室ログ未確認ミラーと処分レシート、Anti-Raid タスク排空と認証復旧、双方向 Worker 再構築キャンセル、SQLite 起動時の行検証、コールド移行、ならびに Disk I/O の検査・原子的書き込み・復旧障害を網羅します。完全な一覧は [`package.json`](../../package.json) を参照してください。

- **規約検証**：`check:conventions` が登録済みハーネスと本番復旧/ライフサイクル境界の実参照パスを突合し、登録漏れを検査。
- **歓迎文案と通知**：`test/workers/antiRaid/verificationWelcome.test.ts` が実際の双方向プロトコル、メインスレッド一時メッセージ、削除境界を貫通検証。
- **`/wed` 対話状態機械**：25 グループ容量上限、teardown キューキャンセル、アバター読み込みメカニズム、停止時排空を検証。

---

## ホットパスゲート

`bun run perf:hot-path-gate` は `bun run check` のハードゲートです。`packages/consts/performance.ts` の `HOT_PATH_PROFILE_SCENARIOS` に従って、シナリオごとに 2 つの独立子プロセスを起動します：
- `steadyProfile`：`BUN_JSC_logGC=1` の下で正式ループの GC 停止時間比率と JIT 階層を測定。
- `retained`：プロファイラーの干渉がない状態で、実際の RSS ピーク、heapUsed ピーク、および full-GC 後のメモリ残存を測定。

### ゲート指標と段階区分

- **GC 停止比率予算**：利用可能な CPU コア数に応じて自動で段階区分（4 コア以上 25%、2〜3 コア 30%、単核 35%）。予算に 5 ポイントを加えた値を超過すると不合格と判定。
- **ハード指標ゲート**：GC 停止時間比率、サンプリング RSS ピークとプロセス生涯 RSS 高水位、サンプリング heapUsed 増加量、full-GC 後のヒープ/オブジェクト残存、DFG/FTL コンパイルの安定性。
- **読数の記録**：ベンチマーク校正記録は [`performance-result.json`](../../performance-result.json) に保存。`--write-result` を指定することで今回の読数を書き戻し可能。

---

## 入室ログ性能ベンチマーク

`bun run perf:join-log` は、容量 250,000 件、あふれ出し `FLUSH_MAX_ENTRIES`（256）件、ウォームアップ 10,000 件に固定し、スナップショット（`snapshot`）、容量（`capacity`）、追記記帳（`append-accounting`）の 3 経路の baseline/current をそれぞれ 5 つの独立 Bun プロセスで実行し、チェックサムを照合してスループットとヒープ変化を検証します。

---

## ID データベース性能ベンチマーク

`bun run perf:identity-database` は一時データルートと一時 SQLite 内で 6 つの実操作を測定します：2 テーブル読み取り（コールド/ホット）、128 行トランザクション書き込み（コールド/ホット）、メインスレッド 8,192 件 LRU ホット読み取り、およびライトスルー経路。ライトスルーシナリオは 4,096 個の主キーのワークセットに対して 65,536 回の操作を実行します。

---

## 個別シナリオと伝送ストレス検証

`bun run perf:review` は特定のシステムボトルネックに対して専門的かつ詳細な再検証を行います：
- `--hot-paths`：送信者、メッセージスライディングウィンドウ、権限読み取り、AI アクティブウィンドウ、認証待ちスナップショットなど 12 のシナリオを網羅。
- `--ai`：返信受け入れ判定、通常送信、容量負荷、Base64 変換、Opus 音声エンコードを測定。
- `--chains`：`ad-detect-command`、`ai-reply-command`、`cron-send-voice` の完全コマンドチェーンを実行。
- `--worker`：実際の Disk I/O Worker を通じたバッチ書き込み、グレースフルシャットダウン、25 グループ復元をストレステスト。
- `--cooldown` / `--text`：クールダウンテーブル操作とテキストサニタイズの専用ベンチマーク。クールダウンの identity は `STATE_MANAGED_CHAT_LIMIT` チャットへ分布させ、production の容量と窓で hit、更新、増加、満杯時の拒否、一括期限切れを測定します。
- `bun run perf:disk-transport`：単一バッチ ACK、通常排空、容量拒否メカニズムを測定。

---

## 全量パフォーマンスベンチマーク

`bun run perf:full` はリリース時または明示的な指示があった場合のみ実行され、失敗閾値は設けず、6 つのセクションをそれぞれ 3 ラウンドの独立子プロセスで実行して平均を算出します：
1. **コールドスタート**：フル投入フィクスチャ上での実起動・復元所要時間。
2. **本番ホットパス**：メッセージがメインパイプラインに入り配信完了するまでの高頻度経路所要時間。
3. **エンドツーエンド永続化チェーン**：メインスレッドから Worker を経由して最終永続化に至るレシート所要時間。
4. **SQLite とメインスレッドキャッシュ**：データベースと LRU キャッシュの対話。
5. **コンテナとアルゴリズム**：中核状態コンテナと計算所要時間。
6. **入室ログ容量線**：25 万件規模での入室ログ処理性能。

データはすべてリポジトリルートの `performance/`（自動クリーンアップ）に書き込まれ、`--write-doc` により `docs/{cn,en,ja}/10-performance.md` と `performance-result.json` へ同時に書き戻されます。

---

## コミット手順

1. **ブランチ原則**：開発は必ず `dev` ブランチで行い、`master` への直接コミットは禁止。
2. **コミット前確認**：`git diff --stat` で余分なファイルがないことを確認し、`git branch --show-current` でカレントブランチを確認。
3. **ローカル全量ゲート**：マージ前に必ず `bun run check` を実行して合格すること。永続化、シャットダウン、Worker ライフサイクルに関わる変更の場合は `bun run test:fault-injection` の合格も必須。
4. **コミットメッセージ規約**：Conventional Commits 形式（例: `feat(ai): ...`、`fix(runtime): ...`、`docs: ...`）に準拠。

### README 指標の同期

ユーザーがドキュメントや指標の同期を明示的に依頼した場合にのみ、今回のゲートの実測出力に基づいて以下を同期します：
```bash
bun run test:coverage 2>&1 | tail -5          # テスト数、ファイル数、expect() 数
bun run test:coverage 2>&1 | grep 'All files'  # 関数・行カバレッジ
```
- **3 言語 README のバッジ行**（Tests / Coverage）。
- **カバレッジベクトル画像**：`public/coverage_light.svg` と `public/coverage_dark.svg`。
- **3 言語 README 内の `<img alt>` 説明文言**。
- **3 言語本ドキュメント内の「このドキュメント版の実測値」段落**。

---

## リリース

毎回のリリースでは、次の順序でバイナリ資産を含む GitHub Release を作成します：

1. **バージョンとゲート**：リモート tag を同期し、`gh release list` で Latest Release を確認します。`v` プレフィックスのない未使用の `MAJOR.MINOR.PATCH` tag を選びます。`dev` 上の開発を完了して `bun run check` を通過させ、永続化、停止処理、Worker ライフサイクルを変更した場合は `bun run test:fault-injection` も実行します。
2. **ベンチマーク読数**：本リポジトリのサービスプロセスと、同じマシン上の他の高負荷処理を停止します。ゲート終了後、マシンがアイドルになってから `bun run perf:full -- --write-doc` を実行し、3 言語の 10 パフォーマンスページと `performance-result.json` の読数をコードとともに `dev` へコミットします。
3. **プラットフォームごとのネイティブ構築**：今回宣言する**各プラットフォームの環境**で、同一の Git tree と Bun version/revision、クリーンでコミット済みの `dev` を使用し、`bun run release:build -- --version <tag>` を実行します。各実行で作られるのは現在のプラットフォームのパッケージと `.sha256` のみです。全資産を一つのディレクトリへ集めます。
4. **収集済み資産の検証**：同じ Git tree のクリーンな作業ツリーで、宣言したプラットフォームの完全な一覧を検証します。いずれかの資産が欠けていれば停止します：
   ```bash
   bun run release:verify -- --version <tag> --platforms <カンマ区切りのプラットフォーム一覧> --directory <集約ディレクトリ>
   ```
5. **マージとリモート参照**：デプロイ保護の Git 事前確認を行い、`git merge --squash` で `master` にマージして単一のコミットを作ります。その Git tree が構築時と一致することを確認します。`master` をプッシュした後、そのコミットに annotated version tag を作り、別途プッシュします。
6. **公開と確認**：前回の Latest Release からの増分を、Highlights、Compatibility / Migration Notes、Validation を含む英語のリリースノートにまとめます。次のコマンドを実行し、Latest 状態、リモート参照、宣言した全資産のダウンロード検証を確認します：
   ```bash
   bun run release:publish -- --version <tag> --platforms <カンマ区切りのプラットフォーム一覧> --notes-file <説明ファイル> --directory <集約ディレクトリ>
   ```
7. **`dev` の整列**：Release の成功をすべて確認した後、`git diff dev master --quiet` で tree を照合します。その後 `dev` 上で `git reset --hard master` と `git push --force-with-lease origin dev` を実行し、ローカルとリモートの `dev`、`master` が同じコミットを指すことを確認します。

---

<div align="center">

[← 前のページ：04 不変条件](04-invariants.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#05-開発フローと品質ゲート) · [次のページ：06 変更レシピ →](06-modification-guide.md)

</div>
