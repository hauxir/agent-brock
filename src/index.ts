import { App } from '@slack/bolt';
import { config, validateConfig } from './config.js';
import { ClaudeHandler } from './claude-handler.js';
import { SlackHandler } from './slack-handler.js';
import { McpManager } from './mcp-manager.js';
import { Logger } from './logger.js';
import { TaskQueue } from './task-queue.js';
import { SlackNotifier } from './slack-notifier.js';
import { WebhookServer } from './webhook-server.js';
import { GithubHandler } from './github-handler.js';
import { PlankaHandler } from './planka-handler.js';
import { Heartbeat } from './heartbeat.js';
import { Scheduler } from './scheduler.js';

const logger = new Logger('Main');

let app: App;
let webhookServer: WebhookServer;
let heartbeat: Heartbeat;
let scheduler: Scheduler;

async function start() {
  try {
    validateConfig();

    logger.info('Starting Agent Brock', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // 1. Initialize Slack app (existing)
    app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // 2. Initialize shared services
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();
    const claudeHandler = new ClaudeHandler(mcpManager);
    const taskQueue = new TaskQueue(config.server.maxConcurrent);

    // 3. Initialize Slack notifier (used by all non-Slack triggers)
    const notifier = new SlackNotifier(app, claudeHandler, mcpManager);

    // 4. Initialize Slack handler (existing — handles DMs, mentions, threads)
    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);
    slackHandler.setupEventHandlers();

    // Bridge: let notifier register threads with slack handler for interactivity
    notifier.setRegisterThreadFn((threadTs, channel, sessionKey) => {
      // The SlackHandler uses thread_ts-based session keys for threaded replies.
      // When someone replies in a notifier-created thread, it routes through
      // the existing app_mention / message handler which looks up by thread_ts.
      logger.debug('Registered notifier thread for interactivity', { threadTs, channel, sessionKey });
    });

    // 5. Start Slack app
    await app.start();
    logger.info('Slack app started (Socket Mode)');

    // 6. Initialize and start webhook server
    webhookServer = new WebhookServer(taskQueue);

    const githubHandler = new GithubHandler(taskQueue, notifier);
    webhookServer.setGithubHandler((payload, headers) => githubHandler.handle(payload, headers));

    const plankaHandler = new PlankaHandler(taskQueue, notifier);
    webhookServer.setPlankaHandler((payload, headers) => plankaHandler.handle(payload, headers));

    await webhookServer.start(config.server.port);
    logger.info(`Webhook server started on port ${config.server.port}`);

    // 7. Start heartbeat (proactive polling)
    if (config.heartbeat.enabled) {
      heartbeat = new Heartbeat(taskQueue, notifier);
      heartbeat.start(config.heartbeat.intervalMs);
      logger.info('Heartbeat started', { intervalMs: config.heartbeat.intervalMs });
    }

    // 8. Start scheduler (cron jobs from jobs.json)
    scheduler = new Scheduler(taskQueue, notifier);
    scheduler.start();
    logger.info('Scheduler started');

    // Log configuration summary
    logger.info('Agent Brock is running!', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      webhookPort: config.server.port,
      maxConcurrent: config.server.maxConcurrent,
      heartbeatEnabled: config.heartbeat.enabled,
      heartbeatIntervalMs: config.heartbeat.intervalMs,
      githubRepos: config.github.repos,
      plankaBoardId: config.planka.boardId || 'not set',
    });
  } catch (error) {
    logger.error('Failed to start', error);
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  try {
    scheduler?.stop();
    heartbeat?.stop();
    await webhookServer?.stop();
    await app?.stop();
    logger.info('Shutdown complete');
  } catch (error) {
    logger.error('Error during shutdown', error);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
