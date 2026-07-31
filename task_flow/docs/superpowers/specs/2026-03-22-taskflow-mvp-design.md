# TaskFlow MVP — Design Specification

## 1. Overview

TaskFlow is a local-first task execution system optimized for focus, dependency awareness, and time accountability. Built with Vite + React 19, it uses Dexie.js (IndexedDB) for persistent storage with reactive hooks, React Router for navigation, and shadcn/ui components themed to the "Neon Flux" (Kinetic Terminal) design system.

**Core philosophy:** Tasks are the atomic unit. Execution over planning. Multiple tasks can run concurrently — blocking only applies to dependency-linked tasks.

---

## 2. Tech Stack

| Concern | Choice |
|---|---|
| Framework | React 19 + Vite |
| Routing | React Router |
| Data / State | Dexie.js + dexie-react-hooks (no Zustand) |
| UI Components | shadcn/ui (Radix) themed to Neon Flux |
| Icons | Material Symbols Outlined (nav/pages) + Lucide (shadcn internals) |
| Font | Space Grotesk |
| Charts | Recharts |
| Dependency Graph | @xyflow/react + dagre |
| Markdown | react-markdown + remark-gfm |
| Notifications | Web Notifications API |
| Desktop (future) | Tauri |
| Styling | Tailwind v4, 0px border-radius, dark-and-light modes |

---

## 3. Project Structure

```
src/
├── db/              # Dexie database, tables, migrations
├── components/      # Shared UI (sidebar, header, task-card, timer-bar)
│   └── ui/          # shadcn primitives
├── routes/          # One file per page
├── hooks/           # useLiveQuery wrappers, useTimer, useNotifications
├── lib/             # DAG validation, time formatting, theme config
└── types/           # Task, Project, Session TypeScript types
```

---

## 4. Data Model

### 4.1 Dexie Schema

```typescript
class TaskFlowDB extends Dexie {
  tasks!: Table<Task>;
  projects!: Table<Project>;
  sessions!: Table<Session>;
  settings!: Table<Setting>;
}

// Tables & indexes
tasks:    '++id, projectId, status, *dependencies'
projects: '++id, name'
sessions: '++id, taskId, start, end'
settings: '++id, key'
```

### 4.2 Types

```typescript
type TaskStatus = 'not_started' | 'in_progress' | 'paused' | 'blocked' | 'partial_done' | 'done';

type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

interface Task {
  id?: number;
  title: string;
  description?: string;       // markdown string
  status: TaskStatus;
  priority: TaskPriority;
  projectId?: number;
  dependencies: number[];     // IDs of tasks this depends on
  links?: string[];           // external URLs
  tags?: string[];            // metadata tags
  dueDate?: Date;
  estimatedTime?: number;     // estimated ms
  createdAt: Date;
  updatedAt: Date;
  // NOTE: totalTime is NOT stored — always computed from sessions
}

interface Project {
  id?: number;
  name: string;
  color: string;              // hex color
  description?: string;       // markdown string
  createdAt: Date;
}

interface Session {
  id?: number;
  taskId: number;
  start: Date;
  end?: Date;
  // duration is always computed: end - start (or now - start if active)
  // No stored duration field — prevents desync on crashes/refreshes
}

// Known settings keys and their value types
interface SettingsMap {
  timerBarDisplayMode: 'carousel' | 'expanded';
  notificationInterval: number;           // minutes, default 30
  statusColors: Record<TaskStatus, string>; // hex colors per status
  glowIntensity: number;                  // 0-100
  backdropBlur: number;                   // px
  shadowSpread: number;                   // px
}

interface Setting {
  id?: number;
  key: keyof SettingsMap;
  value: SettingsMap[keyof SettingsMap];
}
```

### 4.3 Custom Hooks

- `useTasks(filter?)` — all tasks or filtered by project/status
- `useTask(id)` — single task with its sessions
- `useProjects()` / `useProject(id)`
- `useSessions(taskId?)` — session history
- `useActiveSessions()` — all currently running sessions (no `end` date)
- `useTaskTotalTime(taskId)` — computed: sum of completed session durations + elapsed active session
- `useAnalytics(dateRange)` — aggregated time/completion data

