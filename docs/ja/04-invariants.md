# 04 実行時の正式な不変条件

<p align="center">
  <a href="../04-invariants.md">简体中文</a> · <a href="../en/04-invariants.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="README.md">📚 開発者ドキュメント TOP</a> · <a href="03-directory-map.md">← 前のページ：03 ディレクトリマップ</a> · <a href="05-dev-workflow.md">次のページ：05 開発フロー →</a>
</p>

---

このページは、モジュールやライフサイクルをまたぐ**正式な制約**を記録します。旧 `docs/architecture.md` の後継です。ソースコメントでは局所的な不変条件を説明し、`@see ../../docs/04-invariants.md` のようにここを参照してください。起動や永続化の説明全体を複数のモジュールへ重複させてはいけません。以下のいずれかに関わる変更では、コードより先にこのページを更新します。

案内用の説明は [02 アーキテクチャ概要](02-architecture.md)、これらの制約に触れる変更手順は [06 よくある変更手順](06-modification-guide.md) を参照してください。

## 起動と import の境界

- production モジュールを import しても Worker、timer、ネットワーク要求、共有ディレクトリへの書き込みを開始しません。
- メインプロセスは実行時データルートを再帰的に作成し、書き込み、ファイル fsync、hard link、アトミック rename、ディレクトリ fsync を事前検査してから `bot.lock` を取得します。続いて `config/` を検証し、トップレベルの孤立した一時ファイルを削除し、`state.json` を厳密に復元します。ここまではすべてネットワーク接続や Worker 作成より前です。その後に Telegram クライアントと Disk I/O Worker を初期化し、`memory/` を復元し、handler・コマンドメニュー・`bot.init()` の handshake を完了します。最後に AI/Anti-Raid Worker を初期化して hydrate し、acknowledgement-safe runner を開始します。
- 初期化失敗と正常終了はどちらも `ApplicationLifecycle` に合流し、実際に取得したリソースだけを解放または flush します。
- 設定 parser 自体は I/O を行いません。`getStickerConfig()`、`getReactionConfig()`、`getMoodConfig()` は業務上の初回利用時に遅延読み込みされますが、メインプロセスはロック取得後に事前読み込みし、デプロイ設定の誤りをネットワーク接続前に検出します。
- `state.json`、`bot.lock`、`logs/`、`memory/` はすべて 1 つの実行時データルートから導出します。production の既定値はプロジェクトルートです。テスト preload は production モジュールを import する前に isolate ごとの一時ルートを注入し、実ファイル I/O が production キャッシュへアクセスできないようにします。
- 低優先度のグループタイトル保守は、コマンドメニュー、`bot.init()`、Worker hydrate、acknowledgement-safe runner の準備完了後にだけ開始します。title owner の `getChat` は現在最大 15 並列で、履歴補完が共有 throttler を先頭から占有する量を制限し、ライフサイクルの quiesce/abort signal を受け取ります。
- 汎用 JSON API request は `JSON_API_ALLOWED_ORIGINS` に明記した HTTPS origin だけを許可し、redirect を無効にします。新しい caller は allowlist を明示的に拡張しなければなりません。Telegram avatar crawler は独立した経路を使い、この JSON allowlist へ誤って接続してはいけません。
- 送信メッセージには `parse_mode` を一切設定しません。表示名やメッセージ本文は純テキストとしてのみ連結し、書式やリンクとして解釈される余地を残してはいけません。リッチテキストが必要な場合は、呼び出し側がテキストを段ごとに組み立て、`entities` を自ら与えます（offset は Telegram の UTF-16 code unit 基準で、JavaScript の `String#length` と同一。長さ 0 の entity はメッセージ全体が拒否されます）。新しい送信経路がこの制約を迂回するために `parse_mode` を使ってはいけません。

## Worker と状態の所有権

