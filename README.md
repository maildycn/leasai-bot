# leasai-bot

LINE bot that reads rent-payment slip images (via Claude vision), matches the amount to a room in the AssetLiving Notion database, and logs the payment into the "💰 รายรับ-รายจ่าย" Notion database.

## Deployment

- **Hosted on Render**, live at: https://leasai-bot.onrender.com
- Deploys automatically on every push to `main` on this repo (`github.com/maildycn/leasai-bot`)
- Render account: not the same account as `assetliving-app`/`fortune-app` — as of 2026-07-22 those two are on the user's main Render account, but this service is not, meaning it was created under a different login (different email or OAuth provider). Whoever picks this up next should confirm which Render login owns it before assuming it's the "obvious" account.

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

**Scheduler: GitHub Actions**, not cron-job.org. `.github/workflows/check-rent.yml` in this repo runs daily at 12:30 Asia/Bangkok (`30 5 * * *` UTC) via `workflow_dispatch`-triggerable schedule, and calls the endpoint with `${{ secrets.CRON_SECRET }}` (set as a GitHub Actions repo secret, same value as the Render env var). **Do not switch back to cron-job.org** — as of 2026-07-25 Render was returning `429 Too Many Requests` to every request from cron-job.org's IPs (confirmed via cron-job.org's execution history), so the reminder silently never fired for days despite being configured correctly. The cron-job.org job (`เช็คค่าเช่าค้าง`) still exists but was disabled, left as a reference/backup only.

Per contract, two more fields control where the reminder goes:
- `LINE Group ID` — if set, a personalized reminder is pushed directly to that tenant's own group instead of the main one. Get a group's ID by typing `กลุ่มไอดี` in it.
- `ใช้บอทขุนทองอยู่แล้ว` (checkbox) — if checked, that room is skipped entirely (no duplicate nagging when another bot already handles it).

Contracts with neither set fall back to a single summary message pushed to `LINE_GROUP_ID` (the main/owner group), so nothing goes unnoticed while per-tenant groups are being configured one at a time.

## Related services (separate repos/hosts, not this one)

- `assetliving-app` — the main web apps (finance.html, agent.html, index.html/LeaseAI). GitHub: `maildycn/assetliving-app`. Hosted on Render at `assetliving-app.onrender.com`.
- A second, unrelated LINE bot (Python/Flask, not Node) reads *personal* (non-rental) expense slips into the "💸 รายจ่ายส่วนตัว" database. Live at `line-expense-bot.onrender.com`. Its source repo/hosting account is currently unknown — do not assume it's in this GitHub account.
