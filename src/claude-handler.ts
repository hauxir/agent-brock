import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { ConversationSession } from './types.js';
import { ContentBlock } from './file-handler.js';
import { Logger } from './logger.js';
import { McpManager } from './mcp-manager.js';

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string | ContentBlock[],
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
    };

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;

      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }

      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(mcpServers).length,
        servers: Object.keys(mcpServers),
        allowedTools: defaultMcpTools,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    options.abortController = abortController || new AbortController();

    // Build the prompt: either a plain string or an async iterable with content blocks
    let queryPrompt: string | AsyncIterable<SDKUserMessage>;

    if (typeof prompt === 'string') {
      queryPrompt = prompt;
    } else {
      // Structured content blocks (e.g. with inline images) - use AsyncIterable format
      const sessionId = session?.sessionId || randomUUID();
      const contentBlocks = prompt;
      queryPrompt = (async function* () {
        yield {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: contentBlocks as any,
          },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      })();
    }

    try {
      for await (const message of query({
        prompt: queryPrompt,
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.logger.info('Session initialized', { 
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}