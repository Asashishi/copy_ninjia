# 04 · Lockdown Mirror and Terminal Flags

[简体中文](../cn/04-lockdown-invariants.md) · [English](../en/04-lockdown-invariants.md) · [日本語](../ja/04-lockdown-invariants.md)

[← 04 Runtime Invariants](04-invariants.md)

- **Lockdown Fingerprint & Intent Identity**:
  - The lockdown durability handshake fingerprint (`lockdownFingerprint`) consists of three fields: `phase`, `intentId`, and `announced`.
  - `phase` and `intentId` establish the stable identity of a specific lockdown intent.
  - `announced` determines whether crash recovery is permitted to broadcast an unlock notice; therefore, the persistence acknowledgement must cover it.
  - Emergency permission recovery checks only `phase` and `intentId` when deciding whether a delayed result belongs to the active intent (persisting the announcement flag does not spawn a new permission intent).
  - Neither fingerprint may ever include `expiresAt`.

- **Countdown & Reconcile Loop**:
  - The countdown timer is tracked in the mirror's `expiresAt`, from which `remainingMs` is derived upon state adoption.
  - The persistence reconcile loop is capped at `LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS` rounds.
  - If a new event arrives while persistence is currently in flight, a queued-rerun flag is set.
  - If the round limit is reached, the active task logs an error, yields the current microtask, and automatically initiates a fresh task using the latest mirror snapshot, without waiting for external triggers.

- **Main-Thread Emergency Takeover**:
  - If the Anti-Raid Worker gives up self-healing, the main thread's `recoverAbandonedLockdowns` directly scans the hot-read chat state cache (`chatStateCache` in `cache/main/chatState.ts`) without cloning or relying on iteration order.
  - The recovery pipeline reads each entry synchronously before any `await`; each locked chat is processed once and logged once in the takeover journal.
  - If recovery for a chat is already active with the identical `phase` and `intentId`, `startEmergencyLockdownRecovery` returns immediately. If a different intent is detected, it aborts the old recovery process and restarts anew.

- **Mirror Validation & Optional Fields**:
  - Active lockdown mirrors must contain `phase` and a positive integer `intentId`. `announcementMessageId` is permitted only when `announced` is true.
  - Verification challenge snapshots must include `phase` and `trackedMessageTimes`.
  - `reminderMessageId` and `announcementMessageId` are optional: their absence merely indicates that a reminder has not yet landed or that no join announcement was captured, allowing recovery to follow their respective cleanup paths.
  - Any other missing or unrecognized fields are rejected by strict validation and must be migrated offline; production read paths retain no backward-compatibility fallback logic.

- **Three Independent Terminal Notice Flags**:
  - `successNoticeSent`: Records that the success report was delivered.
  - `failureNoticeSent`: Records an unsuccessful kick attempt or missing `can_restrict_members` permission.
  - `unconfirmedNoticeSent`: Records unconfirmed chat membership or invalid chat type.
  - The main thread automatically deletes all three notice types after `COMMAND_MESSAGE_AUTO_DELETE_MS` (30 seconds).
  - Each flag independently ensures its notice is not duplicated across Worker restarts or process reboots. Setting any flag issues a new revision that terminal retry loops must await.

- **Kick Confirmation & Report Atomicity**:
  - **A successful kick whose success report failed to send must not be marked settled.**
  - `removalConfirmed` is written to the snapshot before backing off and retrying. When the subsequent probe reports that the user is "not in chat", the bot recognizes that it completed the expulsion and dispatches the success report.
  - `removalConfirmed` is written and persisted only when the report dispatch encounters a network failure. Under normal conditions, the kick and report settle together in a single atomic transaction without extra writes.

- **Short-Circuiting Without Ban Rights**:
  - The short-circuit optimization ("confirmed to lack ban permissions, halt further API calls") requires cleanup to be completely finished first (`cleanupSettled`).
  - When `botCanRestrictIn` is false, the cycle exits early only if both `failureNoticeSent` and `cleanupSettled` are true; each such cycle sends a single membership probe, settles if the member has left, and otherwise keeps backing off.
  - Lockdown instant kicks (`kickPending`) also probe membership first when the ban permission is missing: a departed member settles and its record is released; a present member is logged and backed off without a kick request.
  - If cleanup remains unsettled, the full disposal cycle continues: the kick is bypassed by `canRestrict`, the report is bypassed by `failureNoticeSent`, and message deletions are bypassed when `can_delete_messages` is absent. Only pending deletions that can still execute are retried.
  - Like `executionStarted`, `cleanupSettled` is an **in-memory Worker-local idempotency gate that is never written to disk snapshots**.

<p align="right"><a href="04-invariants.md#quick-navigation">↑ Back to quick navigation</a></p>
