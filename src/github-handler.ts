import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger.js';
import { config } from './config.js';
import { TaskQueue } from './task-queue.js';
import { SlackNotifier } from './slack-notifier.js';

export class GithubHandler {
  private logger = new Logger('GithubHandler');
  private taskQueue: TaskQueue;
  private notifier: SlackNotifier;

  constructor(taskQueue: TaskQueue, notifier: SlackNotifier) {
    this.taskQueue = taskQueue;
    this.notifier = notifier;
  }

  /**
   * Entry point called by webhook-server when a GitHub event arrives.
   */
  handle(payload: any, headers: Record<string, any>): void {
    const event = headers['x-github-event'] as string;
    if (!event) {
      this.logger.warn('GitHub webhook missing x-github-event header');
      return;
    }

    this.logger.info('Received GitHub event', { event, action: payload.action });

    switch (event) {
      case 'pull_request':
        this.handlePullRequest(payload);
        break;
      case 'issue_comment':
        this.handleIssueComment(payload);
        break;
      default:
        this.logger.debug('Ignoring GitHub event', { event });
    }
  }

  private handlePullRequest(payload: any): void {
    const action = payload.action;
    const pr = payload.pull_request;
    if (!pr) return;

    const repo = payload.repository?.full_name;
    const number = pr.number;
    const title = pr.title;

    const actionable = ['opened', 'reopened', 'ready_for_review', 'synchronize'];
    if (!actionable.includes(action)) {
      this.logger.debug('Ignoring PR action', { action, repo, number });
      return;
    }

    // Skip draft PRs (except synchronize on non-draft)
    if (pr.draft && action !== 'synchronize') {
      this.logger.debug('Skipping draft PR', { repo, number });
      return;
    }

    const taskId = `github-pr-${repo}-${number}`;
    const isIncremental = action === 'synchronize';

    this.taskQueue.enqueue({
      id: taskId,
      source: 'github',
      execute: () => this.reviewPR(repo, number, title, isIncremental),
    });
  }

  private handleIssueComment(payload: any): void {
    const action = payload.action;
    if (action !== 'created') return;

    const comment = payload.comment;
    const repo = payload.repository?.full_name;
    const botUsername = config.github.botUsername;

    // Only respond if the bot is mentioned
    if (!botUsername || !comment?.body?.includes(`@${botUsername}`)) {
      return;
    }

    const issue = payload.issue;
    const number = issue.number;
    const isPR = !!issue.pull_request;

    const taskId = `github-comment-${repo}-${number}-${comment.id}`;

    this.taskQueue.enqueue({
      id: taskId,
      source: 'github',
      execute: () => this.respondToComment(repo, number, comment.body, isPR, comment.user?.login),
    });
  }

