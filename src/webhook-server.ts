import * as http from 'http';
import * as crypto from 'crypto';
import { Logger } from './logger.js';
import { config } from './config.js';
import { TaskQueue } from './task-queue.js';

export type WebhookHandler = (payload: any, headers: http.IncomingHttpHeaders) => void;

export class WebhookServer {
  private server: http.Server;
  private logger = new Logger('WebhookServer');
  private githubHandler?: WebhookHandler;
  private plankaHandler?: WebhookHandler;
  private taskQueue: TaskQueue;
  private startTime = Date.now();

  // Deduplication: track GitHub delivery IDs (expire after 10 minutes)
  private recentDeliveries: Map<string, number> = new Map();
  private deduplicationTtlMs = 10 * 60 * 1000;

  constructor(taskQueue: TaskQueue) {
    this.taskQueue = taskQueue;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Periodically clean up old delivery IDs
    setInterval(() => this.cleanupDeliveries(), this.deduplicationTtlMs);
  }

  setGithubHandler(handler: WebhookHandler): void {
    this.githubHandler = handler;
  }

  setPlankaHandler(handler: WebhookHandler): void {
    this.plankaHandler = handler;
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        this.logger.info(`Webhook server listening on port ${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '';
    const method = req.method || '';

    // Health check
    if (method === 'GET' && url === '/health') {
      this.handleHealth(res);
      return;
    }

    // GitHub webhook
    if (method === 'POST' && url === '/webhook/github') {
      this.bufferBody(req, (body) => this.handleGithubWebhook(req, res, body));
      return;
    }

    // Planka webhook
    if (method === 'POST' && url === '/webhook/planka') {
      this.bufferBody(req, (body) => this.handlePlankaWebhook(req, res, body));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private handleHealth(res: http.ServerResponse): void {
    const status = this.taskQueue.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        queue: status,
      }),
    );
  }

  private handleGithubWebhook(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer): void {
    // Verify signature
    const secret = config.github.webhookSecret;
    if (secret) {
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      if (!signature) {
        this.logger.warn('GitHub webhook missing signature');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing signature' }));
        return;
      }

      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        this.logger.warn('GitHub webhook invalid signature');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
    }

    // Deduplicate by delivery ID
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;
    if (deliveryId) {
      if (this.recentDeliveries.has(deliveryId)) {
        this.logger.debug('Duplicate GitHub delivery, skipping', { deliveryId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'duplicate' }));
        return;
      }
      this.recentDeliveries.set(deliveryId, Date.now());
    }

    // Parse and dispatch
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Respond 202 immediately
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));

    if (this.githubHandler) {
      this.githubHandler(payload, req.headers);
    }
  }

  private handlePlankaWebhook(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer): void {
    // Verify secret if configured
    const secret = config.planka.webhookSecret;
    if (secret) {
      const signature = req.headers['x-webhook-signature'] as string | undefined;
      if (!signature) {
        this.logger.warn('Planka webhook missing signature');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing signature' }));
        return;
      }

      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        this.logger.warn('Planka webhook invalid signature');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));

    if (this.plankaHandler) {
      this.plankaHandler(payload, req.headers);
    }
  }

  private bufferBody(req: http.IncomingMessage, callback: (body: Buffer) => void): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => callback(Buffer.concat(chunks)));
  }

  private cleanupDeliveries(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, timestamp] of this.recentDeliveries) {
      if (now - timestamp > this.deduplicationTtlMs) {
        this.recentDeliveries.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug('Cleaned up delivery IDs', { cleaned });
    }
  }
}
