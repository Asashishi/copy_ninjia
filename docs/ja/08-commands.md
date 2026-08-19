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
<tr><td><code>/bot_status</code></td><td align="center">メンバー</td><td>ローカルプロセス指標、グローバル model capability、Telegram 429 outbound queue、有効な gag 数、このグループで Bot が現在持つ権限（JSON ブロック）、このグループで有効な機能を表示</td></tr>
<tr><td><code>/query_mood</code></td><td align="center">メンバー</td><td>このグループで現在有効な AI の気分を、再抽選せずに表示</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>isCanSwitchMood</code></td><td>AI 有効グループの気分を即時再抽選</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>isCanControllJATranslatePermission</code></td><td>日本語翻訳機能を切り替え（既定 OFF）</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>このグループの主要処理ゲートを切り替え</td></tr>
<tr><td><code>/batch_kick &lt;Nm|Nh|Nd&gt;</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>スーパーグループで、rolling 24 時間以内の指定 window に入室し、まだ在室しているメンバーを kick。blocklist には追加しません</td></tr>
<tr><td><code>/permission query</code><br><code>/permission help</code></td><td align="center">allowlist identity</td><td>呼び出し元自身の全 permission を表示、または permission 説明を JSON で一覧表示。<code>help</code> は長期保持し、<code>query</code> は 30 秒後に削除</td></tr>
<tr><td><code>/permission …</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>既存 allowlist user/channel の個別 permission を変更。<code>all</code> ですべて有効化</td></tr>
<tr><td><code>/white … enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>返信、<code>@username</code>、user id、channel id で allowlist identity を追加・削除</td></tr>
<tr><td><code>/send &lt;group_id&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code>（PM 限定）</td><td>Bot との個人チャットから指定グループへの転送セッションを開始/終了</td></tr>
</table>

> **permission 列の読み方**：`isCanXxx` を挙げた行はその permission key で認可されます。`SUPER_ADMIN_USER_ID` という identity 自体が**すべて**の permission key を持つため、SQLite allowlist table に entry がなくてもこれらの行はすべて使えます。`SUPER_ADMIN_USER_ID` を挙げた行だけが identity のみで決まり、allowlist では付与できません。

### 挙動の詳細

