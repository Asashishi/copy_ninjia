# 08 コマンドと挙動リファレンス

<p align="center">
  <a href="../cn/08-commands.md">简体中文</a> · <a href="../en/08-commands.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="conntent-table.md">📚 ドキュメントホーム</a> · <a href="07-operations.md">← 前のページ：07 運用とトラブルシュート</a> · <a href="09-performance.md">次のページ：09 パフォーマンスベンチマーク →</a>
</p>

---

利用者向けの完全なコマンド表、権限の読み方、挙動の詳細です。ルート README には概要だけを残し、
正確な仕様はこのページを正とします。コマンドの実装は `packages/commands/`、権限キーの定義は
[`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts) にあります。

## 🎭 Copy モード

copy 対象はグローバルで唯一です。1 つのインスタンスは同時に 1 つの対象にしか「変身」できませんが、copy 自体はコマンドを実行したグループでのみ発生します。`/stop_copy` は任意のグループから停止できます。

| コマンド | 挙動 |
| :---: | :--- |
| `/copy` | メッセージをそのまま復唱 |
| `/r_copy` | 書記素クラスタ単位でテキストを反転 |
| `/nya_copy` | テキストの末尾に「nya~」を追加 |
| `/ja_copy` | Google Cloud Translate で日本語翻訳してから復唱 |
| `/steal_icon` | アバターのみコピー |
| `/reset_icon` | bot 本来のアバターに戻す |
| `/stop_copy` | グローバル copy 状態を停止し、アバターも元に戻す |

対象は「メッセージへの返信」または `@username` で指定します。

- **ユーザー名での検索には、Bot がそのアカウントを以前に観測している必要があります。** 改名、ユーザー名の削除、ユーザー名の再割り当てが行われると、古い別名は直ちに無効になります。`/block` や `/unblock` のような破壊的操作では、過去のユーザー名に頼らず、対象メッセージへの返信か、ユーザー id の直接指定（この 2 つのコマンドは裸の id も受け付けます）を優先してください。
- **匿名管理者が現在のグループとして発言した場合、そのグループ自体が copy 対象**となるため、グループのアバターを取得してその「外見」を再現できます。`/block` は現在のグループをメンバー対象として扱うことを拒否します。
- **一般ユーザーの copy 系コマンドには 5 分間のグローバル cooldown があり**、allowlist 境界の内側にいる identity は対象外です（SQLite allowlist table の entry と、常に内側にいる `SUPER_ADMIN_USER_ID`）。

<a id="commands-and-permissions"></a>

## 🎮 コマンドと権限

<table width="100%">
<tr><th width="26%" align="left">コマンド</th><th width="19%" align="center">権限</th><th width="55%" align="left">説明</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">メンバー</td><td>各 copy モードを開始</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">メンバー</td><td>現在のグローバル copy を停止し、アバターも復元</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">メンバー</td><td>アバターのみ取得</td></tr>
<tr><td><code>/reset_icon</code></td><td align="center">メンバー</td><td>既定アバターに戻す</td></tr>
<tr><td><code>/&lt;漢字 1~2 文字&gt;</code></td><td align="center">メンバー</td><td>アクションコマンド。<code>/咬</code> や <code>/揪住</code> で「実行者 咬了 対象！」と応答し、成功結果は長期保持</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">メンバー</td><td>自発的発言を N 分間停止（既定 3 分）</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">メンバー</td><td>静寂モードを早期解除</td></tr>
<tr><td><code>/mute … &lt;期間&gt;</code> <code>/unmute</code></td><td align="center"><code>isCanMute</code> / <code>isCanUnMute</code></td><td>スーパーグループで一時ミュート／早期解除。返信、<code>@username</code>、user id を対象にでき、期間は <code>m/h/d</code> で指定します</td></tr>
<tr><td><code>/gag … [5|10|15] [道具]</code><br><code>/ungag …</code></td><td align="center"><code>isCanGag</code></td><td>user/channel identity の発言を Bot の inline 経路だけに制限、または対象を指定して早期解除。返信、<code>@username</code>、user id、channel の負の id を指定できます</td></tr>
<tr><td><code>/block</code></td><td align="center"><code>isCanBlock</code></td><td>ブロックリスト登録：永続的に記録し、全管理グループで BAN。対象はメッセージへの返信・<code>@username</code>・ユーザー id のいずれでも指定できます</td></tr>
<tr><td><code>/unblock</code></td><td align="center"><code>isCanUnBlock</code></td><td>完全解除：動的ブロックリストから id を削除し、Bot が管理する全グループの BAN を解除します。対象指定は <code>/block</code> と同じで、チャンネルの負の id も受け付けます。静的ブロックリストの identity は拒否します</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>isCanControllAIPermission</code></td><td>このグループの AI チャットを切り替え</td></tr>
<tr><td><code>/ad_detect enable|disable</code></td><td align="center"><code>isCanControllAdDetectPermission</code></td><td>このグループの広告検出を切り替え。protected identity 以外の命中時は <code>/block</code> と同じ処分</td></tr>
<tr><td><code>/flood_control enable|disable</code></td><td align="center"><code>isCanControllFloodControlPermission</code></td><td>このグループの連投ミュートを切り替え（既定で無効）</td></tr>
<tr><td><code>/antiraid enable|disable</code></td><td align="center"><code>isCanControllAntiRaidPermission</code></td><td>このグループの参加認証と Anti-Raid の非公開モードを切り替え（既定で無効）</td></tr>
<tr><td><code>/bot_status</code></td><td align="center">メンバー</td><td>ローカルプロセス指標、グローバル model capability、Telegram 429 outbound queue、有効な gag 数、このグループで Bot が現在持つ権限（JSON ブロック）、このグループで有効な機能を表示</td></tr>
<tr><td><code>/query_mood</code></td><td align="center">メンバー</td><td>このグループで現在有効な AI の気分を、再抽選せずに表示</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>isCanSwitchMood</code></td><td>AI 有効グループの気分を即時再抽選</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>isCanControllJATranslatePermission</code></td><td>日本語翻訳機能を切り替え（既定 OFF）</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>このグループの主要処理ゲートを切り替え</td></tr>
<tr><td><code>/batch_kick &lt;Nm|Nh|Nd&gt;</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>スーパーグループで、rolling 24 時間以内の指定 window に入室し、まだ在室しているメンバーを kick。blocklist には追加しません</td></tr>
<tr><td><code>/permission query</code><br><code>/permission help</code></td><td align="center">allowlist identity</td><td>呼び出し元自身の全 permission を表示、または permission 説明を JSON で一覧表示。どちらも描画した board を長期保持</td></tr>
<tr><td><code>/permission …</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>既存 allowlist user/channel の個別 permission を変更。<code>all</code> ですべて有効化</td></tr>
<tr><td><code>/white … enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>返信、<code>@username</code>、user id、channel id で allowlist identity を追加・削除</td></tr>
<tr><td><code>/set_qa</code></td><td align="center"><code>isCanControllQaPermission</code></td><td>form を開き、開いた本人が「问题:」「回答:」の 2 通に分けて送信。両方揃うとこの chat の Q&amp;A を 1 件登録（最大 15 件、質問 256 文字・回答 3840 文字まで）</td></tr>
<tr><td><code>/query_qa</code><br><code>/query_qa &lt;質問文&gt;</code></td><td align="center">グループメンバー</td><td>この chat の Q&amp;A を JSON code block で一覧表示、または 1 件だけ照会。board 上の回答は 256 文字で切り詰め、質問は切り詰めません。収まらない場合はページ送りボタンを表示。board は長期保持し、該当なしの通知は 30 秒後に削除</td></tr>
<tr><td><code>/remove_qa &lt;質問文&gt;</code></td><td align="center"><code>isCanControllQaPermission</code></td><td>指定の Q&amp;A を削除。削除対象が無かった場合はその旨を正直に返す</td></tr>
<tr><td><code>/send &lt;group_id&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code>（PM 限定）</td><td>Bot との個人チャットから指定グループへの転送セッションを開始/終了</td></tr>
</table>

> **permission 列の読み方**：`isCanXxx` を挙げた行はその permission key で認可されます。`SUPER_ADMIN_USER_ID` という identity 自体が**すべて**の permission key を持つため、SQLite allowlist table に entry がなくてもこれらの行はすべて使えます。`SUPER_ADMIN_USER_ID` を挙げた行だけが identity のみで決まり、allowlist では付与できません。

### 挙動の詳細

- **コマンドの入口ゲート**：グループコマンドは一律 `/init` ゲートを通ります。未初期化グループで受け付けるのはスーパー管理者の `/init` だけなので、`/permission` と `/white` も初期化済みグループで使う必要があります。private chat で許可される slash command は `/send` だけです。
- **アクションコマンド**：名前は `first_name last_name` 形式で、公開ユーザー名があればプロフィールへリンクします。対象の指定方法は他のコマンドと同じで、返信または `@username` です。成功したアクション結果は `/permission help`・`/permission query` と同様に長期保持し、対象不足・引数エラー・`/x` の使い方提示は引き続き 30 秒後に削除します。
- **chat Q&A**：`/set_qa` の form は**書式付き message** でテキストを集めます。form を開く段階で `isCanControllQaPermission` を確認し、その後は「form を開いた身分本人か」だけを見ます。これにより **channel の皮（sender_chat）や匿名管理者でも Q&A を設定できます**——command 側と投稿側が見るのは同じ `sender_chat` なので、2 つの id は構造上必ず一致します。投稿の書式は行頭の `问题:` または `回答:`（半角・全角コロンどちらも可、`答案:` も同義）。値は改行を含んでよく、通常は 2 通に分けて送りますが、1 通にまとめても受け付けます。回答内の ```` ```json ```` block は**リテラルの fence のまま**保存し、直答時に code block へ戻して原文どおり送出します。したがって fence 自体も 3840 文字の上限に数えます。認識された投稿 message は削除され、AI や echo の pipeline には流れません。続いて form 本文をその場で書き換え、「已收到的问题」「已收到的回答」の 2 行が現在の状態を示します（同じ message 内の項目がすべて長さ超過で弾かれた場合は session が変わらないため、書き換えません）。2 項目の合計が Telegram の 1 通 4096 文字を超える場合は、**表示側の回答**を残り予算に合わせて切り詰めて省略記号を付け、質問はそのまま並べます——切り詰められるのはこの form 上の表示だけで、database に登録されるのは完全な原文です。form は chat ごとに 1 つ、15 分で失効します。**途中でやり直す**場合は 3 通りあります。同じ項目を送り直すと前の値を上書きし、form はもう一方を待ち続けます。**同じ人**がもう一度 `/set_qa` を送ると、古い form はその message ごと破棄され、両項目が空の状態から始まります。**別の人**が誰かの記入中に `/set_qa` を送った場合はその場で拒否し、他人の form を黙って奪いません——奪われた側には form が突然消えたようにしか見えず、追跡できないからです。form が確定した後に書式付き message を送っても認識されず、通常の message pipeline に流れます。`/init disable` と chat teardown が片付けるのは未完了の form だけで、**登録済みの Q&A は database に残ります**。運用者が登録した設定だからです。`/init enable` し直せばそのまま有効で、削除するには `/remove_qa` を使います。
- **Q&A board のページ送り**：`/query_qa` の board は 1 ページ 3 件で詰めます。2 ページ以上になると「‹ 前へ / ページ番号 / 次へ ›」の 3 ボタンを付け、同じ message をその場で書き換えます。ページ番号はどの session 状態にも入りません——クリックのたびに `callback_data` のページ番号で hot table から詰め直すため、再起動後も、`/remove_qa` で件数が変わった後も、全件削除後でさえ、古い board をもう一度押せば現在の事実に収束します。board 上の回答は 256 文字で切り詰めて省略記号を付けますが、**質問は決して切り詰めません**。質問は `/remove_qa` の引数であり、切り詰めた質問をそのまま渡しても何も削除できないからです。
- **Q&A の直接応答**：chat が `/init enable` 済みで、メッセージ本文が登録済みの質問と**一字一句同じ**場合、Bot は AI を介さず即座に回答します。@ / 返信 / ランダム発言といった通常のトリガー条件にも縛られません（Bot への返信や @ mention を含む）。先頭の `@bot ` は比較前に取り除きます。username の照合は大文字小文字を区別しません（Telegram 自体と同じ）が、質問文そのものは一字一句同じである必要があります。意味は近いが文字列が異なる質問はこの経路を通らず、AI ラウンド内の `group_qa_query` と `group_qa_answer` という 2 つの照会 tool に委ねます。どちらもラウンドの可視アクション予算を消費せず、chat に登録が無ければ tool 自体が存在しません。
- **`/gag` の発言制限**：グローバルで同時に有効な対象は最大 5 件です。同一 chat に複数対象を置けますが、同じ identity は重複できません。入口は初期化済みで Bot がメッセージを削除できるグループだけに作成します。通常 user には、まずボタンなしの公開 status を送り、続いて `receiver_user_id` で限定された「发言」ボタン付きの一時入口を送ります。channel にはボタン付きの公開 status を 1 通だけ送ります。通常の `@bot` query は常におみくじだけへ進みます。user と channel のボタンはいずれも `gag:<対象 Telegram id>`（user は正数、channel は負数）だけを prefill します。最初の空白より前に MD5、digest、random token、group id、その他の metadata を追加してはいけません。Telegram の inline query は現在の具体的な chat id を公開せず、Bot が送信前に遮断できる hook もないため、そのような追加フィールドでは実際の入力 chat を認証できません。通常入口は current-chat button を使います。生成結果は hidden text link に `<対象プロフィール>#<セッション chat id>` を保持します。この公開 URL は検証材料であり、秘密や認証 token ではありません。着地後は、リンク内の対象とセッション chat、実際の `from.id`/`sender_chat.id`、実際の `message.chat.id` を同時に検証し、identity または chat が不一致なら直ちに削除します。channel 候補の title にグループ名は表示しません。`gag:` を持つ query はすべて gag domain が排他的に処理し、不正・期限切れ・identity 不一致では空結果だけを返して、おみくじへ fallback しません。開始 status は 30 秒の command cleanup を通らず、対象指定の `/ungag`、timeout、chat-runtime teardown のいずれかで各 message id を使って削除します。いずれかの削除失敗時は上限付き ending state を保持して有限回 retry し、すべての status が実際に消えるまで同じ対象を再 gag できません。そのため `/ungag` には返信、`@username`、identity id のいずれかが必須です。発言 rendering は grapheme ごとに抽選します：75% は filler 分岐で、その grapheme の後ろへ 3〜6 個の点を追加し（点の間には各 1/3 の確率で ASCII 空白を挟みます）、残り 25% は grapheme 全体を六つの filler のいずれかへ等確率で置き換えます。同種の操作は隣接する 2 つの grapheme までで、3 つ目の候補は gate が弾くため、75% は抽選確率であって最終テキストにおける filler の比率を約束しません。短いテキストには最低操作数の段階もあります（grapheme 2〜3、4〜7、8〜31、32〜64 でそれぞれ最低 2、3、7、15 回）。
- **`/block` ブロックリスト**：対象は返信・`@username`・ユーザー id の直接指定（正の整数。グループやチャンネルの負の id は対象外）で指名できます。id が最も確実です——手放されたユーザー名は他人が再登録でき、一方このコマンドは取り消せません。id が永続ブロックリストに入ると、監視中のどのグループの入室更新でも即 kick されます。あるグループで「管理者権限がある」と「`/init enable` 済み」が揃った瞬間には（どちらが先でも）、すでに在室しているリスト該当者もまとめて掃除します。`/unblock` は正式な SQLite ブロックリストから対象を transaction で削除し、既定で Bot が管理する全グループの BAN も解除します。対象が動的リストにいなくてもチャット横断解除は実行します。`/unblock` は `/block` にはない指定方法をもう 1 つ受け付けます——**チャンネルの負の id** です。チャンネル被りは `sender_chat` としてリストに入りますが（チャンネルのメッセージへ返信しての `/block`、広告検出の命中）、広告検出は元メッセージを削除し、公開 username の無いチャンネルはキャッシュにも載りません。負の id を拒否したままだと、そうした項目は二度と消せなくなります。逆方向を開かないのは、`/block` で会話 id を貼り間違えると会話 identity 全体を、しかも取り消せない形で BAN してしまうからです。
- **`/batch_kick` の低速 wave cleanup**：初期化済みスーパーグループでスーパー管理者だけが使用できます。引数は `30m`、`2h`、`1d` のような 24 時間以内の window 1 個です。入室ログから window 内の user ごとの最終入室を取り、まだ在室している対象を小さい固定並行数で kick します。blocklist へは追加せず、スーパー管理者・allowlist identity・恒久 blocklist の対象は通常の kick 対象として扱いません。
- **`/ad_detect` 広告検出**：メッセージは送信者ごと（`chatId:senderId`）に bundle され、1 秒ごとの queue tick が `agent.ad_detect` の model へ batch を渡し続けます。連続して発言する送信者の定常的な判定間隔は「1 tick + 分類 1 往復」です。90 秒の window は命中後の処分抑制と消費済み context の保持だけを縛るもので、「同じ人を何秒ごとに判定するか」ではありません。命中時は protected identity 以外に対して `/block` と同じ処分を行います。Bot が管理者の chat だけで発火します。メッセージ番号を除いた bundle がリンクだけ（`vless://`、`vmess://`、`trojan://`、`ss://` の proxy node や購読リンクを含む）で構成され、リンク以外の宣伝・勧誘・取引の文言が無い場合は広告と判定しません。それ以外の判定基準は [`config/ad_samples.json`](../../config_example/ad_samples.json) です。
- **参加認証と Anti-Raid**：チャットごとに既定で無効で、`isCanControllAntiRaidPermission` を持つ identity（スーパー管理者は常に持ちます）が `/antiraid enable` で両方を有効化します。2 つの経路は同じ参加イベントを消費するため、スイッチは 1 つだけです。分けると「認証は無効なのに非公開モードだけがキックし続ける」という組み合わせが生まれます。無効な間はどちらの経路も 1 件もイベントを発火しません。認証ウィンドウを開かず、リマインダーも送らず、タイムアウトによるキックも行わず、参加頻度の集計も止めます。すでに開いているウィンドウは未処理の終了状態ごと破棄します。投稿済みの 2 種類の認証リマインダーは削除します——その時点でボタンは失効しており、グループに残し続けられないためです。参加アナウンスとメンバー自身のメッセージには触れず、キックも行いません。有効なままの非公開モードは招待権限を戻します。同じ Worker 上にある広告検出、連投ミュート、永久ブロックリストの即時キック、`/batch_kick` が依存する参加ログはいずれも影響を受けません。
- **連投ミュート**：チャットごとに既定で無効で、`isCanControllFloodControlPermission` を持つ identity（スーパー管理者は常に持ちます）が `/flood_control enable` で有効化します。同一人物が同一スーパーグループで 1 分以内に 15 件発言すると、その場で 3 分間ミュートし、グループに一言告知します（告知はミュート解除時に自動削除）。解除は Telegram 側が自動で行い、ブロックリストにも載せず、メッセージも削除しません。Bot が実際に「メンバーを制限」権限を持つときだけ発火し、オーナー/管理者、チャンネル名義と匿名管理者はカウントしません。bypass は `isCanBypassFloodControl` だけで決まり、allowlist entry では既定 `true`、明示的に `false` にした場合だけカウント対象になります。`SUPER_ADMIN_USER_ID` は常にこれを持つためカウントされません。
- **`/send` 転送**：開始前に対象へ到達できるか確認し、期間中はスーパー管理者の各メッセージを対象グループへ 1 回ずつ転送します。到達できなくなった場合はセッションを終了して通知します。転送状態は `state.json` に保存され、再起動後も復元されます。このコマンドは Telegram のコマンドメニューには表示されず、グループ内や他のユーザーから呼び出されても応答しません。

> [!TIP]
> **漢字 1~2 文字のアクションコマンドは事前登録が不要**で、どの漢字でも使えます。Telegram のコマンド名は ASCII（ラテン文字・数字・アンダースコア）のみのため：
> - コマンドメニューにも補完にも現れません。メニューにはプレースホルダー項目 `/x` だけを置いています。コマンド名の `x` がその変数であり、任意の漢字 1~2 文字に置き換えることを示します。実行すると使い方を 1 行返して処理を終え、通常メッセージとして AI/copy pipeline へは流しません。
> - `/咬人人` のような 3 文字以上はアクションコマンドとして扱わず、通常のメッセージ処理へ流します。
> - 登録不要で誰でも自由に作れるため、グローバルな sliding window 制限があり、グループ・ユーザーを合算して 90 秒あたり最大 450 回まで応答します。超過分は通知なしで黙って破棄されます。

> [!TIP]
> **`/luck_challenge` はスラッシュコマンドではありません。** 任意のチャットで `@Botのユーザー名 [お願い]` と入力して Inline Mode を使用します。BotFather で Inline Mode を有効にし、`/setinlinefeedback` を 100% に設定することをお勧めします。Inline query にはグローバルな sliding window 制限があり、応答は 90 秒あたり最大 300 回です。
