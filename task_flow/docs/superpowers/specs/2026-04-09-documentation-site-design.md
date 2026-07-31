# TaskFlow Documentation Site

**Date:** 2026-04-09
**Status:** Draft

## Overview

Replace the static `landing-page/index.html` with a Specra-powered documentation site at `documentation/`. The docs site becomes the sole public-facing surface — landing page + full docs for all supported AI agents.

## Goals

1. Port the existing landing page content into `+page.svelte` (replacing Specra boilerplate)
2. Theme the docs site to match TaskFlow's dark aesthetic (`#69fd5d` green accent, dark backgrounds)
3. Add per-agent setup guides as MDX pages
4. Replace Specra boilerplate docs with TaskFlow-specific content
5. Leave `landing-page/` directory untouched

## Architecture

```
documentation/
├── src/
│   ├── app.css                          ← TaskFlow dark theme (Mint variant)
│   └── routes/
│       └── +page.svelte                 ← Landing page (ported from index.html)
├── docs/
│   └── v1.0.0/
│       ├── about.mdx                    ← What is TaskFlow
│       ├── getting-started.mdx          ← Quick start overview
│       ├── features.mdx                 ← Feature overview
│       ├── configuration.mdx            ← MCP server config reference
│       └── agents/
│           ├── index.mdx                ← Agent setup overview + comparison table
│           ├── claude.mdx               ← Claude Code setup
│           ├── codex.mdx                ← OpenAI Codex CLI setup
│           ├── cursor.mdx               ← Cursor IDE setup
│           ├── windsurf.mdx             ← Windsurf setup
│           ├── cline.mdx                ← Cline (VS Code) setup
│           ├── continue.mdx             ← Continue (VS Code/JetBrains) setup
│           └── copilot.mdx              ← GitHub Copilot CLI setup
├── specra.config.json                   ← TaskFlow branding + nav
└── static/
    └── favicon.svg                      ← TaskFlow icon
```

## 1. Theme — `app.css`

Activate the **Mint dark theme** override (already present but commented out in `app.css`). The Mint theme uses hue 160 (green) which is closest to TaskFlow's `#69fd5d` brand color.

- Uncomment the Mint light theme (`:root` block, lines 15-43)
- Uncomment the Mint dark theme (`.dark` block, lines 175-203)
- Set `defaultMode: "dark"` in `specra.config.json` since TaskFlow's brand is dark-first

## 2. Specra Config — `specra.config.json`

Update all boilerplate values:

```json
{
  "site": {
    "title": "TaskFlow",
    "description": "Local-first task and time tracking with MCP integration for AI agents",
    "url": "https://taskflow.dalmasonto.com",
    "organizationName": "dalmasonto",
    "projectName": "task_flow",
    "activeVersion": "v1.0.0"
  },
  "theme": {
    "defaultMode": "dark",
    "respectPrefersColorScheme": true
  },
  "navigation": {
    "tabGroups": [
      { "id": "guides", "label": "Guides", "icon": "book-open" },
      { "id": "agents", "label": "Agent Setup", "icon": "cpu" },
      { "id": "api", "label": "API Reference", "icon": "zap" }
    ]
  },
  "social": {
    "github": "https://github.com/dalmasonto/task_flow"
  },
  "footer": {
    "copyright": "Copyright 2025 TaskFlow. All rights reserved.",
    "branding": { "showBranding": true }
  }
}
```

## 3. Landing Page — `+page.svelte`

Port the content from `landing-page/index.html` into the Svelte component. This means converting the static HTML into Svelte with Specra components where appropriate:

- **Header**: TaskFlow logo + nav links (Docs, GitHub, Get Started)
- **Hero**: "Track Every Task. Time Every Build." tagline, install command, CTA buttons
- **Feature grid**: 31 MCP Tools, Real-Time Live Sync, Multi-Agent Collaboration, Remote Dashboard
- **Setup steps**: Simplified version showing only Claude (quick start), with a "View all agent guides" link to `/docs/v1.0.0/agents`
- **Terminal demo / screenshots**: If present in original
- **Footer**: GitHub, npm links

Key changes from original:
- Replace CDN Tailwind/Iconify with Specra's built-in Tailwind + Lucide icons
- Use Specra's `Button`, `Logo` components where applicable
- Add prominent "View setup guides for all agents" CTA linking to docs

## 4. Agent Setup Guides — MDX Pages

### 4.1 `agents/index.mdx` — Overview

Frontmatter:
```yaml
title: Agent Setup
description: Configure TaskFlow with your AI coding agent
sidebar_position: 5
icon: cpu
tab_group: agents
```

