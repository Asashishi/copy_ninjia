[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# デプロイ設定リファレンス

このディレクトリには、Git に commit できる構造例だけを置きます。Bot が実際に読むのは
プロジェクトルートにある Git ignore 対象の `config/` です。example の token、API key、
user ID、model、endpoint は deployment で確認した値へ置き換えてください。placeholder は
production 設定として使用できません。

初回 deployment では、まだ存在しない JSON だけをコピーできます。`g-auth.json` の例は構造を、
`cron.json` の例は定時タスクの書き方を示すだけなので、どちらもコピーしないでください。

```bash
mkdir -p config
for example in config_example/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" config/ ;;
  esac
done
```

既存 file を上書きする copy command を使わず、`config_example/` を deployment backup として
扱わないでください。`config/` には credential が含まれるため、service account だけが読める
権限を推奨します。稼働中の `ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、
`cron.json` の変更は hot reload され、それ以外の file は変更後に再起動が必要です（下記「稼働中の変更」）。allowlist、
blocklist、未完了 removal は deployment 設定ではなく runtime data であり、
`database/storage.sqlite` にまとめて保存し、command または明示 migration script だけで変更します。

すべての JSON は strict schema で解析します。file が存在する場合、未知／誤記 field、型違い、
不正 enum、競合、範囲外の値は Telegram 接続や Worker 作成前に startup を失敗させます。
不正設定の修復、無視、silent fallback は行いません。本当に欠落している optional capability
だけが、以下の feature boundary に従います。

## ファイルと startup boundary

| ファイル | 設定内容 | 欠落時の動作 |
| --- | --- | --- |
| `bot.json` | Telegram Bot token と唯一のスーパー管理者 | 常に startup を拒否 |
| `agent.json` | capability ごとの AI provider、credential、endpoint、model | capability ごとに異なる。下記参照 |
| `stickers.json` | AI chat が使える sticker pack | AI chat を有効化できない。すでに有効だった chat は静かに止まるが startup は成功する |
| `mood.json` | AI mood、base probability、天気／時刻 multiplier | AI chat を有効化できない。すでに有効だった chat は静かに止まるが startup は成功する |
| `ad_samples.json` | 広告分類の positive reference | 広告検出を有効化できない。すでに有効だった chat は静かに止まるが startup は成功する |
| `cron.json` | 定時送信タスク（テキスト・画像・ファイル・ボイス） | 定時タスクなし |
| `g-auth.json` | `/translate` 用の Google Cloud service account key。例は placeholder だけで、実 key はデプロイ側が帯域外で `config/` に置く | 翻訳を有効化できない。有効な翻訳セッションは message を処理しなくなるが startup は成功する |

AI chat はこのディレクトリにない `prompt/persona.md` にも依存します。optional file が存在するのに
不正な場合、feature が無効でも startup を拒否します。

## 稼働中の変更

bot は `config/` を監視します。`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、
`cron.json` を最後に保存してから約 0.5 秒後に、起動時と同じ strict schema で parse し直します。

- parse が通り内容が変わっていれば snapshot を差し替えて関係する Worker に渡し、log に
  `Reloaded deployment config <path>.` を 1 行残します。実行中の model request は旧設定で完了します。
- parse に失敗した変更は丸ごと拒否し、file path・field path・期待される形を示す error を
  log に 1 行残して、直前に適用済みの設定を使い続けます。不正なまま残すと次回 startup は拒否されます。
- `ad_samples.json`・`agent.json`・`mood.json`・`stickers.json` の追加・削除、`agent.json` での `ad_detect` 全体、または `text`・`summary`・
  `media` のいずれかの追加・削除は、対応する機能の可用性をそのまま変えます。前提が欠けた AI
  雑談や広告検出はすぐに停止して理由を log に 1 行残し、グループ switch は元の値のままです。
  前提が戻れば再起動なしで自動的に再開します。file を削除すると log に
  `Deployment config <path> was removed.` を残します。`image`・`tts` の追加・削除はそのまま反映します。
- `cron.json` の `send_voice` は `agent.json` の `tts`（と `text`・`summary`・`media`）に依存します。
  新しいタスク表が `send_voice` を使うのにその時点で使える `tts` が無ければ、`cron.json` の変更を
  丸ごと拒否します。タスク表がまだ `send_voice` を使っている間は、`tts`（または `agent.json` 全体や
  会話 core capability）を外す `agent.json` の変更も同様に丸ごと拒否します。どちらの拒否も直前に
  適用済みの設定を使い続けて error log を残します。起動時に同じ組み合わせがあれば起動を拒否します。
- `stickers.json` に新しく加えた pack はすぐに catalog 生成を始めます。外した pack は AI に
  提示されなくなり、その catalog は次回 startup 時に allowlist に沿って整理されます。
- `mood.json` に残っている mood は各 chat に即時反映し、現在の mood が削除された chat は次に
  使うときに引き直します。
- `cron.json` はタスク名で照合します。内容が変わらないタスクは元のタイミングを保ち、変更・
  削除されたタスクはスケジュールを止め（実行中の回は次の動作の前で止まります）、新しいタスクは
  スケジュールを始めます。ファイルを削除するとすべてのタスクが消えます。

`bot.json`、`prompt/persona.md`、`g-auth.json` は hot reload されず、変更後は再起動が
必要です。

## `bot.json`

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789,
  "atmosphere": "mesugaki"
}
```

- `bot_token`：BotFather が発行する非空の Bot API token。secret です。
- `super_admin_user_id`：唯一のスーパー管理者を表す正の safe integer Telegram user ID。
  username ではありません。この identity は付与可能な全 permission を本来持つため、
  SQLite allowlist table に重ねて追加しないでください。

任意の `atmosphere` は `"mesugaki"`（雌小鬼、既定）または `"normal"`（普通）のみ受け付けます。カスタム AI 人設のある群は引き続き普通の通知を優先し、その他の群の通知とメニューにはこの設定を使います。送信先群の情報がない inline 運勢にも Bot の口調設定を使います。変更は再起動で反映され、installer で identity を再入力しても有効な風格は維持されます。`telegram.json` が残っている場合、`bot.json` との併存も含め、明示的な cold migration まで起動とインストールを拒否します。

## `agent.json`

top level は 1 個の `agent` object だけを持てます。各 capability は protocol、API key、
endpoint、model を独立に選びます。capability ごとに別 service を使うことも同じ key を繰り返す
こともできますが、credential や failure が capability 間で fallback することはありません。

| capability | 実行時の用途 | 必須関係 |
| --- | --- | --- |
| `ad_detect` | message bundle の広告判定 | optional。欠落は広告検出だけを阻止 |
| `text` | group chat 本文生成と tool call | AI chat core。`summary`、`media` と同時に必要 |
| `summary` | 長期会話 memory の圧縮と sticker pack summary | AI chat core。必須 |
| `media` | 画像／sticker 説明と voice 転写 | AI chat core。必須 |
| `image` | 生画像 tool の登録 | optional。欠落はこの tool だけを除去 |
| `tts` | 音声合成：AI のボイス tool（日本語セリフを合成してボイスメッセージで送信）、`/send` 中継の TTS request、`cron.json` の `send_voice` で共用 | optional。欠落または implementation 非対応ならボイス tool を除去し、`/send` の TTS request は error になる。`cron.json` が `send_voice` を使うなら必須 |

通常 capability の field は次の 4 個です。

| field | 意味 |
| --- | --- |
| `provider` | request protocol。`google` または `openai` のみ。model brand ではない |
| `api_key` | この capability 専用の非空 API key |
| `base_url` | optional の absolute `https` endpoint。省略時は選択 SDK の official endpoint。平文 `http` は `localhost`・`127.0.0.1`・`::1`（ローカル proxy）のみ許可し、それ以外は起動を拒否します——このフィールドの隣には同じ capability の `api_key` があるためです。URL に userinfo と `#` fragment を含めることはできません |
| `model` | endpoint が受理する非空 model identifier。program は推測も書換えもしない |

