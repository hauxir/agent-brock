import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger.js';
import { config } from './config.js';
import { TaskQueue } from './task-queue.js';
import { SlackNotifier } from './slack-notifier.js';

interface TrackedItem {
  timestamp: number;
}

export class Heartbeat {
  private logger = new Logger('Heartbeat');
  private taskQueue: TaskQueue;
  private notifier: SlackNotifier;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Track processed items to avoid duplicate work
  // Key format: "source:id", value: timestamp when first seen
  private processedItems: Map<string, TrackedItem> = new Map();
  private itemTtlMs = 60 * 60 * 1000; // 1 hour TTL

  constructor(taskQueue: TaskQueue, notifier: SlackNotifier) {
    this.taskQueue = taskQueue;
    this.notifier = notifier;
  }

  start(intervalMs: number): void {
    this.logger.info('Starting heartbeat', { intervalMs });

    // Run immediately, then on interval
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    this.logger.debug('Heartbeat tick');
    this.cleanupProcessedItems();

    try {
      await Promise.allSettled([
        this.checkGithubPRs(),
        this.checkPlankaCards(),
        this.checkFreescoutTickets(),
        this.checkBeszelHealth(),
      ]);
    } catch (error) {
      this.logger.error('Heartbeat tick error', error);
    }
  }

  // --- GitHub: Check for PRs needing review ---

  private async checkGithubPRs(): Promise<void> {
    const repos = config.github.repos;
    if (repos.length === 0) return;

    for (const repo of repos) {
      try {
        const result = this.execCommand(
          `gh pr list --repo ${repo} --search "review-requested:@me" --json number,title,url --limit 10`,
        );
        if (!result) continue;

        const prs = JSON.parse(result);
        for (const pr of prs) {
          const itemKey = `github-pr:${repo}/${pr.number}`;
          if (this.isProcessed(itemKey)) continue;

          this.markProcessed(itemKey);
          this.logger.info('Found PR needing review', { repo, number: pr.number, title: pr.title });

          const channel = config.github.notifySlackChannel;
          if (!channel) continue;

          this.taskQueue.enqueue({
            id: `heartbeat-github-pr-${repo}-${pr.number}`,
            source: 'heartbeat',
            execute: async () => {
              const thread = await this.notifier.createThread(
                channel,
                `🔍 Found unreviewed PR #${pr.number}: ${pr.title} — ${repo}`,
              );
              if (!thread) return;

              const workingDirectory = this.ensureRepo(repo);
              if (!workingDirectory) return;

              const diff = this.execCommand(`gh pr diff ${pr.number} --repo ${repo}`, workingDirectory);
              const truncatedDiff = diff && diff.length > 50000 ? diff.substring(0, 50000) + '\n...(truncated)' : diff;

              const prompt = [
                `You found an unreviewed PR during your periodic check.`,
                `PR #${pr.number}: ${pr.title} in ${repo}`,
                truncatedDiff ? `\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` : '',
                '\nPlease review this PR concisely.',
              ].join('\n');

              const result = await this.notifier.runAndStream(thread, prompt, workingDirectory);

              if (result) {
                const truncated = result.length > 65000 ? result.substring(0, 65000) + '\n...(truncated)' : result;
                this.execCommandWithStdin(
                  `gh pr review ${pr.number} --repo ${repo} --comment --body-file -`,
                  truncated,
                  workingDirectory,
                );
              }
            },
          });
        }
      } catch (error) {
        this.logger.error('Error checking GitHub PRs', error);
      }
    }
  }

  // --- Planka: Check for assigned cards ---

