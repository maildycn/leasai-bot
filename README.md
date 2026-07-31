# leasai-bot

LINE bot that reads rent-payment slip images (via Claude vision), matches the amount to a room in the AssetLiving Notion database, and logs the payment into the "💰 รายรับ-รายจ่าย" Notion database.

## Deployment

- **Hosted on Render**, live at: https://leasai-bot.onrender.com
- Render account: **same account as assetliving-app/fortune-app** ("My Workspace" / maildy.cn@gmail.com) — it's just grouped inside a Render *Project* called "My project" instead of showing under "Ungrouped Services" on the dashboard overview, which is why past sessions (2026-07-22, and initially 2026-07-31) mistakenly concluded it was on a different account. Check Projects, not just Ungrouped Services.
- **Git source: GitLab, not GitHub** (`gitlab.com/maildy.cn/leasai-bot`, public repo — no secrets in the code, all secrets live in Render env vars). Deploys automatically on every push to `main` via Render's "Public Git Repository" source (no OAuth needed).
- **Why not GitHub anymore**: the original repo (`github.com/maildycn/leasai-bot`) still exists and has the same commit history, but as of 2026-07-31 the `maildycn` GitHub account is **flagged by GitHub account-wide** — confirmed via the literal GitHub UI banner "This account is flagged, and therefore cannot authorize a third party application." This broke GitHub Actions, Render's ability to `git clone` the repo (deploys silently failed with "Exited with status 1 because of an internal system error" from 2026-07-25 through 2026-07-31), and reconnecting Render's GitHub credential. It is **not fixable from Render or code** — only the user can resolve it (check the email on the `maildycn` GitHub account for a Trust & Safety notice, or contact GitHub Support). Until/unless that's resolved, **GitLab is the source of truth for this repo** — don't push new fixes to the GitHub remote expecting them to deploy; push to `gitlab` instead (`git remote -v` to confirm both remotes are configured locally).

## Required environment variables

Set these in the Render service's Environment settings:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `ANTHROPIC_API_KEY`
- `NOTION_TOKEN`
- `NOTION_INCOME_DB_ID` — the "💰 รายรับ-รายจ่าย" database
- `NOTION_ASSET_DB_ID` — the "AssetLiving" database (used to match slip amounts to rooms)
- `NOTION_CONTRACT_DB_ID` — the "LeaseAI — สัญญาเช่า" database (`0d3ce732aec048f298c93baa788b5306`). Optional but strongly recommended: without it, room matching falls back to comparing the slip amount against AssetLiving's listed rent, which is often stale/wrong and ambiguous when rooms share the same listed price. With it, matching uses the slip's memo text first, then the tenant's name, then the real contract rent — in that order.
- `LINE_GROUP_ID` — the LINE group/room ID to push daily rent-due reminders to. Get it by typing `กลุ่มไอดี` in the target chat; the bot replies with the ID. Without this set, `checkRentDue()` just logs what it would have sent instead of pushing.
- `CRON_SECRET` — any random string you choose. Required to call `/cron/check-rent?key=<CRON_SECRET>` (returns 403 otherwise).

## Daily rent-due reminders

`GET /cron/check-rent?key=<CRON_SECRET>` checks every active contract with a `วันครบชำระ` (due day) set in the Contract DB, and if today's day-of-month is on or past the due day with no matching payment recorded in "💰 รายรับ-รายจ่าย" for the current month (`รอบเดือน`), it's overdue. Render's free web-service tier has no built-in cron, so something external has to hit that URL once a day.

**Scheduler: Render Cron Job** (`check-rent-due`, in the same "My Workspace" Render account, `curlimages/curl` image), not GitHub Actions or cron-job.org. Runs daily at 05:30 UTC = 12:30 Asia/Bangkok, executing `curl -sf https://leasai-bot.onrender.com/cron/check-rent?key=$CRON_KEY`. **As of 2026-07-31 this cron job exists but `CRON_KEY` still needs to be set** (Render account settings won't let an agent type secret values into fields — the user needs to fill it in via the Render dashboard's Environment tab on the `check-rent-due` service, matching this service's `CRON_SECRET` value) — check whether that's done before assuming reminders are firing.

Both older schedulers are dead ends, kept here so nobody retries them: **GitHub Actions** (`.github/workflows/check-rent.yml` still in this repo) never ran even once — same GitHub account-flag issue described above blocks Actions execution (`HTTP 422: Actions has been disabled for this user`), not a workflow config problem. **cron-job.org** was tried before that; Render returned `429 Too Many Requests` to its shared IPs, so it silently never fired despite being configured correctly.

Per contract, two more fields control where the reminder goes:
- `LINE Group ID` — if set, a personalized reminder is pushed directly to that tenant's own group instead of the main one. Get a group's ID by typing `กลุ่มไอดี` in it.
- `ใช้บอทขุนทองอยู่แล้ว` (checkbox) — if checked, that room is skipped entirely (no duplicate nagging when another bot already handles it).

Contracts with neither set fall back to a single summary message pushed to `LINE_GROUP_ID` (the main/owner group), so nothing goes unnoticed while per-tenant groups are being configured one at a time.

## Related services (separate repos/hosts, not this one)

- `assetliving-app` — the main web apps (finance.html, agent.html, index.html/LeaseAI). GitHub: `maildycn/assetliving-app`. Hosted on Render at `assetliving-app.onrender.com`.
- A second, unrelated LINE bot (Python/Flask, not Node) reads *personal* (non-rental) expense slips into the "💸 รายจ่ายส่วนตัว" database. Live at `line-expense-bot.onrender.com`. Its source repo/hosting account is currently unknown — do not assume it's in this GitHub account.
