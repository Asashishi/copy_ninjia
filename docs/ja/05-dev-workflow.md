# 05 開発フローと品質ゲート

<p align="center">
  <a href="../cn/05-dev-workflow.md">简体中文</a> · <a href="../en/05-dev-workflow.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="04-invariants.md">← 前のページ：04 不変条件</a> · <a href="06-modification-guide.md">次のページ：06 変更レシピ →</a>
</p>

---

## コマンド早見表

| コマンド | 用途 |
| :--- | :--- |
| `bun run start` | ロングポーリングを開始 |
| `bun run lint` / `lint:fix` | ESLint の検査 / 自動修正 |
| `bun run lint:fast` | `--cache` 付きの ESLint。ローカルの編集ループ専用です。型を見る rule はファイルを跨ぐ一方 ESLint の cache はファイル単位で無効化されるため、依存先だけを変更しても依存元の警告は再報告されません。**gate では必ず cache なしの `lint` を使います** |
| `bun run typecheck` | 完全 strict mode で `tsc --noEmit --incremental` を実行。増分情報は `tsconfig.tsbuildinfo`（gitignore 済み）に置かれます。tsconfig や依存の型を変えると丸ごと無効化されるため、gate に入れても安全です |
| `bun run test` | ファイル分離を強制して全テストを実行 |
| `bun run test:random` | 固定 seed のランダム順で全テストを実行し、テスト間の残留を炙り出す |
| `bun run test:coverage` | テスト + 全ソースコードのカバレッジ |
| `bun run check:install-script-syntax` | `bash -n` で `install.sh` の shell 構文だけを解析し、インストール処理は実行しない |
| `bun run check:install-isolation` | `copy-ninjia-install-test-*` 専用の一時 fixture root で `install.sh` を実際に実行し（`scripts/checkInstallIsolation.ts`）、staging 失敗時の cleanup、`telegram.json` の rollback、中断後の再開、置換成功、symlink topology、未検証 backup の保持、資格情報の分離を検査。実際の deploy path には一切触れない |
| `bun run check:conventions` | `scripts/checkProjectConventions.ts` でリポジトリ規約を検査 |
| `bun run check` | install-script-syntax + install-isolation + conventions + lint + typecheck + coverage + hot path gate の 7 段。**コミット前に必須** |
| `bun run check:coverage` | いまカバレッジを計測し、3 言語 README の badge/alt、本ページ 3 部、カバレッジ画像 2 枚の数値が実測と一致するか照合。テスト全体を再実行するため `check` には含めない |
| `bun run test:fault-injection` | 決定論的 fault injection suite |
| `bun run perf:hot-paths` | 単一の hot path シナリオを独立 process で測定（`--profile` で sampling 分析） |
| `bun run perf:hot-path-gate` | `HOT_PATH_PROFILE_SCENARIOS` で厳選した 10 個の hot path シナリオの memory/GC/JIT gate（registry には 30 個あり、残りは `perf:full` のみ）。`check` に組み込み済み。`--write-result` で今回の読数を repository root の `performance-result.json` に記録 |
| `bun run perf:join-log` | 入室ログ 250,000 件上限で capacity・snapshot・append-accounting の独立 process 比較 benchmark を実行 |
| `bun run perf:identity-database` | identity database の cold/hot な読み書き 6 項目を独立 process で benchmark |
| `bun run perf:full` | 6 セクション × 3 ラウンドの全量 benchmark。リリース時と明示指示時のみ実行し、`--write-doc` で 3 言語の 09 パフォーマンスページと `performance-result.json` の `fullSuite.lastRun` を同時に更新 |
| `bun run migrate:qa-thumbnail` | `state.json` から退場した `global.assets.qaThumbnailUrl` を取り除く停止時 cold migration |
| `bun run migrate:temporary-whitelist` | 停止中の共有 SQLite を v5 → v7 の直接 edge で移行する cold migration。v6 は同じ migration の再開可能な intermediate lineage のみ |
| `bun run release:check` | frozen lockfile install + check + カバレッジ数値の照合 + fault injection。リリース前に必須 |
| `bun run audit:release` | moderate 以上の依存関係脆弱性を監査 |

