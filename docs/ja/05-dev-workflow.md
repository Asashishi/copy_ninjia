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
| `bun run test:random` | 固定 seed のランダム順で全テストを実行し、テスト間の残留を炙り出す。スタブの復位には `mockReset()` を使う。`mockClear()` は `mockResolvedValueOnce` のキューを消さないため、消費されなかった分が次のテストに漏れる。復位後は各スタブに実装を入れ直す |
| `bun run test:coverage` | テスト + 全ソースコードのカバレッジ |
| `bun run check:install-script-syntax` | `bash -n` で `install.sh` の shell 構文だけを解析し、インストール処理は実行しない |
| `bun run check:install-isolation` | `copy-ninjia-install-test-*` 専用の一時 fixture root で `install.sh` を実際に実行し（`scripts/checkInstallIsolation.ts`）、staging 失敗時の cleanup、`bot.json` の rollback、中断後の再開、置換成功、symlink topology、未検証 backup の保持、資格情報の分離を検査。実際の deploy path には一切触れない |
| `bun run check:conventions` | `scripts/checkProjectConventions.ts` でリポジトリ規約を検査 |
| `bun run check` | install-script-syntax + install-isolation + conventions + lint + typecheck + coverage + 固定 seed のランダム順全テスト + hot path gate の 8 段。**master へのマージ前に必須** |
| `bun run check:coverage` | いまカバレッジを計測し、3 言語 README の badge/alt、本ページ 3 部、カバレッジ画像 2 枚の数値が実測と一致するか照合。テスト全体を再実行するため `check` には含めない |
| `bun run test:fault-injection` | 決定論的 fault injection suite |
| `bun run perf:hot-paths` | 単一の hot path シナリオを独立 process で測定（`--profile` で sampling 分析） |
| `bun run perf:hot-path-gate` | `HOT_PATH_PROFILE_SCENARIOS` で厳選した 10 個の hot path シナリオの memory/GC/JIT gate（registry は 51 個で、残りは全量基準の manifest または個別 command で実行）。`check` に組み込み済み。`--write-result` で今回の読数を repository root の `performance-result.json` に記録 |
| `bun run perf:join-log` | 入室ログ 250,000 件上限で capacity・snapshot・append-accounting の独立 process 比較 benchmark を実行 |
| `bun run perf:identity-database` | identity database の cold/hot な読み書き 6 項目を独立 process で benchmark |
| `bun run perf:full` | 6 セクション × 3 ラウンドの全量 benchmark。リリース時と明示指示時のみ実行し、`--write-doc` で 3 言語の 09 パフォーマンスページと `performance-result.json` の `fullSuite.lastRun` を同時に更新 |
| `bun run perf:review` | 既存の 12 hot path、AI 返信・payload の 7 シナリオ、2 本の完全 command chain、実 Disk I/O Worker 負荷を各 3 独立ラウンドで検証。`--hot-paths` / `--ai` / `--chains` / `--worker` で選択。テキスト清掃とクールダウンの専用検証は `--text` / `--cooldown` を明示した場合のみ実行 |
| `bun run build -- --version <tag>` | バージョンの明示指定が必須で既定値なし。現在の Linux 向けバイナリを隔離検証後、`.map` を含まないアーカイブと SHA-256 ファイルを `dist/` へ出力 |
| `bun run release:check -- --version <tag>` | frozen lockfile install + check + カバレッジ数値の照合 + fault injection + バイナリ構築・検証。リリース前に必須。バージョン未指定・不正は依存関係のインストール前に拒否 |
| `bun run release:build -- --version <tag>` | クリーンでコミット済みの `dev` から正式版をネイティブ構築 |
| `bun run release:verify -- --version <tag> --platforms <一覧>` | 宣言した全プラットフォームのアーカイブ、SHA-256、版、Git tree、Bun build を照合 |
| `bun run release:publish -- --version <tag> --platforms <一覧> --notes-file <ファイル>` | push 済み参照を検証し、草稿の作成・再開、資産のダウンロード照合、Latest としての公開と再確認を実施 |
| `bun run audit:release` | moderate 以上の依存関係脆弱性を監査 |

## 品質ゲートの基準

