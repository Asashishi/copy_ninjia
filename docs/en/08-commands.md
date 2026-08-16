# 08 Command and Behaviour Reference

<p align="center">
  <a href="../cn/08-commands.md">简体中文</a> · <b>English</b> · <a href="../ja/08-commands.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 Documentation home</a> · <a href="07-operations.md">← Prev: 07 Operations</a> · <b>Next: none →</b>
</p>

---

The full command table, permission semantics and behavioural details for users. The root README
keeps only a one-line summary; this page is the authority. Command implementations live in
`packages/commands/`, and the permission keys are defined in
[`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts).

## 🎭 Copy Modes

The copy target is global: one instance can “become” only one target at a time, although copying occurs only in the group where the command was issued. `/stop_copy` can stop the current copy state from any group.

| Command | Behavior |
| :---: | :--- |
| `/copy` | Reproduce messages unchanged |
| `/r_copy` | Reverse plain text by grapheme cluster |
| `/nya_copy` | Append “nya~” to plain text |
| `/ja_copy` | Translate into Japanese with Google Cloud Translate before copying |
| `/steal_icon` | Copy only the avatar |
| `/reset_icon` | Restore the bot's own default avatar |
| `/stop_copy` | Stop the global copy state and restore the avatar |

Choose a target by replying to their message or providing `@username`:

- **Username lookup depends on the bot having observed the account previously**; rename, username removal, or username reassignment immediately invalidates the old alias. For destructive operations such as `/block` and `/unblock`, prefer replying to the target or passing the user id directly (those two commands additionally accept a bare id) rather than relying on historical usernames.
- **When an anonymous administrator speaks as the current group, that group identity is the copy target**, so copy modes can obtain the group avatar and reproduce that “skin”; `/block` rejects the current group identity as a member target.
- **Ordinary users have a 5-minute cooldown on copy-family commands**; identities inside the allowlist boundary are exempt — entries in the SQLite allowlist table, plus `SUPER_ADMIN_USER_ID`, which is always inside it.

## 🎮 Commands and Permissions

<table width="100%">
<tr><th width="26%" align="left">Command</th><th width="19%" align="center">Permission</th><th width="55%" align="left">Description</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">Group member</td><td>Start respective copy mode</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">Group member</td><td>Stop current global copy state and restore the avatar</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">Group member</td><td>Copy avatar only</td></tr>
<tr><td><code>/reset_icon</code></td><td align="center">Group member</td><td>Restore the default avatar</td></tr>
<tr><td><code>/&lt;1–2 CJK chars&gt;</code></td><td align="center">Group member</td><td>Action command: <code>/咬</code> or <code>/揪住</code> replies "actor 咬了 target！"; successful results are retained</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">Group member</td><td>Pause proactive behavior for N minutes (default 3)</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">Group member</td><td>Resume proactive behavior early</td></tr>
<tr><td><code>/mute … &lt;duration&gt;</code> <code>/unmute</code></td><td align="center"><code>isCanMute</code> / <code>isCanUnMute</code></td><td>Temporarily mute or unmute a member in a supergroup; reply, <code>@username</code>, and user-id targets are supported, with <code>m/h/d</code> durations</td></tr>
<tr><td><code>/gag … [5|10|15] [tool]</code><br><code>/ungag …</code></td><td align="center"><code>isCanGag</code></td><td>Restrict a user or channel identity to the bot's inline speech path, or release one target early; targets may be replies, <code>@username</code>, user ids, or negative channel ids</td></tr>
<tr><td><code>/block</code></td><td align="center"><code>isCanBlock</code></td><td>Blocklist the target: recorded permanently and banned across all bot-managed groups; name the target by replying to a message, by <code>@username</code>, or by user id</td></tr>
<tr><td><code>/unblock</code></td><td align="center"><code>isCanUnBlock</code></td><td>Fully unblock the target: remove the id from the dynamic blocklist and lift bans in every bot-managed group. Targets are named as for <code>/block</code>, plus negative channel ids. Static-blocklist identities are refused</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>isCanControllAIPermission</code></td><td>Toggle AI chat for the group</td></tr>
<tr><td><code>/ad_detect enable|disable</code></td><td align="center"><code>isCanControllAdDetectPermission</code></td><td>Toggle ad detection for the group; a non-protected hit gets the same disposal as <code>/block</code></td></tr>
<tr><td><code>/bot_status</code></td><td align="center">Group member</td><td>Show local process metrics, global model capabilities, the Telegram 429 outbound queue, the active gag count, the permissions the bot currently holds in this group (as a JSON block), and enabled features in this group</td></tr>
<tr><td><code>/query_mood</code></td><td align="center">Group member</td><td>Show the group's current effective AI mood without rerolling it</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>isCanSwitchMood</code></td><td>Reroll current group mood immediately</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>isCanControllJATranslatePermission</code></td><td>Toggle Japanese translation mode for the group (disabled by default)</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Toggle the group's main processing gate</td></tr>
<tr><td><code>/batch_kick &lt;Nm|Nh|Nd&gt;</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>In a supergroup, kick members who joined within the selected rolling window of up to 24 hours and are still present; never blocklist them</td></tr>
<tr><td><code>/permission query</code><br><code>/permission help</code></td><td align="center">Allowlisted identity</td><td>Show the caller's complete permission set or list permission descriptions as JSON; <code>help</code> is retained, while <code>query</code> self-deletes after 30 seconds</td></tr>
<tr><td><code>/permission …</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Change one permission on an existing allowlisted user/channel; <code>all</code> enables every permission</td></tr>
<tr><td><code>/white … enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Add or remove an allowlisted user/channel by reply, <code>@username</code>, user id, or channel id</td></tr>
<tr><td><code>/send &lt;group_id&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code> (PM only)</td><td>Start or finish a relay session from the bot's private chat to the target group</td></tr>
</table>

> **How to read the permission column**: rows naming an `isCanXxx` key are authorized by that key, and the `SUPER_ADMIN_USER_ID` identity itself always holds **every** permission key — so it can use all of them without an entry in the SQLite allowlist table. Rows naming `SUPER_ADMIN_USER_ID` are the ones that depend on the identity alone and cannot be granted through the allowlist.

### Behavior details

- **Command entry gates**: group commands uniformly pass through `/init`. An uninitialized group accepts only the super administrator's `/init`, so `/permission` and `/white` must also run in an initialized group. `/send` is the only slash command admitted in private chat.
- **Action commands**: both names render as `first_name last_name` and link to the profile when a public username exists; the target is picked the same way, by replying to their message or by `@username`. Successful action results are retained like `/permission help`; missing-target, invalid-argument, and `/x` usage hints still self-delete after 30 seconds.
- **`/gag` speech restriction**: at most five targets are active globally; one chat may hold several targets, but an identity cannot be duplicated within that chat. Entries are created only in initialized groups where the bot can delete messages. A regular user first gets a public status with no button, followed by a temporary “发言” entry restricted by `receiver_user_id`; a channel target instead gets one public status with the button. An ordinary `@bot` query always enters fortune only. Both buttons prefill only `gag:<target Telegram id>` (positive for a user, negative for a channel). Before the first space, no MD5, digest, random token, group id, or other metadata is allowed. Telegram inline queries do not expose the exact current chat id or a bot-side pre-send interception hook, so such extra fields cannot authenticate the actual input chat; the normal entry uses a current-chat button. A generated result carries `<target profile>#<session chat id>` in a hidden text link. That public URL is verification material, not a secret or authentication token. After the message lands, the bot must jointly verify the linked target and session chat, actual `from.id`/`sender_chat.id`, and actual `message.chat.id`; an identity or chat mismatch is deleted immediately. Channel candidate titles never expose the group title. Every `gag:` query is owned exclusively by the gag domain; invalid, stale, or identity-mismatched input returns an empty result and never falls back to fortune. Start-state messages bypass the 30-second command cleanup and are deleted through their respective ids only by targeted `/ungag`, timeout, or chat-runtime teardown. Any failed deletion retains bounded ending state and receives finite retries; the same target cannot be gagged again until every state message is actually gone. `/ungag` therefore requires a reply, `@username`, or identity id. Speech rendering samples per grapheme: 75% takes the filler branch and appends 3–6 dots after that grapheme (each gap independently gets an ASCII space with probability 1/3), while the remaining 25% replaces the whole grapheme uniformly with one of six fillers. The same operation may apply to at most two adjacent graphemes, and a third candidate is blocked by the gate, so 75% is the sampling probability rather than the filler share of the final text; short texts also carry minimum-operation tiers (2–3, 4–7, 8–31, and 32–64 graphemes get at least 2, 3, 7, and 15 operations respectively).
- **`/block` blocklist**: name the target by replying to their message, by `@username`, or by passing a user id directly (a positive integer; the negative ids of groups and channels do not count) - the id form is the most reliable one, since a released username can be re-registered by somebody else while this command is irreversible. Once the id lands in the persistent blocklist, the target is kicked on sight from any join update in any watched group. The moment a group has both an administrator bot and an enabled `/init` — in either order — anyone from the list already sitting there gets swept out too. `/unblock` atomically rewrites the whole list and lifts the target's ban in every bot-managed group by default; it still performs the cross-chat unban when the target is absent from the dynamic list. `/unblock` accepts one target form `/block` does not: **the negative id of a channel**. Channel vests enter the list as a `sender_chat` (a `/block` on a reply to a channel message, or an ad-detection hit), and since ad detection deletes the original message while a channel without a public username is never in the cache, refusing negative ids would leave such entries permanently unremovable. The reverse is not opened because a mispasted chat id in `/block` bans a whole chat identity, irreversibly.
- **`/batch_kick` slow-wave cleanup**: only the super administrator may use it, and only in an initialized supergroup. Its sole argument is a window such as `30m`, `2h`, or `1d`, capped at 24 hours. It reads the join log, keeps each user's latest join in the window, and kicks those still present with bounded concurrency and no blocklisting. The super administrator, allowlisted identities, and permanent-blocklist members are not treated as ordinary targets.
- **`/ad_detect` ad detection**: messages are bundled per sender (`chatId:senderId`), and a one-second queue tick keeps handing batches to the model configured in `agent.ad_detect`, so a continuously posting sender is judged roughly every tick plus one classification round trip. The 90-second window bounds only post-hit disposal suppression and the retention of already-consumed context; it is not "how often one sender is judged". a non-protected hit gets the same disposal as `/block` and announces the reason in the triggering chat. Detection only fires while the bot is an administrator there. Once the message ordinals are stripped, a bundle consisting solely of links (including `vless://`, `vmess://`, `trojan://`, and `ss://` proxy nodes or subscription links) with no promotional, recruiting, or trading copy beyond them is never judged an ad. The remaining criteria live in [`config/ad_samples.json`](../../config_example/ad_samples.json).
- **Flood muting**: off by default per chat; any identity holding `isCanControllFloodControlPermission` (the super administrator always does) enables it with `/flood_control enable`. 15 messages from one person within one minute in one supergroup gets them muted for 3 minutes, with a one-line notice that self-deletes when the mute expires. Telegram lifts the mute on its own; nothing is blocklisted and no message is deleted. It only fires when the bot actually holds the "restrict members" right; owners/administrators, channel identities and anonymous administrators are never counted. The bypass depends on `isCanBypassFloodControl` alone — it defaults to `true` on an allowlist entry, and an identity counts only once it is explicitly `false`; `SUPER_ADMIN_USER_ID` always holds it and is therefore never counted.
- **`/send` relay**: reachability is probed before starting, every message the super administrator sends is relayed to the target group once, and the session ends with a notification if the target becomes unreachable. Relay state persists in `state.json` across restarts. The command is omitted from Telegram's command menu and remains silent in groups or when invoked by any other user.

> [!TIP]
> **CJK action commands need no registration** — any one or two Chinese characters work. Telegram only accepts ASCII command names (Latin letters, digits, underscores), so:
> - These commands never appear in the command menu and get no autocompletion. The menu carries a single placeholder entry `/x` instead — the name `x` is the variable, prompting you to swap it for any one or two Chinese characters. Invoking it returns a usage hint and terminates the chain rather than falling through into the AI/copy pipeline.
> - Forms of three characters or more, such as `/咬人人`, are not action commands and fall through to normal message handling.
> - Precisely because anyone can invent one without registering it, these commands share a global sliding-window limit of 450 responses per 90 seconds, counted across all groups and users; anything over the quota is dropped silently with no notice.

> [!TIP]
> **`/luck_challenge` is not a slash command**: type `@bot_username [query]` in any chat to use Inline Mode. Enable Inline Mode in BotFather; 100% result feedback is recommended. Inline queries share a global sliding-window limit of 300 responses per 90 seconds.