### 4.4 Description Fields

Task and project descriptions store raw markdown strings. Rendered at the component level using `react-markdown` + `remark-gfm`. Edit mode uses a textarea with a preview toggle.

---

## 5. Routing

```
/                    → redirect to /dashboard
/dashboard           → Main Dashboard (task columns by status)
/projects            → Project list / grid
/projects/new        → Create Project form
/tasks/new           → Create Task form
/tasks/:id           → Task Detail view
/analytics           → Analytics dashboard
/analytics/timeline  → Execution Timeline
/projects/:id        → Project Detail / Edit
/dependencies        → Dependency Graph
/archive             → Archived / completed tasks
/settings            → Configuration / Theme page
```

---

## 6. Layout Shell

```
<RootLayout>
├── <AppSidebar />                    ← shadcn Sidebar (collapsible)
├── <SidebarInset>
│   ├── <Header />                    ← sticky, SidebarTrigger + search + icons
│   ├── <Outlet />                    ← route content swaps here
│   └── <FloatingTimerBar />          ← fixed bottom, active sessions
</RootLayout>
```

### 6.1 Sidebar Navigation

Uses the shadcn Sidebar component, styled to match Neon Flux. Items:

1. Terminal (Dashboard) — `terminal` icon
2. Projects — `grid_view` icon
3. Analytics — `insights` icon
4. Dependencies — `account_tree` icon
5. Archive — `archive` icon
6. **NEW TASK** button at bottom

Active item: cyan text + left-2 border cyan + darker background.
Hover: text shifts to cyan, subtle background shift.

### 6.2 Header

Sticky top bar inside `SidebarInset`:
- Left: `SidebarTrigger` (shadcn toggle) + search input (Neon Flux styled: `surface-container-low` bg, bottom border only, uppercase tracking)
- Right: notifications icon, settings link (navigates to `/settings`), user avatar placeholder

### 6.3 Floating Timer Bar

Fixed bottom bar showing active sessions. Two display modes:

**Default (carousel):** Single session visible, chevron navigation to cycle through active sessions.
```
[ ◀ ]  [ ▶ Task Name  00:12:44 | ⏸ ]  [ ▶ ]    (2/3)
```

**Expanded (toggle):** All active sessions stacked/visible.
```
[ ▶ Buy Domain     00:12:44 | ⏸ ]
[ ▶ Deploy Site    00:42:15 | ⏸ ]
```

Display mode preference stored in `settings` table. Bar only visible when at least one session is active.

---

## 7. Neon Flux Theme

### 7.1 CSS Variable Overrides

Dark-only theme. Replace shadcn's default `:root` and `.dark` blocks with unified values:

```css
:root {
  --background: #0e0e0e;
  --foreground: #ffffff;
  --card: #1a1a1a;
  --card-foreground: #ffffff;
  --popover: #262626;
  --popover-foreground: #ffffff;
  --primary: #de8eff;
  --primary-foreground: #4f006e;
  --secondary: #00fbfb;
  --secondary-foreground: #005c5c;
  --muted: #1a1a1a;
  --muted-foreground: #adaaaa;
  --accent: #20201f;
  --accent-foreground: #ffffff;
  --destructive: #ff6e84;
  --border: rgba(222, 142, 255, 0.2);
  --input: #131313;
  --ring: #de8eff;
  --radius: 0px;

  --sidebar: #131313;
  --sidebar-foreground: #adaaaa;
  --sidebar-primary: #de8eff;
  --sidebar-primary-foreground: #4f006e;
  --sidebar-accent: #1a1a1a;
  --sidebar-accent-foreground: #00fbfb;
  --sidebar-border: rgba(222, 142, 255, 0.1);
  --sidebar-ring: #de8eff;
}
```

### 7.2 Additional Custom Tokens

```css
--color-tertiary: #69fd5d;
--color-tertiary-foreground: #005e07;
--color-surface-container-low: #131313;
--color-surface-container-high: #20201f;
--color-surface-variant: #262626;
--color-outline-variant: #484847;
--color-primary-dim: #b90afc;
--color-error-dim: #d73357;
```