xAI や別の OpenAI-compatible gateway は `provider: "openai"` とし、その capability の
`base_url` と `model` を設定します。`provider` は SDK と wire protocol だけを選び、URL や
model 名から自動判定しません。

`image.provider` が `openai` の場合、画像 request shape を示す `image_protocol` も必須です。

- `openai`：OpenAI `gpt-image-2` の任意 size protocol。
- `openai-standard`：GPT Image family 共通の standard size protocol。
- `xai`：xAI JSON／aspect-ratio protocol。

`image.provider` が `google` の場合は `image_protocol` を書けません。

`tts` は 4 個の field に加えて空でない `voice` が必須で、合成 request の voice としてそのまま渡します。
prebuilt voice 名（例の `Leda`）、または AI Studio Voice design が生成した `voice_` voice ID を指定できます。
design した voice はその `api_key` の project に属し、1 年後に失効します。プログラムは空でない文字列で
あることだけを検証し、voice が存在するかは最初の合成 request で決まります。現在、音声合成を実装して
いるのは Google だけなので、`tts.provider: "openai"` は設定検証を通ってもボイス tool を登録せず、
`/send` と `cron.json` の音声 request も失敗して error log を残します。3 つとも AI Worker 上で合成する
ため、AI chat の残りの前提（`stickers.json`、`mood.json`、`prompt/persona.md`）も揃っている必要があり、
欠けていると合成は「Worker 利用不可」で失敗します。

