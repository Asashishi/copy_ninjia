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
| `bun run lint`<br>`bun run lint:fix` | ESLint 検査 / 自動修正 | コード規約を厳格に検査。品質ゲートでは一貫してキャッシュなしの `lint` を使用 |
| `bun run lint:fast` | ローカルキャッシュ付き ESLint | `--cache` 有効。ローカルの開発デバッグループでのみ使用 |
| `bun run typecheck` | TypeScript 型検査 | `tsc --noEmit --incremental`、完全 strict モード。増分情報は `tsconfig.tsbuildinfo` にキャッシュ |
| `bun run test` | 全量テスト | ファイル単位の完全分離を強制（`bun test --isolate`） |
| `bun run test:random` | ランダム順全量テスト | 固定シードによるランダム順テスト。テスト間の状態残留やモック漏れを検知 |
| `bun run test:coverage` | テスト + カバレッジ | 全量テストを実行し、全ソースコードのカバレッジ指標を集計 |
| `bun run check:install-script-syntax` | インストーラー構文検査 | `bash -n` で `install.sh` と全シェルモジュールを静的解析（実処理は非実行） |
| `bun run check:install-isolation` | インストーラー隔離検証 | 専用の一時環境で `install.sh` のテストフィクスチャを実行し、ロールバック、中断再開、バックアップ保持、認証情報隔離、サービス保護、起動監視を検証 |
| `bun run check:conventions` | プロジェクト規約自己検査 | `scripts/checkProjectConventions.ts` を実行し、定数定義、スレッド所有権、リンク整合性、アーキテクチャ境界を検証 |
| `bun run check` | **全量統合ゲート** | 構文検査 + インストーラー隔離 + 規約検査 + lint + typecheck + カバレッジ + ランダム順テスト + ホットパスゲート（`master` マージ前必須） |
| `bun run check:coverage` | カバレッジ指標突合 | 3 言語 README、ドキュメント、SVG バッジの数値と実測値の一致を検証 |
| `bun run test:fault-injection` | 決定論的障害注入スイート | プロセスクラッシュ、異常停止、DB 瞬断、Worker 再起動時の復元整合性を検証 |
| `bun run perf:hot-paths -- <シナリオ> [--profile]` | ホットパス独立プロセス測定 | 単一ホットパスシナリオの測定（`--profile` でサンプリングプロファイル出力） |
| `bun run perf:hot-path-gate` | **ホットパス性能ゲート** | 厳選ホットパスシナリオのメモリ / GC / JIT ハードゲート（`check` に組み込み済み） |
| `bun run perf:join-log` | 入室ログ性能ベンチマーク | 入室ログの容量境界 / スナップショット / 追記記帳の独立プロセスベンチマーク |
| `bun run perf:identity-database` | ID データベースベンチマーク | データベースのコールド / ホット読み書き、メインスレッド LRU キャッシュ、ライトスルー経路のベンチマーク |
| `bun run perf:full` | 全量性能ベンチマークスイート | 全セクションを規定ラウンド数で独立子プロセス実行（`--write-doc` で各言語の 10 ドキュメントと `performance-result.json` を更新） |
| `bun run perf:review` | 専門性能再検証 | ホットパス、AI 返信 / ペイロード / 音声エンコード、完全コマンドチェーン、Disk I/O 負荷を網羅 |
| `bun run build -- --version <tag>` | バイナリパッケージ構築 | プレフィックスなしのバージョン指定が必須。現在のプラットフォーム向け `dist/` 配布物と SHA-256 を生成 |
| `bun run release:check -- --version <tag>` | リリース前全量自検 | frozen lockfile + check + カバレッジ突合 + 障害注入 + バイナリビルド検証 |
| `bun run release:build -- --version <tag>` | 正式リリースパッケージ構築 | クリーンな `dev` ブランチ上で現在のプラットフォーム向け資産をネイティブビルド（他プラットフォームは各環境で個別実行） |
| `bun run release:verify -- --version <tag> --platforms <一覧>` | 配布パッケージ検証 | 全対象プラットフォームのパッケージ、SHA-256、バージョン、Git tree の整合性を検証 |
| `bun run release:publish -- --version <tag> --platforms <一覧> --notes-file <ファイル>` | GitHub Release 公開 | リモート参照検証、下書き作成、資産アップロード・ダウンロード検証を経て Latest として公開 |
| `bun run audit:release` | 依存関係セキュリティ監査 | 依存関係の脆弱性をスキャン（moderate 以上を検出） |

