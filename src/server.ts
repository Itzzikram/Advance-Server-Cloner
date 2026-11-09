import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { DiscordCloner } from './core/cloner.js';
import { defaultClonerOptions, defaultRateLimitConfig } from './config/defaults.js';
import type { ClonerConfig, ClonerOptions, ProxyConfig } from './types/index.js';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS — allow the UI (which may be hosted separately, e.g. on Vercel) to call this API.
// Set ALLOWED_ORIGIN in the environment to lock this down to your Vercel domain.
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Static UI lives in <projectRoot>/public (one level up from dist/).
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

// ---------------------------------------------------------------------------
// Live log streaming (Server-Sent Events)
// ---------------------------------------------------------------------------
type LogEntry = { level: string; message: string; time: string };

const sseClients = new Set<express.Response>();
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*m/g;

function broadcast(entry: LogEntry): void {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// Capture the cloner's console output (Logger uses console.log / console.error)
// and forward a cleaned copy to every connected browser.
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);

function toText(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
    .join(' ')
    .replace(ANSI, '');
}

console.log = (...args: unknown[]) => {
  origLog(...args);
  const text = toText(args);
  broadcast({ level: /ERROR|WARN/i.test(text) ? 'warn' : 'info', message: text, time: new Date().toISOString() });
};
console.error = (...args: unknown[]) => {
  origErr(...args);
  broadcast({ level: 'error', message: toText(args), time: new Date().toISOString() });
};

app.get('/api/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ level: 'info', message: 'Connected to log stream.', time: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------------------------------------------------------------------------
// Clone endpoint
// ---------------------------------------------------------------------------
let cloneRunning = false;

function isValidToken(t: unknown): t is string {
  return typeof t === 'string' && t.trim().length >= 50;
}
function isValidSnowflake(id: unknown): id is string {
  return typeof id === 'string' && /^\d{17,20}$/.test(id.trim());
}

function parseProxy(raw: unknown): ProxyConfig | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const line = raw.trim();
  try {
    if (line.includes('://')) {
      const url = new URL(line);
      return {
        host: url.hostname,
        port: parseInt(url.port, 10),
        username: url.username || undefined,
        password: url.password || undefined,
        protocol: (url.protocol.replace(':', '') as 'http' | 'https') || 'http',
      };
    }
    const parts = line.split(':');
    if (parts.length < 2) return undefined;
    const proxy: ProxyConfig = { host: parts[0].trim(), port: parseInt(parts[1].trim(), 10), protocol: 'http' };
    if (parts.length >= 4) {
      proxy.username = parts[2].trim();
      proxy.password = parts[3].trim();
    }
    if (!proxy.host || isNaN(proxy.port)) return undefined;
    return proxy;
  } catch {
    return undefined;
  }
}

app.post('/api/clone', async (req, res): Promise<void> => {
  if (cloneRunning) {
    res.status(409).json({ success: false, error: 'A clone operation is already running. Please wait for it to finish.' });
    return;
  }

  const body = req.body ?? {};
  const { sourceToken, targetToken, sourceGuildId } = body;
  const targetGuildId: string | undefined =
    typeof body.targetGuildId === 'string' && body.targetGuildId.trim() !== '' ? body.targetGuildId.trim() : undefined;
  const mode: 'fromStart' | 'resume' = body.mode === 'resume' ? 'resume' : 'fromStart';

  if (!isValidToken(sourceToken)) { res.status(400).json({ success: false, error: 'SOURCE token looks invalid (expected 50+ characters).' }); return; }
  if (!isValidToken(targetToken)) { res.status(400).json({ success: false, error: 'TARGET token looks invalid (expected 50+ characters).' }); return; }
  if (!isValidSnowflake(sourceGuildId)) { res.status(400).json({ success: false, error: 'SOURCE guild ID must be 17-20 digits.' }); return; }
  if (targetGuildId && !isValidSnowflake(targetGuildId)) { res.status(400).json({ success: false, error: 'TARGET guild ID must be 17-20 digits (or empty to create a new server).' }); return; }

  const o = body.options ?? {};
  const options: ClonerOptions = {
    ...defaultClonerOptions,
    cloneChannels: o.cloneChannels !== false,
    cloneRoles: o.cloneRoles !== false,
    cloneRoleIcons: o.cloneRoleIcons !== false,
    cloneGuildSettings: o.cloneGuildSettings !== false,
    cloneEmojis: o.cloneEmojis !== false,
    cloneStickers: o.cloneStickers !== false,
  };

  const config: ClonerConfig = {
    sourceToken: sourceToken.trim(),
    targetToken: targetToken.trim(),
    proxy: parseProxy(body.proxy),
    options,
    rateLimit: { ...defaultRateLimitConfig },
  };

  // Respond immediately; progress is delivered through the SSE log stream.
  cloneRunning = true;
  res.json({ success: true, message: 'Clone started. Watch the live log for progress.' });

  const cloner = new DiscordCloner(config);
  try {
    await cloner.initialize();
    cloner.setOptions(options);
    const result = await cloner.cloneGuild(sourceGuildId.trim(), targetGuildId, mode);
    if (result.success) {
      broadcast({ level: 'success', message: `✅ Clone completed! Target Guild ID: ${result.data?.guildId ?? 'unknown'}`, time: new Date().toISOString() });
    } else {
      broadcast({ level: 'error', message: `❌ Clone failed: ${result.error ?? 'Unknown error'}`, time: new Date().toISOString() });
    }
  } catch (err) {
    broadcast({ level: 'error', message: `❌ Fatal error: ${(err as Error).message}`, time: new Date().toISOString() });
  } finally {
    try {
      await cloner.destroy();
    } catch {
      /* ignore cleanup errors */
    }
    cloneRunning = false;
    broadcast({ level: 'info', message: '— Session ended —', time: new Date().toISOString() });
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', running: cloneRunning }));

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  origLog(`\n🌐 Discord Cloner web UI running at http://localhost:${PORT}\n`);
});