`media` の vision と voice 対応は、最初の実 request で別々に probe／cache します。明示的に
unsupported と判定した後、その Worker は同種 media を download しません。成功は supported、
一時的 network error は unknown のままなので後続 media が再 probe できます。通常の
Google/OpenAI HTTP request は初回 failure 後に最大 5 回 retry します。hot reload による `media`
の差し替え、または Worker／process 再構築で probe 結果を消します。

## 資格情報を外す前に機能を無効化する

ある機能がどこかのグループで有効なまま、その API key や設定を外しても、プロセスは**通常どおり
起動**し、その `true` も従来どおり復元されます。ただしその機能は唯一の判定入口で利用不可と
判定されます——起動時に前提が欠けていれば AI 雑談の Worker はそもそも起動せず（ディスク上の
スナップショットはそのまま保持）、稼働中に外せば hot reload 後に Worker が待機します。`/translate` の
セッションはメッセージを処理せず、広告検出は bundle を送らなくなります。グループからは Bot が外した
時点（またはその再起動）を境に働かなくなったようにしか見えず、痕跡は `logs/` の 1 行だけです。
正しい順序は、まずグループで `/ai_chat disable`、`/ad_detect disable`、`/translate disable` を実行し、
その後に設定を外すこと。あるいは前提を復旧することです。AI 雑談と広告検出は hot reload で自動的に
再開しますが、`g-auth.json` を戻した場合は再起動が必要です。

**方向に注意**：これはファイルが**本当に存在しない**場合だけです。ファイルが残っていて内容が
不正なら、対応機能が今オフでも従来どおり起動時のゲートが拒否します。

## identity policy とグループ状態は `config/` に置かない

allowlist、blocklist、未完了 removal、そして**グループ単位の状態**（機能スイッチ、静音、
ロックダウン記録、Bot の権限スナップショット、グループ名、中継フラグ）の authoritative source は
いずれも runtime data root の `database/storage.sqlite` です。グループ状態は `chat_states` テーブルに
あり、最大 25 グループまで。超過時は `/init enable` が 1 行の返信で拒否します。`/white`、`/permission`、`/block … enable`、`/block … disable` は Disk I/O Worker
経由の transaction で変更を永続化し、通常の deployment は database を直接編集しません。
permission key と default は `/permission help` が現行 reference です。不正 schema、未対応 version、
2 つの policy table の重複は network 接続前に startup を拒否します。legacy JSON deployment は
[運用文書](../../docs/ja/07-operations.md) の一回限りの migration に従い、旧 file を `config/` へ戻さないでください。

## `stickers.json`

`packs` は `t.me` link ではなく Telegram sticker pack の short name 配列です。unique entry は
最大 5 個。空配列は設定 sticker pack を無効化します。Bot が各 pack を読める必要があります。

