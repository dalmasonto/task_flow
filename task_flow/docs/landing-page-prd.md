# TaskFlow Landing Page — Product Requirements Document

**Version:** 1.0
**Date:** 2026-03-24
**Author:** Dalmas Otieno
**Status:** Draft

---

## 1. Overview

A dedicated marketing/landing page for **TaskFlow** — the local-first task and time tracking system with MCP integration for AI agents. The page should convert developers, AI power users, and productivity enthusiasts into users by showcasing the unique value proposition: **AI agents that autonomously manage your task board while you code.**

### Target Audience
- **Primary:** Developers using AI coding assistants (Claude Code, Cursor, Windsurf, Copilot)
- **Secondary:** Solo developers who want a private, local-first task tracker
- **Tertiary:** Open-source enthusiasts looking for a self-hosted alternative to Linear/Jira

### Design Direction
- Dark theme only — matches the "Neon Flux" shadcn theme of the app itself
- Space Grotesk font (same as the app)
- Accent color: `#69fd5d` (primary green), `#00fbfb` (secondary cyan)
- Minimal, high-contrast, developer-focused aesthetic
- No stock photos — only real screenshots, demo videos, and code snippets
- Responsive: desktop-first but must work on mobile

---

## 2. Page Structure & Sections

### Section 1: Hero

**Purpose:** Instant hook — communicate what TaskFlow is and why it's different in 5 seconds.

**Content:**
- **Headline:** `Your AI Agent's Task Manager`
- **Subheadline:** `Local-first task tracking with MCP integration. AI agents create tasks, track time, and manage your projects — while you code.`
- **CTA Buttons (side by side):**
  - `Download for Linux` (primary, green glow) — dropdown with .AppImage / .deb / .rpm options
  - `Install MCP Server` (secondary, outlined) — copies `npm install -g @dalmasonto/taskflow-mcp`
  - `View on GitHub` (tertiary, text link) — github.com/dalmasonto/task_flow
- **Platform badge:** `Currently available for Linux` with small icons for .deb, .rpm, .AppImage
- **Hero visual:** Full-width screenshot of the dashboard in dark mode, slightly tilted with a glow effect behind it

**Image placeholder:**
```
[HERO_IMAGE: Full dashboard screenshot — dark theme, showing task cards, sidebar, timer bar]
Recommended size: 1400x900px, PNG or WebP
```

**Video placeholder:**
```
[HERO_VIDEO: Optional — 30-second autoplay loop (muted) showing agent creating tasks live]
YouTube embed or self-hosted MP4
```

---

### Section 2: The Problem → Solution

**Purpose:** Establish the pain point and position TaskFlow as the answer.

**Layout:** Two columns — left (problem), right (solution)

**Problem column:**
- "You're using AI to write code, but still manually managing your task board"
- "Your AI agent finishes a bug fix — you still have to update Jira"
- "Context switching between code and project management kills flow"
- "Cloud-based trackers see all your data"

**Solution column:**
- "TaskFlow's MCP server gives AI agents 29 tools to manage tasks autonomously"
- "Agent fixes a bug → creates task → starts timer → marks done. You watch it happen."
- "Zero context switching — the agent tracks its own work"
- "100% local. Your data never leaves your machine."

---

### Section 3: Live Demo Video

**Purpose:** The scroll-stopper. Show, don't tell.

**Content:**
- **Section title:** `Watch an AI Agent Manage a Full Project`
- **Description:** `A Claude Code agent implements a feature from scratch — creating tasks, tracking time, debugging, logging progress, and marking work done. The TaskFlow UI updates in real-time. No human touched the task board.`
- **Embedded YouTube video** (16:9, centered, max-width 900px)

**Video placeholder:**
```
[DEMO_VIDEO: YouTube embed — full MCP agent demo, 15-20 minutes]
YouTube URL: [TO BE ADDED]
Thumbnail: Screenshot of dependency graph with tasks being created
Recommended: Add chapter markers for key moments
```

---

### Section 4: Feature Showcase

**Purpose:** Deep dive into each major feature with screenshots.

**Layout:** Alternating left-right sections (image left / text right, then swap). Each feature gets a card with:
- Icon (Material Symbols)
- Title
- 2-3 sentence description
- Screenshot