---

## 品質ゲートの基準

- **インストーラー起動の隔離**：フィクスチャは独立した一時設定・一時データルートを使用し、システム管理コマンド、パッケージマネージャー、ネットワーク通信をモック化して、実際の `index.ts`、Worker、終了時永続化を実行します。各 Worker は Bun の `preload` でモック化されたネットワークスタックを読み込み、天気 API には固定値を返し、それ以外の外部リクエストは安全に拒否します。起動完了、ポーリング開始、SIGTERM 時の安全な排空、ロックファイル解放が検証されます。
- **ファイル行数制限と走査対象**：手書きの TS / JS / シェルファイルは `MAX_SOURCE_LINES`（`scripts/conventions/fileLength.ts`）を超えてはならず、長大なファイルは分割が義務付けられます（[`AGENTS.md`](../../AGENTS.md) 参照）。Git 追跡対象および未ステージングの新規ファイルが検査対象となり、`.gitignore` されたデプロイデータは除外されます。インストーラー構文検査は `install.sh` と定義済みの全シェルモジュールを網羅します。
- **全ソースコードを分母とするカバレッジ計測**：`test/productionModules.test.ts` が `index.ts` および `packages/types/` を除く `packages/` 配下の全ランタイムモジュールをロードします。どのテストからも実行されなかったモジュールは 0% として分母に算入されます。関数・行カバレッジはともに `bunfig.toml` の `coverageThreshold` を満たす必要があります。テストを伴わない新規モジュールの追加は、全体カバレッジを直接低下させます。
- **ESLint + 完全 strict な tsc**：`tsconfig.json` で `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` を有効化しています。本番コードでは `any` の使用を禁止し（テストコードのみ例外）、`Promise.all` は `no-restricted-syntax` で禁止されているため、安全な `Promise.allSettled` による有界並行処理を用います。
- **型 import の明示的分離**：本番コード・スクリプト・テストのすべてで独立した `import type` を使用します。ESLint の `no-restricted-syntax` が `import { value, type Shape }` のようなインライン型指定を禁止しています。
- **明示的な型注釈の強制**：本番コード（`index.ts`、`packages/`、`scripts/`）の変数・引数・分割代入は `@typescript-eslint/typedef`、関数・コールバックの戻り値型は `@typescript-eslint/explicit-function-return-type` で強制され、文脈からの暗黙推論は認められません。`for...of` / `for...in` のループ変数は TypeScript の構文上型注釈を記述できないためルール側で自動除外されます。また、初期化子が完全注釈付きアロー関数である const も除外されます。テストコードはこの制限を受けません。
- **規約自己検査（`check:conventions`）**：
  - **構造とリンク**：ファイル行数上限、コード配置ルール、Markdown のローカルリンクおよび同一文書内アンカー、ドキュメント内のファイル参照記述の存在性、実行権限、ワンショットインストーラーのモジュール一覧とステップ番号の整合性を検査。
  - **境界とスレッド分離**：定数およびキャッシュのスレッド所有権（`packages/cache/<owner>/` の単一所有権境界）を照合し、モジュール依存グラフに基づいて Worker と Telegram クライアントの隔離を検証。環境変数の読み込みは `consts/paths.ts` と `consts/environment.ts` にのみ限定し、`consts/` は実行時に `consts` 以外へ依存せず（他の `packages/` モジュールは `import type` のみ）、`states/` は `consts`、`libs`、`types`、`states` 以外に依存せず、`infra/` は上位の業務層に逆依存せず、ベンチマーク親プロセスは純粋定数と型のみを import します。
  - **定数テーブルの制約**：オブジェクト要素を持つエクスポート定数テーブル（正規表現と関数値を除く）は、`test/consts/immutability.test.ts` で `@ts-expect-error` コメントの直後の行から参照されていなければなりません（`scripts/conventions/constImmutability.ts`）。要素がリテラル union のエクスポート配列テーブルは `exhaustiveList<U>()([...])`（`packages/consts/exhaustiveList.ts`）の形で書き、`U` は宣言した要素型と一致させ、引数は各要素を文字列または数値リテラルで並べます。型のメンバーを追加・削除してテーブルが追従していなければコンパイルに失敗します。意図的に部分集合だけを列挙するテーブルは `<相対パス>#<テーブル名>` で `scripts/conventions/constExhaustiveLists.ts` の `PARTIAL_LITERAL_TABLES` に登録し、無効になった登録もエラーとなります。
  - **安全な API 呼び出し**：`packages/workers/` 配下の全タイマーは `unref()` が必須です。Node 互換モジュールおよび `Buffer` は事前登録された用途のみ許可され、未使用の登録もエラーとなります。コマンドライン引数の取得には `Bun.argv` を強制します。ランタイムで import される外部パッケージはルート `package.json` に明示的に宣言されている必要があります。
  - **整合性突合**：Telegram 提示メッセージの遅延削除例外とトピック属性、コールドマイグレーションスクリプトと `package.json` の `migrate:*` 定義の一致、障害注入スイート一覧、カバレッジ測定値およびベンチマーク記録（3 言語ドキュメントと `performance-result.json` の完全一致）を静的検証します。コメント内の「`<モジュール>.ts` の `<シンボル>` を参照」という記述は、現存するシンボルを正確に指している必要があります。
  - **テストアサーション規約**：テストコード内で大文字定数や数値リテラルを直接ハードコードして比較することを禁止します。matcher の引数に `packages/consts` の文字列定数（長さ `STRING_CONSTANT_MIN_LENGTH` 以上）と同一のリテラルを書くこと、および漢字・仮名を `CONSTANT_TEXT_FRAGMENT_MIN_CJK` 文字以上含む文言の断片を書き写すことも禁止されます（期待値は定数そのもの、または template 定数から描画された固定部分を使用。`test/helpers/templateText.ts` 参照）。プロンプトの文言を検証する契約テストは `scripts/conventions/testAssertionFragments.ts` の `CONSTANT_TEXT_CONTRACT_EXEMPTIONS` に登録する必要があります。

