---
name: codexgram-repair
description: "Diagnose and repair Codexgram production incidents in this repo, including legacy Claudegram runtime names, Telegram bot delivery, systemd claudegram.service, getMe/getUpdates timeouts, 409 polling conflicts, startup retry regressions, and session-stall-watch false alerts such as /tmp/session_watch_off."
---

# Codexgram Repair

Use this skill for production repair of Codexgram, whose legacy runtime identifiers still use `claudegram`.

## Ground Rules

- Treat `Codexgram` as the user-facing name and `claudegram` as legacy runtime compatibility.
- Do not rename `/home/atun/claudegram`, `claudegram.service`, package names, env files, or Telegram bot artifacts during incident repair unless the user explicitly asks for a migration.
- Never print `TELEGRAM_BOT_TOKEN` or other secrets.
- Do not call Telegram `getUpdates` while `claudegram.service` is running; it can create a false `409 Conflict` with the long-polling worker.
- Prefer `getMe`, `getWebhookInfo`, and `sendMessage` for safe Telegram diagnostics.
- Keep operational notes in `README.md` under `Production Operations`; that section is the project SSOT.

## First Triage

1. Identify the alert source before changing code.
   - Codexgram service: `systemctl status claudegram.service --no-pager`
   - Service logs: `journalctl -u claudegram.service -n 160 --no-pager -o short-iso`
   - User cron: `crontab -l`
   - Session watch script: `~/.claude/scripts/session-stall-watch.sh`
2. Check whether the production bot is alive.
   - `systemctl show claudegram.service -p ActiveState -p SubState -p ExecMainPID -p NRestarts -p ActiveEnterTimestamp`
   - `pgrep -af '/home/atun/claudegram/dist/index.js'`
3. Check safe Telegram API state without stealing polling.
   - Source `/home/atun/claudegram/.env` without echoing it.
   - Use `getMe` to verify token/API reachability.
   - Use `getWebhookInfo` to verify webhook is empty and pending updates are reasonable.

## Known Incident Patterns

### Startup `getMe` Timeout

Symptom:

```text
Fatal error: Error: Request to 'getMe' timed out after 60 seconds
```

Expected fix state:

- `src/index.ts` wraps `bot.init()` in bounded transient retry.
- Retry policy: 10s initial delay, 60s max delay, 20 minutes max.
- `401 Unauthorized` and `409 Conflict` fail fast.
- `src/bot/bot.ts` exports `registerCommandMenu()` and does not call `setMyCommands` inside `createBot()`.
- Command menu registration runs after successful init with transient retry.

Verify:

```bash
npm run typecheck
npm run build
sudo systemctl restart claudegram.service
journalctl -u claudegram.service --since '5 minutes ago' --no-pager -o short-iso
```

Good recovery log:

```text
[startup] Telegram init failed, retrying in 10s (attempt 1): Request to 'getMe' timed out after 60 seconds
Bot started as @amaocutebot
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

- Usually transient long-poll timeout.
- If the service stays active and one Node process remains, do not restart solely for this log.
- Investigate only if it repeats with user-visible delivery failure.

### `session watch` Alert

Symptom:

```text
session watch: Claude session already N minutes idle
touch /tmp/session_watch_off
```

Meaning:

- This is not Codexgram startup or Telegram polling.
- Source is `~/.claude/scripts/session-stall-watch.sh`, run from user crontab.
- It should alert only when a live Claude Code process exists and transcript files have not updated for 60+ minutes.

Checks:

```bash
ps -eo pid,ppid,stat,etimes,cmd | rg '(^|/| )claude( |$)|@anthropic-ai/claude|claude-code' | rg -v 'rg '
stat -c '%y %n' /tmp/session_watch/alert_ts 2>/dev/null
```

If no Claude process exists, the script should exit without sending a Telegram alert.

## Safe Smoke Test

After a repair:

```bash
npm run typecheck
npm run build
sudo systemctl restart claudegram.service
systemctl show claudegram.service -p ActiveState -p SubState -p ExecMainPID -p NRestarts
pgrep -af '/home/atun/claudegram/dist/index.js'
```

Optional outbound Telegram test:

```bash
cd /home/atun/claudegram
set -a
. ./.env
set +a
CHAT_ID="${ALLOWED_USER_IDS%%,*}"
curl -fsS --connect-timeout 10 --max-time 30 \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  --data-urlencode text="Codexgram smoke test OK: $(date '+%Y-%m-%d %H:%M:%S %Z')" \
  | jq '{ok, message_id: .result.message_id, chat_id: .result.chat.id}'
```

## Closeout

- State whether production was restarted.
- State whether `typecheck` and `build` passed.
- State current service status and PID.
- Update `README.md` `Production Operations` if the repair changes diagnosis, commands, retry policy, service names, or alert handling.
