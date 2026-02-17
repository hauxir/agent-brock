import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler.js';
import { McpManager } from './mcp-manager.js';
import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './logger.js';
import { TodoManager, Todo } from './todo-manager.js';

/**
 * SlackNotifier creates and manages Slack threads for non-Slack triggers
 * (GitHub webhooks, Planka webhooks, heartbeat, scheduler).
 *
 * Each triggered task gets a thread in a configured Slack channel.
 * Claude activity streams into the thread in real-time — same UX as
 * a direct Slack conversation.
 *
 * Threads are registered with the SlackHandler so replies in the thread
 * are routed to the right Claude session for interactivity.
 */

export interface NotifierThread {
  channel: string;
  threadTs: string;
  sessionKey: string;
}

// Callback to register a thread with the SlackHandler for interactivity
export type RegisterThreadFn = (threadTs: string, channel: string, sessionKey: string) => void;

export class SlackNotifier {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private todoManager: TodoManager;
  private logger = new Logger('SlackNotifier');
  private registerThread?: RegisterThreadFn;

  // Track todo messages per session for in-place updates
  private todoMessages: Map<string, string> = new Map();

  constructor(app: App, claudeHandler: ClaudeHandler, _mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.todoManager = new TodoManager();
  }

  setRegisterThreadFn(fn: RegisterThreadFn): void {
    this.registerThread = fn;
  }

  /**
   * Create a new Slack thread for a triggered task.
   * Returns the thread timestamp for streaming into.
   */
  async createThread(channel: string, headerText: string): Promise<NotifierThread | null> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel,
        text: headerText,
      });

      if (!result.ts || !result.channel) {
        this.logger.error('Failed to create thread — no ts/channel in response');
        return null;
      }

      const sessionKey = `notifier-${result.channel}-${result.ts}`;

      // Register thread with SlackHandler for interactive replies
      if (this.registerThread) {
        this.registerThread(result.ts, result.channel, sessionKey);
      }

      this.logger.info('Created Slack thread', {
        channel: result.channel,
        threadTs: result.ts,
        sessionKey,
      });

      return {
        channel: result.channel,
        threadTs: result.ts,
        sessionKey,
      };
    } catch (error) {
      this.logger.error('Failed to create Slack thread', error);
      return null;
    }
  }

  /**
   * Run a Claude query and stream all activity into the given Slack thread.
   * This mirrors the streaming logic in slack-handler.ts.
   */
  async runAndStream(
    thread: NotifierThread,
    prompt: string,
    workingDirectory: string,
    abortController?: AbortController,
  ): Promise<string | null> {
    const { channel, threadTs, sessionKey } = thread;
    const controller = abortController || new AbortController();

    // Create a virtual session for this task
    const session = this.claudeHandler.createSession('agent', channel, threadTs);
    let statusMessageTs: string | undefined;
    let lastResult: string | null = null;

    try {
      // Send initial status
      const statusResult = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '🤔 *Thinking...*',
      });
      statusMessageTs = statusResult.ts ?? undefined;

      for await (const message of this.claudeHandler.streamQuery(prompt, session, controller, workingDirectory)) {
        if (controller.signal.aborted) break;

        if (message.type === 'assistant') {
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            if (statusMessageTs) {
              await this.safeUpdate(channel, statusMessageTs, '⚙️ *Working...*');
            }

            // Handle TodoWrite separately
            const todoTool = message.message.content?.find(
              (part: any) => part.type === 'tool_use' && part.name === 'TodoWrite',
            );
            if (todoTool) {
              await this.handleTodoUpdate((todoTool as any).input, sessionKey, session?.sessionId, channel, threadTs);
            }

            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) {
              await this.safePost(channel, threadTs, toolContent);
            }
          } else {
            const content = this.extractTextContent(message);
            if (content) {
              lastResult = content;
              await this.safePost(channel, threadTs, this.truncateForSlack(content));
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && finalResult !== lastResult) {
              lastResult = finalResult;
              await this.safePost(channel, threadTs, this.truncateForSlack(finalResult));
            }
          } else if (message.subtype === 'error_during_execution') {
            const errors: string[] = (message as any).errors || [];
            const errorMessage = errors.length > 0 ? errors.join('\n') : 'Claude encountered an error';
            await this.safePost(channel, threadTs, `❌ ${errorMessage}`);
          }
        }
      }

      if (statusMessageTs) {
        await this.safeUpdate(channel, statusMessageTs, '✅ *Task completed*');
      }

      return lastResult;
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error during streamed run', error);
        if (statusMessageTs) {
          await this.safeUpdate(channel, statusMessageTs, '❌ *Error occurred*');
        }
        await this.safePost(channel, threadTs, `Error: ${error.message || 'Something went wrong'}`);
      } else {
        if (statusMessageTs) {
          await this.safeUpdate(channel, statusMessageTs, '⏹️ *Cancelled*');
        }
      }
      return null;
    } finally {
      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
        }, 5 * 60 * 1000);
      }
    }
  }

  // --- Formatting helpers (mirrored from slack-handler.ts) ---

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        if (part.name === 'TodoWrite') continue;
        switch (part.name) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(part.name, part.input));
            break;
          case 'Write':
            parts.push(`📄 *Creating \`${part.input.file_path}\`*\n\`\`\`\n${this.truncateString(part.input.content, 300)}\n\`\`\``);
            break;
          case 'Read':
            parts.push(`👁️ *Reading \`${part.input.file_path}\`*`);
            break;
          case 'Bash':
            parts.push(`🖥️ *Running command:*\n\`\`\`bash\n${part.input.command}\n\`\`\``);
            break;
          default:
            parts.push(`🔧 *Using ${part.name}*`);
        }
      }
    }
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits =
      toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    let result = `📝 *Editing \`${filePath}\`*\n`;
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    return result;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private truncateForSlack(text: string): string {
    const MAX_LENGTH = 3900;
    if (text.length <= MAX_LENGTH) return text;
    return text.substring(0, MAX_LENGTH) + '\n...(truncated)';
  }

  private async handleTodoUpdate(
    input: any,
    sessionKey: string,
    sessionId: string | undefined,
    channel: string,
    threadTs: string,
  ): Promise<void> {
    if (!sessionId || !input.todos) return;
    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);

    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      this.todoManager.updateTodos(sessionId, newTodos);
      const todoList = this.todoManager.formatTodoList(newTodos);
      const existingTs = this.todoMessages.get(sessionKey);

      if (existingTs) {
        try {
          await this.app.client.chat.update({ channel, ts: existingTs, text: todoList });
        } catch {
          const result = await this.safePost(channel, threadTs, todoList);
          if (result) this.todoMessages.set(sessionKey, result);
        }
      } else {
        const result = await this.safePost(channel, threadTs, todoList);
        if (result) this.todoMessages.set(sessionKey, result);
      }

      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await this.safePost(channel, threadTs, `🔄 *Task Update:*\n${statusChange}`);
      }
    }
  }

  // --- Safe Slack API wrappers ---

  private async safePost(channel: string, threadTs: string, text: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
      });
      return result.ts ?? undefined;
    } catch (error) {
      this.logger.error('Failed to post message', error);
      return undefined;
    }
  }

  private async safeUpdate(channel: string, ts: string, text: string): Promise<void> {
    try {
      await this.app.client.chat.update({ channel, ts, text });
    } catch (error) {
      this.logger.error('Failed to update message', error);
    }
  }
}