---

### 依存関係のリリース待機期間

依存関係のインストールでは、`bunfig.toml` で規定された 7 日間のリリース待機期間（`minimumReleaseAge = 604_800`）を厳格に適用します：
- 待機期間を満たしていない緊急セキュリティ修正を取り込む場合、該当するパッケージ名 1 件のみを `install.minimumReleaseAgeExcludes` に一時追加し、インストール完了後ただちに削除します。`--minimum-release-age` オプションによる全体緩和は禁止されています。除外対象のバージョンは少なくとも 2 つの独立したセキュリティ情報源と照合し、npm registry の `integrity` ハッシュやインストールスクリプト、バックドアの不在を確認した上で、パッケージ名、理由（CVE 番号等）、削除日時を記録します。
- 使用する Bun ランタイムと `@types/bun` は、`package.json` に宣言されたバージョンに固定されています。`packageManager` と `install.sh` がランタイムバージョンを共同でロックします。
- `bun run typecheck` は `@typescript/native`（`npm:typescript@~7.0.2`）のコンパイラを使用します。また、ESLint および規約検査ツールに TypeScript 6 のコンパイラ API を提供するため、`npm:@typescript/typescript6@^6.0.2` が `@typescript/old` 経由で利用されます。

---

### Bun の実行境界

- **実行モード**：`bunfig.toml` で `run.bun = true` を指定しており、Node.js 向けの shebang を持つ依存 CLI もすべて現在の Bun ランタイム上で動作します。
- **画像コーデック**：Bun 内蔵の `Bun.Image` で画像変換を実行します（`packages/infra/image.ts`）：
  - JPEG / PNG はそのまま透過し、WebP / GIF は透明度を維持したまま PNG にトランスコード。GIF は先頭フレームを取得し、アニメーション WebP は先頭の `ANMF` フレームを静的 WebP に再構成してからデコード。
  - 1 枚あたりの最大デコード画素数は `VISION_TRANSCODE_MAX_PIXELS` で制限され、超過した場合はピクセルバッファ確保前に安全に拒否。コーデックは Bun ランタイムに内蔵されているため、ソースコード版・バイナリ配布版ともに `node_modules` のネイティブアドオンには依存しません。
- **ネイティブファイル I/O**：ファイル内容の読み書き・削除には `Bun.write` と `Bun.file` を優先使用します。`atomicWriteText` の排他的書き込みは `Bun.write(Bun.file(handle.fd), content)`、fsync、アトミック rename を組み合わせて実現しています。Disk I/O Worker の同期アトミック書き込み、ディレクトリ走査、パス操作、パーミッション管理、ハードリンク作成など、Bun ネイティブ API が提供しない操作にのみ `node:` 互換モジュールを使用します。
- **性能ベンチマークの再校正**：ランタイムのバージョン更新時は、同一の Bun バージョン / リビジョンを対象に性能キャリブレーションを再測定する必要があります。

