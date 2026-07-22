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
- `NOTION_CONTRACT_DB_ID` — the "LeaseAI — สัญญาเช่า" database (`0d3ce732aec048f298c93baa788b5306`). Optional but strongly recommended: without it, room matching falls back to comparing the slip amount against AssetLiving's listed rent, which is often stale/wrong and ambiguous when rooms share the same listed price. With it, matching uses the tenant's name first (much more reliable) and the real contract rent as fallback.

## Related services (separate repos/hosts, not this one)

- `assetliving-app` — the main web apps (finance.html, agent.html, index.html/LeaseAI). GitHub: `maildycn/assetliving-app`. Hosted on Render at `assetliving-app.onrender.com`.
- A second, unrelated LINE bot (Python/Flask, not Node) reads *personal* (non-rental) expense slips into the "💸 รายจ่ายส่วนตัว" database. Live at `line-expense-bot.onrender.com`. Its source repo/hosting account is currently unknown — do not assume it's in this GitHub account.