## 品質ゲートの基準

- **カバレッジの分母は全ソースコード**：`bun run check` はすべての production runtime モジュールを分母に入れます。どのテストからも到達しないモジュールは 0% として計算します。関数・行カバレッジのしきい値はどちらも 90% なので、テストなしの新規モジュールは全体カバレッジを直接下げます。
- **ESLint + 完全 strict な tsc**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` をすべて有効化しています。production コードでは `any` を禁止し、テストだけを例外とします。
- **明示的な型注釈は lint で強制**：production コード（`index.ts`、`packages/`、`scripts/`）の変数・引数・分割代入は `@typescript-eslint/typedef`、関数とコールバックの戻り値型は `@typescript-eslint/explicit-function-return-type` で強制し、いずれも文脈からの推論を認めません。`for...of` / `for...in` のループ変数は TypeScript の構文上注釈を付けられないため、ルール側が自動的に除外します。初期化子がすでにアロー関数である const も対象外です。テストファイルはこの制約を受けません。
- **規約検査**：`check:conventions` はコード配置、Markdown のローカルリンク先、tracked 非スクリプトファイルの実行権限、定数、cache owner を検査し、実際の thread module graph で Worker/Telegram 境界を照合します。`packages/workers/` 配下で生成される各 timer handle の `unref()`、production コードと script の Node compatibility import、許可された `Buffer` method、`Bun.argv` を使うべき process argument、Telegram の cleanup／長期保持例外、現在の cold migration 入口、14 か所の coverage 宣言、3 言語の performance record も静的に照合します。コメント内の「`<module>.ts` の `<symbol>` を参照」という相互参照も同様に照合し、名指しされた module がその symbol を宣言も再 export もしていない場合は失敗します（`export *` 互換入口は 1 段だけ展開）。`check:coverage` は別途実測し、宣言値全体の陳腐化を検出します。
  module-level のリテラル定数とその組合せはドメイン `consts` に置き、関数 composition と cache owner は別に確認します。Node builtin は `node:` prefix の有無によらず同じ許可表を使います。動的 load、再 export、`require`、`process.hrtime` / `nextTick`、分割代入も検査し、型専用宣言は runtime 検査から除外します。

### 依存関係の release-age gate

依存関係の install では、`bunfig.toml` の 7 日間 release-age gate を常に使用します。公開から 7 日未満の厳密な version を一時的に package 単位で除外できるのは、利用者がリスクを理解したうえで承認し、upstream source・npm integrity・lifecycle script を検証した場合だけです。除外は install 直後に削除し、package 名・理由・削除時刻を記録します。Bun runtime は 1.4.1、`@types/bun` は 1.4.0 に固定します。version gate は major/minor の一致を要求し、runtime の patch version は `packageManager` と `install.sh` が共同で固定します。

### このドキュメント版の実測値

`bun run test:coverage`：**3179 tests / 321 files / 123010 `expect()` calls**。全ソースコードの**関数カバレッジは 97.12%、行カバレッジは 97.38%**です。3 言語の各プロジェクト README の Coverage badge は行カバレッジを表示します。

## テスト分離

テストは必ず `bun run test`、つまり `bun test --isolate` から実行し、4 層で保護します。

1. **ファイル分離**：Bun はテストファイルごとに新しい global object を作成するため、`mock.module` とモジュールレベル状態がほかのテストファイルを汚染しません。`--parallel` は有効にしていないので、各ファイルが別プロセスを占有するとは説明しません。
2. **一時データルート**：`test/preloadEnv.ts` は production モジュールがロードされる前に isolate ごとの独立した一時データルートを注入します。mock されていない実ファイル I/O も一時ディレクトリだけを読み書きし、production の `state.json`、`bot.lock`、`logs/`、`memory/`、`database/` には触れません。終了後に一時ディレクトリを削除します。**path 注入を別 file に分けている**のは、ESM が import を同 file の文より先に評価するためです。`test/preload.ts` が production モジュールを static import した時点で、file 内に書いた環境変数の代入はすでに手遅れになり、`CONFIG_ROOT` は開発機の実デプロイディレクトリを指してしまいます。
3. **読み取り専用の設定ルート**：同じ注入は `COPY_NINJIA_CONFIG_ROOT` をリポジトリ内の `config_example/` に向けます（`packages/consts/paths.ts` の `CONFIG_ROOT` を参照）。デプロイ用の `config/` はバージョン管理外なので、この層はクリーンな checkout でもテストが走ることを保証しつつ、テストとテスト Worker が開発機の実 Telegram / feature 設定を読むのを防ぎます。identity database は前項の一時 data root で隔離されます。この環境変数はテスト専用でデプロイ用のスイッチではないため、README の環境変数表には載せません。
4. **agent 設定 snapshot**：`agent.json` は runtime path が disk から読まない唯一のデプロイ入力です（実 process では main thread が parse し、各 Worker へ init message で渡します。[04 実行時の権威的制約](04-invariants.md) を参照）。テスト isolate はその message を受け取らないため、`test/preload.ts` が同じ `config_example/agent.json` を isolate の holder へ一度 adopt します——「snapshot はすでに届いている」と等価です。未設定の経路を検証する test は自分で holder を空にします。

単一ファイルの debug で `bun test` を直接使うことはできますが、merge 前には必ず完全な `bun run check` を通してください。

### テスト作成の規約

- `packages/` のパスを反映します：`packages/foo/bar.ts` → `test/foo/bar.test.ts`。
- domain をまたいで共用する test double・fixture・harness は `test/helpers/` に、domain に依存しない汎用ユーティリティは `test/libs/helpers.ts` に置きます。テスト間で可変なモジュール状態を共有しないでください。分離機構によって、`--isolate` なしで実行されるまで問題が隠れる可能性があります。
- 実ファイル I/O を行うテストも、preload の一時データルートによって安全です。ただし `infra/storage` 周辺の mock 境界には注意してください。`infra/diskIO` だけを mock して `infra/storage` を実物のままにすると、実際の `saveStateInBackground` に到達する可能性があります。これは [`AGENTS.md`](../../AGENTS.md) が実行時ファイルの事前バックアップを求める状況です。

## Fault injection suite

`bun run test:fault-injection` は crash recovery と永続化境界を重点的に検証します。ライフサイクル失敗、update runner の確認境界、StateStore と cleanup、AI/Anti-Raid Worker のミラーとライフサイクル、Disk I/O の追記・snapshot・ログファイル、flush barrier などが対象です。完全な一覧は [`package.json`](../../package.json) の script 定義を参照してください。[04 実行時の正式な不変条件](04-invariants.md) に関わる経路を変更した場合、この suite は必ず成功しなければなりません。

## Hot path gate

`bun run perf:hot-path-gate` は `bun run check` の最終段で、コミットのたびに実行されます。`packages/consts/performance.ts` の `HOT_PATH_PROFILE_SCENARIOS` の各シナリオ・各繰り返しごとに独立した子プロセスを 2 つ起動します。`steadyProfile` は正式ループの GC と JIT だけを判定し、`retained` は profiler 自身のメモリ干渉がない状態で RSS、heapUsed のピーク、full GC 後の残存を判定します。

校準記録を [`performance-result.json`](../../performance-result.json) に保存し、`scripts/perf/hotPaths/gateResult.ts` が厳密に解析します。`gateRuntime.ts` は規約検査と hot-path 子 process の開始前に `packageManager`、現在の Bun version/revision、校準 build を照合し、不一致なら再測定を要求します。記録には process 数、各場面の遅延測定値、GC/RSS/保持量の hard limit を含みます。過去の `fullSuite` 結果は各回の時刻と Bun build を維持します。

`hotPathProfileGate` の節は双方向ですが、2 つの半分は owner が異なります。`calibration` は再校正後に人が手で編集し、gate からは read-only です。`lastRun` は直近の gate 読数を記録し、`bun run perf:hot-path-gate -- --write-result` を明示的に渡したときだけ上書きされるため、通常の `bun run check` は working tree を汚しません。write-back は `calibration` を 1 byte も触りません。gate が 1 回の実行結果から自身の判定基準を書き換えられるようにすることは、現在の性能で gate を溶接してしまうのと同じだからです。

同じ file のもう一つの節 `fullSuite.lastRun` は[全量 benchmark](#全量パフォーマンス-benchmark) のもので、`bun run perf:full -- --write-doc` が書き込みます。2 つの benchmark は別プロセス・別タイミングで走るため、書き込みはどちらも `scripts/perf/performanceResult.ts` の「全体を読む → 自分の枠だけ差し替える → 全体を書き戻す」を通ります。parse 結果から document を再構築する方式は取りません。そうすると後に走った方が、もう一方の節を `calibration` 配下の人間向け説明ごと消してしまうからです。

gate を設けている項目：GC sample 比率、sampling RSS ピークとプロセス生涯 RSS 高水位（同一上限を共有。後者は 2 つの tick の間に完全に収まる一時的な確保を捕捉できます）、sampling heapUsed 増加、full GC 後の JSC heap／heap 外メモリ／object 数の残存、最小 sample 数、そして production probe ごとの「warmup 後に DFG 到達済み」と「sampling 中に再コンパイルや脱最適化なし」。

出力のうち `Diagnostic` 接尾辞が付く項目は報告のみで gate しません。集計 FTL 比率はその一つで、純粋な leaf シナリオでは 100% 近く、非同期の主経路では一桁に留まります（sample に native Promise とスケジューラのフレームが混ざるため）。単一の閾値は両者に共通の意味を持ちません。`reoptRetries` の絶対値も同様で、sampling 開始前の JIT 安定ラウンドが既に連続ラウンドでの不変を要求しているため、残るのは warmup 期の履歴だけです。

`profile` / `retained` の接頭辞は、その読み取り値がどちらの子プロセス由来かを示します。両者の warmup 回数は一桁違う（profile 側は JIT 安定ラウンドを追加で回す）ため、混ぜて読んではいけません。

シナリオを追加・書き換えるときに**必ず守る収束ルール**が 1 つあります。被測定関数が文字列を返す場合、benchmark を `.length` だけで収束させてはいけません。JSC の rope は自身の長さを持つため、長さを読んでも materialize されません。それでは「連結ツリーを組んだ」ことを測っているだけで、「使える文字列を得た」ことにはなりません。同一入力で実測すると、転写レンダリングを行ごとの `+=` に変えた後は 2 つの収束方法で 42.0 対 57.5 µs/op（27%）の差が出ますが、変更前は 3.1% しか違いませんでした。長さだけで収束させる benchmark は、この変更を「42% 高速化」と読んでしまい、その半分以上はまだ実行していない作業です。収束は必ず `charCodeAt(length - 1)` のような強制解決で行ってください（`scripts/perf/hotPaths/transcriptScenarios.ts` の `transcript-render` を参照）。同じ理屈は「後でまとめて実体化する」あらゆる遅延構造に当てはまります。**benchmark は本番が実際に支払う工程を支払わなければなりません。** さもないと、その工程を経路から外してしまう regression が、失敗ではなく読み取り値の高速化として現れます。

## 入室ログ性能 benchmark

`bun run perf:join-log` は入力を容量 250,000 件、overflow 300 件、warm-up 10,000 件に固定し、snapshot・capacity・append-accounting の 3 経路の baseline/current をそれぞれ 5 個の独立 Bun process で実行します。親 process は sample ごとに両 variant の checksum を突き合わせ、一致しなければ全体を失敗させます。`append-accounting` の 1 batch は production の `JOIN_LOG_MAX_BUFFERED_ENTRIES` を使い、合計が他の 2 経路と同じ 25 万件規模になるまで繰り返します。出力には完全な Bun version/revision、所要時間の中央値と範囲、強制 GC 前後の JSC heap/object 変化を記録します。baseline は最適化前の実装——Map 全体 copy、全件 sort、完全な JSON 文字列生成（snapshot と capacity）、および 1 件ずつ再 serialize して byte 数だけを測る方式（append-accounting）——を、同一 Bun build 内の前後比較専用として固定したものです。`Bun.gc(true)` はこの benchmark にしか存在せず、production control flow には入りません。入室 index、容量裁剪、snapshot serialization、追記後の byte 記帳、分割 atomic write を変更した場合は必ず実行し、差が 5 sample の範囲に表れる noise より十分大きいことを確認します。

## Identity database 性能 benchmark

`bun run perf:identity-database` は一時 data root / SQLite で 6 つの production operation を測ります。identity 8 件単位の 2 table read（同一接続の hot read と、batch ごとに接続を開き直す cold read）、128 row の明示 transaction write（同じく hot 接続と cold 接続の 2 種）、main thread の 8,192-entry LRU hot read、Worker・JSONB transaction・exact ACK を通る write-through です。「cold」は接続の page cache と statement cache が空という意味で、OS の page cache を破棄したという意味ではありません。各 operation を warm-up してから 5 個の独立 Bun process で sample し、Bun version/revision、throughput、batch latency、sample range / coefficient of variation、強制 GC 前後の JSC heap・extra memory・object・GC time を報告します。`--single-process` は同じ measurement process 内で各 operation を 3 回反復し、round 間の retained growth を調べますが、独立 process 比較の代わりではありません。`Bun.gc(true)` は計時外の診断専用です。identity LRU、cold prefetch、encoding、transaction batch、ACK、Worker replay を変えた場合に実行し、同じ Bun build の差を sample noise と heap/GC の両方で判断します。

## 全量パフォーマンス benchmark

`bun run perf:full` はリリース時と明示的な指示があったときにのみ実行します。`bun run check` には含めず、失敗閾値も設けません。ホットパスのハードゲートは上記の `perf:hot-path-gate` のままです。6 つのセクションをそれぞれ独立プロセスで 3 ラウンド実行し、平均を報告します。コールドスタート、本番ホットパス、エンドツーエンドの永続化チェーン、SQLite とメインスレッドキャッシュ、コンテナとアルゴリズム、参加ログ容量線の 6 つです。各項目には平均に加えて最小値・最大値・変動係数も付き、CV が大きく跳ねた行は履歴と比較できません。

計測対象はすべて既存コードの再利用です。ホットパスは `perf:hot-paths` のシナリオと反復数をそのまま使い、ストレージは `perf:identity-database` の実装を呼び、容量線は `perf:join-log` の子プロセスを呼びます。チェーンは `recordJoinLog`、`persistChatState`、`queueIdentityPolicyWrite`、`postDiskIO`、`relayLogMessage` というメインスレッドの本番エントリから実際の Disk I/O Worker を駆動し、永続化の完了応答までを計測します。さらに**コマンド全体**を計測する 2 本があります。`ad-detect-command` は `enqueueAdCandidate` から `runAdDetectBatch`、そしてメインスレッドの `handleAdDetected` による処理の排出まで、`ai-reply-command` は `recordChatMessage` と `generateAndSendReply` から返信が実際に送信されるまでです。この 2 本のモデル呼び出しと Telegram 送信は `scripts/perf/outboundGuard.ts` のプロセス内固定応答が返します——ベンチマークは実際のリクエストを一切発行せず、API 費用も発生しません。`ai-reply-command` はさらに送信前の擬人的な間を実測して差し引きます（基準は [09 パフォーマンス](09-performance.md)）。コールドスタートは満載のフィクスチャ上で `packages/app/lifecycle.ts` の init 順に段階ごとに計測し、通信を伴う処理と 2 つの業務 Worker の生成は含みません。

データはすべてリポジトリ直下の `performance/`（`.gitignore` 済み）に書き、設定は `config_example/` から読み、各ラウンドの終了後にツリーごと削除します。実行が終わればこのディレクトリには何も残りません。親プロセスは production の実装モジュールを一切 import しないため、実データルートへ書き込む手段を持ちません。`--write-doc` を付けると `docs/{cn,en,ja}/09-performance.md` の 3 言語ブロックを書き換えます。計測値と各セクションの定義は [09 パフォーマンスベンチマーク](09-performance.md) を参照してください。

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

- **中国語の文字列リテラル数**：数値は 3 言語の [06 よくある変更手順](06-modification-guide.md)「i18n を行わない」節にだけ書きます。3 言語 README の「言語について」注記はその節へリンクするだけで、数値は持ちません。ユーザー向け文言を増減したら数え直します。コメントを除き、TypeScript AST の文字列／template literal ノードが跨るソース行を数えます。backtick を grep で数えないでください——正規表現リテラル内の backtick が計数を狂わせます。
- **動作値**（確率、容量、時間）：README 内のこれらの数値は `packages/consts/` と一致させます。詳細は [06 よくある変更手順](06-modification-guide.md#動作パラメータの調整) を参照してください。

## リリース

このリポジトリは GitHub Actions に依存しません。リリース環境では `bun run release:check` を明示的な build または pre-deploy step としてください。ネットワーク接続可能な環境では `bun run audit:release` も実行します。ネットワーク失敗は監査未完了を意味し、脆弱性が 0 件という意味ではありません。CVE を無視する場合は理由と期限を記録します。永続化構造を変更するリリースでは、先に [06 よくある変更手順](06-modification-guide.md#永続化-schema-の変更) の migration を実行してください。

`dev` で gate が通過した後、サービスとほかの高負荷処理を停止してマシンが空くのを待ち、
`bun run perf:full -- --write-doc` を既定の 3 ラウンドで実行します。3 言語の
[09 パフォーマンスベンチマーク](09-performance.md) と `performance-result.json` の
`fullSuite.lastRun` を同時に更新し、両方をコード変更と一緒にコミットします。
全量 benchmark と `bun run check` は同時または連続して実行せず、間にマシンが空くのを待ちます。
性能比較は同一マシン・同一 Bun build で行います。ランタイム更新後の読数はその build の基準値であり、
build 間の差をコード最適化の効果として扱いません。失敗や異常値は原因を確認して再実行してから公開します。

`master` への squash merge ごとに GitHub Release を 1 つ作成します。

1. remote tag を同期し、`gh release list` で現在の Latest Release tag を取得します。tag は `v` prefix を付けない `MAJOR.MINOR.PATCH` 形式に限定します。変更セット全体で最も高い semantic impact に従い、breaking change は `MAJOR`（`1.0.9` → `2.0.0`）、後方互換の新機能は `MINOR`（`1.0.9` → `1.1.0`）、修正・性能改善・refactoring・documentation のみの場合は `PATCH`（`1.0.9` → `1.0.10`）を増やします。
2. `master` の squash commit を push した後、その commit を指す immutable な annotated version tag を作成して push します。既存 tag の上書き、移動、再利用は禁止です。
3. `gh release create <tag> --verify-tag --target master ...` で英語の Release を作成します。Release notes は前回の Latest Release tag から現在の `master` までの差分だけを対象とし、少なくとも Highlights、Compatibility / Migration Notes、Validation を含めます。gate の数値は今回の実測値だけを使います。
4. tag の push 後に Release 作成が失敗した場合は、version を再度増やさず同じ tag で再試行します。`master`、tag、Release のすべてを確認してから、[`AGENTS.md`](../../AGENTS.md) の手順に従って `dev` を `master` に揃えます。

---

<div align="center">

[← 前のページ：04 不変条件](04-invariants.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#05-開発フローと品質ゲート) · [次のページ：06 変更レシピ →](06-modification-guide.md)

</div>