  private async checkPlankaCards(): Promise<void> {
    const boardId = config.planka.boardId;
    if (!boardId) return;

    try {
      const result = this.execCommand(`planka board ${boardId} -j`);
      if (!result) return;

      const board = JSON.parse(result);
      const targetLists = config.planka.targetLists;
      const cards = (board.cards || board.items || []).filter((card: any) => {
        const listId = String(card.listId || card.list_id || '');
        return targetLists.length === 0 || targetLists.includes(listId);
      });

      for (const card of cards) {
        const cardId = String(card.id);
        const itemKey = `planka-card:${cardId}`;
        if (this.isProcessed(itemKey)) continue;
        if (this.taskQueue.isActive(`planka-card-${cardId}`)) continue;

        this.markProcessed(itemKey);

        const { PlankaHandler } = await import('./planka-handler.js');
        const plankaHandler = new PlankaHandler(this.taskQueue, this.notifier);

        this.taskQueue.enqueue({
          id: `heartbeat-planka-${cardId}`,
          source: 'heartbeat',
          execute: () => plankaHandler.workOnCard(cardId),
        });
      }
    } catch (error) {
      this.logger.error('Error checking Planka cards', error);
    }
  }

  // --- FreeScout: Check for new support tickets ---

  private async checkFreescoutTickets(): Promise<void> {
    if (!config.freescout.enabled) return;

    const mailboxId = config.freescout.mailboxId;
    if (!mailboxId) return;

    try {
      const result = this.execCommand(`freescout conversations --mailbox ${mailboxId} --status active -j`);
      if (!result) return;

      const conversations = JSON.parse(result);
      for (const conv of Array.isArray(conversations) ? conversations : []) {
        const convId = String(conv.id);
        const itemKey = `freescout:${convId}`;
        if (this.isProcessed(itemKey)) continue;

        this.markProcessed(itemKey);

        const channel = config.freescout.notifySlackChannel;
        if (!channel) continue;

        this.taskQueue.enqueue({
          id: `heartbeat-freescout-${convId}`,
          source: 'heartbeat',
          execute: async () => {
            const thread = await this.notifier.createThread(
              channel,
              `📧 New support ticket: ${conv.subject || conv.title || `#${convId}`}`,
            );
            if (!thread) return;

            // Fetch full conversation with threads
            const fullConv = this.execCommand(`freescout conversation ${convId} --threads -j`);
            const workingDirectory = config.defaultWorkingDirectory || config.baseDirectory || '/tmp';

            const prompt = [
              `A support ticket needs attention.`,
              `\nTicket #${convId}: ${conv.subject || conv.title || 'No subject'}`,
              fullConv ? `\nFull conversation:\n${fullConv}` : '',
              `\nPlease:`,
              `1. Read and understand the issue`,
              `2. Classify the ticket (bug report, feature request, how-to question, etc.)`,
              `3. Draft a helpful response`,
              `4. If you can resolve it, provide the answer. Otherwise, suggest escalation.`,
            ].join('\n');

            const result = await this.notifier.runAndStream(thread, prompt, workingDirectory);

            // Post as internal note for human review
            if (result) {
              const note = result.length > 2000 ? result.substring(0, 2000) + '...' : result;
              this.execCommandWithStdin(`freescout note ${convId} --user 1`, note);
            }
          },
        });
      }
    } catch (error) {
      this.logger.error('Error checking FreeScout tickets', error);
    }
  }

  // --- Beszel: Check server health ---