- **コマンドの入口ゲート**：グループコマンドは一律 `/init` ゲートを通ります。未初期化グループで受け付けるのはスーパー管理者の `/init` だけなので、`/permission` と `/white` も初期化済みグループで使う必要があります。private chat で許可される slash command は `/send` だけです。
- **アクションコマンド**：名前は `first_name last_name` 形式で、公開ユーザー名があればプロフィールへリンクします。対象の指定方法は他のコマンドと同じで、返信または `@username` です。成功したアクション結果は `/permission help` と同様に長期保持し、対象不足・引数エラー・`/x` の使い方提示は引き続き 30 秒後に削除します。
- **`/gag` の発言制限**：グローバルで同時に有効な対象は最大 5 件です。同一 chat に複数対象を置けますが、同じ identity は重複できません。入口は初期化済みで Bot がメッセージを削除できるグループだけに作成します。通常 user には、まずボタンなしの公開 status を送り、続いて `receiver_user_id` で限定された「发言」ボタン付きの一時入口を送ります。channel にはボタン付きの公開 status を 1 通だけ送ります。通常の `@bot` query は常におみくじだけへ進みます。user と channel のボタンはいずれも `gag:<対象 Telegram id>`（user は正数、channel は負数）だけを prefill します。最初の空白より前に MD5、digest、random token、group id、その他の metadata を追加してはいけません。Telegram の inline query は現在の具体的な chat id を公開せず、Bot が送信前に遮断できる hook もないため、そのような追加フィールドでは実際の入力 chat を認証できません。通常入口は current-chat button を使います。生成結果は hidden text link に `<対象プロフィール>#<セッション chat id>` を保持します。この公開 URL は検証材料であり、秘密や認証 token ではありません。着地後は、リンク内の対象とセッション chat、実際の `from.id`/`sender_chat.id`、実際の `message.chat.id` を同時に検証し、identity または chat が不一致なら直ちに削除します。channel 候補の title にグループ名は表示しません。`gag:` を持つ query はすべて gag domain が排他的に処理し、不正・期限切れ・identity 不一致では空結果だけを返して、おみくじへ fallback しません。開始 status は 30 秒の command cleanup を通らず、対象指定の `/ungag`、timeout、chat-runtime teardown のいずれかで各 message id を使って削除します。いずれかの削除失敗時は上限付き ending state を保持して有限回 retry し、すべての status が実際に消えるまで同じ対象を再 gag できません。そのため `/ungag` には返信、`@username`、identity id のいずれかが必須です。発言 rendering は grapheme ごとに抽選します：75% は filler 分岐で、その grapheme の後ろへ 3〜6 個の点を追加し（点の間には各 1/3 の確率で ASCII 空白を挟みます）、残り 25% は grapheme 全体を六つの filler のいずれかへ等確率で置き換えます。同種の操作は隣接する 2 つの grapheme までで、3 つ目の候補は gate が弾くため、75% は抽選確率であって最終テキストにおける filler の比率を約束しません。短いテキストには最低操作数の段階もあります（grapheme 2〜3、4〜7、8〜31、32〜64 でそれぞれ最低 2、3、7、15 回）。
- **`/block` ブロックリスト**：対象は返信・`@username`・ユーザー id の直接指定（正の整数。グループやチャンネルの負の id は対象外）で指名できます。id が最も確実です——手放されたユーザー名は他人が再登録でき、一方このコマンドは取り消せません。id が永続ブロックリストに入ると、監視中のどのグループの入室更新でも即 kick されます。あるグループで「管理者権限がある」と「`/init enable` 済み」が揃った瞬間には（どちらが先でも）、すでに在室しているリスト該当者もまとめて掃除します。`/unblock` は正式な SQLite ブロックリストから対象を transaction で削除し、既定で Bot が管理する全グループの BAN も解除します。対象が動的リストにいなくてもチャット横断解除は実行します。`/unblock` は `/block` にはない指定方法をもう 1 つ受け付けます——**チャンネルの負の id** です。チャンネル被りは `sender_chat` としてリストに入りますが（チャンネルのメッセージへ返信しての `/block`、広告検出の命中）、広告検出は元メッセージを削除し、公開 username の無いチャンネルはキャッシュにも載りません。負の id を拒否したままだと、そうした項目は二度と消せなくなります。逆方向を開かないのは、`/block` で会話 id を貼り間違えると会話 identity 全体を、しかも取り消せない形で BAN してしまうからです。
- **`/batch_kick` の低速 wave cleanup**：初期化済みスーパーグループでスーパー管理者だけが使用できます。引数は `30m`、`2h`、`1d` のような 24 時間以内の window 1 個です。入室ログから window 内の user ごとの最終入室を取り、まだ在室している対象を小さい固定並行数で kick します。blocklist へは追加せず、スーパー管理者・allowlist identity・恒久 blocklist の対象は通常の kick 対象として扱いません。
- **`/ad_detect` 広告検出**：メッセージは送信者ごと（`chatId:senderId`）に bundle され、1 秒ごとの queue tick が `agent.ad_detect` の model へ batch を渡し続けます。連続して発言する送信者の定常的な判定間隔は「1 tick + 分類 1 往復」です。90 秒の window は命中後の処分抑制と消費済み context の保持だけを縛るもので、「同じ人を何秒ごとに判定するか」ではありません。命中時は protected identity 以外に対して `/block` と同じ処分を行います。Bot が管理者の chat だけで発火します。メッセージ番号を除いた bundle がリンクだけ（`vless://`、`vmess://`、`trojan://`、`ss://` の proxy node や購読リンクを含む）で構成され、リンク以外の宣伝・勧誘・取引の文言が無い場合は広告と判定しません。それ以外の判定基準は [`config/ad_samples.json`](../../config_example/ad_samples.json) です。
- **連投ミュート**：チャットごとに既定で無効で、`isCanControllFloodControlPermission` を持つ identity（スーパー管理者は常に持ちます）が `/flood_control enable` で有効化します。同一人物が同一スーパーグループで 1 分以内に 15 件発言すると、その場で 3 分間ミュートし、グループに一言告知します（告知はミュート解除時に自動削除）。解除は Telegram 側が自動で行い、ブロックリストにも載せず、メッセージも削除しません。Bot が実際に「メンバーを制限」権限を持つときだけ発火し、オーナー/管理者、チャンネル名義と匿名管理者はカウントしません。bypass は `isCanBypassFloodControl` だけで決まり、allowlist entry では既定 `true`、明示的に `false` にした場合だけカウント対象になります。`SUPER_ADMIN_USER_ID` は常にこれを持つためカウントされません。
- **`/send` 転送**：開始前に対象へ到達できるか確認し、期間中はスーパー管理者の各メッセージを対象グループへ 1 回ずつ転送します。到達できなくなった場合はセッションを終了して通知します。転送状態は `state.json` に保存され、再起動後も復元されます。このコマンドは Telegram のコマンドメニューには表示されず、グループ内や他のユーザーから呼び出されても応答しません。

> [!TIP]
> **漢字 1~2 文字のアクションコマンドは事前登録が不要**で、どの漢字でも使えます。Telegram のコマンド名は ASCII（ラテン文字・数字・アンダースコア）のみのため：
> - コマンドメニューにも補完にも現れません。メニューにはプレースホルダー項目 `/x` だけを置いています。コマンド名の `x` がその変数であり、任意の漢字 1~2 文字に置き換えることを示します。実行すると使い方を 1 行返して処理を終え、通常メッセージとして AI/copy pipeline へは流しません。
> - `/咬人人` のような 3 文字以上はアクションコマンドとして扱わず、通常のメッセージ処理へ流します。
> - 登録不要で誰でも自由に作れるため、グローバルな sliding window 制限があり、グループ・ユーザーを合算して 90 秒あたり最大 450 回まで応答します。超過分は通知なしで黙って破棄されます。

> [!TIP]
> **`/luck_challenge` はスラッシュコマンドではありません。** 任意のチャットで `@Botのユーザー名 [お願い]` と入力して Inline Mode を使用します。BotFather で Inline Mode を有効にし、`/setinlinefeedback` を 100% に設定することをお勧めします。Inline query にはグローバルな sliding window 制限があり、応答は 90 秒あたり最大 300 回です。