## `mood.json`

`moods` は非空配列で、各 entry は次を持ちます。

- `name`：unique な非空 mood 名。
- `weight`：正 integer の base weight。全 mood の合計は正確に 100。
- `instruction`：AI に注入する非空 behavior instruction。
- `weatherMultipliers`：optional。key は `clear`、`cloudy`、`rain`、`snow`、`storm`、`fog` のみ。
- `timeMultipliers`：optional の東京時刻 multiplier。key は `lateNight`、`morning`、`daytime`、
  `evening`、`night` のみ。

省略 multiplier は `1`。存在する値は finite、0 より大きく 100 以下でなければなりません。
multiplier はその時点の抽選確率だけを調整し、base weight 合計 100 の rule は変えません。

## `ad_samples.json`

top level は string 配列です。各 entry は「広告として分類すべき内容」の positive example で、
deployment の分類方針を定義します。keyword blocklist ではありません。最大 500 件で、whitespace
normalize 後に非空、unique、1,024 文字以下でなければなりません。識別情報を除いた sample を使い、
無関係な個人情報や実 credential を置かないでください。

## `g-auth.json`

例は GCP console からダウンロードする service account key file と同じ形で、構造の対照用です。
placeholder の秘密鍵は parse できないため、そのまま `config/` に置くと startup を拒否します。
翻訳を使う場合は実 key file を `config/g-auth.json` として保存し、使わない場合はこの file を
置かないでください。`client_email` は非空、`private_key` は parse 可能な RSA PEM 秘密鍵で、
`type` は存在する場合 `service_account` に限ります。`private_key_id`、`project_id`、
`quota_project_id`、`universe_domain` は存在する場合に非空 string でなければならず、その他の
公式 field はそのまま SDK に渡します。installer はこの例から file を作りません。

## `cron.json`

トップレベルはタスクの配列で、ファイルが無いか `[]` なら定時タスクはありません。strict JSON
のためコメントは書けません。

[`config_example/cron.json`](../cron.json) にはすべての書き方を網羅する例のタスクがあります：平日の
テキスト、time zone を明示してテキスト・URL の画像・ファイルを順に送るもの、
プロジェクトルートからの相対パスで指定したローカル画像と絶対パスで指定したローカルファイル、
`rand_cron` の区間で既定の画像ライブラリから抽選する
もの、`@daily` と単一値の `rand_cron` で指定ディレクトリから抽選するもの、口調ありと口調なしの
`send_voice`、そして `just_once` です。
例の会話 id、URL、ローカルパスはすべて架空で、そのまま `config/` に置くとローカルファイルが存在
しないため起動を拒否します。必要なタスクだけを選び、会話 id とパスを実際の値に書き換えてから
`config/cron.json` に書いてください。installer が例からこのファイルを作ることはありません。

```json
[
  {
    "name": "daily-greeting",
    "chat_id": [-1001234567890],
    "cron": "0 9 * * *",
    "time_zone": "Asia/Tokyo",
    "rand_cron": "6h-24h",
    "actions": [
      { "type": "send_message", "payload": { "content": "おはよう" } },
      { "type": "send_image", "payload": { "content": "今日の一枚", "rand_image": true } },
      { "type": "send_image", "payload": { "url": ["https://example.com/a.png", "https://example.com/b.png"], "is_blurred": true } },
      { "type": "send_file", "payload": { "content": "週報", "path": "/srv/copy-ninjia/reports/weekly.pdf" } },
      { "type": "send_voice", "payload": { "tone": "眠そうに小声で", "content": "おはよう、今日もがんばろうね" } }
    ]
  }
]
```

