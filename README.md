# Nate Discord App

Discord bot that:
- collects submissions through two slash commands (`/sales` and `/checkin`)
- only accepts submissions in a dedicated submission channel
- posts sales and check-ins to separate log channels
- keeps two self-updating Top 10 sales leaderboards in a leaderboard channel (daily and monthly)

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Invite the bot to your server with `applications.commands` and `bot` scopes.
3. Copy `.env.example` to `.env` and fill in values:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID`
   - `SUBMISSION_CHANNEL_ID`
   - `SALES_LOG_CHANNEL_ID`
   - `CHECKIN_LOG_CHANNEL_ID`
   - `LEADERBOARD_CHANNEL_ID`
4. Install and run:

```bash
npm install
npm start
```

## Commands

- `/sales` opens the sales modal form:
  - agent name
  - company
  - product
  - AP
  - notes
- `/checkin` opens the daily check-in modal form:
  - agent name
  - calls made
  - appointments made
  - policies closed
  - notes
- `/top` updates both leaderboard messages (Top 10 Daily Sales and Top 10 Monthly Sales).
- `/manager_daily_ap` shows a manager-only daily AP summary for all agents (ephemeral reply).

## Submission Channel Behavior

- Agents must run `/sales` and `/checkin` inside `SUBMISSION_CHANNEL_ID`.
- If they run commands elsewhere, the bot replies with the correct channel mention.
- The bot keeps one persistent "How To Submit" message in the submission channel and updates it on startup.

## Data Storage

Submissions are saved in `data/submissions.json`.
Leaderboard message state is saved in `data/leaderboard-state.json` so the bot edits persistent daily and monthly Top 10 messages.
Submission instruction message state is saved in `data/submission-channel-state.json`.

## Deploy on Render

Use a **Background Worker** service (not a web service) for Discord bots.

1. Push this project to GitHub.
2. In Render, create a new Blueprint and select your repo (uses `render.yaml`).
3. Confirm service type is `worker`.
4. Add environment variables in Render:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID`
   - `DATA_DIR` (set to your mounted disk path, example: `/var/data/nate-bot`)
   - `SUBMISSION_CHANNEL_ID`
   - `SALES_LOG_CHANNEL_ID`
   - `CHECKIN_LOG_CHANNEL_ID`
   - `LEADERBOARD_CHANNEL_ID`
5. Deploy and watch logs for:
   - `Slash commands registered.`
   - `Logged in as ...`

Note: Render free web services can sleep and are not reliable for always-on Discord bots. Use a worker plan for stable uptime.
Important: Without a persistent disk, files reset on restart/deploy. Attach a persistent disk to the worker and point `DATA_DIR` to that mount path.
