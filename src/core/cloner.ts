import {
  Client,
  Intents,
  Guild,
  Channel,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
} from 'discord.js-selfbot-v13';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type {
  ClonerConfig,
  CloneResult,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import { ProxyManager } from '../utils/proxy.js';
import axios, { AxiosInstance } from 'axios';

// Constants
const CHANNEL_TYPES = {
  GUILD_TEXT: 0,
  GUILD_VOICE: 2,
  GUILD_CATEGORY: 4,
  GUILD_NEWS: 5,
  GUILD_FORUM: 15,
} as const;

const EMOJI_UPLOAD_RETRIES = 3;
const EMOJI_DOWNLOAD_TIMEOUT = 30000;

// Per-guild capacity by boost/premium tier (index 0..3).
// Emoji limit applies SEPARATELY to static and animated emojis.
const EMOJI_LIMIT_BY_TIER = [50, 100, 150, 250];
const STICKER_LIMIT_BY_TIER = [5, 15, 30, 60];

// How many downloads/uploads to run at once (keeps us under CDN/API rate limits).
const MEDIA_BATCH_SIZE = 5;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class DiscordCloner {
  private sourceClient: Client;
  private targetClient: Client;
  private sourceREST: REST;
  private targetREST: REST;
  private config: ClonerConfig;
  private rateLimiter: RateLimiter;
  private proxyManager: ProxyManager;
  private axiosInstance: AxiosInstance;

  // Once the target guild rejects an upload for hitting its capacity, stop that step.
  private emojiLimitReached = false;
  private stickerLimitReached = false;

  constructor(config: ClonerConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(config.rateLimit);
    
    // Initialize proxy manager with multiple proxies if available, otherwise single proxy
    // Rotate proxy every 5 clones
    const proxyConfig = config.proxies && config.proxies.length > 0 
      ? config.proxies 
      : config.proxy;
    this.proxyManager = new ProxyManager(proxyConfig, 5);

    // Initialize clients with shared intents
    const intents = [
      Intents.FLAGS.GUILDS,
      Intents.FLAGS.GUILD_MEMBERS,
      Intents.FLAGS.GUILD_MESSAGES,
      Intents.FLAGS.GUILD_VOICE_STATES,
    ] as any;

    this.sourceClient = new Client({ intents } as any);
    this.targetClient = new Client({ intents } as any);

    // Initialize REST clients
    this.sourceREST = new REST({ version: '10' }).setToken(config.sourceToken);
    this.targetREST = new REST({ version: '10' }).setToken(config.targetToken);

    // Initialize axios for CDN downloads
    this.axiosInstance = axios.create({
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://discord.com/',
      },
      maxRedirects: 5,
      timeout: EMOJI_DOWNLOAD_TIMEOUT,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    // Note: Proxy rotation will be handled per-request in downloadEmoji method
    // Setting a default proxy for initial requests
    if (this.proxyManager.isEnabled()) {
      const proxyConfig = this.proxyManager.getProxyAgent();
      if (proxyConfig) {
        this.axiosInstance.defaults.proxy = {
          host: proxyConfig.host,
          port: proxyConfig.port,
          protocol: proxyConfig.protocol,
          auth: proxyConfig.auth,
        };
      }
    }
  }

  async initialize(): Promise<void> {
    Logger.info('Initializing Discord clients...');
    
    try {
      await Promise.all([
        this.loginClient(this.sourceClient, this.config.sourceToken, 'Source'),
        this.loginClient(this.targetClient, this.config.targetToken, 'Target'),
      ]);
      Logger.success('Both clients logged in successfully');
    } catch (error) {
      Logger.error('Failed to initialize clients:', error as Error);
      throw error;
    }
  }

  private async loginClient(client: Client, token: string, label: string): Promise<void> {
    try {
      Logger.info(`Attempting to login ${label.toLowerCase()} client...`);
      Logger.debug(`Token length: ${token.length} characters`);
      await client.login(token);
      Logger.success(`${label} client logged in successfully`);
    } catch (error) {
      const err = error as Error;
      Logger.error(`${label} client login failed`);
      Logger.error(`Error details: ${err.message}`);
      
      if (err.message.includes('TokenInvalid') || err.message.includes('invalid token')) {
        const tokenPreview = `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
        const tokenLength = token.length;
        const isLikelyBotToken = token.match(/^[MN][A-Za-z\d]{23}\.[A-Za-z\d-_]{6}\.[A-Za-z\d-_]{27}$/);
        const additionalInfo = isLikelyBotToken 
          ? '\n  ⚠️  WARNING: Your token appears to be a BOT TOKEN format. You need a USER ACCOUNT TOKEN instead.'
          : '';
        
        throw new Error(
          `${label.toUpperCase()}_TOKEN authentication failed.\n\n` +
          '⚠️  IMPORTANT: discord.js v12+ does NOT support user account tokens (selfbot tokens).\n' +
          'The library removed support for user tokens to comply with Discord\'s Terms of Service.\n\n' +
          'Possible solutions:\n' +
          '  1. Use discord.js-selfbot-v13 or similar fork that supports user tokens\n' +
          '  2. Use discord.js v11 or earlier (not recommended, outdated)\n' +
          '  3. Use REST API directly instead of WebSocket connection\n' +
          '  4. Switch to bot tokens if possible for your use case\n\n' +
          'Token verification:\n' +
          `  - Token preview: ${tokenPreview}\n` +
          `  - Token length: ${tokenLength} characters${additionalInfo}\n` +
          '  - Token format appears valid, but discord.js cannot authenticate user tokens\n\n' +
          'Note: Using selfbots violates Discord\'s Terms of Service and may result in account bans.'
        );
      }
      throw new Error(`${label} client login failed: ${err.message}`);
    }
  }

  /**
   * Canary test method — verifies that the source & target clients,
   * tokens, REST APIs, and basic cloning operations are functional.
   * 
   * This prevents full clone runs from failing midway.
   */
  async canary(): Promise<void> {
    Logger.info('🐤 Running canary diagnostic check...');

    try {
      // Validate tokens
      Logger.info('🔑 Validating tokens...');
      const [testSource, testTarget] = await Promise.all([
        this.sourceREST.get(Routes.user('@me')).catch(() => null),
        this.targetREST.get(Routes.user('@me')).catch(() => null),
      ]);

      if (!testSource || !testTarget) {
        throw new Error('Invalid source or target token detected.');
      }

      Logger.success(`✅ Source token valid: ${(testSource as any).username}#${(testSource as any).discriminator}`);
      Logger.success(`✅ Target token valid: ${(testTarget as any).username}#${(testTarget as any).discriminator}`);

      // Check network + proxy
      Logger.info('🌐 Testing network and proxy connectivity...');
      const networkCheck = await this.axiosInstance.get('https://discord.com/api/v10/gateway', { timeout: 10000 });
      if (!networkCheck.data?.url) {
        throw new Error('Discord API Gateway check failed.');
      }
      Logger.success('✅ Discord API Gateway reachable.');

      // Check rate limiter
      Logger.info('⏳ Testing rate limiter execution...');
      await this.rateLimiter.execute(async () => {
        await new Promise(res => setTimeout(res, 500));
      });
      Logger.success('✅ Rate limiter operational.');

      // Verify emoji upload permissions
      Logger.info('🧩 Testing emoji upload permission on target guild...');
      const guild = this.targetClient.guilds.cache.first();
      if (!guild) {
        Logger.warning('⚠️ No guilds found on target client to test emoji upload.');
      } else {
        try {
          const dummy = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NgYGD4DwABAgEA1mzpVwAAAABJRU5ErkJggg==', 'base64');
          const dummyUri = `data:image/png;base64,${dummy.toString('base64')}`;
          await this.targetREST.post(Routes.guildEmojis(guild.id), {
            body: { name: `canary_test_${Date.now()}`, image: dummyUri },
          });
          Logger.success(`✅ Emoji upload permissions OK on guild: ${guild.name}`);
        } catch (err: any) {
          const msg = err?.message || String(err);
          Logger.error(`❌ Emoji upload test failed: ${msg}`);
          if (msg.includes('403') || msg.includes('permission')) {
            Logger.warning('→ Missing "Manage Emojis and Stickers" permission.');
          } else if (msg.includes('limit')) {
            Logger.warning('→ Guild may have reached emoji limit.');
          }
        }
      }

      // Confirm both clients are logged in
      if (!this.sourceClient.user || !this.targetClient.user) {
        Logger.warning('⚠️ One or both clients are not logged in properly.');
      } else {
        Logger.success(`✅ Source logged in as ${this.sourceClient.user.tag}`);
        Logger.success(`✅ Target logged in as ${this.targetClient.user.tag}`);
      }

      Logger.success('🎉 Canary diagnostic completed successfully! All systems operational.');
    } catch (err: any) {
      Logger.error('❌ Canary diagnostic failed.');
      Logger.error(`Reason: ${err.message}`);
      Logger.warning('→ Fix the above issues before running cloneGuild().');
    }
  }

  async cloneGuild(
    sourceGuildId: string,
    targetGuildId?: string,
    mode: 'fromStart' | 'resume' = 'fromStart'
  ): Promise<CloneResult> {
    try {
      Logger.info(`Starting guild clone: ${sourceGuildId} (mode: ${mode})`);

      // Reset per-run limit flags so a fresh operation isn't blocked by a previous one.
      this.emojiLimitReached = false;
      this.stickerLimitReached = false;
      
      const sourceGuild = this.sourceClient.guilds.cache.get(sourceGuildId);
      if (!sourceGuild) {
        throw new Error('Source guild not found');
      }

      let targetGuild: Guild;
      if (targetGuildId) {
        targetGuild = this.targetClient.guilds.cache.get(targetGuildId)!;
        if (!targetGuild) {
          throw new Error('Target guild not found');
        }

        if (mode === 'resume') {
          // Resume: never delete. Every clone step skips items that already exist,
          // and the reconcile scanners add whatever is missing.
          Logger.info('▶️  Resume mode: keeping existing content, only adding what is missing.');
        } else {
          Logger.info('Deleting existing content from target guild...');
          await this.deleteAllContent(targetGuild);
        }

        // Apply guild settings to the existing target guild (non-destructive)
        if (this.config.options.cloneGuildSettings) {
          await this.applyGuildSettings(sourceGuild, targetGuild);
        }
      } else {
        // A new guild always needs at least a name; extended settings are gated
        targetGuild = await this.createGuild(sourceGuild);
      }

      const results: CloneResult[] = [];
      let roleMap = new Map<string, string>();

      // Clone roles (and role icons, handled inside)
      if (this.config.options.cloneRoles) {
        const roleResult = await this.cloneRoles(sourceGuild, targetGuild);
        results.push(roleResult);
        if (roleResult.success && roleResult.data && 'roleMap' in roleResult.data) {
          roleMap = roleResult.data.roleMap as Map<string, string>;
        }
        // Verify + repair: re-add any roles that failed the first time
        await this.reconcileRoles(sourceGuild, targetGuild, roleMap);
      }

      // Clone channels
      if (this.config.options.cloneChannels) {
        const channelResult = await this.cloneChannels(sourceGuild, targetGuild, roleMap);
        results.push(channelResult);
        const channelMap = (channelResult.data?.channelMap as Map<string, string>) || new Map<string, string>();
        // Verify + repair: re-add any channels that failed the first time (e.g. bitrate errors)
        await this.reconcileChannels(sourceGuild, targetGuild, channelMap);
      }

      // Clone emojis
      if (this.config.options.cloneEmojis) {
        const emojiResult = await this.cloneEmojis(sourceGuild, targetGuild);
        results.push(emojiResult);
        await this.reconcileEmojis(sourceGuild, targetGuild);
      }

      // Clone stickers
      if (this.config.options.cloneStickers) {
        const stickerResult = await this.cloneStickers(sourceGuild, targetGuild);
        results.push(stickerResult);
        await this.reconcileStickers(sourceGuild, targetGuild);
      }

      Logger.success(`Guild clone completed: ${targetGuild.name}`);
      return {
        success: true,
        item: 'Guild',
        data: { guildId: targetGuild.id, results },
      };
    } catch (error) {
      Logger.error('Failed to clone guild:', error as Error);
      return {
        success: false,
        item: 'Guild',
        error: (error as Error).message,
      };
    }
  }

  private async createGuild(sourceGuild: Guild): Promise<Guild> {
    const applySettings = this.config.options.cloneGuildSettings;
    const guildName = applySettings ? sourceGuild.name : 'New Server';

    // Create the guild via a direct API call using the raw user token.
    // The selfbot library's guilds.create() uses a hardcoded template and extra fields
    // that trigger a misleading "Unknown Message" error, so we bypass it.
    let guildId: string;
    try {
      const resp = await this.rateLimiter.execute(async () =>
        axios.post(
          'https://discord.com/api/v10/guilds',
          { name: guildName },
          {
            headers: {
              'Authorization': this.config.targetToken,
              'Content-Type': 'application/json',
              'User-Agent': DEFAULT_USER_AGENT,
            },
            timeout: EMOJI_DOWNLOAD_TIMEOUT,
          }
        )
      );
      guildId = (resp.data as any)?.id;
      if (!guildId) throw new Error('API did not return a guild id');
    } catch (error: any) {
      const apiMsg = error?.response?.data?.message || error?.message || String(error);
      const status = error?.response?.status;
      Logger.error(`Failed to create new guild: ${apiMsg}${status ? ` (HTTP ${status})` : ''}`);
      Logger.warning('  → User accounts can normally only create servers while in fewer than ~10 servers,');
      Logger.warning('    and some accounts are blocked from creating servers entirely.');
      Logger.warning('  → Reliable alternative: create an empty server yourself in Discord, then run again');
      Logger.warning('    and paste that server\'s ID into the "target guild ID" prompt.');
      throw new Error(`Could not create a new guild: ${apiMsg}`);
    }

    // Resolve the discord.js Guild object for the freshly created guild
    const guild = await this.resolveTargetGuild(guildId);
    Logger.success(`Created new guild: ${guild.name} (${guild.id})`);

    if (applySettings) {
      // Non-fatal: if settings fail, the guild still exists and the rest of the clone continues.
      try {
        await this.applyGuildSettings(sourceGuild, guild);
      } catch (error) {
        Logger.warning(`Could not fully apply guild settings: ${(error as Error).message}`);
      }
    }

    return guild;
  }

  /**
   * Resolve a Guild object on the target client after creation.
   * The WebSocket client usually receives GUILD_CREATE shortly after, so we poll the
   * cache briefly and fall back to a REST-style fetch.
   */
  private async resolveTargetGuild(guildId: string): Promise<Guild> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const cached = this.targetClient.guilds.cache.get(guildId);
      if (cached) return cached;
      await new Promise((res) => setTimeout(res, 300));
    }

    try {
      const fetched = await this.targetClient.guilds.fetch(guildId);
      if (fetched) return fetched as unknown as Guild;
    } catch {
      // ignore and fall through
    }

    throw new Error(`Guild ${guildId} was created but could not be resolved on the client`);
  }

  /**
   * Apply guild-level settings from the source guild onto a target guild.
   * Used both for freshly created guilds and existing target guilds.
   */
  private async applyGuildSettings(sourceGuild: Guild, targetGuild: Guild): Promise<void> {
    Logger.info('Applying guild settings...');

    const settings: Array<{ method: () => Promise<any>; name: string }> = [
      { method: () => targetGuild.setName(sourceGuild.name), name: 'name' },
      { method: () => targetGuild.setVerificationLevel(sourceGuild.verificationLevel), name: 'verification level' },
      { method: () => targetGuild.setDefaultMessageNotifications(sourceGuild.defaultMessageNotifications), name: 'default message notifications' },
      { method: () => targetGuild.setExplicitContentFilter(sourceGuild.explicitContentFilter), name: 'explicit content filter' },
    ];

    // Icon (only if the source has one) — download to a buffer for reliability
    const iconUrl = sourceGuild.iconURL({ format: 'png', size: 1024 } as any) || sourceGuild.iconURL();
    if (iconUrl) {
      settings.push({
        method: async () => {
          const iconBuffer = await this.downloadEmoji(iconUrl, 'guild-icon');
          await targetGuild.setIcon(iconBuffer as any);
        },
        name: 'icon',
      });
    }

    await Promise.allSettled(
      settings.map(async ({ method, name }) => {
        try {
          await this.rateLimiter.execute(() => method());
          Logger.debug(`Set guild ${name}`);
        } catch (e) {
          Logger.warning(`Could not set guild ${name}: ${(e as Error).message}`);
        }
      })
    );

    Logger.success('Guild settings applied');
  }

  private async deleteAllContent(targetGuild: Guild): Promise<void> {
    try {
      const tasks: Promise<void>[] = [];
      const opts = this.config.options;

      // Only delete the content types the user chose to clone.
      if (opts.cloneChannels) tasks.push(this.deleteChannels(targetGuild));
      if (opts.cloneEmojis) tasks.push(this.deleteEmojis(targetGuild));
      if (opts.cloneStickers) tasks.push(this.deleteStickers(targetGuild));
      if (opts.cloneRoles) tasks.push(this.deleteRoles(targetGuild));

      if (tasks.length === 0) {
        Logger.info('No content types selected for deletion — skipping cleanup.');
        return;
      }

      await Promise.all(tasks);
      Logger.success('Existing content for selected types deleted');
    } catch (error) {
      Logger.error('Error deleting content:', error as Error);
      throw error;
    }
  }

  private async deleteStickers(targetGuild: Guild): Promise<void> {
    Logger.info('Deleting all stickers...');
    try {
      await targetGuild.stickers.fetch();
    } catch {
      // ignore fetch errors
    }
    const stickers = Array.from(targetGuild.stickers.cache.values());

    await Promise.allSettled(
      stickers.map(async (sticker: any) => {
        try {
          await this.rateLimiter.execute(() => sticker.delete());
          Logger.debug(`Deleted sticker: ${sticker.name}`);
        } catch (error) {
          Logger.warning(`Failed to delete sticker ${sticker.id}: ${(error as Error).message}`);
        }
      })
    );
  }

  private async deleteChannels(targetGuild: Guild): Promise<void> {
    Logger.info('Deleting all channels...');
    const channels = Array.from(targetGuild.channels.cache.values());
    
    await Promise.allSettled(
      channels.map(async (channel) => {
        if (channel.id === targetGuild.id || typeof channel.delete !== 'function') {
          return;
        }
        try {
          await this.rateLimiter.execute(async () => {
            await channel.delete();
          });
          const channelName = 'name' in channel ? channel.name : 'Unknown';
          Logger.debug(`Deleted channel: ${channelName} (${channel.id})`);
        } catch (error) {
          Logger.warning(`Failed to delete channel ${channel.id}: ${(error as Error).message}`);
        }
      })
    );
  }

  private async deleteEmojis(targetGuild: Guild): Promise<void> {
    Logger.info('Deleting all emojis...');
    const emojis = Array.from(targetGuild.emojis.cache.values());
    
    await Promise.allSettled(
      emojis.map(async (emoji) => {
        try {
          await this.rateLimiter.execute(() => emoji.delete());
          Logger.debug(`Deleted emoji: ${emoji.name}`);
        } catch (error) {
          Logger.warning(`Failed to delete emoji ${emoji.id}: ${(error as Error).message}`);
        }
      })
    );
  }

  private async deleteRoles(targetGuild: Guild): Promise<void> {
    Logger.info('Deleting all roles...');
    await targetGuild.roles.fetch();
    
    const roles = Array.from(targetGuild.roles.cache.values())
      .filter(role => role.id !== targetGuild.id && !role.managed)
      .sort((a, b) => b.position - a.position);
    
    Logger.info(`Found ${roles.length} roles to delete`);
    
    let deletedCount = 0;
    let failedCount = 0;
    
    for (const role of roles) {
      try {
        await this.rateLimiter.execute(() => role.delete('Clearing roles before cloning'));
        deletedCount++;
        Logger.info(`✓ Deleted role: ${role.name} (position: ${role.position})`);
      } catch (error) {
        failedCount++;
        const errorMsg = (error as Error).message;
        Logger.warning(`✗ Failed to delete role "${role.name}" (${role.id}): ${errorMsg}`);
        
        if (errorMsg.includes('permission') || errorMsg.includes('Missing')) {
          Logger.warning(`  → This role may require higher permissions or cannot be deleted`);
        }
      }
    }
    
    if (deletedCount > 0) {
      Logger.success(`Successfully deleted ${deletedCount} roles`);
    }
    if (failedCount > 0) {
      Logger.warning(`${failedCount} roles could not be deleted (may require higher permissions)`);
    }
  }

  private async cloneRoles(
    sourceGuild: Guild,
    targetGuild: Guild
  ): Promise<CloneResult> {
    try {
      Logger.info('Cloning roles...');
      await Promise.all([
        sourceGuild.roles.fetch(),
        targetGuild.roles.fetch(),
      ]);

      // Names already present in the target — these will be skipped.
      const existingRoleNames = new Set(
        Array.from(targetGuild.roles.cache.values())
          .filter((role) => role.id !== targetGuild.id)
          .map((role) => role.name)
      );

      const allSourceRoles = Array.from(sourceGuild.roles.cache.values())
        .filter((role) => !role.managed && role.id !== sourceGuild.id)
        .sort((a, b) => b.position - a.position);

      const skippedRoles = allSourceRoles.filter((role) => existingRoleNames.has(role.name));
      const sourceRoles = allSourceRoles.filter((role) => !existingRoleNames.has(role.name));

      if (skippedRoles.length > 0) {
        Logger.info(`Skipping ${skippedRoles.length} role(s) that already exist in the target`);
      }
      Logger.info(`Found ${sourceRoles.length} roles to clone`);
      
      const roleMap = new Map<string, string>();
      const results: CloneResult[] = [];

      // Clone all roles in parallel for maximum speed
      const rolePromises = sourceRoles.map(async (sourceRole) => {
        try {
          Logger.info(`Cloning role: ${sourceRole.name} (position: ${sourceRole.position})`);
          
          const targetRole = await this.rateLimiter.execute(async () => {
            const roleOptions: any = {
              name: sourceRole.name,
              color: sourceRole.color,
              hoist: sourceRole.hoist || false,
              mentionable: sourceRole.mentionable || false,
            };
            
            if (sourceRole.permissions) {
              roleOptions.permissions = sourceRole.permissions;
            }
            
            const createdRole = await targetGuild.roles.create(roleOptions);
            
            // Try to set position separately
            if (sourceRole.position > 0) {
              try {
                await createdRole.setPosition(sourceRole.position, { reason: 'Cloning role position' });
              } catch (posError) {
                Logger.warning(`Could not set position for role ${sourceRole.name}: ${(posError as Error).message}`);
              }
            }

            // Clone role icon if enabled and supported by the target guild (requires boost / ROLE_ICONS feature)
            if (this.config.options.cloneRoleIcons) {
              await this.cloneRoleIcon(sourceRole, createdRole, targetGuild);
            }
            
            return createdRole;
          });

          const result: CloneResult = {
            success: true,
            item: `Role: ${sourceRole.name}`,
            data: { sourceId: sourceRole.id, targetId: targetRole.id },
          };
          Logger.success(`✓ Cloned role: ${sourceRole.name}`);
          
          // Increment clone count and rotate proxy if needed (every 5 clones)
          this.proxyManager.incrementCloneCount();
          
          return result;
        } catch (error) {
          const errorMsg = (error as Error).message;
          const result: CloneResult = {
            success: false,
            item: `Role: ${sourceRole.name}`,
            error: errorMsg,
          };
          Logger.error(`✗ Failed to clone role ${sourceRole.name}: ${errorMsg}`);
          this.logRoleError(errorMsg, sourceRole.position);
          return result;
        }
      });

      // Wait for all roles to be cloned in parallel
      const roleResults = await Promise.allSettled(rolePromises);
      for (const result of roleResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
          // Update roleMap from successful results
          if (result.value.success && result.value.data) {
            roleMap.set(result.value.data.sourceId, result.value.data.targetId);
          }
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;
      
      Logger.success(`Cloned ${successCount} roles`);
      if (failCount > 0) {
        Logger.warning(`${failCount} roles failed to clone`);
      }
      
      return {
        success: true,
        item: 'Roles',
        data: { roleMap, results },
      };
    } catch (error) {
      Logger.error(`Role cloning failed: ${(error as Error).message}`);
      return {
        success: false,
        item: 'Roles',
        error: (error as Error).message,
      };
    }
  }

  private logRoleError(errorMsg: string, position: number): void {
    if (errorMsg.includes('permission') || errorMsg.includes('Missing') || errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
      Logger.warning(`  → PERMISSION ERROR: Missing MANAGE_ROLES permission`);
      Logger.warning(`  → Solution: Grant "Manage Roles" permission to your role`);
      Logger.warning(`  → Also ensure your role is higher than the role you're trying to create`);
    }
    if (errorMsg.includes('position') || errorMsg.includes('hierarchy')) {
      Logger.warning(`  → POSITION ERROR: Your role position (${position}) is too low`);
      Logger.warning(`  → Solution: Make sure your role is higher than the roles you want to create`);
    }
  }

  /**
   * Copies a role's icon (custom image or unicode emoji) onto the cloned role.
   * Role icons require the guild to be boosted enough to unlock the ROLE_ICONS feature.
   */
  private async cloneRoleIcon(sourceRole: any, targetRole: any, targetGuild: Guild): Promise<void> {
    // Only attempt if the target guild supports role icons
    const features = (targetGuild.features as unknown as string[]) || [];
    if (!features.includes('ROLE_ICONS')) {
      return;
    }

    const unicodeEmoji: string | null = sourceRole.unicodeEmoji ?? null;
    const iconUrl: string | null = typeof sourceRole.iconURL === 'function' ? sourceRole.iconURL() : null;

    if (!unicodeEmoji && !iconUrl) {
      return; // Nothing to copy
    }

    try {
      await this.rateLimiter.execute(async () => {
        if (iconUrl) {
          const imageBuffer = await this.downloadEmoji(iconUrl, `role-icon-${sourceRole.name}`);
          await targetRole.setIcon(imageBuffer, 'Cloning role icon');
        } else if (unicodeEmoji) {
          await targetRole.setUnicodeEmoji(unicodeEmoji, 'Cloning role unicode emoji');
        }
      });
      Logger.success(`  ✓ Cloned icon for role: ${sourceRole.name}`);
    } catch (iconError) {
      Logger.warning(`  → Could not clone icon for role ${sourceRole.name}: ${(iconError as Error).message}`);
    }
  }

  private async cloneChannels(
    sourceGuild: Guild,
    targetGuild: Guild,
    _roleMap: Map<string, string>
  ): Promise<CloneResult> {
    try {
      Logger.info('Cloning channels...');
      await Promise.all([sourceGuild.channels.fetch(), targetGuild.channels.fetch()]);

      // Remove any duplicate channels left over from previous runs before we start.
      await this.dedupeChannels(sourceGuild, targetGuild);
      await targetGuild.channels.fetch();
      
      const allChannels = Array.from(sourceGuild.channels.cache.values());
      const { categories: allCategories, regularChannels: allRegular } = this.categorizeChannels(allChannels);
      
      // Sort channels
      allCategories.sort((a, b) => this.getChannelPosition(a) - this.getChannelPosition(b));
      allRegular.sort((a, b) => {
        const parentCompare = this.getParentId(a).localeCompare(this.getParentId(b));
        return parentCompare !== 0 ? parentCompare : this.getChannelPosition(a) - this.getChannelPosition(b);
      });

      const channelMap = new Map<string, string>();
      const results: CloneResult[] = [];

      // Build a lookup of channels that already exist in the target (by key).
      // This lets us SKIP existing ones (so Resume mode doesn't duplicate) and
      // seed the map for existing categories so their children attach correctly.
      const targetByKey = new Map<string, Channel[]>();
      for (const tc of targetGuild.channels.cache.values()) {
        const k = this.channelKey(tc);
        const arr = targetByKey.get(k) || [];
        arr.push(tc);
        targetByKey.set(k, arr);
      }

      // Categories: skip existing (and map them), queue the rest for creation.
      const categories: Channel[] = [];
      for (const cat of allCategories) {
        const arr = targetByKey.get(this.channelKey(cat));
        if (arr && arr.length > 0) {
          const existing = arr.shift()!;
          channelMap.set(cat.id, existing.id); // reuse existing category as parent
        } else {
          categories.push(cat);
        }
      }

      // Regular channels: skip those that already exist, queue the rest.
      const regularChannels: Channel[] = [];
      for (const ch of allRegular) {
        const arr = targetByKey.get(this.channelKey(ch));
        if (arr && arr.length > 0) {
          arr.shift(); // already present, skip
        } else {
          regularChannels.push(ch);
        }
      }

      const skipped = (allCategories.length - categories.length) + (allRegular.length - regularChannels.length);
      if (skipped > 0) {
        Logger.info(`Skipping ${skipped} channel(s) that already exist in the target`);
      }
      Logger.info(`Creating ${categories.length} categories and ${regularChannels.length} regular channels`);
      
      // Clone categories first (in parallel), then regular channels (in parallel)
      // Categories need to be created before their children
      const categoryPromises = categories.map(async (sourceChannel) => {
        try {
          const channelName = this.getChannelName(sourceChannel);
          Logger.info(`Cloning category: ${channelName}`);
          
          const targetChannel = await this.createChannel(sourceChannel, targetGuild, channelMap);
          if (targetChannel) {
            channelMap.set(sourceChannel.id, targetChannel.id);
            const result: CloneResult = {
              success: true,
              item: `Channel: ${channelName}`,
              data: { sourceId: sourceChannel.id, targetId: targetChannel.id },
            };
            Logger.success(`✓ Cloned category: ${channelName}`);
            
            // Increment clone count and rotate proxy if needed (every 5 clones)
            this.proxyManager.incrementCloneCount();
            
            return result;
          } else {
            const result: CloneResult = {
              success: false,
              item: `Channel: ${channelName}`,
              error: 'Channel type not supported or creation returned null',
            };
            Logger.warning(`✗ Failed to clone category: ${channelName} (unsupported type)`);
            return result;
          }
        } catch (error) {
          const channelName = this.getChannelName(sourceChannel);
          const errorMsg = (error as Error).message;
          const result: CloneResult = {
            success: false,
            item: `Channel: ${channelName}`,
            error: errorMsg,
          };
          Logger.error(`✗ Failed to clone category ${channelName}: ${errorMsg}`);
          return result;
        }
      });

      // Wait for all categories to be created first
      const categoryResults = await Promise.allSettled(categoryPromises);
      for (const result of categoryResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }

      // Now clone regular channels in parallel
      const channelPromises = regularChannels.map(async (sourceChannel) => {
        try {
          const channelName = this.getChannelName(sourceChannel);
          Logger.info(`Cloning channel: ${channelName}`);
          
          const targetChannel = await this.createChannel(sourceChannel, targetGuild, channelMap);
          if (targetChannel) {
            channelMap.set(sourceChannel.id, targetChannel.id);
            const result: CloneResult = {
              success: true,
              item: `Channel: ${channelName}`,
              data: { sourceId: sourceChannel.id, targetId: targetChannel.id },
            };
            Logger.success(`✓ Cloned channel: ${channelName}`);
            
            // Increment clone count and rotate proxy if needed (every 5 clones)
            this.proxyManager.incrementCloneCount();
            
            return result;
          } else {
            const result: CloneResult = {
              success: false,
              item: `Channel: ${channelName}`,
              error: 'Channel type not supported or creation returned null',
            };
            Logger.warning(`✗ Failed to clone channel: ${channelName} (unsupported type)`);
            return result;
          }
        } catch (error) {
          const channelName = this.getChannelName(sourceChannel);
          const errorMsg = (error as Error).message;
          const result: CloneResult = {
            success: false,
            item: `Channel: ${channelName}`,
            error: errorMsg,
          };
          Logger.error(`✗ Failed to clone channel ${channelName}: ${errorMsg}`);
          
          if (errorMsg.includes('permission') || errorMsg.includes('Missing') || errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
            Logger.warning(`  → PERMISSION ERROR: Missing MANAGE_CHANNELS permission`);
            Logger.warning(`  → Solution: Grant "Manage Channels" permission to your role`);
          }
          
          return result;
        }
      });

      // Wait for all channels to be cloned in parallel
      const channelResults = await Promise.allSettled(channelPromises);
      for (const result of channelResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }

      Logger.success(`Cloned ${results.filter((r) => r.success).length} channels`);
      return {
        success: true,
        item: 'Channels',
        data: { channelMap, results },
      };
    } catch (error) {
      return {
        success: false,
        item: 'Channels',
        error: (error as Error).message,
      };
    }
  }

  private categorizeChannels(channels: Channel[]): { categories: Channel[]; regularChannels: Channel[] } {
    const categories: Channel[] = [];
    const regularChannels: Channel[] = [];
    
    for (const channel of channels) {
      const type = this.getChannelType(channel);
      if (type === CHANNEL_TYPES.GUILD_CATEGORY || channel instanceof CategoryChannel) {
        categories.push(channel);
      } else {
        regularChannels.push(channel);
      }
    }
    
    return { categories, regularChannels };
  }

  private getChannelType(channel: Channel): number | null {
    if ('type' in channel) {
      const typeValue = channel.type;
      if (typeof typeValue === 'number' && !isNaN(typeValue)) {
        return typeValue;
      }
      if (typeof typeValue === 'string') {
        const parsed = parseInt(typeValue, 10);
        return isNaN(parsed) ? null : parsed;
      }
    }
    return null;
  }

  private getChannelName(channel: Channel): string {
    return ('name' in channel && channel.name) ? String(channel.name) : 'Unknown';
  }

  /**
   * A stable key used to match a source channel to a target channel by identity.
   * Categories and non-categories are kept in separate namespaces; within
   * non-categories we match on name only (a source announcement/forum channel
   * may be created as a plain text channel on the target, so the numeric type
   * can legitimately differ).
   */
  private channelKey(channel: Channel): string {
    const isCategory = this.getChannelType(channel) === CHANNEL_TYPES.GUILD_CATEGORY || channel instanceof CategoryChannel;
    return `${isCategory ? 'cat' : 'chan'}|${this.getChannelName(channel)}`;
  }

  /**
   * Removes duplicate channels from the target that were created by earlier runs.
   * A channel is considered a duplicate only when the target has MORE copies of a
   * given name than the source does — so a user's own extra channels (not present
   * in the source at all) are never touched.
   */
  private async dedupeChannels(sourceGuild: Guild, targetGuild: Guild): Promise<void> {
    const sourceCounts = new Map<string, number>();
    for (const sc of sourceGuild.channels.cache.values()) {
      const k = this.channelKey(sc);
      sourceCounts.set(k, (sourceCounts.get(k) || 0) + 1);
    }

    const targetGroups = new Map<string, Channel[]>();
    for (const tc of targetGuild.channels.cache.values()) {
      const k = this.channelKey(tc);
      const arr = targetGroups.get(k) || [];
      arr.push(tc);
      targetGroups.set(k, arr);
    }

    let removed = 0;
    for (const [k, arr] of targetGroups) {
      const allowed = sourceCounts.get(k) || 0;
      // Only trim when this name exists in the source AND the target has extras.
      if (allowed > 0 && arr.length > allowed) {
        const extras = arr.slice(allowed);
        for (const ex of extras) {
          try {
            await this.rateLimiter.execute(() => (ex as any).delete());
            removed++;
            Logger.info(`  🗑️ Removed duplicate channel: ${this.getChannelName(ex)}`);
          } catch (e) {
            Logger.warning(`  Could not remove duplicate ${this.getChannelName(ex)}: ${(e as Error).message}`);
          }
        }
      }
    }

    if (removed > 0) {
      Logger.warning(`🔍 Removed ${removed} duplicate channel(s) from the target`);
    }
  }

  private getChannelPosition(channel: Channel): number {
    if ('position' in channel && typeof (channel as any).position === 'number') {
      return (channel as any).position;
    }
    return 0;
  }

  private getParentId(channel: Channel): string {
    if ('parentId' in channel && typeof (channel as any).parentId === 'string') {
      return (channel as any).parentId;
    }
    return '';
  }

  private async createChannel(
    sourceChannel: Channel,
    targetGuild: Guild,
    channelMap: Map<string, string>
  ): Promise<Channel | null> {
    try {
      const channelName = this.getChannelName(sourceChannel);
      const channelPosition = this.getChannelPosition(sourceChannel);
      const channelType = this.detectChannelType(sourceChannel, channelName); // Now synchronous
      
      // Route to appropriate channel creation method
      switch (channelType) {
        case CHANNEL_TYPES.GUILD_CATEGORY:
          return await this.createCategoryChannel(channelName, channelPosition, targetGuild);
        
        case CHANNEL_TYPES.GUILD_NEWS:
          return await this.createAnnouncementChannel(sourceChannel as TextChannel, channelName, channelPosition, targetGuild, channelMap);
        
        case CHANNEL_TYPES.GUILD_FORUM:
          return await this.createForumChannel(sourceChannel as TextChannel, channelName, channelPosition, targetGuild, channelMap);
        
        case CHANNEL_TYPES.GUILD_TEXT:
          return await this.createTextChannel(sourceChannel as TextChannel, channelName, channelPosition, targetGuild, channelMap);
        
        case CHANNEL_TYPES.GUILD_VOICE:
          return await this.createVoiceChannel(sourceChannel as VoiceChannel, channelName, channelPosition, targetGuild, channelMap);
        
        default:
          Logger.warning(`Unknown channel type for ${channelName} (type: ${channelType}), attempting fallback...`);
          return await this.createChannelFallback(sourceChannel as TextChannel, channelName, channelPosition, targetGuild, channelMap);
      }
    } catch (error) {
      Logger.error(`Failed to create channel: ${(error as Error).message}`);
      throw error;
    }
  }

  private detectChannelType(sourceChannel: Channel, _channelName: string): number {
    // Try to get type from channel object (synchronous check first)
    let channelTypeNum = this.getChannelType(sourceChannel);
    
    // Fallback to instanceof checks (synchronous)
    if (channelTypeNum === null) {
      if (sourceChannel instanceof CategoryChannel) return CHANNEL_TYPES.GUILD_CATEGORY;
      if (sourceChannel instanceof VoiceChannel) return CHANNEL_TYPES.GUILD_VOICE;
      if (sourceChannel instanceof TextChannel) {
        // Check raw type for announcement/forum
        const rawType = (sourceChannel as any).type;
        if (typeof rawType === 'number') {
          if (rawType === 5) return CHANNEL_TYPES.GUILD_NEWS;
          if (rawType === 15) return CHANNEL_TYPES.GUILD_FORUM;
        }
        const rawTypeStr = rawType ? String(rawType).toUpperCase() : '';
        if (rawTypeStr.includes('NEWS')) return CHANNEL_TYPES.GUILD_NEWS;
        if (rawTypeStr.includes('FORUM')) return CHANNEL_TYPES.GUILD_FORUM;
        return CHANNEL_TYPES.GUILD_TEXT;
      }
    }
    
    // If we have a type number, use it
    if (channelTypeNum !== null) {
      return channelTypeNum;
    }
    
    // Default to text channel (skip API call for speed)
    return CHANNEL_TYPES.GUILD_TEXT;
  }

  private async createCategoryChannel(name: string, position: number, targetGuild: Guild): Promise<Channel> {
    Logger.info(`Creating category channel: ${name}`);
    return await this.rateLimiter.execute(async () => {
      const channel = await targetGuild.channels.create(name, {
        type: CHANNEL_TYPES.GUILD_CATEGORY,
        position,
      } as any);
      Logger.success(`✓ Created category: ${channel.name}`);
      return channel;
    });
  }

  private buildTextChannelOptions(
    textChannel: TextChannel,
    _channelName: string,
    channelPosition: number,
    channelMap: Map<string, string>,
    type: number
  ): any {
    const parentId = textChannel.parentId ? channelMap.get(textChannel.parentId) : undefined;
    
    const options: any = {
      type,
      position: channelPosition,
    };
    
    if (textChannel.topic) options.topic = textChannel.topic;
    if (textChannel.nsfw !== undefined) options.nsfw = textChannel.nsfw;
    if (textChannel.rateLimitPerUser !== undefined && textChannel.rateLimitPerUser > 0) {
      options.rateLimitPerUser = textChannel.rateLimitPerUser;
    }
    if (parentId) options.parent = parentId;
    
    return options;
  }

  private async createAnnouncementChannel(
    textChannel: TextChannel,
    channelName: string,
    channelPosition: number,
    targetGuild: Guild,
    channelMap: Map<string, string>
  ): Promise<Channel | null> {
    Logger.info(`[ANNOUNCEMENT] Creating announcement channel: ${channelName}`);
    
    const options = this.buildTextChannelOptions(textChannel, channelName, channelPosition, channelMap, CHANNEL_TYPES.GUILD_NEWS);
    
    try {
      return await this.rateLimiter.execute(async () => {
        // Try REST API first
        try {
          const channelData = await this.targetREST.post(Routes.guildChannels(targetGuild.id), {
            body: {
              name: channelName,
              type: CHANNEL_TYPES.GUILD_NEWS,
              position: channelPosition,
              topic: textChannel.topic || undefined,
              nsfw: textChannel.nsfw || false,
              rate_limit_per_user: textChannel.rateLimitPerUser || 0,
              parent_id: options.parent || undefined,
            },
          }) as any;
          
          const channel = await targetGuild.channels.fetch(channelData.id);
          if (!channel) throw new Error('Failed to fetch created channel');
          
          Logger.success(`✓ Created announcement channel: ${channel.name}`);
          return channel;
        } catch (restError: any) {
          const errorMsg = (restError as Error).message;
          if (errorMsg.includes('type: Value must be one of') || errorMsg.includes('50035')) {
            Logger.warning(`[ANNOUNCEMENT] Type 5 not supported, creating as text channel instead`);
            return await this.createTextChannel(textChannel, channelName, channelPosition, targetGuild, channelMap);
          }
          throw restError;
        }
      });
    } catch (error) {
      Logger.error(`[ANNOUNCEMENT] Failed to create announcement channel: ${(error as Error).message}`);
      return await this.createTextChannel(textChannel, channelName, channelPosition, targetGuild, channelMap);
    }
  }

  private async createForumChannel(
    textChannel: TextChannel,
    channelName: string,
    channelPosition: number,
    targetGuild: Guild,
    channelMap: Map<string, string>
  ): Promise<Channel> {
    Logger.info(`Creating forum channel: ${channelName}`);
    const options = this.buildTextChannelOptions(textChannel, channelName, channelPosition, channelMap, CHANNEL_TYPES.GUILD_FORUM);
    
    // Forum-specific properties
    if ('availableTags' in textChannel && (textChannel as any).availableTags) {
      options.availableTags = (textChannel as any).availableTags;
    }
    if ('defaultAutoArchiveDuration' in textChannel && (textChannel as any).defaultAutoArchiveDuration) {
      options.defaultAutoArchiveDuration = (textChannel as any).defaultAutoArchiveDuration;
    }
    if ('defaultReactionEmoji' in textChannel && (textChannel as any).defaultReactionEmoji) {
      options.defaultReactionEmoji = (textChannel as any).defaultReactionEmoji;
    }
    if ('defaultThreadRateLimitPerUser' in textChannel && (textChannel as any).defaultThreadRateLimitPerUser) {
      options.defaultThreadRateLimitPerUser = (textChannel as any).defaultThreadRateLimitPerUser;
    }

    return await this.rateLimiter.execute(async () => {
      const channel = await targetGuild.channels.create(channelName, options);
      Logger.success(`✓ Created forum channel: ${channel.name}`);
      return channel;
    });
  }

  private async createTextChannel(
    textChannel: TextChannel,
    channelName: string,
    channelPosition: number,
    targetGuild: Guild,
    channelMap: Map<string, string>
  ): Promise<Channel> {
    Logger.info(`Creating text channel: ${channelName}`);
    const options = this.buildTextChannelOptions(textChannel, channelName, channelPosition, channelMap, CHANNEL_TYPES.GUILD_TEXT);

    return await this.rateLimiter.execute(async () => {
      const channel = await targetGuild.channels.create(channelName, options);
      Logger.success(`✓ Created text channel: ${channel.name}`);
      return channel;
    });
  }

  private async createVoiceChannel(
    voiceChannel: VoiceChannel,
    channelName: string,
    channelPosition: number,
    targetGuild: Guild,
    channelMap: Map<string, string>
  ): Promise<Channel> {
    Logger.info(`Creating voice channel: ${channelName}`);
    const parentId = voiceChannel.parentId ? channelMap.get(voiceChannel.parentId) : undefined;
    
    // Clamp bitrate to what the TARGET guild actually supports.
    // A boosted source can have 256k/384k, but the target's tier may cap lower (e.g. 96k).
    const sourceBitrate = voiceChannel.bitrate || 64000;
    const targetMaxBitrate = (targetGuild as any).maximumBitrate || 96000;
    const safeBitrate = Math.min(sourceBitrate, targetMaxBitrate);

    const options: any = {
      type: CHANNEL_TYPES.GUILD_VOICE,
      position: channelPosition,
      bitrate: safeBitrate,
    };
    
    if (voiceChannel.userLimit !== undefined && voiceChannel.userLimit > 0) {
      options.userLimit = voiceChannel.userLimit;
    }
    if (parentId) {
      options.parent = parentId;
    }

    return await this.rateLimiter.execute(async () => {
      const channel = await targetGuild.channels.create(channelName, options);
      Logger.success(`✓ Created voice channel: ${channel.name}`);
      return channel;
    });
  }

  private async createChannelFallback(
    textChannel: TextChannel,
    channelName: string,
    channelPosition: number,
    targetGuild: Guild,
    channelMap: Map<string, string>
  ): Promise<Channel | null> {
    const nameSuggestsAnnouncement = channelName.toLowerCase().includes('announce') || 
      channelName.toLowerCase().includes('news') ||
      channelName.toLowerCase().includes('update');
    
    if (nameSuggestsAnnouncement) {
      try {
        Logger.info(`[FALLBACK] Attempting to create as announcement channel: ${channelName}`);
        const announcementOptions = this.buildTextChannelOptions(textChannel, channelName, channelPosition, channelMap, CHANNEL_TYPES.GUILD_NEWS);
        return await this.rateLimiter.execute(async () => {
          const channel = await targetGuild.channels.create(channelName, announcementOptions);
          Logger.success(`✓ Created channel as announcement (fallback): ${channel.name}`);
          return channel;
        });
      } catch (announcementError) {
        Logger.warning(`Failed to create as announcement, trying text: ${(announcementError as Error).message}`);
      }
    }
    
    // Fallback to text channel
    return await this.createTextChannel(textChannel, channelName, channelPosition, targetGuild, channelMap);
  }

  /** Boost/premium tier as an index 0..3, handling both string and numeric forms. */
  private getTierIndex(guild: Guild): number {
    const tier = (guild as any).premiumTier;
    if (typeof tier === 'number') return Math.max(0, Math.min(3, tier));
    switch (String(tier)) {
      case 'TIER_1': return 1;
      case 'TIER_2': return 2;
      case 'TIER_3': return 3;
      default: return 0;
    }
  }

  /** Run an array of async tasks with limited concurrency to avoid CDN/API rate limits. */
  private async runInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const settled = await Promise.allSettled(batch.map(fn));
      for (const s of settled) {
        if (s.status === 'fulfilled') out.push(s.value);
      }
    }
    return out;
  }

  private async cloneEmojis(
    sourceGuild: Guild,
    targetGuild: Guild
  ): Promise<CloneResult> {
    try {
      Logger.info('🧩 Starting emoji cloning process...');

      await Promise.all([
        sourceGuild.emojis.fetch(),
        targetGuild.emojis.fetch(),
      ]);

      const sourceEmojis = Array.from(sourceGuild.emojis.cache.values());
      const results: CloneResult[] = [];

      if (sourceEmojis.length === 0) {
        Logger.warning('⚠️ No emojis found in source guild.');
        return { success: true, item: 'Emojis', data: { results: [] } };
      }

      // Work out the target's real capacity from its boost tier (static & animated are separate).
      const tier = this.getTierIndex(targetGuild);
      const perTypeLimit = EMOJI_LIMIT_BY_TIER[tier];
      const targetEmojiList = Array.from(targetGuild.emojis.cache.values());
      const existingNames = new Set(targetEmojiList.map((e) => e.name));
      const existingStatic = targetEmojiList.filter((e) => !e.animated).length;
      const existingAnimated = targetEmojiList.filter((e) => e.animated).length;

      let staticFree = Math.max(0, perTypeLimit - existingStatic);
      let animatedFree = Math.max(0, perTypeLimit - existingAnimated);

      Logger.info(
        `Target is boost tier ${tier} → emoji limit ${perTypeLimit} each. ` +
        `Free slots: ${staticFree} static, ${animatedFree} animated.`
      );

      // Pick only what fits, skipping duplicates. Sort by name for a stable order.
      const sorted = [...sourceEmojis].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const toClone: any[] = [];
      for (const emoji of sorted) {
        if (existingNames.has(emoji.name)) continue;
        if (emoji.animated) {
          if (animatedFree <= 0) continue;
          animatedFree--;
        } else {
          if (staticFree <= 0) continue;
          staticFree--;
        }
        toClone.push(emoji);
      }

      const skipped = sourceEmojis.length - toClone.length;
      Logger.info(`Cloning ${toClone.length} emojis (skipping ${skipped}: duplicates or over the target's limit).`);

      // Download + upload in small batches to stay under rate limits.
      const batchResults = await this.runInBatches(toClone, MEDIA_BATCH_SIZE, (emoji) =>
        this.cloneSingleEmoji(emoji, targetGuild, existingNames)
      );
      for (const r of batchResults) {
        if (r) results.push(r);
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      Logger.success(`🎉 Emoji cloning complete → Success: ${successCount}, Failed: ${failCount}`);
      return { success: true, item: 'Emojis', data: { results } };
    } catch (error) {
      Logger.error(`Emoji cloning failed: ${(error as Error).message}`);
      return { success: false, item: 'Emojis', error: (error as Error).message };
    }
  }

  private async cloneSingleEmoji(
    emoji: any,
    targetGuild: Guild,
    existingNames: Set<string | null>
  ): Promise<CloneResult | null> {
    const emojiName = emoji.name || 'unknown_emoji';
    const isAnimated = emoji.animated ?? false;
    const emojiType = isAnimated ? 'animated' : 'static';
    const emojiId = emoji.id;

    // Stop early if the target guild is already full
    if (this.emojiLimitReached) {
      return null;
    }

    // Skip duplicates
    if (existingNames.has(emojiName)) {
      Logger.warning(`[EMOJI] Skipping duplicate emoji: ${emojiName}`);
      return null;
    }

    Logger.info(`[EMOJI] → Cloning: ${emojiName} (${emojiType})`);

    // Construct URL if missing
    const emojiUrl = emoji.url || `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}`;
    Logger.debug(`[EMOJI] CDN URL: ${emojiUrl}`);

    try {
      // Step 1: Download
      const imageBuffer = await this.downloadEmoji(emojiUrl, emojiName);
      const imageBase64 = imageBuffer.toString('base64');
      const mimeType = isAnimated ? 'image/gif' : 'image/png';
      const dataUri = `data:${mimeType};base64,${imageBase64}`;

      Logger.success(`[EMOJI] ✓ Downloaded ${emojiName} (${(imageBuffer.length / 1024).toFixed(1)} KB)`);

      // Re-check just before upload — the limit may have been hit by an earlier (serialized) upload.
      if (this.emojiLimitReached) {
        return null;
      }

      // Step 2: Upload
      await this.uploadEmoji(emojiName, emojiType, dataUri, targetGuild.id);
      
      Logger.success(`[EMOJI] ✓ Uploaded ${emojiName} (${emojiType})`);
      
      // Increment clone count and rotate proxy if needed (every 5 clones)
      this.proxyManager.incrementCloneCount();
      
      return { success: true, item: `Emoji: ${emojiName}` };
    } catch (error: any) {
      const msg = error?.message || String(error);
      // If the guild is full, flag it so remaining emojis are skipped instead of erroring one-by-one.
      if (/limit|maximum|30008/i.test(msg)) {
        if (!this.emojiLimitReached) {
          this.emojiLimitReached = true;
          Logger.warning('⚠️ Target guild emoji limit reached (based on its boost level). Stopping emoji cloning and moving on.');
        }
        return { success: false, item: `Emoji: ${emojiName}`, error: 'Emoji limit reached' };
      }
      Logger.error(`[EMOJI] ✗ Failed to clone ${emojiName}: ${msg}`);
      return { success: false, item: `Emoji: ${emojiName}`, error: msg };
    }
  }

  private async cloneStickers(
    sourceGuild: Guild,
    targetGuild: Guild
  ): Promise<CloneResult> {
    try {
      Logger.info('🏷️  Starting sticker cloning process...');

      await Promise.all([
        sourceGuild.stickers.fetch(),
        targetGuild.stickers.fetch(),
      ]);

      const sourceStickers = Array.from(sourceGuild.stickers.cache.values());
      const results: CloneResult[] = [];

      if (sourceStickers.length === 0) {
        Logger.warning('⚠️ No stickers found in source guild.');
        return { success: true, item: 'Stickers', data: { results: [] } };
      }

      // Capacity from boost tier.
      const tier = this.getTierIndex(targetGuild);
      const stickerLimit = STICKER_LIMIT_BY_TIER[tier];
      const targetStickerList = Array.from(targetGuild.stickers.cache.values());
      const existingNames = new Set(targetStickerList.map((s: any) => s.name));
      let free = Math.max(0, stickerLimit - targetStickerList.length);

      Logger.info(`Target is boost tier ${tier} → sticker limit ${stickerLimit}. Free slots: ${free}.`);

      // Sort by name, skip duplicates and Lottie, and only take what fits.
      const sorted = ([...sourceStickers] as any[]).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
      const toClone: any[] = [];
      for (const sticker of sorted) {
        if (free <= 0) break;
        if (existingNames.has(sticker.name)) continue;
        if (sticker.format === 'LOTTIE' || sticker.format === 3) continue; // can't upload Lottie
        toClone.push(sticker);
        free--;
      }

      const skipped = sourceStickers.length - toClone.length;
      Logger.info(`Cloning ${toClone.length} stickers (skipping ${skipped}: duplicates, Lottie, or over the target's limit).`);

      const batchResults = await this.runInBatches(toClone, MEDIA_BATCH_SIZE, (sticker: any) =>
        this.cloneSingleSticker(sticker, targetGuild, existingNames)
      );
      for (const r of batchResults) {
        if (r) results.push(r);
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      Logger.success(`🎉 Sticker cloning complete → Success: ${successCount}, Failed: ${failCount}`);
      return { success: true, item: 'Stickers', data: { results } };
    } catch (error) {
      Logger.error(`Sticker cloning failed: ${(error as Error).message}`);
      return { success: false, item: 'Stickers', error: (error as Error).message };
    }
  }

  private async cloneSingleSticker(
    sticker: any,
    targetGuild: Guild,
    existingNames: Set<string | null>
  ): Promise<CloneResult | null> {
    const stickerName: string = sticker.name || 'unknown_sticker';

    // Stop early if the target guild is already full
    if (this.stickerLimitReached) {
      return null;
    }

    if (existingNames.has(stickerName)) {
      Logger.warning(`[STICKER] Skipping duplicate sticker: ${stickerName}`);
      return null;
    }

    // Lottie stickers (format type 3) cannot be uploaded to standard guilds
    if (sticker.format === 'LOTTIE' || sticker.format === 3) {
      Logger.warning(`[STICKER] Skipping Lottie sticker (not uploadable): ${stickerName}`);
      return { success: false, item: `Sticker: ${stickerName}`, error: 'Lottie stickers cannot be cloned' };
    }

    Logger.info(`[STICKER] → Cloning: ${stickerName}`);

    try {
      const stickerUrl: string = sticker.url || `https://media.discordapp.net/stickers/${sticker.id}.png`;
      const imageBuffer = await this.downloadEmoji(stickerUrl, stickerName);

      // Re-check just before upload — the limit may have been hit by an earlier (serialized) upload.
      if (this.stickerLimitReached) {
        return null;
      }

      await this.rateLimiter.execute(async () => {
        await targetGuild.stickers.create(imageBuffer as any, stickerName, sticker.tags || stickerName, {
          description: sticker.description || undefined,
          reason: 'Cloning sticker',
        } as any);
      });

      Logger.success(`[STICKER] ✓ Cloned ${stickerName}`);
      this.proxyManager.incrementCloneCount();
      return { success: true, item: `Sticker: ${stickerName}` };
    } catch (error: any) {
      const msg = error?.message || String(error);

      // Guild is full — flag it so remaining stickers are skipped instead of erroring one-by-one.
      if (/limit|maximum|30039/i.test(msg)) {
        if (!this.stickerLimitReached) {
          this.stickerLimitReached = true;
          Logger.warning('⚠️ Target guild sticker limit reached (based on its boost level). Stopping sticker cloning and moving on.');
        }
        return { success: false, item: `Sticker: ${stickerName}`, error: 'Sticker limit reached' };
      }

      Logger.error(`[STICKER] ✗ Failed to clone ${stickerName}: ${msg}`);
      if (msg.includes('403') || msg.includes('permission') || msg.includes('Missing')) {
        Logger.warning('  → Missing "Manage Emojis and Stickers" permission.');
      }

      return { success: false, item: `Sticker: ${stickerName}`, error: msg };
    }
  }

  private async downloadEmoji(emojiUrl: string, emojiName: string): Promise<Buffer> {
    Logger.debug(`[EMOJI] Attempting to download from: ${emojiUrl}`);
    
    // Get proxy config for this request (rotation happens here)
    const proxyConfig = this.proxyManager.isEnabled() 
      ? this.proxyManager.getProxyAgent() 
      : undefined;
    
    const requestConfig: any = {
      responseType: 'arraybuffer' as const,
      timeout: EMOJI_DOWNLOAD_TIMEOUT,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
      },
      validateStatus: (status: number) => status >= 200 && status < 400,
    };

    // Add proxy to request config if available
    if (proxyConfig) {
      requestConfig.proxy = {
        host: proxyConfig.host,
        port: proxyConfig.port,
        protocol: proxyConfig.protocol,
        auth: proxyConfig.auth,
      };
    }
    
    try {
      // Try with authentication first
      const response = await axios.get(emojiUrl, {
        ...requestConfig,
        headers: {
          ...requestConfig.headers,
          'Authorization': this.config.sourceToken,
        },
      });
      
      if (!response.data || response.data.length === 0) {
        throw new Error('Empty response from CDN');
      }
      
      return Buffer.from(response.data);
    } catch (authError: any) {
      // Fallback to public CDN (without auth header)
      Logger.debug(`[EMOJI] Auth download failed for ${emojiName}, trying public CDN...`);
      const response = await axios.get(emojiUrl, requestConfig);
      
      if (!response.data || response.data.length === 0) {
        throw new Error('Empty response from CDN');
      }
      
      return Buffer.from(response.data);
    }
  }

  private async uploadEmoji(
    emojiName: string,
    _emojiType: string,
    dataUri: string,
    targetGuildId: string
  ): Promise<void> {
    const token = this.config.targetToken.trim();
    if (!token || token.length === 0) {
      throw new Error('Target token is empty or invalid');
    }
    
    let lastError: any;
    
    for (let attempt = 1; attempt <= EMOJI_UPLOAD_RETRIES; attempt++) {
      try {
        await this.rateLimiter.execute(async () => {
          const uploadUrl = `https://discord.com/api/v10/guilds/${targetGuildId}/emojis`;
          await axios.post(uploadUrl, {
            name: emojiName,
            image: dataUri,
          }, {
            headers: {
              'Authorization': token,
              'Content-Type': 'application/json',
              'User-Agent': DEFAULT_USER_AGENT,
            },
            timeout: EMOJI_DOWNLOAD_TIMEOUT,
          });
        });
        return; // Success
      } catch (uploadErr: any) {
        lastError = uploadErr;
        const status = uploadErr?.response?.status;
        const msg = uploadErr?.message || String(uploadErr);
        
        // Handle 401 - don't retry
        if (status === 401) {
          Logger.error(`[EMOJI] ❌ 401 Unauthorized - Target token is invalid or expired.`);
          throw new Error('Target token authentication failed (401 Unauthorized). Please check your TARGET_TOKEN.');
        }
        
        // Rate limits are now handled automatically by RateLimiter
        // No need to manually handle 429 errors here
        
        // Handle emoji limit - stop immediately
        if (status === 400 || msg.includes('maximum') || msg.includes('limit') || msg.includes('50035')) {
          Logger.error('❌ Emoji limit reached in target guild.');
          throw new Error('Emoji limit reached in target guild.');
        }
        
        // Handle permission issues - stop immediately
        if (status === 403 || msg.includes('Missing') || msg.includes('permission')) {
          Logger.error('❌ Missing MANAGE_EMOJIS_AND_STICKERS permission in target guild.');
          throw new Error('Missing MANAGE_EMOJIS_AND_STICKERS permission.');
        }
        
        // Other errors - log and retry
        if (attempt < EMOJI_UPLOAD_RETRIES) {
          Logger.warning(`[EMOJI] Upload failed (attempt ${attempt}/${EMOJI_UPLOAD_RETRIES}) for ${emojiName}: ${msg}`);
        }
      }
    }
    
    // All retries failed
    throw lastError || new Error('Upload failed after all retries');
  }

  // ────────────────────────────────────────────────────────────────────────
  // Reconciliation scanners — run after each clone step to detect and re-add
  // anything that failed the first time (rate limits, transient errors, the
  // bitrate issue, etc.), placing items back in their correct position.
  // ────────────────────────────────────────────────────────────────────────

  private async reconcileChannels(
    sourceGuild: Guild,
    targetGuild: Guild,
    channelMap: Map<string, string>
  ): Promise<void> {
    const maxPasses = 3;
    for (let pass = 1; pass <= maxPasses; pass++) {
      await Promise.all([sourceGuild.channels.fetch(), targetGuild.channels.fetch()]);

      const targetNames = new Set(
        Array.from(targetGuild.channels.cache.values()).map((c) => this.getChannelName(c))
      );
      const missing = Array.from(sourceGuild.channels.cache.values()).filter(
        (c) => !targetNames.has(this.getChannelName(c))
      );

      if (missing.length === 0) {
        if (pass > 1) Logger.success('🔍 Channel scan: all channels present.');
        return;
      }

      Logger.warning(`🔍 Channel scan (pass ${pass}): ${missing.length} missing — re-adding...`);

      // Categories first so children can attach to their parent.
      const { categories, regularChannels } = this.categorizeChannels(missing);
      for (const ch of [...categories, ...regularChannels]) {
        const name = this.getChannelName(ch);
        try {
          const created = await this.createChannel(ch, targetGuild, channelMap);
          if (created) {
            channelMap.set(ch.id, created.id);
            Logger.success(`  ✓ Re-added channel: ${name}`);
          }
        } catch (e) {
          Logger.warning(`  ✗ Channel still failing: ${name}: ${(e as Error).message}`);
        }
      }
    }
    Logger.warning('🔍 Channel scan: reached max passes; some channels may still be missing.');
  }

  private async reconcileRoles(
    sourceGuild: Guild,
    targetGuild: Guild,
    roleMap: Map<string, string>
  ): Promise<void> {
    await Promise.all([sourceGuild.roles.fetch(), targetGuild.roles.fetch()]);

    const targetNames = new Set(
      Array.from(targetGuild.roles.cache.values())
        .filter((r) => r.id !== targetGuild.id)
        .map((r) => r.name)
    );

    const missing = Array.from(sourceGuild.roles.cache.values())
      .filter((r) => !r.managed && r.id !== sourceGuild.id && !targetNames.has(r.name))
      .sort((a, b) => b.position - a.position);

    if (missing.length === 0) return;

    Logger.warning(`🔍 Role scan: ${missing.length} missing — re-adding...`);
    for (const sourceRole of missing) {
      try {
        const created = await this.rateLimiter.execute(async () => {
          const roleOptions: any = {
            name: sourceRole.name,
            color: sourceRole.color,
            hoist: sourceRole.hoist || false,
            mentionable: sourceRole.mentionable || false,
          };
          if (sourceRole.permissions) roleOptions.permissions = sourceRole.permissions;
          const r = await targetGuild.roles.create(roleOptions);
          if (sourceRole.position > 0) {
            try { await r.setPosition(sourceRole.position); } catch { /* best effort */ }
          }
          return r;
        });
        roleMap.set(sourceRole.id, created.id);
        if (this.config.options.cloneRoleIcons) {
          await this.cloneRoleIcon(sourceRole, created, targetGuild);
        }
        Logger.success(`  ✓ Re-added role: ${sourceRole.name}`);
      } catch (e) {
        Logger.warning(`  ✗ Role still failing: ${sourceRole.name}: ${(e as Error).message}`);
      }
    }
  }

  private async reconcileEmojis(sourceGuild: Guild, targetGuild: Guild): Promise<void> {
    if (this.emojiLimitReached) return;

    await Promise.all([sourceGuild.emojis.fetch(), targetGuild.emojis.fetch()]);

    // Only retry as many as still fit — never re-attempt over-limit items.
    const tier = this.getTierIndex(targetGuild);
    const perTypeLimit = EMOJI_LIMIT_BY_TIER[tier];
    const targetList = Array.from(targetGuild.emojis.cache.values());
    const existingNames = new Set(targetList.map((e) => e.name));
    let staticFree = Math.max(0, perTypeLimit - targetList.filter((e) => !e.animated).length);
    let animatedFree = Math.max(0, perTypeLimit - targetList.filter((e) => e.animated).length);

    const missing: any[] = [];
    for (const e of Array.from(sourceGuild.emojis.cache.values())) {
      if (existingNames.has(e.name)) continue;
      if (e.animated) { if (animatedFree <= 0) continue; animatedFree--; }
      else { if (staticFree <= 0) continue; staticFree--; }
      missing.push(e);
    }

    if (missing.length === 0) return;
    Logger.warning(`🔍 Emoji scan: retrying ${missing.length} that still fit...`);
    await this.runInBatches(missing, MEDIA_BATCH_SIZE, (emoji) => {
      if (this.emojiLimitReached) return Promise.resolve(null);
      return this.cloneSingleEmoji(emoji, targetGuild, existingNames);
    });
  }

  private async reconcileStickers(sourceGuild: Guild, targetGuild: Guild): Promise<void> {
    if (this.stickerLimitReached) return;

    await Promise.all([sourceGuild.stickers.fetch(), targetGuild.stickers.fetch()]);

    const tier = this.getTierIndex(targetGuild);
    const stickerLimit = STICKER_LIMIT_BY_TIER[tier];
    const targetList = Array.from(targetGuild.stickers.cache.values());
    const existingNames = new Set(targetList.map((s: any) => s.name));
    let free = Math.max(0, stickerLimit - targetList.length);

    if (free <= 0) return;

    const missing: any[] = [];
    for (const s of Array.from(sourceGuild.stickers.cache.values()) as any[]) {
      if (free <= 0) break;
      if (existingNames.has(s.name)) continue;
      if (s.format === 'LOTTIE' || s.format === 3) continue;
      missing.push(s);
      free--;
    }

    if (missing.length === 0) return;
    Logger.warning(`🔍 Sticker scan: retrying ${missing.length} that still fit...`);
    await this.runInBatches(missing, MEDIA_BATCH_SIZE, (sticker: any) => {
      if (this.stickerLimitReached) return Promise.resolve(null);
      return this.cloneSingleSticker(sticker, targetGuild, existingNames);
    });
  }

  /** Update which parts get cloned (used between operations in the same session). */
  setOptions(options: ClonerConfig['options']): void {
    this.config.options = options;
  }

  async destroy(): Promise<void> {
    Logger.info('Destroying clients...');
    this.sourceClient.destroy();
    this.targetClient.destroy();
    this.proxyManager.destroy();
    await this.rateLimiter.waitForCompletion();
    Logger.success('All clients destroyed');
  }
}