| フィールド | 必須 | 規則 |
| --- | --- | --- |
| `name` | はい | 空でなく 64 文字以内、ファイル内で一意。タスクの識別子で、名前を変えると別タスク |
| `chat_id` | はい | chat id の配列：個別に列挙（0 以外の整数、重複不可、最大 64 件）、`["all"]`（送信できる有効化済みグループすべて）、`["except", <id>, ...]`（`all` から列挙した会話を除外）。下記参照 |
| `cron` | はい | 5 フィールドの式か `@daily` などの別名。将来の発火時刻が必要 |
| `time_zone` | いいえ | IANA タイムゾーン名（例：`Asia/Shanghai`）。既定 `Asia/Tokyo` |
| `rand_cron` | いいえ | `"<最短>-<最長>"` または単一値（`1m-<値>` と同じ）。単位 m/h/d、範囲 1m–24d。初回は `cron` に従い、以後は各回の終了後に範囲内でランダムに待つ |
| `just_once` | いいえ | `true` なら 1 回だけ実行し、再起動するまで再登録しない。`rand_cron` とは併用不可。**実行記録はメモリだけにあり、再起動で消えます**：実行し終えたタスクは `cron.json` から削除してください。残したままだと次の再起動後にもう一度流れます。そのため「今夜 22:00 から停止」のような再起動と強く結びついた内容には使わないでください |
| `actions` | はい | 1–16 個の動作。順に実行し、隣り合う動作の間は 1 秒 |

動作の `type` と `payload`：

- `send_message`：`content` 必須、最大 4096 文字。
- `send_image`：`content` は任意の単一文字列（最大 1024 文字）。固定画像は `url` 配列かファイル `path` 配列のどちらか一方、1–10 項目を指定します。1 枚でも `"url": ["https://example.com/a.jpg"]` のように配列にし、`rand_image` は省略または `false` のみです。1 枚は写真、2–10 枚は 1 回のアルバム要求で送り、caption は先頭だけ、別のテキスト投稿はしません。アルバムには複数の Telegram message ID があります。`is_blurred: true` は全画像に spoiler を付け、省略または `false` は付けません。
  `rand_image: true` は 1 枚だけ抽選します。`url` とファイル配列は禁止で、`path` は任意のディレクトリ文字列です。省略時は `state.global.assets.randomHImageDir`、別のディレクトリを明示した場合は SHA-256 命名規則を要求しません。
- `send_file`：`content` は任意（最大 1024 文字）。送信元は `url` か `path` のちょうど 1 つ。
- `send_voice`：`content` は必須で、読み上げるセリフ（最大 256 文字）です。`tone` は任意で、この 1 文の
  話し方（最大 64 文字）を固定のベース声色の後ろに付け足し、省略するとベース声色だけを使います。
  どちらも改行を空白にまとめ、前後の空白を除いた後で空であってはなりません。セリフは `agent.json` の
  `tts` で合成してボイスメッセージとして送るため、`tts` の設定が必須です（上記「稼働中の変更」参照）。
  同じ回ではこのボイスを 1 回だけ合成し、再試行や後続グループへの送信は同じ音声を使い回します。最初の送信が成功した後は
  Telegram が返した `file_id` を参照し、再アップロードしません。

`path` は絶対パスか、プロジェクトルート（ソース実行ではリポジトリのルート、バイナリではサービスの
作業ディレクトリ）からの相対パスで書き、ホスト上のどこにあるファイルやディレクトリでも指せます
（シンボリックリンクはリンク先で判定します）。読み込み時に存在と種類を確認します。service account
が読めるファイルはすべてチャットに送れてしまうため、`config/` や `.env` など資格情報を含むファイル
を指さないでください。`url` はそのまま Telegram に渡し、Bot はダウンロードしません。URL 送信では Telegram
の上限が画像 5 MB・その他 20 MB で、ファイルの URL 送信で確実なのは PDF・ZIP・GIF だけです。
それ以外の形式で送れないのは設定の問題です。ローカルからのアップロード上限は画像 10 MB、
ファイル 50 MB です。

実行時の振る舞い：

- 同じタスクの回が重なることはなく、停止中に逃した発火は補いません。`just_once` の実行記録と
  `rand_cron` の待ち時間はメモリだけにあり、再起動するとやり直しです。