#### Feature 4.1: MCP Server — AI Agent Integration
- **Icon:** `smart_toy`
- **Title:** `29 MCP Tools for AI Agents`
- **Description:** `Install the MCP server with one command. Your AI agent gets tools for tasks, projects, timers, analytics, notifications, and debugging. It creates tasks, starts timers, logs debug breadcrumbs, and marks work done — all without human intervention.`
- **Code snippet:**
  ```bash
  npm install -g @dalmasonto/taskflow-mcp
  ```
- **Callout box:** `Works with Claude Code, Cursor, Windsurf, and any MCP-compatible client`

```
[IMAGE: Screenshot of Activity Pulse showing agent-created tasks with timer_started/timer_stopped events]
Recommended size: 800x500px
```

#### Feature 4.2: Real-Time Live Sync (SSE)
- **Icon:** `sync`
- **Title:** `Watch Your Board Update in Real-Time`
- **Description:** `The MCP server broadcasts every change via Server-Sent Events. Agent writes to SQLite → SSE fires → Tauri app updates IndexedDB → UI re-renders instantly. You see tasks appear, timers start, and status changes — live.`

```
[IMAGE: GIF or screenshot showing a task appearing live in the UI while agent works in terminal]
Recommended: Animated GIF, 800x400px
```

#### Feature 4.3: Dependency Graph
- **Icon:** `account_tree`
- **Title:** `Visual Task Dependencies`
- **Description:** `Tasks have dependencies. Dependencies have a graph. Interactive DAG visualization with automatic cycle detection, project nodes as root anchors, drag/zoom, and a side panel for task details. It won't let you create loops.`

```
[IMAGE: Screenshot of dependency graph with project nodes and task connections]
Recommended size: 900x600px
```

#### Feature 4.4: Multiple Concurrent Timers
- **Icon:** `timer`
- **Title:** `Track Time Across Multiple Tasks`
- **Description:** `Work on 3 tasks at once. Pause one, stop another, mark it done. Every session is logged with precise timestamps. The floating timer bar shows all active sessions at a glance.`

```
[IMAGE: Screenshot of floating timer bar with 2-3 active sessions]
Recommended size: 800x200px (wide bar)
```

#### Feature 4.5: Activity Pulse
- **Icon:** `monitoring`
- **Title:** `Complete Activity Trail`
- **Description:** `Every action is logged: task creation, status changes, timer events, debug logs, dependency changes. AI agents use the log_debug tool to leave markdown-formatted breadcrumbs — hypotheses, errors, findings — visible with a yellow bug icon.`

```
[IMAGE: Screenshot of Activity Pulse with debug_log entries and timer events]
Recommended size: 800x600px
```

#### Feature 4.6: Built-in Terminal
- **Icon:** `terminal`
- **Title:** `Command-Line Power`
- **Description:** `Ctrl+K opens a full terminal with autocomplete, command history, and ANSI color support. Create tasks, start timers, navigate — all without touching the mouse. Built on xterm.js.`

```
[IMAGE: Screenshot of terminal open with task detail visible]
Recommended size: 800x500px
```

#### Feature 4.7: Analytics Dashboard
- **Icon:** `analytics`
- **Title:** `Understand How You Work`
- **Description:** `6 charts tracking your real work patterns: activity heatmap, focus by day of week, status distribution, time per project, deep work ratio, and burndown. Not vanity metrics — actionable insights.`

```
[IMAGE: Screenshot of analytics page with charts]
Recommended size: 900x600px
```

#### Feature 4.8: Execution Timeline
- **Icon:** `view_timeline`
- **Title:** `Gantt-Style Work Sessions`
- **Description:** `See every timer session laid out on a horizontal timeline. Color-coded by task, zoomable, with duration labels. Understand when you worked, for how long, and on what.`

```
[IMAGE: Screenshot of execution timeline with colored sessions]
Recommended size: 900x300px (wide timeline)
```

#### Feature 4.9: Desktop Notifications
- **Icon:** `notifications`
- **Title:** `Native Desktop Alerts`
- **Description:** `Get notified when tasks are completed, timers stop, or AI agents need your attention. Powered by Tauri's native notification system — no browser tab required.`

```
[IMAGE: Screenshot of desktop notification appearing]
Recommended size: 400x200px
```

---

### Section 5: How It Works (Setup Guide)

**Purpose:** Remove friction. Show exactly how to get started.

**Layout:** Numbered steps with code blocks and icons.