### 7.3 Font

Replace Geist with Space Grotesk. Update `--font-sans` and `--font-heading`.

### 7.4 Global Utility Classes

- `.glow-primary` / `.glow-secondary` / `.glow-tertiary` — `box-shadow: 0 0 15px` with accent color at 30% opacity
- `.pulse-active` — opacity animation 40% to 100% for kinetic indicators
- Custom scrollbar: thin (4px), purple-tinted thumb
- `::selection` — primary background

### 7.5 Design Rules

- **0px border-radius** on all elements (handled by `--radius: 0px`)
- **No standard borders** for sectioning — use ghost borders (accent at 20% opacity) or tonal background shifts
- **Neon glows** reserved for active/high-priority elements only
- **Material Symbols Outlined** for navigation and page-level icons

---

## 8. Pages

### 8.1 Dashboard (`/dashboard`)

Source: `main_dashboard.html`

- Header stats row: throughput %, active nodes count, uptime (from `useAnalytics`)
- Task board with filterable/groupable views — all 6 statuses are available as filters, users can group by status or project
- Default view shows tasks grouped by status columns, each column representing one of the 6 states
- Each group queries `useTasks({ status })` via `useLiveQuery`
- Task cards: status-colored left border, progress bar, project color indicator
- Click card → navigate to `/tasks/:id`

### 8.2 Create Task (`/tasks/new`)

Source: `create_task.html`

- Left column: title input, description textarea (markdown), project select, status select
- Right column: dependency picker (searchable list of existing tasks), priority indicator, time estimate
- Submit validates DAG (no cycles) before inserting to Dexie
- Primary action button: "INITIALIZE_TASK_SEQUENCE"

### 8.3 Task Details (`/tasks/:id`)

Source: `task_details.html`

- Hero: status badge (colored), priority badge, large title
- Metadata grid: project, due date, estimation, priority
- Description: rendered markdown (`react-markdown` + `remark-gfm`) with edit toggle
- Dependencies: blocking/blocked-by cards with status indicators
- Right sidebar: session timeline from `useSessions(taskId)`
- Tags / metadata display

### 8.4 Create Project (`/projects/new`)

Source: `create_project.html`

- Form: name input, description textarea (markdown), color picker (preset neon swatches + custom hex input)
- Live preview panel: shows task card appearance with selected color
- Primary action: "DEPLOY_PROJECT"

### 8.5 Projects List (`/projects`)

- Grid of project cards with color accent border, task count, completion percentage
- Derived from sidebar "Projects" concept (no dedicated HTML mockup)

### 8.6 Analytics (`/analytics`)

Source: `analytics.html`

- Top metrics row: total focused time, tasks completed, focus velocity
- Status distribution donut chart (Recharts `PieChart`)
- Project time allocation horizontal bars (Recharts `BarChart`)
- System activity pulse timeline (vertical timeline component)

### 8.7 Execution Timeline (`/analytics/timeline`)

Source: `execution_timeline.html`

- Stats row: weekly output, deep work ratio, tasks completed, blocked time
- Stacked bar chart by day (Recharts `BarChart` stacked)
- Live session stream table: status, task ID, project, start time, duration, intensity

### 8.8 Dependency Graph (`/dependencies`)

Source: `preffered_dependency_graph.html` (adapted to Neon Flux theme)

- Full-canvas interactive graph using `@xyflow/react`
- Nodes: task cards with status-colored left border, progress bar, task ID
- Edges: SVG arrows between dependent tasks, colored by status
- Layout: dagre algorithm for automatic DAG positioning
- Floating legend: status color dots
- Floating toolbar: zoom in/out, fit to view
- Right detail panel: selected node properties, metadata, dependency chain
- Dot-grid background pattern

### 8.9 Configuration (`/settings`)

Source: `configurations.html`

- Status color channel editors: color input per task status with hex display
- Glow intensity slider (photon emission control)
- Backdrop blur and shadow spread settings
- Live component preview: task card and buttons update in real-time
- "COMMIT TO CORE" save button, "RESET TO DEFAULTS" button

---

