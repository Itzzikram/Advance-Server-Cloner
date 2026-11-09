import { config as loadEnv } from 'dotenv';
import { input, password, checkbox, confirm, select } from '@inquirer/prompts';
import ora from 'ora';
import { DiscordCloner } from './core/cloner.js';
import { Logger } from './utils/logger.js';
import { defaultClonerOptions, defaultRateLimitConfig } from './config/defaults.js';
import type { ClonerConfig, ClonerOptions, ProxyConfig } from './types/index.js';

/**
 * Interactive, terminal-driven entry point.
 *
 * Everything the cloner needs (tokens, guild IDs, proxy, and which parts to
 * clone) is asked for right here in the terminal. No .env file is required.
 */

// Load .env (optional) so a rotating PROXY_LIST can be picked up automatically.
loadEnv();

const MIN_TOKEN_LENGTH = 50;

interface CloneChoice {
  name: string;
  value: keyof ClonerOptions;
}

// The six selectable clone actions, in the order requested. All checked by default.
const CLONE_CHOICES: CloneChoice[] = [
  { name: '1. Channels (text, voice, categories, forums) with settings', value: 'cloneChannels' },
  { name: '2. Server roles with permissions', value: 'cloneRoles' },
  { name: '3. Role icons (only if the server is boosted / supports role icons)', value: 'cloneRoleIcons' },
  { name: '4. Server settings (name, icon, verification level, etc.)', value: 'cloneGuildSettings' },
  { name: '5. All emojis', value: 'cloneEmojis' },
  { name: '6. All stickers', value: 'cloneStickers' },
];

function isValidToken(token: string): boolean {
  return typeof token === 'string' && token.trim().length >= MIN_TOKEN_LENGTH;
}

function isValidSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id.trim());
}