#### Step 1: Install the Desktop App
- **Title:** `Download TaskFlow`
- **Description:** `Choose your Linux distribution format:`
- **Download buttons (3 side-by-side cards):**

  **Card 1: AppImage**
  ```
  [DOWNLOAD_BUTTON: .AppImage]
  Icon: package_2
  Label: "AppImage"
  Subtitle: "Universal — run anywhere"
  URL: [TO BE ADDED]
  ```

  **Card 2: .deb**
  ```
  [DOWNLOAD_BUTTON: .deb]
  Icon: install_desktop
  Label: "Debian / Ubuntu"
  Subtitle: ".deb package"
  URL: [TO BE ADDED]
  ```

  **Card 3: .rpm**
  ```
  [DOWNLOAD_BUTTON: .rpm]
  Icon: install_desktop
  Label: "Fedora / RHEL"
  Subtitle: ".rpm package"
  URL: [TO BE ADDED]
  ```

- **Platform note:** `Currently supported on Linux (x86_64). macOS and Windows coming soon.`

#### Step 2: Install the MCP Server
- **Title:** `Connect Your AI Agent`
- **Code block:**
  ```bash
  # Install globally
  npm install -g @dalmasonto/taskflow-mcp

  # Add to your Claude Code config (~/.claude.json)
  {
    "mcpServers": {
      "taskflow": {
        "command": "taskflow-mcp",
        "args": []
      }
    }
  }
  ```
- **Note:** `The MCP server runs on stdio transport for Claude Code and HTTP/SSE for the desktop app. Both modes work simultaneously.`

#### Step 3: Start Working
- **Title:** `Your Agent Takes Over`
- **Description:** `Open your AI coding assistant and start working. The agent will automatically:`
  - Create tasks for features, bugs, and improvements
  - Start timers before coding
  - Log debug breadcrumbs while investigating issues
  - Mark tasks done when work is complete
  - Check dependencies before starting blocked work

```
[IMAGE: Screenshot of Claude Code terminal + TaskFlow UI side by side, showing agent creating a task]
Recommended size: 1200x600px (wide split view)
```

---

### Section 6: Architecture Overview

**Purpose:** Build credibility with technical users. Show this is a real, well-architected system.

**Layout:** Diagram + bullet points

**Diagram placeholder:**
```
[ARCHITECTURE_DIAGRAM: Visual showing the data flow]

Claude Code / Cursor / Windsurf
        │ (MCP stdio)
        ▼
  taskflow-mcp (npm package)
   ├── SQLite (~/.taskflow/taskflow.db)
   ├── SSE broadcast (port 3456)
   │       │
   │       ▼
   │   Tauri Desktop App
   │    ├── useSync hook
   │    ├── IndexedDB (Dexie.js)
   │    └── React UI (shadcn/ui)
   │
   └── HTTP API (same port)
        └── /sync, /api/*

Recommended: Create this as an SVG or clean diagram
```

**Tech stack badges (horizontal row):**
- React 19
- TypeScript
- Dexie.js
- SQLite (better-sqlite3)
- Tauri v2
- shadcn/ui
- Recharts
- @xyflow/react
- xterm.js
- SSE (Server-Sent Events)
- MCP Protocol

---

### Section 7: MCP Tools Reference (Collapsible)

**Purpose:** Show the depth of the MCP integration.

**Layout:** Collapsible accordion, grouped by domain.

| Domain | Tools | Count |
|--------|-------|-------|
| Tasks | create_task, list_tasks, get_task, update_task, update_task_status, delete_task, bulk_create_tasks, search_tasks | 8 |
| Projects | create_project, list_projects, get_project, update_project, delete_project, search_projects | 6 |
| Timer | start_timer, pause_timer, stop_timer, list_sessions | 4 |
| Analytics | get_analytics, get_timeline | 2 |
| Activity | get_activity_log, clear_activity_log, log_debug | 3 |
| Notifications | list_notifications, mark_notification_read, mark_all_notifications_read, clear_notifications | 4 |
| Settings | get_setting, update_setting | 2 |
| Agent | get_agent_instructions, clear_data | 2 |

**Total: 31 tools**

**Callout:** `The MCP server includes built-in agent instructions — your AI agent learns how to use TaskFlow automatically on first connection. No prompt engineering required.`

---

### Section 8: Demo Video Gallery

**Purpose:** Show different aspects of the app in short clips.

