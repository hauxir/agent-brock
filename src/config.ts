import dotenv from 'dotenv';

dotenv.config();

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  defaultWorkingDirectory: process.env.DEFAULT_WORKING_DIRECTORY || '',
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',

  // --- New: GitHub webhook integration ---
  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
    repos: (process.env.GITHUB_REPOS || '').split(',').filter(Boolean),
    botUsername: process.env.GITHUB_BOT_USERNAME || '',
    notifySlackChannel: process.env.GITHUB_NOTIFY_SLACK_CHANNEL || '',
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    installationId: process.env.GITHUB_APP_INSTALLATION_ID || '',
  },

  // --- New: Planka webhook integration ---
  planka: {
    webhookSecret: process.env.PLANKA_WEBHOOK_SECRET || '',
    boardId: process.env.PLANKA_BOARD_ID || '',
    targetLists: (process.env.PLANKA_TARGET_LISTS || '').split(',').filter(Boolean),
    notifySlackChannel: process.env.PLANKA_NOTIFY_SLACK_CHANNEL || '',
  },

  // --- New: HTTP server ---
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '2', 10),
  },

  // --- New: Heartbeat (proactive polling) ---
  heartbeat: {
    enabled: process.env.HEARTBEAT_ENABLED !== 'false',
    intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '300000', 10),
  },

  // --- New: FreeScout support tickets ---
  freescout: {
    enabled: process.env.FREESCOUT_HEARTBEAT !== 'false',
    mailboxId: process.env.FREESCOUT_MAILBOX_ID || '',
    notifySlackChannel: process.env.FREESCOUT_NOTIFY_SLACK_CHANNEL || '',
  },

  // --- New: Beszel server monitoring ---
  beszel: {
    enabled: process.env.BESZEL_HEARTBEAT !== 'false',
    systemIds: (process.env.BESZEL_SYSTEM_IDS || '').split(',').filter(Boolean),
    notifySlackChannel: process.env.BESZEL_NOTIFY_SLACK_CHANNEL || '',
  },
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