- **インストーラー起動の隔離**：フィクスチャは独立した一時設定・データルートを使用し、システム管理、依存インストール、ネットワーク送信を mock 化して、実際の `index.ts`、Worker、終了時の永続化を実行します。各 Worker は Bun `preload` でネットワーク代替を読み込み、天気には固定応答を返し、他の要求は拒否します。読み込み完了、ポーリング開始、SIGTERM 時の排空、ロックファイル削除を検証します。
- **ファイル長と走査範囲**：手書き TS・JS・shell ファイルは 1,000 行を超えると拒否し、500 行を超えたら分割を検討します。追跡済みファイルと未 stage の新規ファイルが対象で、Git が無視する配備データは走査しません。インストーラーの構文検査は `install.sh` と宣言された全 shell モジュールを対象とします。
- **カバレッジの分母は全ソースコード**：`bun run check` はすべての production runtime モジュールを分母に入れます。どのテストからも到達しないモジュールは 0% として計算します。関数・行カバレッジのしきい値はどちらも 95% なので、テストなしの新規モジュールは全体カバレッジを直接下げます。
- **ESLint + 完全 strict な tsc**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` をすべて有効化しています。production コードでは `any` を禁止し、テストだけを例外とします。
- **型 import は独立して宣言**：ソース・script・test は独立した `import type` を使用します。ESLint の `no-restricted-syntax` が `import { value, type Shape }` などの inline type specifier を拒否します。`test/scripts/typeImportConventions.test.ts` は 3 種類のファイルで許可・拒否の境界を検証し、既存の `Promise.all` 禁止も確認します。
- **明示的な型注釈は lint で強制**：production コード（`index.ts`、`packages/`、`scripts/`）の変数・引数・分割代入は `@typescript-eslint/typedef`、関数とコールバックの戻り値型は `@typescript-eslint/explicit-function-return-type` で強制し、いずれも文脈からの推論を認めません。`for...of` / `for...in` のループ変数は TypeScript の構文上注釈を付けられないため、ルール側が自動的に除外します。初期化子がすでにアロー関数である const も対象外です。テストファイルはこの制約を受けません。
- **規約検査**：`check:conventions` はコード配置、Markdown のローカルリンク先、Markdown 内の「`<directory>/`（`a.ts`、`b.ts`）」という directory 一覧が名指しするファイルの存在（directory 名が一意に解決しない場合は skip）、tracked 非スクリプトファイルの実行権限、定数、cache owner を検査し、実際の thread module graph で Worker/Telegram 境界を照合します。`packages/workers/` 配下で生成される各 timer handle の `unref()`、production コード・script・test の Node compatibility import、許可された `Buffer` method、`Bun.argv` を使うべき process argument、Telegram の cleanup／長期保持例外、現在の cold migration 入口、fault injection suite の一覧、実行時の bare import がルート `package.json` に直接宣言されていること（hoist された推移的依存でしか解決できない package は失敗。runtime builtin と型だけの参照は対象外で、package subpath は所属 package に帰属）、14 か所の coverage 宣言、3 言語の performance record も静的に照合します。コメント内の「`<module>.ts` の `<symbol>` を参照」という相互参照も同様に照合し、名指しされた module がその symbol を宣言も再 export もしていない場合は失敗します（`export *` 互換入口は 1 段だけ展開）。`check:coverage` は別途実測し、宣言値全体の陳腐化を検出します。
  module-level のリテラル定数とその組合せはドメイン `consts` に置き、関数 composition と cache owner は別に確認します。module-level の Map、Set、WeakMap、WeakSet、AsyncLocalStorage と holder は owner 付きの `packages/cache/` にだけ宣言できます。Node builtin は `node:` prefix の有無によらず同じ許可表を使います。動的 load、再 export、`require`、`process.hrtime` / `nextTick`、分割代入も検査し、型専用宣言は runtime 検査から除外します。

  Node API 検査は `process.getBuiltinModule`、`globalThis.Buffer` とリテラル添字形式を対象にします。`Buffer.byteLength` などの例外は module・symbol・用途ごとに登録します。`@grammyjs/runner` は SDK 対照テスト用の開発依存で、production の取得処理はプロジェクトの offset 確認境界を使います。

### 依存関係の release-age gate

依存関係の install では、`bunfig.toml` の 7 日間 release-age gate を常に使用します。公開から 7 日未満の厳密な version を一時的に package 単位で除外できるのは、利用者がリスクを理解したうえで承認し、upstream source・npm integrity・lifecycle script を検証した場合だけです。除外は install 直後に削除し、package 名・理由・削除時刻を記録します。Bun runtime は 1.4.2、`@types/bun` は 1.4.1 に固定します。両者の major/minor は同じで、runtime の patch version は `packageManager` と `install.sh` が共同で固定します。

TypeScript の依存範囲は `~6.0.3`（6.0.x）で、lockfile のバージョンは `6.0.3` です。現在の `typescript-eslint` が宣言する TypeScript の互換範囲は `>=4.8.4 <6.1.0` です。

### Bun の実行境界

`bunfig.toml` の `run.bun = true` により、Node shebang を持つ依存 CLI も現在の Bun で実行します。画像変換は `packages/infra/image.ts` が必要なときに `sharp` を読み込みます。視覚入力の JPEG/PNG はそのまま渡し、WebP/GIF は PNG に変換します。アニメーションは透明度を保った先頭フレームだけを読みます。サムネイルは縦横比を保ち、小さい画像の拡大や EXIF 方向による自動回転を行わず、透明な画素を黒い背景に合成したうえで、寸法と容量の上限を満たすまで JPEG の品質を順に試します。ネイティブ API への置き換えでは、同じ入力形式・透明度・アニメーションフレーム・失敗時の意味論を満たす必要があります。

ファイル内容の書き込みと通常ファイルの削除には [`Bun.write` と `Bun.file`](https://bun.com/docs/runtime/file-io) を使用します。排他的作成後の書き込みは `Bun.write(Bun.file(handle.fd), content)` で行い、元のハンドルで fsync、close、原子的公開を完了します。ディレクトリ走査、パス、同期永続化、権限、hard link など Bun のネイティブ API が必要な意味論を提供しない操作には `node:` API を使用します。`AsyncLocalStorage`、PEM 秘密鍵の解析、割り当てを伴わない UTF-8 バイト数の計算にも Bun 対応の互換 API を使用します。Disk I/O の起動時・深夜・日付切り替え時の保守は、各非同期削除を待ってから次の領域へ進み、永続化の応答を返します。

ランタイムの更新後は、同じ Bun version/revision で性能校正を再測定する必要があります。それまでは規約チェックとホットパスゲートが以前の校正記録を拒否します。ベンチマークなしで更新を検証する場合は、インストール隔離、lint、typecheck、カバレッジ、障害注入テストを個別に実行します。これは完全な `check` の成功には該当せず、以前の性能測定値も更新しません。

### このドキュメント版の実測値

`bun run test:coverage`：**5072 tests / 441 files / 192270 `expect()` calls**。全ソースコードの**関数カバレッジは 97.01%、行カバレッジは 98.12%**です。3 言語の各プロジェクト README の Coverage badge は行カバレッジを表示します。

## テスト分離

テストは必ず `bun run test`、つまり `bun test --isolate` から実行し、4 層で保護します。

1. **ファイル分離**：Bun はテストファイルごとに新しい global object を作成するため、`mock.module` とモジュールレベル状態がほかのテストファイルを汚染しません。`--parallel` は有効にしていないので、各ファイルが別プロセスを占有するとは説明しません。
2. **一時データルート**：`test/preloadEnv.ts` は production モジュールがロードされる前に isolate ごとの独立した一時データルートを注入します。mock されていない実ファイル I/O も一時ディレクトリだけを読み書きし、production の `state.json`、`bot.lock`、`logs/`、`memory/`、`database/` には触れません。終了後に一時ディレクトリを削除します。**path 注入を別 file に分けている**のは、ESM が import を同 file の文より先に評価するためです。`test/preload.ts` が production モジュールを static import した時点で、file 内に書いた環境変数の代入はすでに手遅れになり、`CONFIG_ROOT` は開発機の実デプロイディレクトリを指してしまいます。
3. **専用の設定ルート**：同じ注入は `config_example/` をその data root 下の `config/` へ丸ごと複製し、`COPY_NINJIA_CONFIG_ROOT` をその複製に向けます（`packages/consts/paths.ts` の `CONFIG_ROOT` を参照）。`agent.json` と `bot.json` の placeholder 資格情報は複製の中だけテスト専用値に置き換えられ、厳格な parser はこれを受け付けます。`g-auth.json` の例は installer と同じく複製に含めず、翻訳の可用性は preload と各テストが設定します。複製は data root ごと削除されます。デプロイ用の `config/` はバージョン管理外なので、この層はクリーンな checkout でもテストが走ることを保証しつつ、テストとテスト Worker が開発機の実 Telegram / feature 設定を読んだり書き換えたりするのを防ぎます。identity database は前項の一時 data root で隔離されます。この環境変数はテスト専用でデプロイ用のスイッチではないため、README の環境変数表には載せません。
4. **agent 設定 snapshot**：Worker が持つデプロイ設定を disk から読むのは main thread だけです（実 process では main thread が parse し、各 Worker へ init と hot reload の message で渡します。[04 実行時の権威的制約](04-invariants.md) を参照）。テスト isolate はそれらの message を受け取らないため、`test/preload.ts` が前項の複製から `agent.json`、`ad_samples.json`、`mood.json`、`stickers.json` とペルソナを isolate の holder へ一度 adopt します——「snapshot はすでに届いている」と等価です。未設定の経路を検証する test は自分で holder を空にします。

`test/scripts/installStartup.test.ts` は installer の隔離 fixture を再利用し、独立した一時設定・データルートで `install.sh`、`bun run start`、実際の Worker を動かします。Telegram 応答とシステムサービスコマンドはテスト用の代替処理が担当します。AI 無効、有効な AI 設定、再インストールと再起動、不正な任意設定の接続前拒否を検証し、正常停止とインスタンスロック解放も確認します。

installer 隔離検査は unit data root の欠落・不一致、`EnvironmentFiles` と関連する `PassEnvironment` / `UnsetEnvironment` の拒否、起動後の `NRestarts` 基準値と減少拒否、既存設定再入力時の mode 保持も検証します。system command はすべて fixture が受け持ち、preflight 失敗は設定・unit・実行データへの書き込みより前に発生する必要があります。

`test/scripts/installMigration.test.ts` は 12.1.0 の mock バックアップから cold migration、mapping 産物の手動配置、ソースインストール、実際の起動までを検証し、未移行の identity 入口を拒否します。ビルド検証の `scripts/checkBinary.ts` は同梱 migration tool、バイナリインストール、起動を同様に確認し、対象プロセスは system Bun を使いません。両者は `scripts/fixtures/migrationDeployment.ts` を共用し、schema v10 の 2 種類の正規系譜、空でない WAL、全業務テーブル、state 主副本、Google 資格情報、配置設定、画像内容を扱います。元バックアップのハッシュ、mode、所有者、link 構造を維持します。データベース移行は宣言した権限 bit の追加、version の更新、系譜 entry の追加だけを行い、その他の業務内容を保持します。

資格情報には一時生成した RSA 鍵を使用します。`test/scripts/migrateBotConfig.test.ts` は BOM の保持、資格情報の不正・欠落、出所の競合、産物の上書き拒否も確認します。ソース移行インストールのテストは fault injection にも含まれます。ソース経路は `bun test --isolate test/scripts/installMigration.test.ts test/scripts/migrateBotConfig.test.ts`、バイナリ経路は `bun run build -- --version <tag>` で検証できます。

単一ファイルの debug で `bun test` を直接使うことはできますが、merge 前には必ず完全な `bun run check` を通してください。

### テスト作成の規約

- `packages/` のディレクトリ構成を反映します：`packages/foo/bar.ts` のテストは `test/foo/` に置きます。ファイル名は 1 対 1 でなくて構いません。1 つのモジュールのテストを主題ごとに複数ファイルへ分けるのは普通です（`packages/commands/gag.ts` → `test/commands/gag.lifecycle.test.ts`、`gag.ingress.test.ts` など）。サブディレクトリ内のモジュールをコマンド族でまとめることもあります（`packages/commands/hImage/add.ts` → `test/commands/hImageAdd.test.ts`）。1000 行のハード上限に近いテストファイルには新しいケースを足さず、新規ファイルを作ってください。
- domain をまたいで共用する test double・fixture・harness は `test/helpers/` に、domain に依存しない汎用ユーティリティは `test/libs/helpers.ts` に置きます。テスト間で可変なモジュール状態を共有しないでください。分離機構によって、`--isolate` なしで実行されるまで問題が隠れる可能性があります。
- 実ファイル I/O を行うテストも、preload の一時データルートによって安全です。ただし `infra/storage` 周辺の mock 境界には注意してください。`infra/diskIO` だけを mock して `infra/storage` を実物のままにすると、実際の `saveStateInBackground` に到達する可能性があります。これは [`AGENTS.md`](../../AGENTS.md) が実行時ファイルの事前バックアップを求める状況です。

## Fault injection suite

`bun run test:fault-injection` は application / Worker lifecycle、封鎖復元、返信容量と取消、資格情報 snapshot、Telegram 送信と遅延削除の停止時 drain、グループ teardown と参加ログの永続化バリア、Anti-Raid タスクの drain と認証復旧、duplex Worker 再構築時の取消、Disk I/O の inspect・原子的書込・復旧障害を検証します。完全な一覧は [`package.json`](../../package.json) の script が正本です。`check:conventions` は登録 harness と production 復旧/lifecycle 境界への実 path 参照から登録漏れを検出します。静的な値 import、dynamic import、値の再 export、directory の `index.ts` 入口を含み、型だけの参照は除外します。空宣言の副作用は保持し、別 path の同名 module は一致させません。互換入口のように主題が混在する module は境界を特定の export に限定できます（`infra/telegram/index.ts`、`actions.ts`、`actions/messageLifecycle.ts` は遅延削除の flush/drain だけを数えます）。namespace は property access で判定し、object literal に展開するだけの替身は数えません。namespace をそのまま受け渡す場合、`export *`、結果を束縛しない dynamic import は取得範囲を確定できないため常に数えます。[04 実行時の不変条件](04-invariants.md) の永続化・停止・Worker lifecycle を変更する場合、この suite を通します。

`test/workers/antiRaid/verificationWelcome.test.ts` は実際の双方向プロトコル、main thread の一時通知境界、削除 owner を通し、Telegram 出力を SDK transformer で代替します。4 種類の歓迎文、返信先、応答消失、取消、Worker teardown・再生成、送信・通信失敗を検証し、削除の一度だけの登録、終了を妨げない timer、後続副作用の順序を確認します。このファイルは全量テストと障害注入の両方に含まれます。

`/wed` の操作回帰は 1,024 件の LRU 容量、コマンドとボタン参照による利用順更新、eviction 時の待機・実行中操作の取消、遅着結果の清掃、個別削除失敗後の継続、update 取消からの独立性、停止時 drain を検証します。メンバー正本では 25 群の満杯時拒否を別途検証します。永続化回帰は各群の集合参照の再利用、15 万人上限、退室後の追加、dirty の TTL/件数閾値、変更なし時の無送信、送信失敗、Worker 復旧水位、停止時 flush、不正ファイルの原本保持と接続前の起動拒否を検証します。抽選の回帰では、ID でアバターを読み、身分を `getChat` の private chat 情報から取り、`getChatMember` を呼ばないことも確認します。`test/app/registerHandlersDispatch.test.ts` は初期化 gate が拒否した更新でも退室 ID だけを削除することを確認します。性能確認は `wed-member-hit`、`wed-member-growth`、`wed-member-churn`、`wed-member-chat-switch`、`registered-middleware` を再利用し、`wed-member-churn` は満杯で新規 ID を拒否して既存メンバーを保持することを検証します。

## Hot path gate

`bun run perf:hot-path-gate` は `bun run check` の最終段で、`master` へのマージ前に実行する必要があります。`packages/consts/performance.ts` の `HOT_PATH_PROFILE_SCENARIOS` の各シナリオ・各繰り返しごとに独立した子プロセスを 2 つ起動します。`steadyProfile` は正式ループの GC と JIT だけを判定し、`retained` は profiler 自身のメモリ干渉がない状態で RSS、heapUsed のピーク、full GC 後の残存を判定します。

校準記録を [`performance-result.json`](../../performance-result.json) に保存し、`scripts/perf/hotPaths/gateResult.ts` が厳密に解析します。`gateRuntime.ts` は規約検査と hot-path 子 process の開始前に `packageManager`、現在の Bun version/revision、校準 build を照合し、不一致なら再測定を要求します。記録には process 数、各場面の遅延と GC 停止の測定値、RSS/保持量の hard limit を含みます。過去の `fullSuite` 結果は各回の時刻と Bun build を維持します。

`steadyProfile` 子プロセスは `BUN_JSC_logGC=1` を明示的に有効化します。`hotPaths/gcProfile.ts` は正式ループの境界内にある JSC の `p=…ms` 停止区間だけを合計し、同じ窓の単調経過時間で割って GC 停止時間比率を得ます。起動 handshake、唯一の完全な窓、停止ログ形式の一致が必須で、欠落・未知形式は失敗です。完全な有効ログで停止がなかった場合だけ 0 を記録します。JIT 層は sampling profiler で集計します。`retained` の強制 GC は計時境界外で、この比率には含めません。シナリオ別 calibration は最低 3 個の独立プロセスの停止データを保存します。GC 停止時間比率の上限は、プロセスが利用可能な CPU 数に応じて全シナリオ共通で適用します。4 コア以上は 25%、2～3 コアは 30%、1 コアは 35% です。上限と同じ値は合格し、上限を超えると失敗します。基準は `packages/consts/performance.ts` の `HOT_PATH_GC_CPU_BUDGETS` で定義します。ゲート起動時に `node:os.availableParallelism()` から利用可能な並列度を取得して上限を選び、Linux の CPU affinity 制限もこの値に反映されます。出力の `availableCpuCount` と `thresholds.maxGcPausePercent` に、今回の CPU 数と共通上限を記録します。

`perf:isolated-hot-path --profile` と `perf:review` の profile 出力は JIT・sampling 診断用で、GC 停止比率は提供しません。GC 計測には `perf:hot-path-gate` を使います。`perf:disk-transport` と `perf:review --text` も親プロセスで GC ログを解析し、各ラウンドに独立した `gcProfile` を返します。

`hotPathProfileGate` の節は双方向ですが、2 つの半分は owner が異なります。`calibration` は再校正後に人が手で編集し、gate からは read-only です。`lastRun` は直近の gate 読数を記録し、`bun run perf:hot-path-gate -- --write-result` を明示的に渡したときだけ上書きされるため、通常の `bun run check` は working tree を汚しません。write-back は `calibration` を 1 byte も触りません。gate が 1 回の実行結果から自身の判定基準を書き換えられるようにすることは、現在の性能で gate を溶接してしまうのと同じだからです。

同じ file のもう一つの節 `fullSuite.lastRun` は[全量 benchmark](#全量パフォーマンス-benchmark) のもので、`bun run perf:full -- --write-doc` が書き込みます。2 つの benchmark は別プロセス・別タイミングで走るため、書き込みはどちらも `scripts/perf/performanceResult.ts` の「全体を読む → 自分の枠だけ差し替える → 全体を書き戻す」を通ります。parse 結果から document を再構築する方式は取りません。そうすると後に走った方が、もう一方の節を `calibration` 配下の人間向け説明ごと消してしまうからです。

gate を設けている項目：GC 停止時間比率、sampling RSS ピークとプロセス生涯 RSS 高水位（同一上限を共有。後者は 2 つの tick の間に完全に収まる一時的な確保を捕捉できます）、sampling heapUsed 増加、full GC 後の JSC heap／heap 外メモリ／object 数の残存、最小 sample 数、そして production probe ごとの「warmup 後に DFG 到達済み」と「sampling 中に再コンパイルや脱最適化なし」。

出力のうち `Diagnostic` 接尾辞が付く項目は報告のみで gate しません。集計 FTL 比率はその一つで、純粋な leaf シナリオでは 100% 近く、非同期の主経路では一桁に留まります（sample に native Promise とスケジューラのフレームが混ざるため）。単一の閾値は両者に共通の意味を持ちません。`reoptRetries` の絶対値も同様で、sampling 開始前の JIT 安定ラウンドが既に連続ラウンドでの不変を要求しているため、残るのは warmup 期の履歴だけです。

`profile` / `retained` の接頭辞は、その読み取り値がどちらの子プロセス由来かを示します。両者の warmup 回数は一桁違う（profile 側は JIT 安定ラウンドを追加で回す）ため、混ぜて読んではいけません。

文字列 scenario は production が利用する内容を実際に読み取る必要があります。`.length` だけでは JSC rope の展開は保証されません。transcript scenario は `charCodeAt(length - 1)` で解析を発生させます。`scripts/perf/hotPaths/transcriptScenarios.ts` を参照してください。他の遅延構造も production が内容を利用する時の処理を含めます。

## 入室ログ性能 benchmark

`bun run perf:join-log` は入力を容量 250,000 件、overflow 300 件、warm-up 10,000 件に固定し、snapshot・capacity・append-accounting の 3 経路の baseline/current をそれぞれ 5 個の独立 Bun process で実行します。親 process は sample ごとに両 variant の checksum を突き合わせ、一致しなければ全体を失敗させます。`append-accounting` の 1 batch は production の `JOIN_LOG_MAX_BUFFERED_ENTRIES` を使い、合計が他の 2 経路と同じ 25 万件規模になるまで繰り返します。出力には完全な Bun version/revision、所要時間の中央値と範囲、強制 GC 前後の JSC heap/object 変化を記録します。baseline は最適化前の実装——Map 全体 copy、全件 sort、完全な JSON 文字列生成（snapshot と capacity）、および 1 件ずつ再 serialize して byte 数だけを測る方式（append-accounting）——を、同一 Bun build 内の前後比較専用として固定したものです。`Bun.gc(true)` はこの benchmark にしか存在せず、production control flow には入りません。入室 index、容量裁剪、snapshot serialization、追記後の byte 記帳、分割 atomic write を変更した場合は必ず実行し、差が 5 sample の範囲に表れる noise より十分大きいことを確認します。

## Identity database 性能 benchmark

`bun run perf:identity-database` は一時 data root / SQLite で 6 つの production operation を測ります。identity 8 件単位の 2 table read（同一接続の hot read と、batch ごとに接続を開き直す cold read）、128 row の明示 transaction write（同じく hot 接続と cold 接続の 2 種）、main thread の 8,192-entry LRU hot read、Worker・JSONB transaction・exact ACK を通る write-through です。「cold」は接続の page cache と statement cache が空という意味で、OS の page cache を破棄したという意味ではありません。各 operation を warm-up してから 5 個の独立 Bun process で sample し、Bun version/revision、throughput、batch latency、sample range / coefficient of variation、強制 GC 前後の JSC heap・extra memory・object・GC time を報告します。`--single-process` は同じ measurement process 内で各 operation を 3 回反復し、round 間の retained growth を調べますが、独立 process 比較の代わりではありません。`Bun.gc(true)` は計時外の診断専用です。identity LRU、cold prefetch、encoding、transaction batch、ACK、Worker replay を変えた場合に実行し、同じ Bun build の差を sample noise と heap/GC の両方で判断します。

write-through scenario は 4,096 key の working set に対して 65,536 operation を実行します。各 working set の終了時に durable flush を待って次へ進み、最後に全 operation の ACK と checksum を照合します。

## 個別シナリオと伝送ストレス検証

`bun run perf:review` は全量基準と同じ隔離 root、設定 fixture、process runner、出力先の canned reply を使い、JSON を出力して各実行の data root を削除します。`--hot-paths` は sender、message window、permission read、AI activity、認証 snapshot と clone、空/微小 chunk および 1 KiB/1 MiB/16 MiB response、登録 middleware の 12 scenario を、それぞれ通常測定 3 回と profile 3 回で検証します。完全な非同期読み取りは明示した回数で warmup し、実際の JIT tier を記録します。他の scenario は最適化 tier の安定性検査を維持します。

`--ai` は受付判定、通常送信、容量・再開負荷、Base64 の 1 MiB / 8 MiB / 異常先頭 / 異常末尾を測定します。7 シナリオで各 3 回の独立 process による計時と 3 回の profile を実行し、production 関数を直接使います。送信シナリオは chat 別/全体容量、実完了、後処理を断言し、production JIT probe の安定を要求します。負荷の 1 iteration は 128 存続 slot と容量拒否検証を含み、遅延は batch 全体の値です。Base64 は符号化後と復号後のサイズ上限、標準 alphabet、末尾 bit の厳密検査、g/y なしの正規表現、1 回だけの decode を維持します。固定入力と warmupによる局所測定であり、実 model / Telegram network や全 production payload の memory 予算は含みません。JIT sampling summary は GC 停止時間を提供しません。

`--chains` は機能を有効にした `ad-detect-command` と `ai-reply-command` を実行し、Telegram canned call 数と処理完了を検証します。`--worker` は各 round で実 Disk I/O Worker に 128 message × 400 batch を渡し、batch ごとに最終 revision の ACK を待ちます。各 round で 2 回の graceful shutdown と Worker 再構築を行い、25 chat の復旧値を照合します。clone、transaction、disk wait を含め、throughput、latency、retained heap、RSS を記録しますが、fault injection の代用にはなりません。各 mode は 3 round で、全量基準と既定 10 scenario の hard gate 閾値は変更しません。

`--cooldown` は明示した場合のみ、production のクールダウンを 5 シナリオで測定します。`cooldown-hit`、`cooldown-renew`、`cooldown-growth`、`cooldown-saturated`、`cooldown-expiry` が、既存キーの hit、単一キーの更新、表の充填、満杯時の拒否、一括期限切れを検証します。容量と期間は production 定数を使います。各シナリオは独立 process で通常測定 3 回と profile 3 回を実行し、受理件数を断言して production JIT probe を観測します。充填シナリオは各 warmup と正式 sample の直前に初期化し、その処理は計時に含めません。通常測定は latency、保持 heap、RSS を返し、profile は JIT sample を返しますが GC 停止比率は返しません。この mode は既定の検証と全量基準には含めず、hard gate の閾値も変更しません。

`--text` は明示した場合のみ実行し、既定の全体検証には含めません。36 シナリオで各 3 回の独立 process を実行し、production の `sanitizeInline` と `buildBufferedMessage` を直接呼びます。メッセージ構築は既定の時計と時刻整形を使い、結果は圧縮 batch サイズの window に保持します。fixture は中国語・英語・emoji を 6:3:1 で巡回し、本文 8〜4,096 code unit、長文の割合 1%〜75%、先頭・中央・末尾の改行、密な空白、混在レイアウト、返信引用を含みます。各子プロセスは warmup でも正式 sample と同じメモリ読み取りを行い、JIT probe が 3 sample 連続で変化しなくなってから 9 sample を採取します。中央値の所要時間、ピーク heap と RSS の増分、保持 heap、JIT tier、親プロセスが解析した GC 停止を報告し、シナリオごとに 3 ラウンド中央値の平均・範囲・CV と JIT 安定性を集計します。

`sender-mixed-identity` は user と channel の identity を交互に入力して steady behavior と JIT 再最適化を観測します。単一 user scenario とは sender 数が異なるため、時間差を shape 混在だけのコストとは解釈しません。benchmark の user ID は int32 を超える値を扱い、production では小さい ID も有効です。

registry は `wed-member-hit`、`wed-member-growth`、`wed-member-churn`、`wed-member-chat-switch`、`registered-middleware`、`storage-sqlite-flush` を含みます。最初の 4 項目はメンバー集合の hit・充填・満杯時の拒否・chat 切替を検証します。middleware は実際の登録 chain と活動経路を検証します。SQLite は空 DB に 128 delete を送るため、主に transaction scheduling の測定であり、disk throughput の値ではありません。

`bun run perf:isolated-hot-path <scenario>` を実行し、別の sampling には `--profile` を付けます。この入口は `gateFixture.ts` で独立した設定・data root を作り、3 回の独立子 process に渡して、終了後に run directory を削除します。外部送信は基準用の固定応答が受け持ちます。Bun と入力を固定し、warm-up 後に retained と profile を別々に観測します。JIT sample が不足する場合は tier の安定を判断できません。

`luck-tier-table` は固定 roll から本番の `drawLuckTier` を直接呼び、返されたランクの checksum と同関数の JIT probe を記録します。`gag-speak-counter` は `GAG_SESSION_MAX` から session 数を読み、本番の発言カウンターを呼びます。これらの境界を変更した場合、両シナリオを通常と `--profile` の両モードで実行し、checksum、清掃、保持 heap、JIT を確認します。両シナリオは標準の十シナリオ gate に含まれません。

`bun run perf:disk-transport` は独立 mock process を 3 回実行し、単一 batch ACK・通常排出・ACK 停止後の容量拒否を検証して latency・heap・GC・JIT を出力します。同一の不変 payload を再利用する queue/ACK の測定であり、Worker clone・実 payload の個別容量・disk wait は含みません。

## 全量パフォーマンス benchmark

`bun run perf:full` はリリース時と明示的な指示があったときにのみ実行します。`bun run check` には含めず、失敗閾値も設けません。ホットパスのハードゲートは上記の `perf:hot-path-gate` のままです。6 つのセクションをそれぞれ独立プロセスで 3 ラウンド実行し、平均を報告します。コールドスタート、本番ホットパス、エンドツーエンドの永続化チェーン、SQLite とメインスレッドキャッシュ、コンテナとアルゴリズム、参加ログ容量線の 6 つです。各項目には平均に加えて最小値・最大値・変動係数も付き、CV が大きく跳ねた行は履歴と比較できません。

計測対象はすべて既存コードの再利用です。ホットパスは `perf:hot-paths` のシナリオと反復数をそのまま使い、ストレージは `perf:identity-database` の実装を呼び、容量線は `perf:join-log` の子プロセスを呼びます。チェーンは `recordJoinLog`、`persistChatState`、`queueIdentityPolicyWrite`、`postDiskIO`、`relayLogMessage` というメインスレッドの本番エントリから実際の Disk I/O Worker を駆動し、永続化の完了応答までを計測します。さらに**コマンド全体**を計測する 2 本があります。`ad-detect-command` は `enqueueAdCandidate` から `runAdDetectBatch`、そしてメインスレッドの `handleAdDetected` による処理の排出まで、`ai-reply-command` は `recordChatMessage` と `generateAndSendReply` から返信が実際に送信されるまでです。この 2 本のモデル呼び出しと Telegram 送信は `scripts/perf/outboundGuard.ts` のプロセス内固定応答が返します——ベンチマークは実際のリクエストを一切発行せず、API 費用も発生しません。`ai-reply-command` はさらに送信前の擬人的な間を実測して差し引きます（基準は [09 パフォーマンス](09-performance.md)）。コールドスタートは満載のフィクスチャ上で `packages/app/lifecycle.ts` の init 順に段階ごとに計測し、通信を伴う処理と 2 つの業務 Worker の生成は含みません。

データはすべてリポジトリ直下の `performance/`（`.gitignore` 済み）に書き、設定は `config_example/` から読み、各ラウンドの終了後にツリーごと削除します。実行が終わればこのディレクトリには何も残りません。親プロセスは production の実装モジュールを一切 import しないため、production の書き込み経路から実データルートへ到達することはありません。加えてディレクトリ作成、コピー、ファイル書き込み、削除は共通の境界（`scripts/perf/fullSuite/mockRoot.ts`）を通ります：まずパスが字句的に `performance/` 配下かを判定し、次にリポジトリルートから対象までの**すでに存在する**パス構成要素を 1 つずつ検査し、いずれかがシンボリックリンクなら拒否します。削除は親チェーンだけを検査するため、末端自体がシンボリックリンクの場合はリンクだけを外し、リンク先には触れません。mock ルート自体は決して削除しません。`--write-doc` は `docs/{cn,en,ja}/09-performance.md` の 3 言語 block と `performance-result.json` の `fullSuite.lastRun` を同時に書き換えます。計測値と各セクションの定義は [09 パフォーマンスベンチマーク](09-performance.md) を参照してください。

## コミット手順

1. 開発は `dev` ブランチで行い、`master` へ直接コミットしません。`master` へのマージは squash のみで、1 つの変更セットを 1 コミットにまとめます。ブランチ規約は [`AGENTS.md`](../../AGENTS.md) の「分支、验证、提交与发布」を参照してください（ここでは繰り返しません）。
2. 開発中にユーザーがパラメータを変更する場合があります。編集直前にファイルを再度読み、未コミットの変更を上書きしないでください。
3. コミット前に `git diff --stat` 全体を確認し、無関係なファイルを混ぜません。
4. 各コミット前に `git branch --show-current` で `dev` を確認し、`bun run lint && bun run typecheck` または完全な `bun run check` を通します。`master` へのマージ前は完全な `check` が必須です。永続化・停止・Worker ライフサイクルの変更には `bun run test:fault-injection` も必要です。
5. Conventional Commits 形式（`feat(ai): ...`、`fix(runtime): ...`、`docs: ...`）を使い、subject は英語にします。

### README 指標の更新

3 言語の各プロジェクト README の badge と、上記のテスト数、assertion 数、カバレッジは実測値です。テスト、production モジュール、カバレッジ定義が変わった場合は次のように更新します。

```bash
bun run test:coverage 2>&1 | tail -5           # テスト数、ファイル数、expect() 数
bun run test:coverage 2>&1 | grep 'All files'  # 関数・行カバレッジ
```

以下はいずれも同じ実測値なので、1 か所直したら全部直します。

- **3 言語の README にある Tests / Coverage badge。** Coverage badge は常に `All files` の行カバレッジを使います。
- **カバレッジ図**：各 README の「プロジェクト品質」節が参照する [`public/coverage_light.svg`](../../public/coverage_light.svg) と [`public/coverage_dark.svg`](../../public/coverage_dark.svg)。banner と同様、1 組を 3 言語の README が共用するため、両テーマのファイルの数値を一緒に更新します。
- **3 つの README の `<img alt>` 内の同等の文言。** 図は画像として読み込まれるため SVG 内部の `<title>` / `aria-label` は読み上げに届かず、alt が唯一の入口です。
- **3 言語の本文にある「このドキュメント版の実測値」。**

カバレッジとは別に、同じく静かに古くなる実測値が 2 組あります。

- **中国語の文字列リテラル数**：数値は 3 言語の [06 よくある変更手順](06-modification-guide.md)「i18n を行わない」節にだけ書きます。3 言語 README の「言語について」注記はその節へリンクするだけで、数値は持ちません。ユーザー向け文言を増減したら数え直します。コメントを除き、TypeScript AST の文字列／template literal ノードが跨るソース行を数えます。backtick を grep で数えないでください——正規表現リテラル内の backtick が計数を狂わせます。
- **動作値**（確率、容量、時間）：README 内のこれらの数値は `packages/consts/` と一致させます。詳細は [06 よくある変更手順](06-modification-guide.md#動作パラメータの調整) を参照してください。

## リリース

このリポジトリは GitHub Actions に依存しません。リリース環境では `bun run release:check -- --version <tag>` を明示的な build または pre-deploy step としてください。ネットワーク接続可能な環境では `bun run audit:release` も実行します。ネットワーク失敗は監査未完了を意味し、脆弱性が 0 件という意味ではありません。CVE を無視する場合は理由と期限を記録します。永続化構造を変更するリリースでは、先に [06 よくある変更手順](06-modification-guide.md#永続化-schema-の変更) の migration を実行してください。

`dev` で gate が通過した後、サービスとほかの高負荷処理を停止してマシンが空くのを待ち、
`bun run perf:full -- --write-doc` を既定の 3 ラウンドで実行します。3 言語の
[09 パフォーマンスベンチマーク](09-performance.md) と `performance-result.json` の
`fullSuite.lastRun` を同時に更新し、両方をコード変更と一緒にコミットします。
全量 benchmark と `bun run check` は同時または連続して実行せず、間にマシンが空くのを待ちます。
性能比較は同一マシン・同一 Bun build で行います。ランタイム更新後の読数はその build の基準値であり、
build 間の差をコード最適化の効果として扱いません。失敗や異常値は原因を確認して再実行してから公開します。

`master` への squash merge ごとに、バイナリ資産付きの GitHub Release を 1 つ作成します。

1. remote tag を同期し、`gh release list` で現在の Latest Release tag を取得します。tag は `v` prefix を付けない `MAJOR.MINOR.PATCH` 形式に限定します。変更セット全体で最も高い semantic impact に従い、breaking change は `MAJOR`（`1.0.9` → `2.0.0`）、後方互換の新機能は `MINOR`（`1.0.9` → `1.1.0`）、修正・性能改善・refactoring・documentation のみの場合は `PATCH`（`1.0.9` → `1.0.10`）を増やします。
2. コードと今回のベンチマーク結果をコミット後、クリーンな `dev` で `release:build` を実行し、Release tag を `--version` で明示します。既定値やソース manifest の版は使わず、指定値をパッケージ内の `package.json` と `binary.json` に書き込み、実行ファイルの `--version` 出力との一致を検証します。宣言する各プラットフォームのアーキテクチャ・libc に対応する環境で、同一の Git tree と Bun version/revision を使ってネイティブ構築します。ビルドでは版、`.map` ファイルがないこと、3 つの Worker、画像処理のネイティブ依存、バイナリ用インストーラーを検証します。正式な公開資産は最終コミット後に生成します。
3. 各プラットフォームの `.tar.gz` と `.tar.gz.sha256` を集め、`release:verify` を実行します。対応する名前は `linux-x64`、`linux-arm64`、`linux-x64-musl`、`linux-arm64-musl` です。`--platforms` は今回必要な全プラットフォームの一覧で、資産が不足すれば失敗します。既定では `dist/` を読み、別の集約先は `--directory` で指定します。`binary.json` の版、プラットフォーム、Git tree、Bun version/revision と実際の SHA-256 を照合し、未コミットの作業ツリーから作った資産は拒否します。
4. リポジトリとデプロイの保護手順に従って `master` へ squash merge し、構築時と Git tree が一致することを確認します。`master` を push 後、そのコミットの annotated version tag を作成して個別に push します。既存 tag の上書き、移動、再利用は禁止です。
5. 前回の Latest tag から現在の `master` までの差分だけを英語で説明し、Highlights、Compatibility / Migration Notes、Validation を含めます。互換性の説明に提供するバイナリのプラットフォームを列挙し、gate の数値には今回の実測値を使います。`release:publish` はローカル・リモートの `master` と annotated tag を照合してから草稿を作り、資産をアップロードしてダウンロード内容を検証します。全検証の通過後に Latest として公開し、ダウンロード内容とリモート参照を再確認します。移行用添付ファイルが必要な場合は、同じ説明文の草稿を先に作って添付し、スクリプトでバイナリ資産を追加できます。
6. 作成・アップロード・確認に失敗した場合は状態を保ち、同じ版で再試行します。草稿には不足資産だけを追加し、同名の既存資産はダウンロード内容を照合して上書きしません。公開済み Release の資産不足は変更せず拒否します。Release、Latest、資産、Git 参照をすべて確認してから `git diff dev master --quiet` を実行し、[`AGENTS.md`](../../AGENTS.md) に従って `dev` を揃えて push します。最後にローカル・リモート両方の 2 ブランチが同じコミットを指すことを確認します。公開スクリプトはこれらの Git 操作を行いません。

次は `12.1.0`、Linux x64 glibc の例です。実際の版は Latest と変更内容から決め、ネイティブ構築と検証が完了したプラットフォームを指定します。

```bash
RELEASE_VERSION=12.1.0
RELEASE_PLATFORMS=linux-x64
bun run release:build -- --version "$RELEASE_VERSION"
bun run release:verify -- --version "$RELEASE_VERSION" --platforms "$RELEASE_PLATFORMS"
# squash と master・annotated tag の push 後、クリーンな master で実行。
bun run release:publish -- --version "$RELEASE_VERSION" --platforms "$RELEASE_PLATFORMS" --notes-file /tmp/release-notes.md
```

資産名は `copy-ninjia-<プラットフォーム>.tar.gz` と `copy-ninjia-<プラットフォーム>.tar.gz.sha256` に固定します。バイナリインストールでは Release 資産を直接ダウンロードして SHA-256 を検証し、対象マシンでソースコードを checkout・ビルドしません。

---

<div align="center">

[← 前のページ：04 不変条件](04-invariants.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#05-開発フローと品質ゲート) · [次のページ：06 変更レシピ →](06-modification-guide.md)

</div>
