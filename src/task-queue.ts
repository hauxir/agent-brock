import { Logger } from './logger.js';

export interface QueuedTask {
  id: string;
  source: string; // 'github', 'planka', 'heartbeat', 'scheduler'
  execute: () => Promise<void>;
}

export class TaskQueue {
  private queue: QueuedTask[] = [];
  private activeTasks: Map<string, QueuedTask> = new Map();
  private maxConcurrent: number;
  private logger = new Logger('TaskQueue');

  constructor(maxConcurrent: number = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.activeTasks.size;
  }

  get activeTaskIds(): string[] {
    return Array.from(this.activeTasks.keys());
  }

  isActive(taskId: string): boolean {
    return this.activeTasks.has(taskId);
  }

  isPending(taskId: string): boolean {
    return this.queue.some((t) => t.id === taskId);
  }

  enqueue(task: QueuedTask): boolean {
    if (this.activeTasks.has(task.id) || this.queue.some((t) => t.id === task.id)) {
      this.logger.debug('Task already queued or active, skipping', { id: task.id, source: task.source });
      return false;
    }

    this.queue.push(task);
    this.logger.info('Task enqueued', {
      id: task.id,
      source: task.source,
      pending: this.pendingCount,
      active: this.activeCount,
    });

    this.drain();
    return true;
  }

  private drain(): void {
    while (this.activeTasks.size < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeTasks.set(task.id, task);

      this.logger.info('Task started', { id: task.id, source: task.source });

      task
        .execute()
        .catch((err) => {
          this.logger.error(`Task ${task.id} failed`, err);
        })
        .finally(() => {
          this.activeTasks.delete(task.id);
          this.logger.info('Task completed', {
            id: task.id,
            source: task.source,
            pending: this.pendingCount,
            active: this.activeCount,
          });
          this.drain();
        });
    }
  }

  getStatus(): { pending: number; active: number; activeIds: string[] } {
    return {
      pending: this.pendingCount,
      active: this.activeCount,
      activeIds: this.activeTaskIds,
    };
  }
}
