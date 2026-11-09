import type { ClonerOptions, RateLimitConfig } from '../types/index.js';

export const defaultClonerOptions: ClonerOptions = {
  cloneChannels: true,
  cloneRoles: true,
  cloneRoleIcons: true,
  cloneGuildSettings: true,
  cloneEmojis: true,
  cloneStickers: true,
  cloneBans: false,
  cloneVoiceStates: false,
};

export const defaultRateLimitConfig: RateLimitConfig = {
  delay: 300, // Minimum spacing (ms) between request dispatches to avoid 429 bursts
  maxConcurrentRequests: 3, // Conservative concurrency — safer for user tokens, far fewer rate limits
};