---

### このドキュメント版の実測値

`bun run test:coverage`：**6269 tests / 526 files / 446227 `expect()` calls**。全ソースコードの**関数カバレッジは 98.24%、行カバレッジは 98.75%**です。3 言語の各プロジェクト README の Coverage badge は行カバレッジを表示します。

---

## テスト分離

テストは必ず `bun run test`（すなわち `bun test --isolate`）で実行され、完全自動の環境分離が行われます：

1. **ファイルコンテキスト分離**：Bun はテストファイルごとに独立したグローバルコンテキストを生成し、`mock.module` やモジュールスコープの可変状態が他のテストファイルへ波及・汚染することはありません。
2. **一時データルートの注入**：`test/preloadEnv.ts` は本番モジュールがロードされる前に、テストプロセス専用の独立した一時データルート（`mkdtempSync`）を作成して環境変数 `COPY_NINJIA_DATA_ROOT` に設定します。実際のファイル I/O は本番用ディレクトリ（`memory/`、`logs/`、`database/`、`bot.lock`）には一切触れず、テスト終了時にディレクトリツリーごと安全に削除されます。
3. **独立した設定ルート**：`config_example/` が一時データルート配下の `config/` へ自動複製され、`COPY_NINJIA_CONFIG_ROOT` によりテスト用コピーが読み込まれます。コピー内のプレースホルダー認証情報はテスト専用ダミー値に置換され、`g-auth.json` は除外され、`cron.json` は空のタスク配列に初期化されます。
4. **設定スナップショット同期と空データベース**：`test/preload.ts` はテスト用コピー内の `agent.json`、`ad_samples.json`、`mood.json`、`stickers.json`、`cron.json`、Bot のトーンスタイル、タイムゾーン、組み込みペルソナを一括してテストアイソレートの holder に adopt し、メインスレッドからの設定注入をシミュレートします。さらに一時データルート内にタイムゾーンマーカー付きの空の SQLite データベースを初期化し、各機能の readiness を有効化します。

### 主要テストスイートの分布

- **インストール・更新テスト**：`test/scripts/installStartup.test.ts`、`test/scripts/installMigration.test.ts` が、インストーラースクリプト、空データベース初期化、起動シーケンス、ならびに旧形式のデプロイ入力・グローバル状態・データベースを起動前に安全に拒否しデータを改変しないことを検証。
- **コールドマイグレーションテスト**：`test/scripts/migrateChatPersonaRemoval.test.ts` が、バージョン 16.3.2 由来のスキーマ（`CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION`）のみを受け付け、現行スキーマ（`IDENTITY_DATABASE_SCHEMA_VERSION`）へのデータベース移行（Asia/Tokyo タイムゾーンマーカー付与を含む）、および移行前後の起動検証を確認。
- **メディア・外部送信ゲートテスト**：`test/aiChat/ai/mediaAdmission.test.ts`、`test/aiChat/ai/imageDescription.test.ts`、`test/infra/telegramWorkerCapabilities.test.ts` がマルチモーダル認識と Telegram 送信ゲートの双方向通信を検証。
- **統一送信統合テスト**：`test/infra/telegramOutboundIntegration.test.ts` が、実体クライアント、送信ゲート、チャット別送信スケジューラを動作させ、最深層のネットワーク応答のみをモック化してテスト。メインスレッド、コンテキスト、両 Worker、cron からの同一チャット FIFO 順序、種別ごとの 429 リトライ、権限問い合わせ、アバターおよびファイル取得の共有バックオフ、キャンセル、シャットダウン時ドレインを検証。
- **セキュリティ・ログテスト**：`test/infra/loggerSecurity.test.ts` が機密認証情報のマスキングを検証。

---

## 障害注入スイート

`bun run test:fault-injection` は、アプリケーションおよび Worker のライフサイクル、ロック復元、返信キューの容量上限とキャンセル、認証情報スナップショット、Telegram 送信と遅延削除の停止時ドレイン、グループ teardown、入室ログ未コミットミラーと処分レシート、Anti-Raid タスクドレインと認証復旧、双方向 Worker 再構築キャンセル、SQLite 起動時バリデーションと停止時クローズ（残り書き込みのコミット、WAL checkpoint）、コールドマイグレーション、Disk I/O の整合性検査・アトミック書き込み・復旧時例外処理を網羅します。完全な一覧は [`package.json`](../../package.json) を参照してください。