- メインスレッドは Telegram runner と Worker 監視ハンドルを所有します。`StateStore` は `state.json` のメモリミラー、latest-only のアトミック書き込み、上限付き失敗リトライ、終了時 flush を排他的に管理します。リトライ上限の超過は fatal durability failure であり、runner を停止して update の確認を続けてはいけません。
- AI Worker はグループチャットメモリ、返信の受け入れ、メディア説明パイプライン、グループごとのムード、スタンプカタログ生成の実行時状態を排他的に所有します。
- Anti-Raid Worker は認証・ロックダウン状態機械とタイマーを排他的に所有し、メインスレッドは復元可能なミラーだけを持ちます。
- 状態機械の `State/Event/Effect/Transition/Decision` contract はすべて `packages/types/states/` が所有します。`packages/states/` は I/O のない純粋な状態遷移だけを実装し、interpreter と cache は前者の型へ直接依存します。
- Disk I/O Worker はログ、AI メモリ、スタンプカタログ、運勢、認証待ちデータの永続化を排他的に所有し、1 つの Worker スレッド内で共有ディレクトリへの読み書きを直列化します。`state.json` は明示的な例外で、メインスレッドの `StateStore` が非同期に管理します。業務 Worker は共有ディレクトリへ直接書き込みません。
- 長寿命の Map、Set、キュー、timer には、対応する `packages/cache/<domain>/` と業務ライフサイクルモジュールが共同で容量、削除、Worker 再構築の意味を定義しなければなりません。
- 業務 Worker と独立した Disk I/O ホストは、同期的な `postMessage` の拒否を明示的な失敗へ統一します。request 型の送信は waiter と timer を即座に削除し、ログだけは console へ fallback し、重要業務の拒否は fatal とします。復元 replay が再び拒否された場合、Worker が writable だと主張してはいけません。処理または永続化の確認が必要な caller は `false` を失敗として扱い、対応する Telegram update を確認してはいけません。
- `/switch_mood` はメインスレッドの request/waiter と AI Worker の確認応答による handshake を使います。メインスレッドは送信前に waiter を登録し、timeout、Worker crash、再起動断念、停止時に統一して精算します。request は絶対 deadline を持ち、AI Worker はムード再抽選の副作用より前に、期限切れの待機 request を拒否しなければなりません。再抽選成功を示せるのは `moodSwitched` 応答だけです。その後の Telegram 確認メッセージ送信失敗を「再抽選失敗」へ書き換えてはいけません。
- AI 返信は、成功したテキスト、スタンプ、リアクション、画像だけを 1 つの統一 action budget に計上します。モデル向け prompt 上限は 8、実行側 hard cap は 11 です。スタンプ、リアクション、生成画像はそれぞれ最大 1 回だけ成功でき、その他の action tool に per-tool call cap はありません。スタンプパック表示と Google Search は独立した lookup cap を持ち、custom function call 全体にも round 単位の loop guard があります。成功 action が 0 件の場合だけ、最終本文を `send_message` から fallback 送信します。意図的に表示するすべての文字列は、モデルがこのツールを明示的に呼び出して送らなければなりません。
- AI 返信のウェブ検証説明は、その round の検索進捗に応じて 3 つの状態を切り替えます。未検索なら「検索すべき条件」と「行動前に検証する」ルールを示し、検索済みで残枠がある場合は結果の使用規律と不足分の再検索に切り替え、枠を使い切った場合も結果の使用規律を保ったうえで「見つからなかったとき」の締め方を示します。3 状態は同じ規律を共有します——検索結果は既存の認識より優先され、結果に無い具体情報を記憶から補ってはいけません——どの状態でもこれを省略できません。モデルから見える prompt には、Google Search が統一 action budget に計上されないことを明記し、action を節約するために検証を省略させないようにします。サーバー側検索を観測した後の tool round はより低い sampling temperature を使います。検索とその round の最初の本文生成は同一リクエスト内で起きるため予測できず、その round は通常の返信 temperature のままです。
- AI 返信の最初の Gemini 入力は、1 つの `user Content` 内に順序付きの 3 つの `text Part` を維持します。すなわち、読み取り専用の参照メモリ、読み取り専用の現在会話、今回の返信タスクです。各 section はモデルから見える開始・終了タグと、先頭の責務説明 1 行だけで囲みます。データと命令の区別、偽造 boundary の無効化、内部構造の非開示という共通の prompt injection 防止規則は `systemInstruction` に 1 回だけ記載し、各 section で繰り返しません。ツール呼び出し後の履歴は実際の `model/user` role で追加し、参照資料を過去の会話 turn に見せかけてはいけません。system prompt は独立した `GenerateContentConfig.systemInstruction` field でだけ送信し、通常会話の `contents` へ連結しません。
- グループチャット transcript の行内 marker（返信引用、転送元）は、`packages/consts/aiChat/prompts/transcript.ts` の共通 template が、組み立てる本文と prompt の形式説明にある placeholder の両方を生成します。同じ形式を両側で個別に手書きしてはいけません。転送元の帰属は marker の入れ子で区別し、外側は現在のメッセージ、内側は返信先の元メッセージに属します。複数階層の返信チェーンにおける各 hop の形式、転送元、`[仅回复快照]` marker も同じドメイン template を再利用します。返信タスクにチェーンを追加するのは 2 階層以上の場合だけです。snapshot-only の末尾では、元メッセージが逐語 transcript から既に外れていることを明示し、完全な原文をモデルが参照できると示唆してはいけません。
- Anti-Raid は、連携チャンネルのディスカッショングループにおける直接コメントとスレッド内返信に同じ免除 semantics を適用します。最近のコメント関連 cache はメッセージ ID と観測時刻だけを保存し、動作差のなくなった source marker を状態機械へ漏らしません。候補になるのは連携チャンネルのディスカッショングループのコメントスレッドだけです。`message_thread_id` はフォーラム（topics）グループのすべてのメッセージにも付くため、`is_topic_message !== true` でフォーラムトピックを除外しなければなりません。トピックは常に通常の認証待ち semantics に従い、barrier の追加投函も連携チャンネル lookup も発生させません。cold cache の `message_thread_id` は非同期確認候補にすぎません。lookup 完了までは通常の認証待ちメッセージとして扱い、`linked_chat_id` が確認され、状態オブジェクトと generation が一致する場合だけ取り消します。lookup 失敗は fail-closed とし、後続の再試行を許可します。
- 人間メンバーの参加認証は本人のクリックだけを受け付けます。Worker は caller の自己申告ではなく、信頼できる `callback_query.from.id === callback_data` の対象 ID から本人関係を導出しなければなりません。クリックしたユーザーが `PRIVILEGED_USERS_ID` に含まれていても、別の人間を認証できません。代行保証の唯一の例外は、現在の認証待ち snapshot が `isBot === true` で、クリックしたユーザーが同じ allowlist に含まれる場合です。対象が存在しない、終端状態、または不一致の場合は失敗応答だけを返し、認証状態を変更してはいけません。
- 認証 reminder にはメンバーごとに delivery owner が 1 つだけあり、送信失敗には上限付き backoff を使います。timeout で kick する前提条件は `reminderMessageId` または `replyReminderMessageId` の少なくとも一方が設定済みであることです。1 件も送信できていない場合、timeout は window を延長して再送するだけです。reminder ID のない現行形式 snapshot を復元したときも同じ owner を再利用し、状態置換、退出、teardown、Worker 終了で取り消します。これは未送信 reminder を示す正規の業務状態であり、旧形式との互換分岐ではありません。
- 送信者 username cache は「正規化 username → identity」と「sender ID → 現在の username」の両方を保持します。名前変更、username 削除、再割り当て、容量超過による eviction は同じ owner が双方向関係をアトミックに更新し、resolver は不整合な alias を拒否します。
- 匿名管理者本人は管理者として免除されますが、招待者を特定 account に帰属できないため、管理者招待による継承免除を新規メンバーへ与えません。匿名管理者が現在のグループとして発言した場合、visible sender の解決は copy と avatar crawler のためにそのグループ identity を保持します。破壊的なメンバー操作は現在のグループ identity を user target として拒否しなければなりません。
- chat runtime teardown の 3 つの固定 owner callback は `packages/cache/chatTeardown.ts` が保持します。上位ドメインは `packages/infra/chatTeardown.ts` を通じて逆向きに登録し、`packages/infra/botAdmin.ts` は `commands/`、AI、Anti-Raid の業務モジュールへ static dependency を持ってはいけません。