function parseProxy(raw: string): ProxyConfig | undefined {
  const line = raw.trim();
  if (!line) return undefined;

  // Accept either host:port:user:pass or a full URL like http://user:pass@host:port
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
    const proxy: ProxyConfig = {
      host: parts[0].trim(),
      port: parseInt(parts[1].trim(), 10),
      protocol: 'http',
    };
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

/** Parse a PROXY_LIST/PROXIES string (newline, comma, or semicolon separated) into proxies. */
function parseProxyList(raw: string): ProxyConfig[] {
  return raw
    .split(/[\n,;]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseProxy)
    .filter((p): p is ProxyConfig => p !== undefined);
}

/** Read a rotating proxy list from the environment (.env), if present. */
function getEnvProxies(): ProxyConfig[] {
  const raw = process.env.PROXY_LIST || process.env.PROXIES;
  return raw ? parseProxyList(raw) : [];
}

function printBanner(): void {
  console.log('');
  console.log('==============================================');
  console.log('       Discord Advanced Cloner (Terminal)');
  console.log('==============================================');
  console.log('');
  console.log('⚠️  Using selfbots / user tokens violates Discord\'s Terms of Service.');
  console.log('   Only clone servers you own or have permission to clone. Use at your own risk.');
  console.log('');
}

/** Ask which parts to clone and how to run (Resume/From start). Repeatable per operation. */
async function gatherRunOptions(hasTarget: boolean): Promise<{ options: ClonerOptions; runMode: 'fromStart' | 'resume' }> {
  // Ask Resume vs From start FIRST — only meaningful when cloning into an existing server.
  let runMode: 'fromStart' | 'resume' = 'fromStart';
  if (hasTarget) {
    runMode = await select<'fromStart' | 'resume'>({
      message: 'How do you want to run this?',
      choices: [
        { name: 'From start (delete existing content, then clone fresh)', value: 'fromStart' },
        { name: 'Resume (keep existing, scan for what is missing and add only that)', value: 'resume' },
      ],
      default: 'fromStart',
    });
  }

  const mode = await select<'all' | 'custom'>({
    message: 'What do you want to clone?',
    choices: [
      { name: 'ALL of the above (channels, roles, role icons, server settings, emojis, stickers)', value: 'all' },
      { name: 'Let me choose specific options', value: 'custom' },
    ],
    default: 'all',
  });

  let selected: (keyof ClonerOptions)[];
  if (mode === 'all') {
    selected = CLONE_CHOICES.map((c) => c.value);
  } else {
    selected = await checkbox<keyof ClonerOptions>({
      message: 'Select what to clone (↑↓ move, SPACE to toggle, ENTER to confirm):',
      choices: CLONE_CHOICES.map((c) => ({ name: c.name, value: c.value, checked: false })),
      validate: (choices) => (choices.length > 0 ? true : 'Select at least one option (or restart and pick "ALL of the above").'),
    });
  }

  const options: ClonerOptions = {
    ...defaultClonerOptions,
    cloneChannels: selected.includes('cloneChannels'),
    cloneRoles: selected.includes('cloneRoles'),
    cloneRoleIcons: selected.includes('cloneRoleIcons'),
    cloneGuildSettings: selected.includes('cloneGuildSettings'),
    cloneEmojis: selected.includes('cloneEmojis'),
    cloneStickers: selected.includes('cloneStickers'),
  };

  return { options, runMode };
}

async function gatherConfig(): Promise<{
  config: ClonerConfig;
  sourceGuildId: string;
  targetGuildId?: string;
}> {
  const sourceToken = await password({
    message: 'Enter the SOURCE user account token:',
    mask: '*',
    validate: (v) => (isValidToken(v) ? true : `Token looks too short (expected ${MIN_TOKEN_LENGTH}+ characters).`),
  });

  const targetToken = await password({
    message: 'Enter the TARGET user account token:',
    mask: '*',
    validate: (v) => (isValidToken(v) ? true : `Token looks too short (expected ${MIN_TOKEN_LENGTH}+ characters).`),
  });

  const sourceGuildId = await input({
    message: 'Enter the SOURCE guild (server) ID to clone from:',
    validate: (v) => (isValidSnowflake(v) ? true : 'Enter a valid guild ID (17-20 digits).'),
  });

  const targetGuildIdRaw = await input({
    message: 'Enter the TARGET guild ID to clone into (leave empty to create a NEW server):',
    validate: (v) => (v.trim() === '' || isValidSnowflake(v) ? true : 'Enter a valid guild ID (17-20 digits) or leave empty.'),
  });
  const targetGuildId = targetGuildIdRaw.trim() === '' ? undefined : targetGuildIdRaw.trim();

  // Optional proxy — prefer a rotating PROXY_LIST from .env if one is present.
  let proxy: ProxyConfig | undefined;
  let proxies: ProxyConfig[] | undefined;
  const envProxies = getEnvProxies();

  if (envProxies.length > 0) {
    const useEnv = await confirm({
      message: `Found ${envProxies.length} proxies in .env (PROXY_LIST). Use them (rotating)?`,
      default: true,
    });
    if (useEnv) {
      proxies = envProxies;
    }
  }

  if (!proxies) {
    const useProxy = await confirm({ message: 'Use a proxy?', default: false });
    if (useProxy) {
      const proxyRaw = await input({
        message: 'Enter proxy (host:port:user:pass or http://user:pass@host:port). Multiple allowed, comma-separated:',
      });
      const parsed = parseProxyList(proxyRaw);
      if (parsed.length === 0) {
        Logger.warning('Could not parse proxy input — continuing without a proxy.');
      } else if (parsed.length === 1) {
        proxy = parsed[0];
      } else {
        proxies = parsed;
      }
    }
  }

  const config: ClonerConfig = {
    sourceToken: sourceToken.trim(),
    targetToken: targetToken.trim(),
    proxy,
    proxies,
    options: { ...defaultClonerOptions },
    rateLimit: { ...defaultRateLimitConfig },
  };

  return { config, sourceGuildId: sourceGuildId.trim(), targetGuildId };
}

async function main(): Promise<void> {
  printBanner();

  // Connection details (tokens, guild IDs, proxy) are asked once and reused.
  const { config, sourceGuildId, targetGuildId } = await gatherConfig();

  const spinner = ora('Initializing Discord Cloner...').start();
  const cloner = new DiscordCloner(config);

  try {
    await cloner.initialize();
    spinner.succeed('Cloner initialized and logged in');

    // Run operations in a loop so the user can keep going without re-logging in.
    let operation = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      Logger.info(`─── Operation #${operation} ───`);

      const { options, runMode } = await gatherRunOptions(Boolean(targetGuildId));
      cloner.setOptions(options);

      const enabled = Object.entries(options)
        .filter(([, v]) => v === true)
        .map(([k]) => k);
      Logger.info(`Selected steps: ${enabled.join(', ') || 'none'}`);

      if (targetGuildId) {
        Logger.info(`Cloning from ${sourceGuildId} into existing guild ${targetGuildId} (${runMode})`);
      } else {
        Logger.info(`Cloning from ${sourceGuildId} into a NEW guild`);
      }

      try {
        const result = await cloner.cloneGuild(sourceGuildId, targetGuildId, runMode);
        if (result.success) {
          Logger.success(`Operation #${operation} completed! Target Guild ID: ${result.data?.guildId}`);
        } else {
          Logger.error(result.error || 'Unknown error during clone');
        }
      } catch (opError) {
        // Don't crash the whole session if one operation fails — let the user retry.
        Logger.error(`Operation #${operation} failed:`, opError as Error);
      }

      const again = await confirm({
        message: 'Run another operation on the same servers?',
        default: false,
      });
      if (!again) break;
      operation++;
    }
  } catch (error) {
    spinner.fail('Cloner failed');
    Logger.error('Fatal error:', error as Error);
    process.exitCode = 1;
  } finally {
    await cloner.destroy();
  }
}

process.on('unhandledRejection', (error) => {
  Logger.error('Unhandled rejection:', error as Error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  Logger.error('Uncaught exception:', error as Error);
  process.exit(1);
});

main().catch((error) => {
  // Gracefully handle Ctrl+C / prompt cancellation from @inquirer/prompts
  if (error && (error as Error).name === 'ExitPromptError') {
    Logger.warning('Cancelled by user. Exiting.');
    process.exit(0);
  }
  Logger.error('Main function error:', error as Error);
  process.exit(1);
});
