<p align="center">
  <img src="https://avatars.githubusercontent.com/u/261835704?v=4" width="200" />
</p>

<h1 align="center">Agent BROCK</h1>

<p align="center">
  <b>B</b>ridging <b>R</b>epos, <b>O</b>ps, <b>C</b>hat, and <b>K</b>anban
</p>

<p align="center">
  Autonomous software engineering agent — Slack bot + GitHub webhooks + Planka webhooks + proactive heartbeat
</p>

---

Agent Brock is a unified agent service built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk). It responds to Slack messages, reacts to GitHub and Planka webhooks, proactively polls for work, and runs scheduled jobs — all with real-time activity streaming to Slack.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                       index.ts                            │
│  Starts Slack app + HTTP server + heartbeat + scheduler   │
└───┬──────────────────┬─────────────────────┬─────────────┘
    │                  │                     │
Slack Socket Mode   HTTP :3000           Heartbeat
    │                  │               (setInterval)
    │                  │                     │
slack-handler.ts   webhook-server.ts    heartbeat.ts
    │                  │                     │
    │           ┌──────┴──────┐        Polls for work:
    │           │             │        - GitHub PRs
    │    github-handler  planka-handler - Planka cards
    │           │             │        - FreeScout tickets
    │           │             │        - Beszel health
    └─────┬─────┴─────────────┴──────────────┘
          │
    task-queue.ts  (shared concurrency limiter)
          │
    slack-notifier.ts  (Slack = primary UI for all activity)
          │
    claude-handler.ts  →  Claude Agent SDK
```

## Features

### Slack Bot
- Direct messages and @mentions
- File uploads (images, code, documents)
- Working directory management per channel/thread
- MCP server integration
- Tool permission prompts via interactive buttons
- Session management with abort/cancel support

### GitHub Webhooks
- **PR review** — automatically reviews PRs on `opened`, `reopened`, `ready_for_review`, and `synchronize` events
- **Comment responses** — responds when mentioned in PR/issue comments
- Posts reviews back to GitHub via `gh pr review --body-file -`
- HMAC-SHA256 signature verification
- Event deduplication by `X-GitHub-Delivery` header

### Planka Webhooks
- Triggers when cards are moved to target lists or assigned
- Fetches card details via `planka` CLI
- Creates a git branch (`planka/<card_id>-<slug>`)
- Posts progress updates as Planka comments

### Proactive Heartbeat
Polls on a configurable interval (default: 5 minutes):
- **GitHub** — finds PRs with `review-requested:@me`
- **Planka** — finds assigned cards in target board/lists
- **FreeScout** — triages new support tickets, drafts responses as internal notes
- **Beszel** — monitors server health (CPU, memory, disk), investigates anomalies

### Scheduled Jobs
- Define cron jobs in `jobs.json` — each job is just a prompt
- Claude has access to all CLI tools, so any query or analysis can be a job
- Hot-reloads `jobs.json` on change (no restart needed)
- Example jobs: weekly retention summaries, daily error digests, SEO reports

### Slack as Unified UI
Every triggered task — whether from a webhook, heartbeat, or scheduled job — creates a Slack thread with real-time activity streaming. You can reply in the thread to redirect or interrupt the agent mid-task.

## Setup

### Prerequisites
- Node.js 20+
- A Slack app with Socket Mode enabled ([manifest](slack-app-manifest.json))
- `gh` CLI authenticated (for GitHub features)
- `planka` CLI configured (for Planka features)

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in the required values:

```env
# Required — Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# Optional — Claude API (omit if using Claude subscription)
ANTHROPIC_API_KEY=...

# Optional — Directories
BASE_DIRECTORY=/path/to/code/
DEFAULT_WORKING_DIRECTORY=/path/to/default/project

# Optional — GitHub webhooks
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_REPOS=owner/repo1,owner/repo2
GITHUB_BOT_USERNAME=your-bot-username
GITHUB_NOTIFY_SLACK_CHANNEL=#github-reviews

# Optional — Planka webhooks
PLANKA_WEBHOOK_SECRET=your-webhook-secret
PLANKA_BOARD_ID=1234567890
PLANKA_TARGET_LISTS=list-id-1,list-id-2
PLANKA_NOTIFY_SLACK_CHANNEL=#planka-tasks

# Optional — Heartbeat
HEARTBEAT_ENABLED=true
HEARTBEAT_INTERVAL_MS=300000

# Optional — FreeScout
FREESCOUT_MAILBOX_ID=1
FREESCOUT_NOTIFY_SLACK_CHANNEL=#support

# Optional — Beszel
BESZEL_SYSTEM_IDS=system1,system2
BESZEL_NOTIFY_SLACK_CHANNEL=#infra

# Optional — Webhook server
PORT=3000
MAX_CONCURRENT=2
```

All features are opt-in. If no webhook/heartbeat env vars are set, it works as a plain Slack bot.

### Scheduled Jobs

Create a `jobs.json` file (see [jobs.example.json](jobs.example.json)):

```json
[
  {
    "name": "weekly-retention-summary",
    "schedule": "0 9 * * 1",
    "prompt": "Run `metabase query 7 \"SELECT ...\"` and summarize the results.",
    "slackChannel": "#analytics"
  }
]
```

### Run

```bash
# Development
npm start

# Production
npm run build
npm run prod
```

### Docker

```bash
docker build -t agent-brock .
docker run -d \
  --env-file .env \
  -p 3000:3000 \
  -v /path/to/code:/code \
  -v ./mcp-servers.json:/app/mcp-servers.json \
  -v ./jobs.json:/app/jobs.json \
  agent-brock
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns queue depth, active tasks, uptime |
| `POST` | `/webhook/github` | GitHub webhook receiver (HMAC-SHA256 verified) |
| `POST` | `/webhook/planka` | Planka webhook receiver |

## MCP Servers

Configure MCP servers in `mcp-servers.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "gh",
      "args": ["mcp"]
    }
  }
}
```

## License

ISC
