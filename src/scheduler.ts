import * as fs from 'fs';
import * as path from 'path';
import cron, { type ScheduledTask } from 'node-cron';
import { Logger } from './logger.js';
import { config } from './config.js';
import { TaskQueue } from './task-queue.js';
import { SlackNotifier } from './slack-notifier.js';

export interface JobDefinition {
  name: string;
  schedule: string; // cron expression
  prompt: string;
  slackChannel?: string;
  workingDirectory?: string;
}

export class Scheduler {
  private logger = new Logger('Scheduler');
  private taskQueue: TaskQueue;
  private notifier: SlackNotifier;
  private jobs: JobDefinition[] = [];
  private cronTasks: ScheduledTask[] = [];
  private configPath: string;

  constructor(taskQueue: TaskQueue, notifier: SlackNotifier, configPath: string = './jobs.json') {
    this.taskQueue = taskQueue;
    this.notifier = notifier;
    this.configPath = path.resolve(configPath);
  }

  start(): void {
    this.loadJobs();

    // Watch for config changes
    try {
      fs.watchFile(this.configPath, { interval: 30000 }, () => {
        this.logger.info('jobs.json changed, reloading');
        this.stopCronTasks();
        this.loadJobs();
      });
    } catch {
      this.logger.debug('Could not watch jobs.json for changes');
    }
  }

  stop(): void {
    this.stopCronTasks();
    try {
      fs.unwatchFile(this.configPath);
    } catch {
      // ignore
    }
  }

  private loadJobs(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info('No jobs.json found, scheduler idle', { path: this.configPath });
        return;
      }

      const content = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        this.logger.warn('jobs.json must be a JSON array');
        return;
      }

      this.jobs = [];
      for (const job of parsed) {
        if (!job.name || !job.schedule || !job.prompt) {
          this.logger.warn('Skipping invalid job definition', { job });
          continue;
        }

        if (!cron.validate(job.schedule)) {
          this.logger.warn('Invalid cron expression, skipping job', { name: job.name, schedule: job.schedule });
          continue;
        }

        this.jobs.push({
          name: job.name,
          schedule: job.schedule,
          prompt: job.prompt,
          slackChannel: job.slackChannel,
          workingDirectory: job.workingDirectory,
        });
      }

      this.logger.info('Loaded jobs', { count: this.jobs.length, names: this.jobs.map((j) => j.name) });

      // Schedule all jobs
      this.scheduleCronTasks();
    } catch (error) {
      this.logger.error('Failed to load jobs.json', error);
    }
  }

  private scheduleCronTasks(): void {
    for (const job of this.jobs) {
      const task = cron.schedule(job.schedule, () => {
        this.logger.info('Cron job triggered', { name: job.name });
        this.enqueueJob(job);
      });
      this.cronTasks.push(task);
    }
  }

  private stopCronTasks(): void {
    for (const task of this.cronTasks) {
      task.stop();
    }
    this.cronTasks = [];
  }

  private enqueueJob(job: JobDefinition): void {
    const taskId = `scheduler-${job.name}-${Date.now()}`;
    const channel = job.slackChannel || config.github.notifySlackChannel || '';

    if (!channel) {
      this.logger.warn('No Slack channel configured for scheduled job', { name: job.name });
      return;
    }

    this.taskQueue.enqueue({
      id: taskId,
      source: 'scheduler',
      execute: async () => {
        const thread = await this.notifier.createThread(channel, `⏰ Scheduled job: ${job.name}`);
        if (!thread) return;

        const workingDirectory =
          job.workingDirectory || config.defaultWorkingDirectory || config.baseDirectory || '/tmp';

        await this.notifier.runAndStream(thread, job.prompt, workingDirectory);
      },
    });
  }
}
