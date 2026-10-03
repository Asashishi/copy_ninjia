# 09 Command and Behavior Reference

<p align="center">
  <a href="../cn/09-commands.md">简体中文</a> · <b>English</b> · <a href="../ja/09-commands.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="08-images-and-cron.md">← Prev: 08 Images and Scheduled Tasks</a> · <a href="10-performance.md">Next: 10 Performance Benchmark →</a>
</p>

---

The complete command table, permission specifications, and behavioral details for users. The root README retains only a one-line summary; this page is the authoritative reference. Command implementations reside in `packages/commands/`, and permission keys are defined in [`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts).

## 🎭 Copy Modes

The copy target is globally unique: a single instance can only "become" one target at any given time, although copying occurs solely within the group where the command was initiated. `/copy stop` can stop the active copy state from any group.

| Command | Behavior |
| :---: | :--- |
| `/copy` | Reproduce messages unchanged |
| `/copy reverse` | Reverse text and captions by grapheme cluster |
| `/copy nya` | Append "喵~" to text and captions |
| `/icon steal` | Copy avatar only |
| `/icon reset` | Restore the bot's own default avatar |
| `/copy stop` | Stop global copy state and restore avatar |

### Sending and Transformation Mechanics

The `/copy` family and random echoes share identical transmission rules:
- **Text and Captions**: Handled strictly as strings; text containing links or @mentions is transformed identically. Plain text is resent; links and @usernames are re-recognized by Telegram, and original link preview settings are preserved.
- **Formatting Entity Constraints**: Formatting such as bold, hidden links, spoilers, and custom emoji is not retained; spoiler text is emitted in cleartext.
- **Rich Media Handling**: Photos, videos, files, and stickers are duplicated server-side by Telegram; when captions exist, they are replaced with processed text without downloading files locally. Paid media cannot be duplicated; only text is sent.
- **Pure Non-Text Messages**: Messages containing neither text nor files (polls, dice, locations, contacts) are copied verbatim.
- **Length Overflow**: If the transformed text exceeds Telegram's message or caption length limits, the entire message is dropped.

### Target and Parameter Specification

Targets can be specified by "replying to their message" or via `@username`:
- **Mode Syntax**: Place the mode keyword before the target, e.g., `/copy reverse @username`, `/copy nya @username`; use `/icon steal @username` to change avatars only. `/copy stop` and `/icon reset` take no additional arguments.
- **Username Observation Dependency**: Looking up by username requires that the bot previously observed that account; renaming, removing, or reassigning a username immediately invalidates historical aliases. For destructive operations such as `/block … enable` and `/block … disable`, prefer replying to target messages or supplying numeric user IDs directly rather than relying on usernames.
- **Anonymous Administrators**: When speaking as the current group, the copy target resolves to the current group itself, allowing the bot to acquire group avatars and copy the group's "disguise"; `/block` rejects current group identities as member targets.
- **Cooldown Restrictions**: `/copy`, `/copy reverse`, `/copy nya`, `/icon steal`, and `/icon reset` share a **5-minute global cooldown**. Only `SUPER_ADMIN_USER_ID` is exempt; allowlisted identities remain subject to cooldowns. `/copy stop` does not consume cooldown.

---

## 🌐 Per-Group Translation

Translation processes text and captions independently of global copy targets, 5-minute cooldowns, and avatar operations. An identity with `isCanControllTranslatePermission` must first execute `/translate enable` (disabled by default) and supply a valid `g-auth.json`. To receive another bot's ordinary messages for translation, enable Bot-to-Bot Communication Mode for this bot in @BotFather. Received messages remain subject to the [bot-message ingress limit](04-invariants.md) (see [01 Getting Started](01-getting-started.md)).

| Command | Behavior |
| :--- | :--- |
| `/translate ja` | Reply to target message to translate subsequent text into Japanese |
| `/translate cn @username` | Target an observed username and translate into Simplified Chinese |
| `/translate en` | Reply to target message to translate into American English |
| `/translate uk` | Reply to target message to translate into Ukrainian |
| `/translate ru` | Reply to target message to translate into Russian |
| `/translate list` | List languages supported by regex checks in a JSON code block |
| `/translate stop` | Stop all translation sessions in this group when run without arguments or replies |
| `/translate stop @username` or `/translate stop 123456789` | Stop a specific target; replies and negative channel IDs are supported |
| `/translate disable` | Delete all sessions in this group and disable translation; requires translation management permission |

### Session Capacity and Exclusion Rules

- **Session Quotas**: Group members can start and stop sessions; up to 5 distinct identities per group, each choosing directions independently, across at most 25 groups. Exceeding capacity rejects new sessions without evicting existing ones; stop an identity before changing its direction.
- **Conflict Handling**: Conflicting reply targets and argument targets are rejected rather than falling back to stopping the entire group.
- **Mutual Exclusion with Copy**: `/copy stop` does not stop translation; if an identity matches both copy and translation simultaneously, **only translation is performed** (no echoing, no media copying, no reaction mirroring); other copy targets operate normally.

`/translate list` produces the following content, sent with a Telegram `pre` entity marked as `json` and deleted in groups after 30 seconds:

```json
{
  "ja": "日语",
  "cn": "简体中文",
  "en": "美式英语",
  "uk": "乌克兰语",
  "ru": "俄语"
}
```

### Language Regex and Dispatch Rules

- **Pre-filtering Rules**: Text and captions are translated as strings, including text with links, @mentions, or formatting entities. If regex identifies the text as already in the target language, or consisting solely of numbers, punctuation, or emoji, the translation API is bypassed and nothing is sent.
  - **Japanese**: Requires kana.
  - **Simplified Chinese**: Excludes traditional characters with simplified counterparts in Unicode Unihan.
  - **English**: Accepts ASCII letters. American English uses [Google Translation LLM](https://docs.cloud.google.com/translate/docs/languages#translation-llm) supporting `en-US`.
  - **Ukrainian**: Accepts Ukrainian letters and apostrophes, excluding Russian `ёъыэ`.
  - **Russian**: Accepts `Ё/ё`, excluding Ukrainian `єіїґ`.
  - *Note*: Shared Han characters, unaccented Latin text, and shared Cyrillic phrases may remain ambiguous; regex checks do not perform semantic language detection.
- **Delivery Format**: Translation sends only translated text, never the original message, and never copies media; if the translation API fails or the translation is identical to the source, nothing is sent.
  - Translations are emitted as strings without formatting; text messages copy the link preview settings of the original message.
  - Captioned photos, videos, audio, files, and paid media only emit the translated caption as text without copying the media.
  - Messages without text (un-captioned photos, stickers, files, polls, locations) are not sent, nor do they fall back to copy modes.
  - Translations exceeding maximum text length are dropped. Output preserves topics and rejects renderable commands; command notices self-delete after 30 seconds.
- **Persistent State**: Sessions are stored in the `translate` array of this group's `chat_states` row in SQLite. Stopping an individual target cancels only that target; adding or stopping others does not abort in-flight translations for current targets. Disabling and group teardowns delete all sessions for that group; asynchronous results recheck target session objects prior to dispatch. `/bot_status` shows the active translation count as `count/5`.

---

## 🎮 Commands and Permissions

| Command | Permission | Description |
| :--- | :---: | :--- |
| `/copy`<br>`/copy reverse`<br>`/copy nya` | Group member | Start respective copy mode |
| `/copy stop` | Group member | Stop current global copy state and restore avatar |
| `/icon steal` | Group member | Copy avatar only |
| `/icon reset` | Group member | Restore default avatar |
| `/translate ja\|cn\|en\|uk\|ru [@username]`<br>`/translate list`<br>`/translate stop [@username/id]` | Group member | Select text translation direction, view languages, or stop all sessions / specific target |
| `/translate enable\|disable` | `isCanControllTranslatePermission` | Toggle translation capability for this group (disabled by default) |
| `/wed` | Group member | Randomly draw a group partner and display their avatar; supports confirmation, reroll, and removal; requires `/init enable` first |
| `/h_image` | Group member | Post one picture drawn uniformly from the random image directory; picture retained long-term, failure notices deleted after 30 seconds |
| `/h_image add` | `isCanAddHImage` | Reply to a message with a photo to collect it (and other photos of the same album seen so far) into the random image library; summary notice deleted after 30 seconds |
| `/info [@username\|id]` | Group member | Query target's display name, username, ID, and avatar; supports replies, `@username`, user ID, or channel ID, including channels and bots; receipt deleted after 30 seconds |
| `/<1–2 CJK chars>` | Group member | Action command, such as `/咬` or `/揪住`, replying "caller 咬了 target!"; successful results retained long-term |
| `/quiet [1-15]` | Group member | Pause proactive behavior (random banter, random echoes), defaulting to 3 minutes |
| `/unquiet` | Group member | Resume proactive behavior early |
| `/mute … <duration>`<br>`/unmute` | `isCanMute`<br>`isCanUnMute` | Temporarily mute or unmute a member in a supergroup; targets support replies, `@username`, user ID, with durations in `m/h/d` |
| `/gag … [5\|10\|15] [tool]`<br>`/ungag …` | `isCanGag` | Restrict a user or channel identity to speak only via the Bot's inline entry point, or release a target early; targets support replies, `@username`, user ID, and negative channel ID |
| `/block … enable` | `isCanBlock` | Blacklist: record in permanent blacklist and ban target across all bot-managed groups; target specified by reply, `@username`, or user ID |
| `/block … disable` | `isCanUnBlock` | Transactionally remove target from authoritative SQLite blacklist and lift bans across all bot-managed groups; targets match `/block … enable` plus negative channel IDs, rejecting current group ID |
| `/ai_chat enable\|disable` | `isCanControllAIPermission` | Toggle AI chat for this group |
| `/clear_context` | `isCanClearContext` | Clear this group's AI context memory: in-Worker rolling verbatim buffer, medium-term summaries, pending summaries, and mood, setting `chat_states.ai_context` to NULL; invalidates in-flight reply generation. Takes no arguments; works even with broken deployment config or unavailable AI Worker |
| `/mood query` | Group member | Query current effective AI mood for this group without rerolling |
| `/mood switch` | `isCanSwitchMood` | Immediately reroll AI mood for this group, replying with new mood name upon Worker acknowledgement |
| `/ad_detect enable\|disable` | `isCanControllAdDetectPermission` | Toggle ad detection for this group; non-protected hits disposed with same authority as `/block` |
| `/flood_control enable\|disable` | `isCanControllFloodControlPermission` | Toggle flood muting for this group (disabled by default) |
| `/antiraid enable\|disable` | `isCanControllAntiRaidPermission` | Toggle join verification and anti-raid private mode for this group (disabled by default) |
| `/qa set` | `isCanControllQaPermission` | Open a form; opener posts question and answer in two messages prefixed with "问题:" and "回答:"; registering one Q&A pair once both arrive; max 15 per group, question ≤ 256 chars, answer ≤ 3840 chars |
| `/qa query`<br>`/qa query <question>` | Group member | List all Q&A for this group as a JSON code block, or query a specific question; answers truncated to 256 chars on the board, questions never truncated; 3 pairs per page with pagination buttons. Board retained long-term, not-found notice deleted after 30 seconds |
| `/qa remove <question>` | `isCanControllQaPermission` | Delete a specific Q&A pair from this group; confirms if nothing was found |
| `/permission query`<br>`/permission help` | User/channel identity | Query complete permissions for self, reply target, or explicit target, or list permission descriptions as JSON; successful boards retained long-term, read failures send 30-second notice |
| `/permission …` | `SUPER_ADMIN_USER_ID` | Modify one permission for an existing allowlisted user/channel; `all` enables all |
| `/white … enable\|disable` | Add: `isCanWhiteOther`<br>Remove: `SUPER_ADMIN_USER_ID` | Supports replies, `@username`, user ID, and channel ID; delegated additions grant default permissions only; modifying existing permissions requires superadmin |
| `/bot_status` | `isCanViewBotStatus` | View local process metrics, global model capabilities, Telegram 429 outbound queue, AI context capacity, active gag count, group translation count (up to 5), permissions bot holds in this group (JSON block), and boolean states of all group feature switches (JSON block, false if disabled) |
| `/init enable\|disable` | `SUPER_ADMIN_USER_ID` | Toggle master processing gateway for this group |
| `/batch_kick <Nm\|Nh\|Nd>` | `SUPER_ADMIN_USER_ID` | In a supergroup, kick members who joined within the rolling window (≤ 24 hours) and are still present; kicks only, does not blacklist |
| `/send <group_id>`<br>`/send finish` | `SUPER_ADMIN_USER_ID` (PM only) | In bot private chat, start or finish relay to target group; sending a TTS request as a whole code block during relay causes bot to speak it as a voice bubble |

> [!IMPORTANT]
> **Reading the Permission Column**:
> - Rows listing `isCanXxx` are authorized by permission keys. The `SUPER_ADMIN_USER_ID` identity inherently holds **all** permission keys and can always invoke them without being listed in the SQLite allowlist.
> - Rows listing `SUPER_ADMIN_USER_ID` represent hard identity boundaries that **only recognize that specific identity and cannot be delegated via the allowlist**.

### Parameter and Target Resolution Rules

- **Topic Message Handling**: Forum topic auto-generated creation messages are treated as "no explicit reply"; commands can still select targets via arguments. Explicit replies to creation messages follow the same rule. Comment replies in linked-channel discussion groups are preserved normally.
- **Policy Warm-up**: All identity mutations and member actions relying on allow/blacklists must complete policy pre-warming first; failures only reply with temporary notices without executing.
- **Unified Menu Entry Points**: In chat menus, `/copy`, `/qa`, `/mood`, and `/icon` serve as unified entry points, with arguments documented in descriptions. Missing or invalid subcommands return usage hints.
  - `/qa set`, `/mood query`, and `/mood switch` accept no extra arguments.
  - `/qa query` lists all entries when omitting questions; `/qa remove` requires a question. Both preserve internal spaces and line breaks.
- **Subcommand Case Insensitivity**: Subcommand keywords for `/copy stop|reverse|nya`, `/icon steal|reset`, `/qa set|remove|query`, `/translate <direction>|stop`, `/mood query|switch`, `/h_image add` are strictly case-insensitive, consistent with `/block`, `/white`, `/init`. Target arguments and Q&A texts follow original casing.
- **Button Callback Validation**: Numbers in `callback_data` for join verification, `/wed`, and `/qa query` pagination are strictly parsed as canonical decimals (no signs, leading zeros, spaces, decimals, or exponents). Non-canonical strings are immediately answered as expired buttons.

---

### Behavior Details

#### 1. Persona and Notice Atmosphere
- Persona is a process-wide deployment input without per-group configuration commands.
- The AI persona uses the text of the project-root `prompt/persona.md`, or the built-in teasing persona when the file is absent. Command notices, permission help, buttons, automatic notices, command menus, and inline fortunes prioritize explicit `atmosphere` in `config/static/bot.json` (`mesugaki` teasing, `normal` plain). When the setting is omitted, custom personas use plain copy and the built-in persona uses teasing copy.
- Both are determined at startup; changes take effect upon restart; AI toggles do not affect the choice.
- Startup registers menus with `all_group_chats` scope and clears default scope; private chat displays no menu; private chat only responds to superadmin's `/send`.

#### 2. `/bot_status` Metric Collection
- **Model capabilities**: List only configured capabilities whose configuration is ready, as `capability: model name`. Model names omit the namespace before the last `/`; xAI speech synthesis shows its voice instead. Omit unconfigured optional image generation, speech synthesis, and separate web search, as well as AI chat or ad detection when their configuration is not ready. Omit the whole model section when no capability can be listed.
- **Memory Footprint**: Calls `Bun.unsafe.memoryFootprint()` upon receiving command, displaying current memory usage of the entire Bot process (including Workers); Linux reports PSS, apportioning shared resident pages across processes. Percentages use container memory constraints as denominator, or host physical memory if unconstrained; displays "Unavailable" if unmeasurable.
- **Group Context Capacity**: Computes utilization of rolling hot memory against `VERBATIM_CONTEXT_MAX` (256 messages) and cold memory summaries against `MAX_SUMMARY_ROUNDS` (7 rounds), returning a weighted sum of 7:3, **displaying only this single percentage**. Both counts are reported by the AI Worker with memory snapshots (`AI_SNAPSHOT_INTERVAL_MS`, 30s) and seeded upon hydration; main thread holds a read-only mirror. Pending summaries do not count toward cold storage; missing mirror entries display as 0; readings lag by at most one report interval.

#### 3. Action Commands and `/x`
- Display names use `first_name last_name`, linking to profile when a public username exists; targets specified via reply or `@username`.
- Successful action results are retained long-term like `/permission help` and `/permission query`; missing targets, parameter errors, and `/x` usage hints self-delete after 30 seconds.

> [!TIP]
> **Chinese action commands require no prior registration**; any 1–2 Chinese characters work. Since Telegram only accepts ASCII command names:
> - These commands do not appear in command menus or autocompletion. The menu carries a placeholder `/x`; tapping it returns usage hints and terminates the chain.
> - Forms with 3 or more characters (e.g., `/咬人人`) are not action commands and are handled as ordinary messages.
> - Global sliding-window rate limit: at most 450 responses per 90 seconds, counted across all groups and users; excess requests are silently dropped.

#### 4. Group Q&A: `/qa` Full Lifecycle
- **Form Collection Mechanism**:
  - `/qa set` collects text via **formatted messages**. Opening the form checks `isCanControllQaPermission`; subsequent delivery only recognizes the identity that opened it (supporting channel identities and anonymous admins).
  - Delivery format requires line-initial `问题:` or `回答:` (half-width or full-width colons, `答案:` synonymous), sent in two messages or combined into one.
  - ```` ```json ```` code blocks in answers are stored with **literal fences** and unpacked back into code blocks when answered, with fences counting toward the 3840-character limit.
  - Claimed delivery messages are deleted without entering pipelines; the form is rewritten in place to reflect current state. If both fields together exceed Telegram's 4096-character limit, the answer display is truncated with an ellipsis while the registered entry retains full text.
- **Concurrency and Reset**:
  - Forms are unique per group, automatically expiring after 15 minutes. Resending a field overwrites its old value; the same user sending `/qa set` voids the old form to start anew; other users sending `/qa set` are rejected immediately.
  - `/init disable` and bot departure purge all group Q&A entries from the database; admin privilege revocation retains Q&A records.
- **Board Pagination and Direct Answers**:
  - `/qa query` packs 3 entries per page with pagination buttons, rewriting messages in place. Each click repacks entries from the hot table based on the page in `callback_data`; answers truncate to 256 characters, while **questions are never truncated**.
  - **Direct Q&A Answers**: Messages exactly matching registered questions (after stripping leading `@bot`) are answered immediately without involving AI or random banter constraints. Semantically similar but non-identical questions are retrieved and answered by AI via `group_qa_query` and `group_qa_answer` tools during chat rounds.

#### 5. Speech Restriction: `/gag`
- **Capacity and Entry Mechanism**:
  - At most 5 targets active globally; multiple targets per group allowed, but duplicate identities within the same group are forbidden.
  - Regular users leave a public status in the group and receive a temporary entry restricted by `ephemeral_message_parameters.receiver_user_id` with a "Speak" button visible only to themselves; channel identities receive a public status with the button.
  - Buttons prefill `gag:<target Telegram ID>`. Results carry `<target profile>#<session chat ID>` in hidden links. Messages landing in the group are verified against target, group, and actual sender; mismatches are deleted immediately.
- **Rendering and Obfuscation Algorithm**:
  - Samples per extended grapheme cluster: 75% take the filler branch (appending 3–6 dots, with 1/3 probability of spaces between dots), 25% replaced uniformly by one of six onomatopoeic characters.
  - The same operation applies to at most two adjacent graphemes. Short texts have minimum operation floors (2–3, 4–7, 8–31, 32–64 graphemes undergo at least 2, 3, 7, 15 operations).
- **Heartbeat and Refresh Mechanism**:
  - Entry refreshed every **7 group messages**.
  - User-specific entries wait **30 seconds** after initial activation and each refresh before resending; if target remains silent for **45 seconds**, their next message triggers an immediate resend.

#### 6. Blacklist: `/block`
- **Operation Syntax**: `/block <target> enable` to blacklist, `/block <target> disable` to unban. Targets support replies, `@username`, user ID (positive integer), and negative channel IDs (unban only).
- **Scope of Effect**: Written to authoritative SQLite blacklist, instantly kicking/banning across all managed groups. When the bot gains admin rights and initializes a group, it sweeps existing blacklisted members.
- **Deleted Account Cleanup**: If banning a target returns `PARTICIPANT_ID_INVALID` 5 consecutive times across sweeps, the account is deemed deleted and automatically removed from the blacklist.

#### 7. Ad Detection and Anti-Raid
- **`/ad_detect`**: Bundles messages per sender (`chatId:senderId`), processed every second by the `agent.ad_detect` model. Hits are disposed with the same authority as `/block`, broadcasting ban reasons in the group (30-second self-deletion). Pure proxy links (`vless://`, `vmess://`, `trojan://`, `ss://`) without promotional copy are not judged as ads.
- **`/flood_control` (Anti-Flood)**: If a user sends 15 messages within 1 minute in a supergroup, they are muted for 3 minutes with an in-group notice (30-second self-deletion). Admins and channel identities are excluded; bypass governed by `isCanBypassFloodControl`.
- **`/antiraid`**: Toggles join verification and anti-raid private mode. Disabling stops all events from both pipelines and immediately recalls verification reminders. Ad detection, anti-flood, and blacklists remain unaffected.
- **`/batch_kick`**: Superadmin only; kicks new members who joined within a rolling window (`30m`, `2h`, `1d`, ≤ 24 hours) based on join logs; kicks without blacklisting, skipping allowlisted and blacklisted identities.

#### 8. Private Chat Relay and Voice Delegation: `/send`
- Probes target group reachability before opening; relays every superadmin private chat message to target group.
- **Voice Delegation**: Send messages formatted as JSON code blocks:
  ```json
  { "type": "tts", "tone": "desired tone", "text": "text to speak" }
  ```
  - Text capped at 256, tone at 64 (UTF-16 code units).
  - Synthesized asynchronously in background, requiring `agent.tts` in `config/dynamic/agent.json`.
  - Quotas share `agent.tts.daily_reserve_quota` (default 25, isolated from AI chat quota).

> [!TIP]
> **`/luck_challenge` is not a slash command**: Type `@bot_username [subject]` in any chat to draw fortunes via Inline Mode. Requires enabling Inline Mode in BotFather. Global sliding-window rate limit: at most 300 responses per 90 seconds.

---

## 💍 Group Marriage: `/wed`

Once the group has executed `/init enable`, group members can send `/wed` (without arguments) in the group. The bot replies to the command and sends the selected user's avatar, captioned with "caller, 你的群友老婆是 member!", accompanied by interactive buttons:

| Button | Behavior |
| :--- | :--- |
| **移除** | Delete this result and release session |
| **娶老婆!** | Confirm current result, changing button to "已确认♡"; rerolling remains available |
| **换一只** | Replace avatar and caption in the same message, excluding caller and current target, restoring confirmation button |

### Core Mechanics

- **Exclusive Operation**: Results can only be operated by the original caller. Clicks on old buttons before rerolling do not affect newly drawn targets. Sending `/wed` again draws a new target and deletes the previous result; each user retains at most one result per group.
- **Candidate Pool Construction**:
  - Independent, long-lived **`Set<number>` capped at 150,000 members** per group.
  - Only records users who actually speak as **personal accounts** in initialized groups (channels, anonymous admins, service messages excluded).
  - Additions pause when full; departure updates immediately remove corresponding IDs.
  - Daily at 00:00 configured local time, Bun cron triggers main-thread reviews at up to 5 IDs/sec (requires admin privileges to call `getChatMember`); non-admin groups rely on leave service messages.
- **Avatar Retrieval and Caching**:
  - Calls `getChat` upon selecting a candidate, matching dimensions against the first 100 photos in `getUserProfilePhotos` via `big_file_unique_id`.
  - Successful matches reuse `PhotoSize.file_id` for direct forwarding without downloading or uploading bytes. Unmatched targets download the current ChatPhoto.
- **Concurrency and Rate Limiting**:
  - Commands and buttons share a main-thread executor: max **32 concurrent operations** globally, queue capped at **512 operations** (FIFO), prompting retry on overflow.
  - Member IDs are stored as JSON arrays in `memory/wed/<chatId>.json`, batched to disk via DiskIO upon 256 mutations or 30 seconds.
  - Max 512 active sessions per group, rejecting new groups when at capacity (max 25 groups). Results do not self-delete after 30 seconds, destroyed only via buttons or group teardown.

---

## 🔎 Profiles: `/info`

Once the group has executed `/init enable`, anyone can query an identity's public profile via `/info`: reply to their message with `/info`, or send `/info @username`, `/info <user ID>`, or `/info <channel or group ID>`. Targets can be users, channels, other bots, or the bot itself.

- **Returned Information**: Display name (`first_name last_name` for users, title for channels/groups), username (marked if none), and ID (tap to copy). Attached with avatar if present, or noted if absent.
- **Data Source**: Queried dynamically. Users read group member data, channels/groups read chat info, the bot reads its own startup profile; avatars reuse `/wed` extraction logic (file_id reuse for users, download/upload for channels, t.me fallback).
- **Retention and Constraints**: Receipts and error notices **self-delete after 30 seconds**. Queries use the shared deferred-command executor, with a 30-second budget after dequeue; full queues reply "try again later". Private chat `/info` does not respond.

---

<a id="random-images"></a>

## 🖼️ Random Pictures: `/h_image`

**Library Configuration**: Configured by `onlyPath.random_h_image_dir` in `config/dynamic/assets.json` (defaults to `./h_image` relative to the data root).

Once the group has executed `/init enable`, sending `/h_image` (without arguments) uniformly selects a random picture from the library to post into the group.

- **Formats and Filtering**: Scans `jpg`, `jpeg`, `png`, and `webp` directly under the library root (ignoring hidden files, subdirectories, and symbolic links). Files over 10 MB are skipped and redrawn automatically. Adding or deleting images requires no restart.
- **Spoiler Masks**: Output images always carry Telegram spoiler masks (`has_spoiler`), delivered blurred until tapped.
- **Retention Rules**: Images are **retained long-term**; invalid argument hints, empty/missing directories, and oversized image notices **self-delete after 30 seconds**.
- **Concurrency and Rate Limiting**:
  - Deferred command executor supports max **2 concurrent operations** globally with **16 queued slots**.
  - Sliding-window rate limit: combined with `/h_image add` to at most **5 requests per second**, dropping excess requests silently.

### Collecting Pictures: `/h_image add`

Identities holding `isCanAddHImage` can reply to an image message with `/h_image add` to add images to the random library.

- **Collection Scope**: Original image (maximum size) from the replied message, or file-based `jpg`/`png`/`webp`. If part of an album, other photos in the album seen by the bot are collected together (max 10 photos per album, caching up to 256 recent albums in memory).
- **Content Addressing and Deduplication**:
  - Filenames strictly use the **SHA-256 of the binary content** with header extension (e.g., `<hash>.jpg`).
  - Deduplication occurs after downloading when computing the hash: if the library already contains an identical hash, it reports existence and avoids re-writing.
- **Dimension Compliance**: Telegram `sendPhoto` enforces width + height ≤ 10000 and aspect ratio ≤ 20. Images exceeding limits are rejected during pre-check.
- **Persistence Safety**: Writes first to temporary files whose names start with a dot, renaming atomically within the directory upon completion to prevent half-written reads.
- **Receipts and Timeouts**: Max execution time 120 seconds; sends a summary report upon completion (added, existing, skipped, oversized), self-deleting after 30 seconds.

---

## ⏰ Scheduled Posts: `cron.json`

Scheduled tasks are configured by operators in `config/dynamic/cron.json`, supporting hot reload without in-group commands.

- **Delivery Scope**: Delivers text, images, files, and voice to explicit chats, all enabled chats with send permissions, or subsets with excluded chats.
- **Images and Spoilers**: Fixed images support 1–10 `url` or local `path` entries (2–10 automatically assembled into albums with captions on the first image); random mode posts one image per trigger. The `is_blurred` switch controls spoiler masks.
- **Voice Broadcasting (`send_voice`)**: Synthesizes `content` with optional `tone` into voice bubbles. Requires `agent.tts` configured in `agent.json`; otherwise rejected at startup or hot reload.
- **Web Digest (`send_web_digest`)**: Researches a short `topic` and follows `instructions` to produce a MarkdownV2 digest with at most 15 items and multiline item bodies. Prefers `agent.web_search`, falling back to built-in `text` search when unconfigured. If the model does not search, its body is sent with the fixed warning 「注意，以下可能为模型侧缓存内容，请仔细甄别」.
- **Lifecycle**: Scheduled messages are retained long-term, landing in the General topic in forum groups. One-off tasks and randomized instants are stored in memory only; missed executions during downtime are not replayed. See [Deployment Configuration](../../config_example/README/en.md#cronjson) for detailed specifications.

---

<div align="center">

[← Prev: 08 Images and Scheduled Tasks](08-images-and-cron.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#09-command-and-behavior-reference) · [Next: 10 Performance Benchmark →](10-performance.md)

</div>
