# 04 · ロックダウンミラーと終端フラグ

[简体中文](../cn/04-lockdown-invariants.md) · [English](../en/04-lockdown-invariants.md) · [日本語](../ja/04-lockdown-invariants.md)

[← 04 実行時の正式な不変条件](04-invariants.md)

- lockdown の永続化ハンドシェイクで使う指紋は `phase`、`intentId`、`announced` で構成します。前 2 つは 1 回の lockdown 意図の安定した同一性です。`announced` は 1 intent につき false から true へ最大 1 回しか変わりませんが、復元後に解除告知を送れるかを決めるため、永続化 acknowledgement が必ず覆わなければなりません。緊急 permission 復元が遅延結果を現 intent のものか判断するときは、引き続き `phase` と `intentId` だけを比較します。告知 flag の永続化は新しい permission intent を作らないからです。どちらの指紋にも `expiresAt` を含めてはいけません。`APPLYING`/`RESTORING` の段階では公開時点の実時計をそのまま入れるため、同じ意図でも 2 回公開すれば（たとえば告知結果の永続化で）値が変わります。

  含めてしまうと、メインスレッドの「保存してからもう一度同じ意図かを見る」照合ループが一致にたどり着かず、1 周ごとに `state.json` と LKG のファイル全体を fsync 付きで書き直します。公開がその書き込みより速いとループは終わらず、指紋も永続化受領も一生生まれません。カウントダウン自体はミラーの `expiresAt` に残り、adopt はそこから残り時間を換算します。このループには保険として周回上限もあります。

  永続化の実行中に新しいイベントが届くと再実行待ちフラグを立てます。上限を使い切った場合、現在の task はエラーログを残して microtask を譲り、その後で最新ミラーから新しい task を自動的に開始します。最後の wake-up を次の外部 lockdown イベントに依存させてはいけません。
- Worker が自己修復を諦めた後、メインスレッドの `recoverAbandonedLockdowns` は snapshot ではなくチャット状態 LRU を直接走査します。復旧チェーンは最初の `await` より前に現在の項目を同期的に `get` し、最新端へ移動させます。`libs/lruCache.ts` の iterator はそのために 1 枠の退避スロットを持ちます：停留中の項目が外されてもその後ろの項目を飛ばさず、その項目は末尾でもう一度だけ産出されます。**終了が保証されるのは「各項目が最新端へ移されるのは高々 1 回」の場合だけ**です——同じグループの 2 回目の産出では復旧がすでに登録済みで、`startEmergencyLockdownRecovery` は fingerprint を見て cache を読まずに戻ります。走査中に繰り返し並べ替える、まとめて削除する、入れ子で走査する場合は先に snapshot（`[...cache]`）を取ってください。
- 現行の lockdown ミラーには `phase` と正の `intentId` が必要で、認証待ち active record には `phase` と `trackedMessageTimes` が必要です。reminder ID と `announcementMessageId` は業務上 optional のままで、欠落は reminder がまだ送信成功していないこと、あるいはこの record が入室アナウンスを観測しなかったことだけを表し、復元時にはそれぞれの再送・清掃経路を使います。

  それ以外の欠落・非互換 field は旧プロセス停止中に手動 migration し、production 読み取り経路に互換 logic を残しません。
- **終端通知の 3 flag を独立に永続化します。** `successNoticeSent` は成功報告、`failureNoticeSent` は kick 失敗または `can_restrict_members` 不足、`unconfirmedNoticeSent` は member または chat type の確認不能を記録します。3 種類とも main thread が送信成功から 30 秒後に削除します。各 flag は Worker 再生成や process 再起動後の同種通知の再送を防ぎ、相互に代用できません。flag の設定は新 revision を publish し、終端 retry はその永続化確認を待ちます。

  **kick は成功したのに成功戦報を送れなかった場合、そこで完了扱いにしてはいけません。** 完了は record の削除を意味し、グループからはメンバーが理由もなく消えたように見え、それを説明する唯一の一文は二度と出ません。この経路では backoff の前に `removalConfirmed` を snapshot へ書きます。これも永続化が必須です。無ければ次の回のメンバー確認は「もうグループにいない」としか答えず、終端は「他人が処分した」として黙って完了し、戦報は永久に飲み込まれます。書くのは戦報の送信に失敗したときだけで、通常の 1 周では kick と戦報が同じ周で完了するため追加の書き込みは発生しません。
- **「BAN 権限が無いと確証できたら以後リクエストを出さない」短絡は、片付けが済んでいることを前提とします**（`cleanupSettled`）。`failureNoticeSent` だけを見ると、ネットワークの揺れで 1 度削除に失敗した入室確認の告知はそこで固定されます。以後は毎回この短絡で return し、片付けの処理は二度と実行されず、押せる確認ボタン付きのメッセージが、実際には kick されていないメンバーのためにグループへ永久に残ります。片付けが残っているうちは通常どおり処分全体を通します——kick は `canRestrict` が、戦報は `failureNoticeSent` が、`can_delete_messages` 不足が確証されている場合は削除も mirror が短絡するので、「リクエストを 1 本も出さない」性質は保たれます。このフラグは `executionStarted` と同じく **Worker ローカルの冪等ゲートで、snapshot には入れません**。削除の再実行は冪等ですが、戦報の再送はそうではないからです。

<p align="right"><a href="04-invariants.md#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>
