[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# デプロイ設定リファレンス

このディレクトリには、Git に commit できる構造例だけを置きます。Bot が実際に読むのは
プロジェクトルートにある Git ignore 対象の `config/` です。example の token、API key、
user ID、model、endpoint は deployment で確認した値へ置き換えてください。placeholder は
production 設定として使用できません。

初回 deployment では、まだ存在しない JSON だけをコピーできます。

```bash
mkdir -p config
cp -n config_example/*.json config/
```

既存 file を上書きする copy command を使わず、`config_example/` を deployment backup として
扱わないでください。`config/` には credential が含まれるため、service account だけが読める
権限を推奨します。設定は hot reload されず、手動変更後は再起動が必要です。allowlist、
blocklist、未完了 removal は deployment 設定ではなく runtime data であり、
`database/storage.sqlite` にまとめて保存し、command または明示 migration script だけで変更します。

すべての JSON は strict schema で解析します。file が存在する場合、未知／誤記 field、型違い、
不正 enum、競合、範囲外の値は Telegram 接続や Worker 作成前に startup を失敗させます。
不正設定の修復、無視、silent fallback は行いません。本当に欠落している optional capability
だけが、以下の feature boundary に従います。

## ファイルと startup boundary

| ファイル | 設定内容 | 欠落時の動作 |
| --- | --- | --- |
| `telegram.json` | Telegram Bot token と唯一のスーパー管理者 | 常に startup を拒否 |
| `agent.json` | capability ごとの AI provider、credential、endpoint、model | capability ごとに異なる。下記参照 |
| `stickers.json` | AI chat が使える sticker pack | AI chat を有効化できず、すでに有効な chat があれば startup を拒否 |
| `reactions.json` | Telegram reaction の候補 keyword | AI chat を有効化できず、すでに有効な chat があれば startup を拒否 |
| `mood.json` | AI mood、base probability、天気／時刻 multiplier | AI chat を有効化できず、すでに有効な chat があれば startup を拒否 |
| `ad_samples.json` | 広告分類の positive reference | 広告検出を有効化できず、すでに有効な chat があれば startup を拒否 |

AI chat は `prompt/persona.md`、日本語翻訳はプロジェクトルートの `g-auth.json` にも依存します。
どちらもこのディレクトリにはありません。optional file が存在するのに不正な場合、feature が
無効でも startup を拒否します。

## `telegram.json`

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789
}
```

- `bot_token`：BotFather が発行する非空の Bot API token。secret です。
- `super_admin_user_id`：唯一のスーパー管理者を表す正の safe integer Telegram user ID。
  username ではありません。この identity は付与可能な全 permission を本来持つため、
  SQLite allowlist table に重ねて追加しないでください。

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
| `song` | 生歌 tool の登録 | optional。欠落または implementation 非対応ならこの tool だけを除去 |

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

`image.provider` が `google` の場合は `image_protocol` を書けません。現在、song generation を
実装しているのは Google だけなので、`song.provider: "openai"` は generic schema を通っても
song tool を登録しません。

`media` の vision と voice 対応は、最初の実 request で別々に probe／cache します。明示的に
unsupported と判定した後、その Worker は同種 media を download しません。成功は supported、
一時的 network error は unknown のままなので後続 media が再 probe できます。通常の
Google/OpenAI HTTP request は初回 failure 後に最大 5 回 retry します。Worker／process 再構築で
probe 結果を消し、新設定を適用します。

## identity policy は `config/` に置かない

allowlist、blocklist、未完了 removal の authoritative source は runtime data root の
`database/storage.sqlite` です。`/white`、`/permission`、`/block`、`/unblock` は Disk I/O Worker
経由の transaction で変更を永続化し、通常の deployment は database を直接編集しません。
permission key と default は `/permission help` が現行 reference です。不正 schema、未対応 version、
2 つの policy table の重複は network 接続前に startup を拒否します。legacy JSON deployment は
[運用文書](../../docs/ja/07-operations.md) の一回限りの migration に従い、旧 file を `config/` へ戻さないでください。

## `stickers.json`

`packs` は `t.me` link ではなく Telegram sticker pack の short name 配列です。unique entry は
最大 5 個。空配列は設定 sticker pack を無効化します。Bot が各 pack を読める必要があります。

## `reactions.json`

`emotionKeywords` は Telegram が対応する standard reaction emoji を非空 keyword 配列へ mapping
します。model output が keyword に一致すると、その reaction が候補になります。custom emoji、
空 keyword、string 以外の entry は不正です。

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
