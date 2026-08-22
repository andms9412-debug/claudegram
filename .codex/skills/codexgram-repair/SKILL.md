---
name: codexgram-repair
description: "Diagnose and repair Codexgram production incidents in this repo, including legacy Claudegram runtime names, Telegram bot delivery, systemd service diagnosis, polling conflicts, startup retry regressions, and session-watch false alerts."
---

# Codexgram Repair

Use this skill for production repair of Codexgram, whose legacy runtime identifiers may still use `claudegram`.

## Ground Rules

- Treat `Codexgram` as the user-facing name and `claudegram` as a legacy runtime compatibility name.
- Do not rename an existing checkout, service, package, env file, or Telegram bot artifact during incident repair unless the operator explicitly asks for a migration.
- Never print `TELEGRAM_BOT_TOKEN` or other secrets.
- Do not call Telegram `getUpdates` while the production service is running; it can create a false `409 Conflict` with the long-polling worker.
- Prefer `getMe`, `getWebhookInfo`, and `sendMessage` for safe Telegram diagnostics.
- Keep public operational examples generic. Machine-specific paths, bot usernames, cron details, and incident identifiers belong in private operator notes rather than the public repository.

## First Triage

1. Identify the alert source before changing code.
   - Service: `systemctl status claudegram.service --no-pager`
   - Service logs: `journalctl -u claudegram.service -n 160 --no-pager -o short-iso`
   - User cron, if relevant: `crontab -l`
   - Any local session-watch script configured by the operator
2. Check whether the production bot is alive.
   - `systemctl show claudegram.service -p ActiveState -p SubState -p ExecMainPID -p NRestarts -p ActiveEnterTimestamp`
   - `pgrep -af "$HOME/claudegram/dist/index.js"`
3. Check safe Telegram API state without stealing polling.
   - Source the local `.env` without echoing it.
   - Use `getMe` to verify token/API reachability.
   - Use `getWebhookInfo` to verify webhook state and pending updates.

## Known Incident Patterns

### Startup `getMe` Timeout

Symptom:

```text
Fatal error: Error: Request to 'getMe' timed out after 60 seconds
```

Expected fix state:

- `src/index.ts` wraps `bot.init()` in bounded transient retry.
- Retry policy uses an increasing delay with a bounded maximum duration.
- `401 Unauthorized` and `409 Conflict` fail fast.
- `src/bot/bot.ts` exports `registerCommandMenu()` and does not call `setMyCommands` inside `createBot()`.
- Command menu registration runs after successful init with transient retry.

Verify:

```bash
npm run typecheck
npm run build
systemctl show claudegram.service -p ActiveState -p SubState -p ExecMainPID -p NRestarts
```

Restarting production is outside ordinary verification. It requires explicit operator authorization and an approved production change window; keep any restart and follow-up logs in a private operator runbook.

Representative recovery log:

```text
[startup] Telegram init failed, retrying after a transient timeout
Bot started as @your_bot
Command menu registered
```

### `409 Conflict`

Symptom:

```text
getUpdates failed! (409: Conflict: terminated by other getUpdates request)
```

Meaning:

- Another long-polling consumer is using the same bot token.
- Do not retry this as transient.
- Find duplicate bot processes, dev watchers, or manual `getUpdates` calls.

Useful checks:

```bash
pgrep -af 'claudegram|tsx watch|dist/index.js'
systemctl status claudegram.service --no-pager
```

### `getUpdates timed out after 60 seconds`

Meaning:

- Usually a transient long-poll timeout.
- If the service stays active and one Node process remains, do not restart solely for this log.
- Investigate only if it repeats with user-visible delivery failure.

### Session-watch Alert

A session-watch alert is not necessarily emitted by Codexgram itself. If the operator has a separate local watcher or cron job, inspect that configuration independently.

Checks may include:

```bash
crontab -l
ps -eo pid,ppid,stat,etimes,cmd | rg '(^|/| )claude( |$)|@anthropic-ai/claude|claude-code' | rg -v 'rg '
```

If no Claude process exists, a well-behaved external watcher should exit without sending an alert.

## Safe Smoke Test

After a repair, run only local build checks and read-only service checks:

```bash
npm run typecheck
npm run build
systemctl show claudegram.service -p ActiveState -p SubState -p ExecMainPID -p NRestarts
pgrep -af "$HOME/claudegram/dist/index.js"
```

A production restart is not part of ordinary verification. It requires explicit operator authorization and an approved production change window; keep the change and follow-up logs in a private operator runbook.

If an outbound Telegram test is needed, use that private operator runbook. Never put a bot token, chat ID, or other sensitive value in command-line arguments or logs.

## Closeout

- State whether production was restarted.
- State whether `typecheck` and `build` passed.
- State current service status and PID.
- Keep any machine-specific paths, usernames, chat identifiers, or private incident notes outside the public repository.
