# Discord Server Cloner Pro

<div align="center">

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [🚀 Upgrade to v3.0 Enterprise](#-upgrade-to-v30-enterprise)
- [Security &amp; Legal](#security--legal)
- [License](#license)

---

## 🎯 Overview

Discord Server Cloner is a TypeScript-based tool designed to clone Discord servers (guilds) from a source to a target server. It provides basic cloning capabilities including guild settings, roles, channels (text, voice, categories), and emojis with rate limiting and error handling.

### What Gets Cloned

- ✅ **Guild Settings**: Name, icon, verification level, notifications, content filter
- ✅ **Roles**: Custom roles with permissions, colors, positions, hoist, mentionable
- ✅ **Channels**: Text, voice, and category channels with settings
- ✅ **Emojis**: Custom emojis (static and animated) with download and upload

---

## ✨ Features

### Core Functionality

- **🔄 Server Cloning**: Clone Discord servers with major components
- **🎭 Role Management**: Preserve role hierarchy, permissions, colors, and positions
- **📁 Channel Support**: Text, voice, and category channels with categorization
- **😀 Emoji Cloning**: Emoji download from CDN and upload to target server

### Technical Features

- **⚡ Rate Limiting**: Automatic rate limit detection with exponential backoff
- **🌐 Proxy Support**: HTTP/HTTPS proxy support for network routing
- **📊 Progress Tracking**: Progress updates with logging
- **🛡️ Error Handling**: Error handling with detailed error messages
- **📝 TypeScript**: Type-safe codebase
- **Modular Architecture**: Clean code structure
- **ESM Support**: Modern ES modules

---

## 📦 Prerequisites

- **Node.js**: Version 18.0.0 or higher ([Download](https://nodejs.org/))
- **npm**: Comes with Node.js
- **Discord User Account Tokens**: Two valid user account tokens

### Token Requirements

⚠️ **CRITICAL**: This tool requires **user account tokens** (selfbot tokens), NOT bot tokens.

- User tokens are typically 59+ characters (base64-encoded strings)
- Bot tokens follow the pattern: `MTA...` or `NTA...`
- Both SOURCE_TOKEN and TARGET_TOKEN must be user account tokens

---

## 🚀 Installation

### Step 1: Clone or Download

```bash
git clone <repository-url>
cd "Discord Cloner"
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Build

```bash
npm run build
```

---

## ⚙️ Configuration

Create a `.env` file in the project root:

```env
# REQUIRED: User Account Tokens
SOURCE_TOKEN=your_source_user_account_token_here
TARGET_TOKEN=your_target_user_account_token_here

# REQUIRED: Guild IDs
SOURCE_GUILD_ID=source_guild_id_here
TARGET_GUILD_ID=target_guild_id_here

# OPTIONAL: Proxy
PROXY_HOST=localhost
PROXY_PORT=8080
PROXY_PROTOCOL=http

# OPTIONAL: Clone Toggles
CLONE_GUILDS=true
CLONE_CHANNELS=true
CLONE_ROLES=true
CLONE_EMOJIS=true

# OPTIONAL: Rate Limiting
RATE_LIMIT_DELAY=1000
MAX_CONCURRENT_REQUESTS=5

# OPTIONAL: Debug
DEBUG=false
```

---

## 💻 Usage

### Clone to Existing Guild

```bash
npm start
```

### Development Mode

```bash
npm run dev
```

### Available Scripts

| Script            | Description                       |
| ----------------- | --------------------------------- |
| `npm run build` | Compile TypeScript to JavaScript  |
| `npm start`     | Run the compiled JavaScript       |
| `npm run dev`   | Development mode with auto-reload |

---

## 🏗️ Architecture

```
Discord Cloner/
├── src/
│   ├── core/
│   │   └── cloner.ts            # Main cloner
│   ├── config/
│   │   ├── defaults.ts          # Default config values
│   │   └── loader.ts            # Config loader
│   ├── types/
│   │   └── index.ts             # Type definitions
│   ├── utils/
│   │   ├── logger.ts            # Logging utility
│   │   ├── proxy.ts             # Proxy manager
│   │   └── rateLimiter.ts       # Rate limiting
│   └── index.ts                 # Entry point
├── .env                         # Environment variables
├── package.json                 # Dependencies
└── tsconfig.json                # TypeScript config
```

### Cloning Process

1. **Initialization** — Load config, initialize Discord clients, login
2. **Guild Setup** — Fetch source, create/use target guild
3. **Role Cloning** — Clone roles preserving hierarchy and permissions
4. **Channel Cloning** — Clone categories first, then channels
5. **Emoji Cloning** — Download and upload emojis
6. **Cleanup** — Close connections

---

## 🔧 Troubleshooting

### Token Invalid Errors

- Ensure you're using **user account tokens**, not bot tokens
- Remove quotes and trailing spaces from `.env`
- Verify token hasn't been revoked or expired
- This project uses `discord.js-selfbot-v13` (standard `discord.js` v12+ does NOT support user tokens)

### Permission Errors

- Need `MANAGE_ROLES`, `MANAGE_CHANNELS`, `MANAGE_EMOJIS_AND_STICKERS`
- Your role must be higher than roles/channels being created

### Rate Limit Errors

- Increase `RATE_LIMIT_DELAY` (e.g., `2000`)
- Decrease `MAX_CONCURRENT_REQUESTS` (e.g., `3`)
- The rate limiter automatically handles retries

### Emoji Upload Failures

- Standard servers: 50 static + 50 animated emoji limit
- Ensure `MANAGE_EMOJIS_AND_STICKERS` permission

---

## 🚀 Upgrade to v3.0 Enterprise

> **Want the full-power, enterprise-grade server cloner?**
>
> **Server Cloner Pro v3.0 Enterprise** is a complete rewrite from the ground up — a professional suite that leaves v1 in the dust.

### 🔥 What v3.0 Enterprise Adds Over v1

<table>
<thead>
<tr>
<th>Feature</th>
<th align="center">v1 (This Repo)</th>
<th align="center">v3.0 Enterprise</th>
</tr>
</thead>
<tbody>
<tr><td><strong>Execution Modes</strong></td><td align="center">Single token only</td><td align="center">✅ Single, Dual Hybrid, & Offline Blueprint Restore</td></tr>
<tr><td><strong>Web Dashboard UI</strong></td><td align="center">❌ CLI only</td><td align="center">✅ Cinematic glassmorphism web HUD with 3D animated background</td></tr>
<tr><td><strong>Live SSE Telemetry</strong></td><td align="center">❌</td><td align="center">✅ Real-time Server-Sent Events progress stream with request/429/timing counters</td></tr>
<tr><td><strong>Bot Token Support</strong></td><td align="center">❌ User tokens only</td><td align="center">✅ Full Bot Token + User Token support with auto-header switching</td></tr>
<tr><td><strong>Stealth Fingerprinting</strong></td><td align="center">❌</td><td align="center">✅ Full Discord Desktop client fingerprint (X-Super-Properties, User-Agent, Sec-Fetch headers)</td></tr>
<tr><td><strong>Speed Profiles</strong></td><td align="center">Fixed delay</td><td align="center">✅ TURBO / BALANCED / GHOST (ultra-stealth human-simulation jitter)</td></tr>
<tr><td><strong>Message Cloning</strong></td><td align="center">❌</td><td align="center">✅ Webhook-based message mirror with original author names & avatars (1-50 msgs/channel)</td></tr>
<tr><td><strong>Blueprint Backup & Restore</strong></td><td align="center">❌</td><td align="center">✅ Export entire server structure to JSON → restore offline anytime</td></tr>
<tr><td><strong>Pre-Flight Inspector</strong></td><td align="center">Basic canary check</td><td align="center">✅ Full server inspector showing roles, channels, emojis, boost tier for both source & target</td></tr>
<tr><td><strong>Guild Branding</strong></td><td align="center">Icon only</td><td align="center">✅ Icon + Banner + Invite Splash (boost-tier aware GIF/PNG)</td></tr>
<tr><td><strong>Role Icons</strong></td><td align="center">❌</td><td align="center">✅ Clones role icons & unicode emojis (Boost Tier 2+ aware)</td></tr>
<tr><td><strong>Forum Channels & Tags</strong></td><td align="center">❌</td><td align="center">✅ Full forum channel support with available_tags, sort order, layout, emoji remapping</td></tr>
<tr><td><strong>Permission Overwrites</strong></td><td align="center">Basic</td><td align="center">✅ Full Snowflake ID remapping of role-based permission overwrites across channels</td></tr>
<tr><td><strong>Smart Proxy Pool</strong></td><td align="center">Single proxy</td><td align="center">✅ Self-healing round-robin proxy pool with auto-quarantine on failure (60s cooldown)</td></tr>
<tr><td><strong>Emoji Quota Intelligence</strong></td><td align="center">❌</td><td align="center">✅ Boost-tier aware limits (50/100/150/250), duplicate detection, 256 KiB auto-downscale, hourly rate limit handling</td></tr>
<tr><td><strong>Abort Pipeline</strong></td><td align="center">❌ Kill process</td><td align="center">✅ Clean AbortController-based pipeline abort via API or UI button</td></tr>
<tr><td><strong>Target Wipe</strong></td><td align="center">Manual</td><td align="center">✅ One-click wipe all roles, channels & emojis on target before cloning</td></tr>
<tr><td><strong>AFK & System Channel Remap</strong></td><td align="center">❌</td><td align="center">✅ Automatically remaps AFK and system channels after cloning</td></tr>
<tr><td><strong>Audit Log Reasons</strong></td><td align="center">❌</td><td align="center">✅ Every API write includes X-Audit-Log-Reason for clean server audit trails</td></tr>
<tr><td><strong>Docker & Railway</strong></td><td align="center">❌</td><td align="center">✅ Production Dockerfile (multi-stage Alpine), docker-compose, Railway & Vercel configs</td></tr>
<tr><td><strong>API Backend</strong></td><td align="center">❌</td><td align="center">✅ Fastify REST API server with Zod validation, 25 MB body limit</td></tr>
<tr><td><strong>Log Download</strong></td><td align="center">❌</td><td align="center">✅ Download full execution logs as .log file from UI or API</td></tr>
<tr><td><strong>Dependencies</strong></td><td align="center">discord.js-selfbot-v13, axios, chalk, ora</td><td align="center">✅ Zero selfbot libraries — pure undici + discord-api-types (lighter, faster, safer)</td></tr>
</tbody>
</table>

### 🎬 v3.0 Enterprise Dashboard Preview

The v3.0 Enterprise ships with a full **cinematic web dashboard** featuring:

- 🎮 3-way architecture switcher (Single / Dual Hybrid / Blueprint Restore)
- 📊 Live telemetry counters (API requests, 429 rate limits, elapsed time)
- 🖥️ Real-time terminal console with SSE event streaming
- 🔍 Pre-flight server inspector cards for source & target
- 📦 One-click JSON blueprint export & import
- 🎨 3D cinematic animated background with quality presets & peek mode
- ⚡ Speed profile selector (Turbo / Balanced / Ghost)

---

### 💰 Get v3.0 Enterprise — Source Code 100$

**One-time purchase** — you receive the full source code, lifetime access, no subscriptions.

#### Payment Methods

| Method            | Details                                |
| ----------------- | -------------------------------------- |
| **PayPal**  | `mdneyatkazi`                        |
| **Binance** | UID: `476440081`                     |
| **BTC**     | `1vfwqN29ZyaQJo3c2RmUq6b2nhYkHxoPr`  |
| **LTC**     | `LL9dD3frEEDdf7VCnAR4krAMF14psipyHb` |

#### After Payment

Send proof of payment to any of the contacts below, and you'll receive the full v3.0 Enterprise source code.

---

### 📞 Contact & Support

| Platform          | Handle                      |
| ----------------- | --------------------------- |
| **Email**   | mdikramhosssain42@gmail.com |
| **Discord** | `kirito_ly`               |

> 💬 DM me on Discord for pricing, questions, or a live demo.

---

## 🔒 Security & Legal

### Security Best Practices

- Never commit tokens to version control
- Use `.env` file and add it to `.gitignore`
- Never share tokens publicly
- Rotate tokens if compromised

### Legal Disclaimer

⚠️ **IMPORTANT**: This tool is for educational purposes only.

- Using selfbots violates Discord's Terms of Service
- Your account may be banned or terminated
- Use at your own risk
- The authors are not responsible for any consequences

---

## 📄 License

This project is licensed under the MIT License.

---

<div align="center">