- **規約検証**：`check:conventions` が、登録済みテストハーネスと本番の復旧・ライフサイクル境界の実パスを突合し、登録漏れがないことを検証。
- **入室歓迎メッセージと通知**：`test/workers/antiRaid/verificationWelcome.test.ts` が、双方向プロトコル、メインスレッド一時メッセージ、自動削除境界の貫通動作を検証。
- **`/wed` インタラクティブステートマシン**：グループ収容上限（`STATE_MANAGED_CHAT_LIMIT`）、teardown キューのキャンセル、アバター取得機構、停止時ドレインを検証。

---

## ホットパスゲート

`bun run perf:hot-path-gate` は `bun run check` に組み込まれたハードゲートです。`packages/consts/performance.ts` の `HOT_PATH_PROFILE_SCENARIOS` に基づき、シナリオごとに `HOT_PATH_PROFILE_REPEATS` 回ずつ 2 つの独立した子プロセスを起動して測定します：
- `steadyProfile`：`BUN_JSC_logGC=1` の下で定常ループを実行し、GC 停止時間の比率および JIT コンパイル階層を測定。
- `retained`：プロファイラーによる干渉を排除した状態で、実際の RSS ピーク、heapUsed ピーク、および full-GC 後のメモリ残存量を測定。

### ゲート指標と段階区分

- **GC 停止時間比率の予算**：利用可能な CPU コア数に応じて自動で段階設定されます（`HOT_PATH_GC_CPU_BUDGETS`）。単一プロセスが基準予算に `HOT_PATH_GC_SOFT_OVERRUN_PERCENT` を加えた値を超過すると不合格と判定。予算を超過してもハード上限に達しない場合はソフト警告のみを出力します。
- **ハード指標ゲート**：GC 停止時間比率のハード上限、サンプリング RSS ピーク、プロセス RSS ピーク、heapUsed 増加量、full-GC 後のヒープ / オブジェクト残存量、最小サンプル数、および本番プローブがウォームアップ段階で DFG コンパイラに到達していることを強制します。各ハード上限は [`performance-result.json`](../../performance-result.json) の `calibration.limits` に規定されています。
- **ソフト警告**：シナリオの中央値処理時間が `calibration.medianNsPerOpReportThresholds` の校正しきい値を超えた場合、または校正値が測定値に対して緩すぎる場合（`HOT_PATH_CALIBRATION_STALE_RATIO`）に、stderr へ警告を出力します（終了コードは変更しません）。
- **測定値の記録**：`calibration` は無負荷の専用マシンで手動再校正してコミットする基準値であり、ゲート自体は読み取り専用です。`lastRun` は `--write-result` オプションを渡した場合にのみディスクへ書き戻されます。

---

## 入室ログ性能ベンチマーク

`bun run perf:join-log` のフィクスチャ規模は本番定数に基づいています：容量境界は `JOIN_LOG_MAX_USERS_PER_CHAT_DAY`、フラッシュ閾値は `FLUSH_MAX_ENTRIES`、バッチ追記長は `JOIN_LOG_MAX_BUFFERED_ENTRIES`。固定の小規模ウォームアップ入力を経た後、スナップショット（`snapshot`）、容量境界（`capacity`）、追記記帳（`append-accounting`）の 3 経路について baseline と current を独立した Bun プロセスで交互に実行し、チェックサムの一致、スループット、ヒープ変動を検証します。

---

## ID データベース性能ベンチマーク

`bun run perf:identity-database` は一時データルートと一時 SQLite 上で、以下の実処理を順次測定します：メインスレッド LRU 読み取り、メインスレッドのライトスルー（実 Worker メッセージ、JSONB トランザクション、ACK 伝播）、ストレージ層のホット接続読み書き、コールド接続読み書き。フィクスチャ規模とサンプル数は `scripts/perf/identityDatabase/constants.ts` に定義されており、読み書き件数は本番の `IDENTITY_READ_CACHE_MAX_ENTRIES` と `IDENTITY_WRITE_BATCH_MAX_ENTRIES` に基づきます。各処理はプロセスごとに独立してサンプリングされ、測定区間の外側で GC、データ整合性検査、クリーンアップが実行されます。

