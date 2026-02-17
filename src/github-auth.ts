import * as crypto from 'crypto';
import { Logger } from './logger.js';

const logger = new Logger('GitHubAuth');

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

function base64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(
    Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })),
  );
  const signature = base64url(
    crypto.sign('sha256', Buffer.from(`${header}.${payload}`), privateKey),
  );
  return `${header}.${payload}.${signature}`;
}

async function fetchInstallationToken(jwt: string, installationId: string): Promise<string> {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get installation token: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  logger.info('Installation token acquired', { expiresAt: data.expires_at });
  return data.token;
}

export function startGitHubTokenRefresh(appConfig: GitHubAppConfig): NodeJS.Timeout | null {
  if (!appConfig.appId || !appConfig.privateKey || !appConfig.installationId) {
    logger.info('GitHub App credentials not configured, skipping token refresh');
    return null;
  }

  const refresh = async () => {
    try {
      const jwt = createJwt(appConfig.appId, appConfig.privateKey);
      const token = await fetchInstallationToken(jwt, appConfig.installationId);
      process.env.GH_TOKEN = token;
    } catch (error) {
      logger.error('Failed to refresh GitHub token', error);
    }
  };

  // Refresh immediately, then every 50 minutes (tokens expire after 1 hour)
  refresh();
  return setInterval(refresh, 50 * 60 * 1000);
}