- ネットワーク、Telegram の 5xx、出力ゲートの再試行後も返る 429、送信キュー満杯で失敗した動作は 2・4・8 秒の間隔で最大 3 回
  再試行します。`send_voice` の合成が音声を返さなかった場合、待機のタイムアウト、AI Worker が一時的に
  使えない場合も同様に再試行します。それ以外（Telegram の 4xx、グループからの削除、ローカルファイルの削除、
  `tts` が未設定または implementation 非対応、音声エンコードの失敗など）は再試行しません。最終的に失敗すると `Cron task "<name>" action #<n> ...` をログに 1 行残し、
  その回の残りの動作を飛ばします。タイムアウトしても Telegram 側に届いていた場合、再試行で
  重複して送られます。
- 定時メッセージは残し、30 秒削除は掛けません。フォーラムのトピックは付けないため、トピックを
  有効にしたグループでは General に送ります。すべての要求は Bot の通常の送信レート制御と
  429 の待機を通ります。
- 送信先のグループで `/init` は不要です。Bot がそこから削除されると、発火のたびにエラーを
  ログに残します。
- `chat_id` に会話を個別に列挙した場合（例 `[-1001234567890, -1009876543210]`）は、送信権限を
  確認せず記述順に送り、会話の間も 1 秒空けます。ある会話で最終的に失敗してもその会話の残りの
  動作を飛ばすだけで次へ進み、複数列挙時は失敗ログにどの会話かを書きます。
- `chat_id: ["all"]`：各回の開始時に、`/init enable` 済みの全グループについて Bot の現在の送信権限を
  1 つずつ確認します（オーナーと管理者は送信可、制限中は Bot 自身の送信権限、一般メンバーならグループの
  既定メンバー権限で判定）。テキストはメッセージ送信、画像は写真送信、ファイルはドキュメント送信、
  ボイスはボイスメッセージ送信の権限が必要で、タスクが使う権限が 1 つでも欠けるグループは丸ごと飛ばし、半分だけ届くことはありません。
  送信できるグループは chat id の昇順で動作一式を順に実行し、グループ間も 1 秒空けます。あるグループ
  で最終的に失敗しても、そのグループの残りの動作を飛ばすだけで、chat id をログに残して次のグループへ
  進みます。飛ばしたグループがあれば、回の終わりに `Cron task "<name>" skipped <n> chat(s) without send permission.`
  を 1 行残します。ランダム画像はグループごとに別々に抽選します。
- `chat_id: ["except", <id>, ...]`：判定は `["all"]` と同一で、列挙した会話を候補から先に外すだけです。
  除外したグループは照会もせず、skipped にも数えません。先頭は必ず `"except"` で、後ろに chat id が
  1 件以上必要です。

## 専用画像庫とパスの基準

| パス項目 | 相対パスの基準 | 形式 |
| --- | --- | --- |
| `state.global.assets.randomHImageDir` | 実行時データルート | 絶対ディレクトリまたは `./`・`../` で始まるパス |
| cron 固定画像 `payload.path` | プロジェクトルート | ファイルパス 1〜10 個の配列 |
| cron ランダム画像 `payload.path` | プロジェクトルート | 任意のディレクトリ文字列。省略時だけ専用画像庫を選択 |
| cron ファイル `payload.path` | プロジェクトルート | 単一ファイルパス文字列 |

`state.global.assets.randomHImageDir` は `/h_image` 専用で、既定は `./h_image` です。`/h_image` のような絶対パスと `./h_image`、`../h_image` のような明示的相対パスを受け付け、相対パスは runtime data root 基準です。他機能の画像を混ぜず、追加は `/h_image add` を使ってください。手動追加は内容 SHA-256 の小文字 16 進数 64 文字をファイル名本体にし、拡張子は jpg/jpeg/png/webp とします。Worker と外部接続より前に名前と項目型を非同期検査し、不正ファイル、サブディレクトリ、ファイル symlink、残存一時ファイルがあれば起動を拒否します。全画像の内容ハッシュは再計算せず、手動名と内容の一致は運用者の責任です。cron で明示した別のディレクトリには命名規則を課しません。ローカル内容の読み取り・事前検査・アップロードは非同期で、アルバム全体の画像を先読みせず再オープン可能な stream を保持します。