Content:
- Brief intro: TaskFlow works with any MCP-compatible agent
- Comparison table: agent name, config format, config path, approval model
- Links to each agent's dedicated page

### 4.2 Each Agent Page Structure

Every agent guide (`claude.mdx`, `codex.mdx`, etc.) follows this template:

```
---
title: <Agent Name>
description: Set up TaskFlow with <Agent Name>
sidebar_position: <N>
tab_group: agents
---

## Prerequisites
- Node.js 18+
- <Agent> installed

## Step 1: Install TaskFlow MCP Server
npm install -g @dalmasonto/taskflow-mcp

## Step 2: Configure MCP Server
<config file path and exact JSON/TOML content>

## Step 3: Set Permissions
<agent-specific approval/sandbox settings>

## Step 4: Verify
<how to test it works — run a command, check tool list>

## Troubleshooting
<common issues for this agent>
```

### 4.3 Agent-Specific Config Content

**Claude Code** (`claude.mdx`):
- Config: `~/.mcp.json` or `.mcp.json` (project)
- Format: JSON `{ "mcpServers": { "taskflow": { "command": "taskflow-mcp" } } }`
- Permissions: `~/.claude/settings.json` with `"allow": ["mcp__taskflow__*"]`
- Verify: Start Claude Code, check tools are loaded

**Codex CLI** (`codex.mdx`):
- Config: `~/.codex/config.toml`
- Format: TOML
- Key settings:
  - Top-level: `sandbox_mode = "danger-full-access"`, `approval_policy = "never"`
  - Per-server: `destructive_enabled = true`, `open_world_enabled = true`
  - Env: `TASKFLOW_DB_PATH = "/home/<user>/.taskflow/taskflow.db"`
- Note: `sandbox_mode` and `approval_policy` MUST be top-level, not under `[apps._default]`
- Verify: `codex exec "list taskflow MCP tools"`

**Cursor** (`cursor.mdx`):
- Config: `~/.cursor/mcp.json` or `.cursor/mcp.json` (project)
- Format: JSON (same schema as Claude)
- Permissions: Toggle tools in Settings > Tools & MCP
- Verify: Open Cursor, check MCP tools panel

**Windsurf** (`windsurf.mdx`):
- Config: `~/.codeium/windsurf/mcp_config.json`
- Format: JSON with optional `"alwaysAllow": []` array
- Verify: Open Windsurf, check Cascade MCP panel

**Cline** (`cline.mdx`):
- Config: `cline_mcp_settings.json` (via MCP Servers icon in Cline top bar)
- Format: JSON with optional `"alwaysAllow": []`
- Verify: Click MCP Servers icon, confirm taskflow listed

**Continue** (`continue.mdx`):
- Config: `.continue/mcpServers/taskflow.yaml` (project) or JSON
- Format: YAML or JSON
- Verify: Open Continue panel, check tools in agent mode

**GitHub Copilot CLI** (`copilot.mdx`):
- Config: `~/.copilot/mcp-config.json`
- Format: JSON with `"type": "local"` and `"tools": ["*"]`
- Verify: Run Copilot CLI, check tool list

## 5. Replace Boilerplate Docs

Replace existing Specra boilerplate content:

- `about.mdx` → "What is TaskFlow" — local-first task tracker, MCP integration, Tauri desktop app, Dexie/IndexedDB
- `getting-started.mdx` → Quick start: install, pick your agent, configure, verify
- `features.mdx` → Feature overview: 50 MCP tools, SSE sync, multi-agent, remote dashboard, time tracking
- `configuration.mdx` → MCP server config reference: env vars (`TASKFLOW_DB_PATH`, `TASKFLOW_SSE_PORT`, etc.), CLI args

Remove or repurpose:
- `components/` — remove (Specra component docs, not relevant)
- `api/` — keep but update with TaskFlow MCP tool reference
- `v2.0.0/` — remove (no v2 yet, avoid confusion)

## 6. Sidebar Navigation

The Specra sidebar is driven by frontmatter (`sidebar_position`, `tab_group`). Target structure:

**Guides tab:**
1. About
2. Getting Started
3. Features
4. Configuration

**Agent Setup tab:**
1. Overview (agents/index.mdx)
2. Claude Code
3. Codex CLI
4. Cursor
5. Windsurf
6. Cline
7. Continue
8. GitHub Copilot CLI

**API Reference tab:**
1. MCP Tools Reference (future — can list all 50 tools)

## Out of Scope

- Search functionality (keep disabled for now)
- i18n
- v2 docs
- Custom Svelte components beyond what Specra provides
- Editing `landing-page/` directory