  private async reviewPR(repo: string, number: number, title: string, incremental: boolean): Promise<void> {
    const channel = config.github.notifySlackChannel;
    if (!channel) {
      this.logger.warn('No GitHub notify Slack channel configured');
      return;
    }

    const actionLabel = incremental ? 'Reviewing new commits on' : 'Reviewing';
    const thread = await this.notifier.createThread(channel, `🔍 ${actionLabel} PR #${number}: ${title} — ${repo}`);
    if (!thread) return;

    const workingDirectory = this.ensureRepo(repo);
    if (!workingDirectory) {
      await this.postToSlackThread(thread.channel, thread.threadTs, '❌ Failed to clone/update repository');
      return;
    }

    // Fetch the diff
    const diff = this.execCommand(`gh pr diff ${number} --repo ${repo}`, workingDirectory);
    if (diff === null) {
      await this.postToSlackThread(thread.channel, thread.threadTs, '❌ Failed to fetch PR diff');
      return;
    }

    // Fetch PR details
    const prDetailsJson = this.execCommand(
      `gh pr view ${number} --repo ${repo} --json body,headRefName,baseRefName,files`,
      workingDirectory,
    );
    let prDetails: any = {};
    if (prDetailsJson) {
      try {
        prDetails = JSON.parse(prDetailsJson);
      } catch {
        // ignore parse errors
      }
    }

    const truncatedDiff = diff.length > 50000 ? diff.substring(0, 50000) + '\n...(diff truncated)' : diff;

    const prompt = [
      `You are reviewing Pull Request #${number} in ${repo}.`,
      `Title: ${title}`,
      prDetails.body ? `\nDescription:\n${prDetails.body}` : '',
      prDetails.baseRefName ? `\nBase branch: ${prDetails.baseRefName}` : '',
      prDetails.headRefName ? `\nHead branch: ${prDetails.headRefName}` : '',
      incremental ? '\nThis is an incremental review — focus on the new changes.' : '',
      `\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
      '\n\nPlease review this PR. Provide:',
      '1. A brief summary of the changes',
      '2. Any issues, bugs, or concerns',
      '3. Suggestions for improvement',
      '4. An overall assessment (approve, request changes, or comment)',
      '\nBe specific and reference file names and line numbers when pointing out issues.',
      'Keep the review concise and actionable.',
    ].join('\n');

    const result = await this.notifier.runAndStream(thread, prompt, workingDirectory);

    // Post the review back to GitHub
    if (result) {
      const truncatedResult = result.length > 65000 ? result.substring(0, 65000) + '\n...(truncated)' : result;
      this.execCommandWithStdin(
        `gh pr review ${number} --repo ${repo} --comment --body-file -`,
        truncatedResult,
        workingDirectory,
      );
      this.logger.info('Posted review to GitHub', { repo, number });
    }
  }

  private async respondToComment(
    repo: string,
    number: number,
    commentBody: string,
    isPR: boolean,
    commenter: string,
  ): Promise<void> {
    const channel = config.github.notifySlackChannel;
    if (!channel) return;

    const kind = isPR ? 'PR' : 'issue';
    const thread = await this.notifier.createThread(
      channel,
      `💬 Responding to ${commenter}'s comment on ${kind} #${number} — ${repo}`,
    );
    if (!thread) return;

    const workingDirectory = this.ensureRepo(repo);
    if (!workingDirectory) {
      await this.postToSlackThread(thread.channel, thread.threadTs, '❌ Failed to clone/update repository');
      return;
    }

    const prompt = [
      `Someone commented on ${kind} #${number} in ${repo} and mentioned you.`,
      `\nCommenter: ${commenter}`,
      `\nComment:\n${commentBody}`,
      `\nPlease respond helpfully. If this is a PR, you can review the code. If it's an issue, provide guidance.`,
    ].join('\n');

    const result = await this.notifier.runAndStream(thread, prompt, workingDirectory);

    if (result) {
      const truncatedResult = result.length > 65000 ? result.substring(0, 65000) + '\n...(truncated)' : result;
      const cmd = isPR
        ? `gh pr comment ${number} --repo ${repo} --body-file -`
        : `gh issue comment ${number} --repo ${repo} --body-file -`;
      this.execCommandWithStdin(cmd, truncatedResult, workingDirectory);
    }
  }

  /**
   * Ensure the repo is cloned and up-to-date under BASE_DIRECTORY.
   * Returns the repo's working directory path, or null on failure.
   */
  ensureRepo(fullName: string): string | null {
    const baseDir = config.baseDirectory || '/tmp/repos';
    const repoDir = path.join(baseDir, fullName.replace('/', path.sep));

    try {
      if (fs.existsSync(path.join(repoDir, '.git'))) {
        // Pull latest
        this.execCommand('git fetch origin && git reset --hard origin/HEAD', repoDir);
        this.logger.debug('Updated existing repo', { repoDir });
      } else {
        // Clone
        fs.mkdirSync(path.dirname(repoDir), { recursive: true });
        execSync(`gh repo clone ${fullName} "${repoDir}"`, {
          stdio: 'pipe',
          timeout: 120000,
        });
        this.logger.info('Cloned repo', { fullName, repoDir });
      }
      return repoDir;
    } catch (error) {
      this.logger.error('Failed to ensure repo', error);
      return null;
    }
  }

  private execCommand(cmd: string, cwd: string): string | null {
    try {
      return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      this.logger.error(`Command failed: ${cmd}`, error);
      return null;
    }
  }

  private execCommandWithStdin(cmd: string, stdin: string, cwd: string): boolean {
    try {
      execSync(cmd, {
        cwd,
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

  private async postToSlackThread(channel: string, threadTs: string, text: string): Promise<void> {
    // Delegate to notifier's app — but we access it through the notifier
    // This is a simplified fallback for error messages
    this.logger.warn(text);
  }
}
