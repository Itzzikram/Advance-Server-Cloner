export interface ClonerConfig {
  sourceToken: string;
  targetToken: string;
  proxy?: ProxyConfig;
  proxies?: ProxyConfig[];
  options: ClonerOptions;
  rateLimit: RateLimitConfig;
}

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol?: 'http' | 'https';
}

export interface ClonerOptions {
  /** Clone channels (text, voice, categories, announcements, forums) with their settings */
  cloneChannels: boolean;
  /** Clone roles with their permissions, colors and positions */
  cloneRoles: boolean;
  /** Clone role icons (only applies when the target guild is boosted / supports ROLE_ICONS) */
  cloneRoleIcons: boolean;
  /** Clone guild-level settings (name, icon, verification level, etc.) */
  cloneGuildSettings: boolean;
  /** Clone custom emojis (static and animated) */
  cloneEmojis: boolean;
  /** Clone custom stickers */
  cloneStickers: boolean;
  cloneBans?: boolean;
  cloneVoiceStates?: boolean;
}

export interface RateLimitConfig {
  delay: number;
  maxConcurrentRequests: number;
}

export interface CloneProgress {
  current: number;
  total: number;
  item: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface CloneResult {
  success: boolean;
  item: string;
  error?: string;
  data?: any;
}

export interface GuildCloneData {
  name: string;
  icon?: string;
  description?: string;
  features?: string[];
  verificationLevel?: number;
  defaultMessageNotifications?: number;
  explicitContentFilter?: number;
  afkChannelId?: string;
  afkTimeout?: number;
  systemChannelId?: string;
  systemChannelFlags?: number;
}