---

## 個別シナリオと伝送ストレス検証

`bun run perf:review` は特定のシステムボトルネックに対して専門的な再検証を実施し、各項目を `FULL_SUITE_ROUNDS` ラウンドの独立プロセスで実行します。引数なしで実行した場合は `--hot-paths`、`--chains`、`--ai`、`--worker` を順次実行します：
- `--hot-paths`：送信者情報、メッセージスライディングウィンドウ、権限読み取り、AI アクティブウィンドウ、認証待ちスナップショット、有界レスポンス、登録ミドルウェアの各シナリオを網羅。
- `--ai`：返信受付判定、通常送信、容量負荷、Base64 変換、Opus 音声エンコードを測定。
- `--chains`：`ad-detect-command`、`ai-reply-command`、`cron-send-voice` の完全コマンドチェーンを実行。
- `--worker`：Disk I/O Worker を通じたバッチ書き込み、トランザクション ACK、Worker 再構築後の復旧（管理対象上限 `STATE_MANAGED_CHAT_LIMIT` グループ）を高負荷検証。
- `--cooldown` / `--text`：クールダウンテーブル操作およびテキストサニタイズの専用ベンチマーク（明示指定時のみ実行）。クールダウンの身元情報を `STATE_MANAGED_CHAT_LIMIT` グループに分散させ、本番の容量と時間窓でヒット、更新、増加、満杯時拒否、一括期限切れを測定。
- `bun run perf:disk-transport`：モック Worker を用い、メインスレッド業務チャネルの単一バッチ ACK、通常排空、キュー満杯時のオーバーヘッド、遅延、ヒープ消費を測定（Worker の clone やディスク待機時間は除外）。

---

## 全量パフォーマンスベンチマーク

`bun run perf:full` はリリース時または明示的な指示があった場合のみ実行されます。失敗しきい値は設けず、各セクションを独立した子プロセスで規定ラウンド数（`FULL_SUITE_ROUNDS`）実行し、平均値、最小値、最大値、変動係数を集計します：
1. **コールドスタート**：フルデータ投入環境における実際の起動・復元所要時間。
2. **本番ホットパス**：メッセージがメインパイプラインに届いてから配信完了するまでの高頻度処理の所要時間。
3. **エンドツーエンド永続化チェーン**：メインスレッドから Worker を経由してディスク永続化レシートが返るまでの時間、および広告検出、AI 会話、cron 音声などの完全コマンドチェーン。
4. **SQLite とメインスレッドキャッシュ**：データベースとインメモリ LRU キャッシュの連携性能。
5. **コンテナとアルゴリズム**：コアステートコンテナの操作および計算所要時間。
6. **入室ログ容量境界**：上限規模での入室ログ処理性能。

測定データはすべてリポジトリルートの `performance/`（各ラウンド完了後に自動削除）に書き出され、`--write-doc` を付与することで `docs/{cn,en,ja}/10-performance.md` および `performance-result.json` へ同時に反映されます。なお、`--rounds <n>` はローカル検証専用であり、規定外のラウンド数で測定した数値をドキュメントへ書き込んではなりません。

---

## コミット手順

1. **ブランチ運用**：`master` と `dev` のみを使用し、フィーチャーブランチは作成しません。すべての開発は `dev` 上で行い、`master` への直接コミットは禁止します。
2. **コミット前確認**：`git diff --stat` で不要な変更が含まれていないことを確認し、`git branch --show-current` でカレントブランチを確認した上で、`bun run lint && bun run typecheck` または `bun run check` を実行。
3. **マージ前ゲート**：`master` へマージする前に、必ず `bun run check` を全項目パスさせる必要があります。永続化、シャットダウン、Worker ライフサイクルに関わる変更の場合は `bun run test:fault-injection` の合格も必須です。ゲート失敗時のマージは禁止されています。
4. **マージ方式**：`master` へのマージは `git merge --squash` のみを用い、単一のスカッシュコミットを作成します。
5. **コミットメッセージ**：変更内容全体を網羅し、変更の根拠を明記します。`feat:`、`fix:`、`perf:`、`docs:` などのプレフィックスを用い、リリースコミットの場合は `release: <バージョン>` で開始します。

### README 指標の同期