## 永続化

- `state.json` は最新値の結合、一時ファイル、fsync、アトミック rename を使います。コマンドスイッチ、中継、copy、権限、退出状態などの正式な変更は、該当 revision が主ファイルと LKG に順番どおり書かれるまで成功を返さず、middleware から戻りません。グループタイトルなど再構築可能な metadata だけは background の eventual consistency で保存できます。
- AI メモリとスタンプカタログは entity ごとのアトミック snapshot を使います。ログ、運勢、認証待ち状態は末尾切断を修復できる追記型 JSON を使います。各追記 batch は成功応答より前に fsync します。認証完了は tombstone を追記し、東京日付の当日ファイルだけを保持し、件数または byte threshold で active snapshot へ compact します。切断修復では JSON 文字列、escape、括弧の深さからトップレベル member の境界を判定し、object 値末尾のインデントに依存してはいけません。`null` tombstone など primitive 値も完全な最終値として扱います。
- AI メモリの upsert/delete は chat ごとの実行時単調 revision を使います。メインスレッドは未確認の delete tombstone を保持し、Disk I/O Worker は unlink が durable boundary に達したか、より新しい revision が delete を上書きした場合だけ応答します。Worker 再構築では tombstone と最新ミラーを replay し、順序が最終結果を決めないようにします。確認済み delete または LRU eviction 後の最初の新 snapshot は直ちに保存し、対応する durable upsert 応答を受けるまでメインスレッドが revision marker を保持して、Disk I/O Worker 再構築後に最新ミラーを replay します。起動復元では `state.json` を正本とし、AI が明示的に有効なグループだけを hydrate し、無効グループの残存 snapshot は削除予定にします。現行 snapshot の hot message はすべて正の `messageId` を持ち、返信チェーン index はそこから再構築して別途永続化しません。
- 運勢永続化の東京日付 owner を切り替える前に、前日の追加 buffer を正常に flush しなければなりません。失敗時は旧 owner を維持して日付切り替えを拒否します。対象日に確認済み結果がある場合、key の欠落または別日 key は不整合 backup であり、新しい key を黙って生成せず起動・日付切り替えを拒否します。
- AI メモリ復元は現在の `AI_MEMORY_HYDRATE_BUFFER_MAX` と `MAX_SUMMARY_ROUNDS` に従い、snapshot の末尾から最新データを残します。現在は逐語メッセージ 149 件と cold summary 7 round です。容量定数を変更してデプロイする前に、旧プロセスを停止し、同じ復元 logic で既存の `memory/ai/` をアトミックに書き換えます。旧プロセスの停止時 flush が migration 結果を上書きしないようにしてください。
- 返信チェーン index（`chatReplyChainIndexes`）は rolling memory から完全に導出する index で、永続化せず、内側の値は cache と同じ object reference を共有します。登録と削除は、メッセージが hot region に出入りする物理位置、すなわち `rollingMemory.ts` の push・rotation・hydrate でだけ行えます。ほかのモジュールは read-only です。そのため index は hot region に残るメッセージだけを常に対象とし、rolling cache 上限で制約され、独立 eviction はありません。Bot 自身が送ったテキストと画像の返信 edge は Telegram が返した実際の `reply_to_message` だけから記録します。生成中またはキュー待ちの間に対象が hot region から外れた場合は、round 開始前に取得した上限付き trigger snapshot を fallback に使い、index の範囲を拡張しません。モデルに見せる追跡深度、各 chain node の本文、trigger snapshot はそれぞれ `REPLY_CHAIN_MAX_DEPTH`、`REPLY_CHAIN_NODE_MAX_CHARS`、`REPLY_REFERENCE_MAX_CHARS` で制限され、現在は 15 hop、500 文字、500 文字です。
- Telegram update が確認境界を進められるのは、対応する middleware が完了した後だけです。Anti-Raid mailbox、リアクション・アバターの background owner、StateStore、AI Worker、Disk I/O Worker の flush はすべて明示的な上限付き drain を持ちます。重要な flush の失敗は必ず失敗を返し、最終 offset の確認を止め、非ゼロで終了します。
- 正常・異常停止のどちらでも、まずタイトル、リアクション、アバター、翻訳の入口を quiesce して runner を止め、その後に上限付き drain を行います。4 つの quiesce 呼び出しの失敗は個別に捕捉しなければなりません。1 つが例外を投げても残りを試行し、すべて成功するまでは quiesce 完了を cache せず、その回の失敗によって最終 offset の確認とインスタンスロック解放を止めます。後続の `wait()` または `dispose()` は、冪等な 4 つの入口を再試行できます。翻訳 client は最初の実要求でだけ遅延生成し、各 RPC にはプロジェクト共通の短い timeout を設け、drain 後に明示的な `close()` と project parent/client reference の削除を行います。翻訳 drain の timeout や close 失敗も、ほかの重要 owner と同様にインスタンスロック解放を妨げます。正常経路では最終 Telegram offset の確認前に AI、Disk I/O、StateStore を順番に flush しなければなりません。最終 dispose は「AI を flush → AI を終了 → Disk I/O を flush → Anti-Raid と Disk I/O を終了 → StateStore を flush」です。通常 dispose の進行中に fatal error が発生した場合、emergency 経路はその Promise を再利用できますが、既存 drain がプロセスを無期限に保持しないよう、現在の独立した絶対 15 秒の強制終了 deadline を設けます。予算超過時は実行中の Telegram 要求、メディア download、429 sleep を abort し、未開始キューを精算します。abort 後はメッセージ送信、アバター変更、グループタイトル書き込みを行いません。異常終了経路の maintenance 予算は 0 なので、各 drain は「予算 0」を正当な入力として扱わなければなりません。idle ならそのまま `flushed`、実行中の作業が残っていれば直ちに abort して `timedOut` として精算し、引数検証で例外を投げてはいけません。未完了のタイトル更新も、skip する際に必ず abort します。dispose の各 owner も個別に失敗隔離し、例外は `failed` として集計に参加させます。1 か所の throw が後続 owner、`flushStateToDisk`、インスタンスロックの処理を飛ばすことは許されません。
- Worker flush と mailbox barrier はすべて `packages/libs/flushBarrier.ts` を使い、ID、waiter table、timeout、遅延応答、crash 時の一括精算を管理します。ドメイン cache が resolver Map を再公開してはいけません。
- 現在のデプロイ基準は、開発 workspace が production workspace でもある単一 tenant の cloud-native 環境です。editor、automation tool、runtime が異なる container UID で同じ mount volume を保守する場合があるため、プロジェクトディレクトリと管理対象ファイルは各プロセスがその場で変更できなければなりません。隔離 tenant 内の緩い Unix mode 自体は権限外の公開とは見なしません。共有 host、共有 volume、その他の trust boundary をまたぐ構成へ移行する場合は、リリース前に owner、group、permission を再設計します。
- `memory/` の成果物は一律 `0644` です。owner が書き込み可能で、通常の system user が読み取り可能です。機密性は読めないファイルを作ることではなく、cloud instance の単一 tenant 境界、デプロイ隔離、バックアップ方針で管理します。
- 永続化 schema は推測的な自動 migration を行いません。非互換入力は起動を止め、空状態が実データを上書きするのを防ぎます。
- 現行の lockdown ミラーには `phase` と正の `intentId` が必要で、認証待ち active record には `phase` と `trackedMessageTimes` が必要です。reminder ID は業務上 optional のままで、欠落は reminder がまだ送信成功していないことだけを表し、復元時には信頼できる再送経路を使います。それ以外の欠落・非互換 field は旧プロセス停止中に手動 migration し、production 読み取り経路に互換 logic を残しません。

## 互換エントリ

大きなファイルの分割後に残すトップレベル barrel は段階移行だけに使用します。新しい production コードは該当ドメインファイルから import してください。互換エントリは状態を所有せず、設定を解析せず、import 時の副作用を導入しません。

運勢レシートに旧形式の互換分岐は置きません。検証はレシートに埋め込まれた日付が当日の東京日付と一致することを要求し、日次鍵は毎日 0 時に切り替わるため、別の日のレシートは決して検証を通りません。旧形式のレシートは表示ラベル形式のリリース翌日から検証不能になっています。識別、除去、検証はいずれも現行形式だけを受け付けます（ラベル接頭辞 + 固定長 HMAC ダイジェスト + 同じ範囲の `text_link` 実体が運ぶ元レシート）。

---

<div align="center">

[← 前のページ：03 ディレクトリマップ](03-directory-map.md) · [📚 開発者ドキュメント TOP](README.md) · [⬆️ トップへ戻る](#04-実行時の正式な不変条件) · [次のページ：05 開発フロー →](05-dev-workflow.md)

</div>