  private async checkBeszelHealth(): Promise<void> {
    if (!config.beszel.enabled) return;

    const systemIds = config.beszel.systemIds;
    if (systemIds.length === 0) return;

    try {
      for (const systemId of systemIds) {
        const stats = this.execCommand(`beszel stats ${systemId} -j`);
        if (!stats) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(stats);
        } catch {
          continue;
        }

        // Check for anomalies
        const anomalies = this.detectAnomalies(parsed, systemId);
        if (anomalies.length === 0) continue;

        if (this.isProcessed(`beszel-check:${systemId}`)) continue;
        this.markProcessed(`beszel-check:${systemId}`);

        const channel = config.beszel.notifySlackChannel;
        if (!channel) continue;

        this.taskQueue.enqueue({
          id: `heartbeat-beszel-${systemId}`,
          source: 'heartbeat',
          execute: async () => {
            const thread = await this.notifier.createThread(
              channel,
              `⚠️ Server health alert: ${systemId} — ${anomalies.join(', ')}`,
            );
            if (!thread) return;

            const workingDirectory = config.defaultWorkingDirectory || config.baseDirectory || '/tmp';

            // Get more details
            const containers = this.execCommand(`beszel containers ${systemId} -j`);
            const systemInfo = this.execCommand(`beszel system ${systemId} -j`);

            const prompt = [
              `Server health anomaly detected on system ${systemId}.`,
              `\nAnomalies: ${anomalies.join(', ')}`,
              systemInfo ? `\nSystem info:\n${systemInfo}` : '',
              stats ? `\nRecent stats:\n${stats}` : '',
              containers ? `\nContainers:\n${containers}` : '',
              `\nPlease:`,
              `1. Analyze the anomaly`,
              `2. Check container logs if relevant: \`beszel logs ${systemId} <container>\``,
              `3. Provide a diagnosis and recommended action`,
            ].join('\n');

            await this.notifier.runAndStream(thread, prompt, workingDirectory);
          },
        });
      }
    } catch (error) {
      this.logger.error('Error checking Beszel health', error);
    }
  }

  private detectAnomalies(stats: any, _systemId: string): string[] {
    const anomalies: string[] = [];

    // Handle array of stats (time series) or single object
    const latest = Array.isArray(stats) ? stats[stats.length - 1] : stats;
    if (!latest) return anomalies;

    const cpu = latest.cpu ?? latest.cpuPercent ?? latest.cpu_percent;
    const mem = latest.mem ?? latest.memPercent ?? latest.mem_percent;
    const disk = latest.disk ?? latest.diskPercent ?? latest.disk_percent;

    if (typeof cpu === 'number' && cpu > 90) anomalies.push(`High CPU: ${cpu.toFixed(1)}%`);
    if (typeof mem === 'number' && mem > 90) anomalies.push(`High memory: ${mem.toFixed(1)}%`);
    if (typeof disk === 'number' && disk > 90) anomalies.push(`High disk: ${disk.toFixed(1)}%`);

    return anomalies;
  }

  // --- Helpers ---

  private isProcessed(key: string): boolean {
    return this.processedItems.has(key);
  }

  private markProcessed(key: string): void {
    this.processedItems.set(key, { timestamp: Date.now() });
  }

  private cleanupProcessedItems(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, item] of this.processedItems) {
      if (now - item.timestamp > this.itemTtlMs) {
        this.processedItems.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug('Cleaned up processed items', { cleaned });
    }
  }

  private ensureRepo(fullName: string): string | null {
    // Inline repo-ensure logic (same as GithubHandler.ensureRepo)
    const baseDir = config.baseDirectory || '/tmp/repos';
    const repoDir = path.join(baseDir, fullName.replace('/', path.sep));

    try {
      if (fs.existsSync(path.join(repoDir, '.git'))) {
        execSync('git fetch origin && git reset --hard origin/HEAD', {
          cwd: repoDir,
          stdio: 'pipe',
          timeout: 60000,
        });
      } else {
        fs.mkdirSync(path.dirname(repoDir), { recursive: true });
        execSync(`gh repo clone ${fullName} "${repoDir}"`, {
          stdio: 'pipe',
          timeout: 120000,
        });
      }
      return repoDir;
    } catch (error) {
      this.logger.error('Failed to ensure repo', error);
      return null;
    }
  }

  private execCommand(cmd: string, cwd?: string): string | null {
    try {
      return execSync(cmd, {
        cwd: cwd || undefined,
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      this.logger.error(`Command failed: ${cmd}`, error);
      return null;
    }
  }

  private execCommandWithStdin(cmd: string, stdin: string, cwd?: string): boolean {
    try {
      execSync(cmd, {
        cwd: cwd || undefined,
        encoding: 'utf-8',
        timeout: 30000,
        input: stdin,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      this.logger.error(`Command with stdin failed: ${cmd}`, error);
      return false;
    }
  }
}