## 9. State Machine

### 9.1 Valid Transitions

```
not_started  → in_progress, blocked
in_progress  → paused, blocked, partial_done, done
paused       → in_progress, blocked, partial_done, done
blocked      → not_started, in_progress (when blocker resolved)
partial_done → in_progress, done
done         → in_progress (reopen)
```

### 9.2 Rules

- Starting a timer automatically transitions `not_started` or `paused` → `in_progress`
- Pausing a timer transitions `in_progress` → `paused`
- A task can only be set to `blocked` if it has unresolved dependencies
- `partial_done` indicates meaningful progress but not completion — user sets this manually
- `done` → `in_progress` is allowed (reopening a task) and creates a new session
- All transitions update `task.updatedAt`

---

## 10. Timer System

### 10.1 Multiple Concurrent Sessions

- Any number of tasks can be `in_progress` simultaneously
- Each running task has its own active `Session` record
- Starting a task creates a `Session` with `start: new Date()`, no `end`
- Pausing closes the session: `end: new Date()` (duration computed as `end - start`)

### 10.2 Blocking Rules

- Only dependency-linked tasks enforce blocking
- If Task B depends on Task A and A is not `done`, Task B cannot be started
- UI disables play button and shows the blocking task
- Independent tasks run freely in parallel

### 10.3 Total Time Calculation

```
totalTime = sum of all completed session durations + (now - activeSession.start)
```

Each play/pause cycle creates a separate `Session` row. All sessions for a task sum to its `totalTime`.

### 10.4 Timer Display

Uses `setInterval(1000)` calculating elapsed time from the stored `session.start` timestamp — no drift accumulation.

---

## 11. Dependency System (DAG)

- Tasks declare dependencies via `dependencies: number[]` (IDs of upstream tasks)
- Adding a dependency runs cycle detection: DFS from target task back through the dependency graph
- If a cycle is detected, the dependency is rejected with user feedback
- Completing a blocking task can auto-unblock downstream tasks (with user prompt)
- `lib/dag.ts` contains pure logic: `hasCycle()`, `getBlockers()`, `getDependents()`

---

## 12. Notification System

- Web Notifications API (`Notification.requestPermission()`)
- Configurable interval stored in `settings` table (default: 30 min)
- When any session is active: fires notification per interval
- Message: `"You are working on: {task.title} ({project.name})"`
- Future: Tauri native notifications

---

## 13. Search

The header search input searches across tasks and projects:
- Searches `title` and `description` fields
- Results displayed as a dropdown list grouped by type (Tasks / Projects)
- Clicking a result navigates to the detail page
- Title-match first, then description substring match
- Client-side filtering via Dexie queries (no full-text index needed for MVP scale)

---

## 14. Empty States

First-run and empty-data states for key pages:
- **Dashboard (no tasks):** "No tasks yet" with prominent NEW TASK button
- **Projects (no projects):** "Create your first project" with CREATE_PROJECT action
- **Analytics (no sessions):** "Start tracking to see analytics" with muted chart placeholders
- **Dependency Graph (no dependencies):** "No dependencies mapped" with instruction text

---

## 15. Design Reference Notes

- `preffered_dependency_graph.html` uses a different color palette (blue/slate). Only the layout and component structure should be used — all colors must be replaced with Neon Flux tokens.
- `dependency_graph.html` is superseded by the preferred version and should be ignored.
- The HTML mockups reference "assignee" fields in several places — these are omitted from the spec since TaskFlow is a single-user app per the PRD.

---

## 16. MVP Scope

### In Scope
- Task CRUD with markdown descriptions
- Project CRUD with color assignment
- Task state machine (6 states)
- Multiple concurrent timers with play/pause/stop
- Session recording and total time accumulation
- Dependency linking with DAG validation
- Dependency graph visualization
- Analytics dashboard with charts
- Execution timeline
- Configurable status colors
- Web notifications
- Floating timer bar (carousel + expanded modes)

### Out of Scope
- Team collaboration / multiple users
- Cloud sync / real-time sync
- Mobile app
- Rich text editor (markdown textarea + preview is sufficient)
- Complex workflow automation