ユーザーから明示的なドキュメント・指標更新の指示があった場合にのみ、今回のゲートの実測出力に基づいて以下を同期します：
```bash
bun run test:coverage 2>&1 | tail -5          # テスト数、ファイル数、expect() 呼び出し数
bun run test:coverage 2>&1 | grep 'All files'  # 関数・行カバレッジ率
```
- **3 言語の README バッジ行**（Tests / Coverage）。
- **カバレッジベクトル画像**：`public/coverage_light.svg` および `public/coverage_dark.svg`。
- **3 言語 README 内の `<img alt>` 説明文言**。
- **3 言語の各ドキュメント内の「このドキュメント版の実測値」段落**。

---

## リリース

各バージョンのリリース作業は、以下の手順を厳格に順守して実行します：

1. **バージョン決定と品質ゲート**：リモートのタグを同期し、`gh release list` で最新リリースを確認します。`v` プレフィックスのない未採番の `MAJOR.MINOR.PATCH` タグを決定します。`dev` ブランチで `bun run check` を通過させ、永続化・停止・Worker 関連の変更がある場合は `bun run test:fault-injection` も実行します。
2. **ベンチマーク測定値の更新**：同一マシン上の Bot プロセスおよび高負荷タスクをすべて停止します。マシンが無負荷になった状態で、規定ラウンド数の `bun run perf:full -- --write-doc` を実行し、3 言語の 10 パフォーマンスドキュメントおよび `performance-result.json` の測定値をコードとともに `dev` へコミットします。
3. **各プラットフォームでのネイティブビルド**：ビルド対象は `RELEASE_PLATFORMS`（`linux-x64`、`linux-arm64`、`linux-x64-musl`、`linux-arm64-musl`）に定義されたプラットフォームです。今回リリースする**各プラットフォームの実機環境**において、同一の Git tree、同一の Bun バージョンで、クリーンな `dev` ブランチから `bun run release:build -- --version <tag>` を実行します。各実行で生成された配布パッケージと `.sha256` ファイルを 1 つのディレクトリに集約します。
4. **集約資産の検証**：同一 Git tree のクリーンな作業ツリーにおいて、リリース対象プラットフォームの資産が揃っていることを検証します。宣言されたいずれかのプラットフォームの資産が不足している場合は作業を中断します。各パッケージの SHA-256、内包バージョン、プラットフォーム名、Git tree、Bun ビルド番号、必須ファイル、コールドマイグレーション CLI、`.map` や `node_modules` の非混入を厳密に照合します：
   ```bash
   bun run release:verify -- --version <tag> --platforms <カンマ区切りのプラットフォーム一覧> --directory <集約ディレクトリ>
   ```
5. **マージとタグ打ち**：デプロイ保護の事前確認を実施後、`git merge --squash` で `master` へマージして単一コミットを作成します。コミットの Git tree がビルド時と完全に一致することを確認します。`master` をプッシュし、そのコミットに対して注釈付きバージョンタグ（annotated tag）を作成してリモートへプッシュします。
6. **Release 公開と確認**：GitHub Release のタイトルと説明文は英語で記述し、前回リリースからの増分のみを記載します（Highlights、Compatibility / Migration Notes、Validation を含む）。テスト数およびカバレッジには今回の実測値を記載します。以下のコマンドを実行して、下書き作成、資産アップロード、ダウンロード検証を経て Latest として公開します：
   ```bash
   bun run release:publish -- --version <tag> --platforms <カンマ区切りのプラットフォーム一覧> --notes-file <説明ファイル> --directory <集約ディレクトリ>
   ```
   タグプッシュ後に Release の作成・アップロードで問題が発生した場合は、同一タグで同コマンドを再実行できます（不足している資産のみが補完され、同一ハッシュの既存資産は上書きされません）。公開後に資産の欠落やハッシュ不一致が検知された場合は、直ちに作業を停止し現場を保全します。
7. **`dev` ブランチの同期・整列**：すべての公開と検証が完了した後、`git diff dev master --quiet` でツリーの一致を確認します。続いて `dev` 上で `git reset --hard master` および `git push --force-with-lease origin dev` を実行し、ローカルおよびリモートの `dev` と `master` が同一のコミットを指す状態に整列させます。

---

<div align="center">

[← 前のページ：04 不変条件](04-invariants.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#05-開発フローと品質ゲート) · [次のページ：06 変更レシピ →](06-modification-guide.md)

</div>
