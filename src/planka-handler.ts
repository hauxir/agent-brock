import { execSync } from 'child_process';
import { Logger } from './logger.js';
import { config } from './config.js';
import { TaskQueue } from './task-queue.js';
import { SlackNotifier } from './slack-notifier.js';

export class PlankaHandler {
  private logger = new Logger('PlankaHandler');
  private taskQueue: TaskQueue;
  private notifier: SlackNotifier;

  constructor(taskQueue: TaskQueue, notifier: SlackNotifier) {
    this.taskQueue = taskQueue;
    this.notifier = notifier;
  }

  /**
   * Entry point called by webhook-server when a Planka event arrives.
   * Planka webhook payloads vary — we handle card-move and card-assign events.
   */
  handle(payload: any, _headers: Record<string, any>): void {
    const eventType = payload.type || payload.event;
    this.logger.info('Received Planka event', { eventType, payload: JSON.stringify(payload).substring(0, 200) });

    // Determine what happened
    if (this.isCardMoveToTargetList(payload)) {
      this.handleCardMove(payload);
    } else if (this.isCardAssignment(payload)) {
      this.handleCardAssignment(payload);
    } else {
      this.logger.debug('Ignoring Planka event', { eventType });
    }
  }

  private isCardMoveToTargetList(payload: any): boolean {
    // Check if a card was moved to one of the target lists
    const targetLists = config.planka.targetLists;
    if (targetLists.length === 0) return false;

    const listId = payload.data?.listId || payload.card?.listId || payload.listId;
    return !!listId && targetLists.includes(String(listId));
  }

  private isCardAssignment(payload: any): boolean {
    return payload.type === 'cardMembershipCreate' || payload.event === 'card_assigned';
  }

  private handleCardMove(payload: any): void {
    const cardId = payload.data?.cardId || payload.card?.id || payload.cardId;
    if (!cardId) {
      this.logger.warn('Card move event missing card ID');
      return;
    }

    const taskId = `planka-card-${cardId}`;
    this.taskQueue.enqueue({
      id: taskId,
      source: 'planka',
      execute: () => this.workOnCard(cardId),
    });
  }

  private handleCardAssignment(payload: any): void {
    const cardId =
      payload.data?.cardId || payload.card?.id || payload.cardMembership?.cardId || payload.cardId;
    if (!cardId) {
      this.logger.warn('Card assignment event missing card ID');
      return;
    }

    const taskId = `planka-card-${cardId}`;
    this.taskQueue.enqueue({
      id: taskId,
      source: 'planka',
      execute: () => this.workOnCard(cardId),
    });
  }

  async workOnCard(cardId: string): Promise<void> {
    const channel = config.planka.notifySlackChannel;
    if (!channel) {
      this.logger.warn('No Planka notify Slack channel configured');
      return;
    }

    // Fetch card details via planka CLI
    const cardJson = this.execCommand(`planka card ${cardId} -j`);
    if (!cardJson) {
      this.logger.error('Failed to fetch card details', { cardId });
      return;
    }

    let card: any;
    try {
      card = JSON.parse(cardJson);
    } catch {
      this.logger.error('Failed to parse card JSON', { cardId });
      return;
    }

    const cardName = card.name || card.title || `Card ${cardId}`;
    const cardDescription = card.description || '';

    const thread = await this.notifier.createThread(channel, `📋 Working on Planka card: ${cardName}`);
    if (!thread) return;

    // Create a branch name
    const slug = this.slugify(cardName);
    const branchName = `planka/${cardId}-${slug}`;

    // Determine working directory
    const workingDirectory = config.defaultWorkingDirectory || config.baseDirectory || '/tmp';

    // Create git branch
    this.execCommand(`git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName}`, workingDirectory);

    const prompt = [
      `You are working on a Planka card task.`,
      `\nCard: ${cardName}`,
      `Card ID: ${cardId}`,
      cardDescription ? `\nDescription:\n${cardDescription}` : '',
      `\nYou are on branch: ${branchName}`,
      `\nPlease:`,
      `1. Read and understand the card requirements`,
      `2. Implement the requested changes`,
      `3. Make sure the code compiles and passes linting`,
      `4. Provide a summary of what you did`,
    ].join('\n');

    // Post a starting comment on the Planka card
    this.execCommand(`planka comment-add ${cardId} "Started working on this card. Branch: ${branchName}"`);

    const result = await this.notifier.runAndStream(thread, prompt, workingDirectory);

    // Post completion comment on the Planka card
    if (result) {
      const summary = result.length > 500 ? result.substring(0, 500) + '...' : result;
      this.execCommand(`planka comment-add ${cardId} "Completed. Summary: ${this.shellEscape(summary)}"`);
    } else {
      this.execCommand(`planka comment-add ${cardId} "Task ended without a clear result. Check Slack for details."`);
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }

  private shellEscape(str: string): string {
    return str.replace(/'/g, "'\\''");
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
}