**Layout:** Grid of 3-4 video cards, each with:
- Thumbnail
- Title
- Duration badge
- YouTube embed on click

**Video placeholders:**
```
[VIDEO_CARD_1: "Full Agent Demo — Feature Implementation"]
YouTube URL: [TO BE ADDED]
Duration: ~20 min
Thumbnail: Dependency graph screenshot

[VIDEO_CARD_2: "Setting Up TaskFlow + MCP in 2 Minutes"]
YouTube URL: [TO BE ADDED]
Duration: ~2 min
Thumbnail: Terminal with npm install command

[VIDEO_CARD_3: "Live Sync — Watching the Board Update"]
YouTube URL: [TO BE ADDED]
Duration: ~3 min
Thumbnail: Side-by-side Claude Code + TaskFlow UI

[VIDEO_CARD_4: "Dependency Graph Deep Dive"]
YouTube URL: [TO BE ADDED]
Duration: ~5 min
Thumbnail: Full dependency graph with project nodes
```

---

### Section 9: Performance & Token Efficiency

**Purpose:** Show that the MCP server is optimized for AI agent workflows — not a token hog.

**Content:**
- **Title:** `Optimized for AI Context Windows`
- **Description:** `TaskFlow's MCP server is designed to minimize token usage. Compact responses, null suppression, and condensed agent instructions mean your AI has more context for reasoning — not wasted on bloated payloads.`

**Stats cards (3 side-by-side):**

| Card | Metric | Value |
|------|--------|-------|
| 1 | Token reduction (v1.0.0 → v1.0.4) | **61% fewer tokens** |
| 2 | list_tasks (compact vs full) | **72% smaller** |
| 3 | Agent instructions | **57% condensed** |

**Code comparison (before/after):**
```json
// v1.0.0 — list_tasks response per task (~360 chars)
{
  "id": 42,
  "title": "Build dependency graph",
  "description": "## Goal\nVisualize task dependencies...",
  "status": "done",
  "priority": "high",
  "project_id": 13,
  "dependencies": [38, 39],
  "links": [],
  "tags": ["frontend"],
  "due_date": null,
  "estimated_time": null,
  "created_at": "2026-03-23T14:56:26.684Z",
  "updated_at": "2026-03-23T19:48:41.810Z"
}

// v1.0.4 — same task (~100 chars)
{
  "id": 42,
  "title": "Build dependency graph",
  "status": "done",
  "priority": "high",
  "project_id": 13,
  "dependencies": [38, 39],
  "tags": ["frontend"]
}
```

---

### Section 10: Open Source CTA

**Purpose:** Drive GitHub engagement.

**Layout:** Centered, clean, high-contrast.

**Content:**
- **Title:** `Open Source. Fork It. Ship It.`
- **Description:** `TaskFlow is MIT-licensed. The code is clean, the PRs are reviewed, and contributions are welcome.`
- **CTA Buttons:**
  - `Star on GitHub` (primary) — github.com/dalmasonto/task_flow
  - `npm: @dalmasonto/taskflow-mcp` (secondary) — npmjs.com/package/@dalmasonto/taskflow-mcp
- **GitHub stats badges:** Stars, Forks, npm downloads (dynamic)
- **Contribution callout:** `Found a bug? Want a feature? Open a PR — I review everything.`

---

### Section 11: Footer

**Content:**
- TaskFlow logo + tagline: `Local-first task tracking for AI-powered development`
- Links: GitHub, npm, Twitter/X (@dalmasonto), License (MIT)
- **Download buttons repeated** (AppImage, .deb, .rpm)
- `Built by Dalmas Otieno`
- Copyright notice

---

## 3. Download Configuration

### Download URLs (to be updated after builds are uploaded)

```yaml
appimage:
  label: "TaskFlow.AppImage"
  url: "[YOUR_SERVER]/downloads/TaskFlow-1.0.0-x86_64.AppImage"
  size: "~80 MB"
  checksum_url: "[YOUR_SERVER]/downloads/TaskFlow-1.0.0-x86_64.AppImage.sha256"

deb:
  label: "taskflow_1.0.0_amd64.deb"
  url: "[YOUR_SERVER]/downloads/taskflow_1.0.0_amd64.deb"
  size: "~60 MB"
  install_cmd: "sudo dpkg -i taskflow_1.0.0_amd64.deb"

rpm:
  label: "taskflow-1.0.0-1.x86_64.rpm"
  url: "[YOUR_SERVER]/downloads/taskflow-1.0.0-1.x86_64.rpm"
  size: "~60 MB"
  install_cmd: "sudo rpm -i taskflow-1.0.0-1.x86_64.rpm"
```

### Platform Support Matrix

| Platform | Status | Format |
|----------|--------|--------|
| Linux (x86_64) | **Supported** | .AppImage, .deb, .rpm |
| macOS (Intel) | Planned | .dmg |
| macOS (Apple Silicon) | Planned | .dmg |
| Windows | Planned | .msi, .exe |

---

## 4. Image & Video Checklist

### Screenshots Needed (14 total)

| # | Screenshot | Section | Priority |
|---|-----------|---------|----------|
| 1 | Dashboard overview (dark theme, populated) | Hero | Critical |
| 2 | Activity Pulse with debug logs and timer events | Feature 4.1, 4.5 | Critical |
| 3 | Dependency graph with project nodes | Feature 4.3 | Critical |
| 4 | Floating timer bar with 2-3 active sessions | Feature 4.4 | High |
| 5 | Terminal open with task output | Feature 4.6 | High |
| 6 | Analytics page with all 6 charts | Feature 4.7 | High |
| 7 | Execution timeline with colored sessions | Feature 4.8 | High |
| 8 | Task detail page (markdown description, sessions, activity log) | General | Medium |
| 9 | Project detail page | General | Medium |
| 10 | Desktop notification appearing | Feature 4.9 | Medium |
| 11 | Claude Code + TaskFlow side-by-side | Setup Step 3 | Critical |
| 12 | Live sync GIF (task appearing in UI) | Feature 4.2 | High |
| 13 | Settings page | General | Low |
| 14 | Bulk task creation | General | Low |

### Videos Needed (4 total)

| # | Video | Duration | Priority |
|---|-------|----------|----------|
| 1 | Full agent demo — feature implementation | 15-20 min | Critical |
| 2 | Quick setup tutorial | 2 min | High |
| 3 | Live sync showcase | 3 min | High |
| 4 | Dependency graph deep dive | 5 min | Medium |

---

## 5. SEO & Meta

```html
<title>TaskFlow — AI-Powered Task Tracking for Developers</title>
<meta name="description" content="Local-first task and time tracking with MCP integration. AI agents create tasks, track time, and manage projects autonomously. Open source, private, no cloud." />
<meta name="keywords" content="task manager, MCP, AI agent, Claude Code, Cursor, local-first, developer tools, time tracking, Tauri, open source" />

<!-- Open Graph -->
<meta property="og:title" content="TaskFlow — Your AI Agent's Task Manager" />
<meta property="og:description" content="29 MCP tools for AI agents to manage tasks, track time, and debug — while you code." />
<meta property="og:image" content="[OG_IMAGE: Dashboard screenshot, 1200x630px]" />
<meta property="og:url" content="[LANDING_PAGE_URL]" />

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:creator" content="@dalmasonto" />
```

---

## 6. Technical Notes for Implementation

- **Framework:** Can be built as a standalone page (Next.js/Astro) or as a route within the existing Vite app
- **Animations:** Use Framer Motion for scroll-triggered reveals on feature cards
- **Code blocks:** Use Shiki or Prism for syntax highlighting in setup guide
- **Download buttons:** Should detect browser (not OS, since Linux-only for now) and pre-select the most common format
- **Video embeds:** Use lite-youtube-embed for performance (lazy-loads YouTube iframe)
- **Analytics:** Add Plausible or Umami for privacy-respecting analytics
- **Hosting:** Static site — deploy to Vercel, Netlify, or Cloudflare Pages

---

## 7. Content Tone

- **Direct.** No marketing fluff. Developers can smell it.
- **Show, don't tell.** Every claim has a screenshot or code block.
- **Technical depth.** Don't dumb it down — the audience writes code.
- **Honest about limitations.** "Linux only for now" is a feature (transparency), not a weakness.
- **Open source pride.** MIT license, PRs welcome, code is clean.

---

## 8. Success Metrics

- GitHub stars after landing page launch
- npm weekly downloads of @dalmasonto/taskflow-mcp
- Download counts (AppImage/deb/rpm) from server logs
- Time on page > 2 minutes (indicates actual reading)
- Video play rate on the demo video
