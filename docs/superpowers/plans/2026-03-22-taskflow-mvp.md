# TaskFlow MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first task execution app with concurrent timers, DAG dependencies, analytics, and a Neon Flux themed UI using shadcn/ui components.

**Architecture:** Flat route structure with React Router wrapping a persistent sidebar layout. Dexie.js provides reactive IndexedDB storage via `useLiveQuery` hooks — no intermediate state management. All UI components are shadcn/ui primitives themed to the Neon Flux dark-and-light design system.

**Tech Stack:** React 19, Vite, TypeScript, Dexie.js + dexie-react-hooks, React Router, shadcn/ui (Radix), Tailwind v4, Recharts, @xyflow/react, react-markdown, Space Grotesk font, Material Symbols Outlined icons.

**Spec:** `docs/superpowers/specs/2026-03-22-taskflow-mvp-design.md`

**Design references:** `designs/pages/*.html` for visual targets, `designs/design-docs/DESIGN.md` for color/typography rules.

---

## File Map

### New files to create

```
src/
├── types/
│   └── index.ts                    # Task, Project, Session, Setting types + TaskStatus, TaskPriority
├── db/
│   └── database.ts                 # Dexie DB class, table definitions, migrations
├── hooks/
│   ├── use-tasks.ts                # useTasks, useTask
│   ├── use-projects.ts             # useProjects, useProject
│   ├── use-sessions.ts             # useSessions, useActiveSessions, useTaskTotalTime
│   ├── use-settings.ts             # useSetting, useSettings
│   ├── use-analytics.ts             # useAnalytics — aggregated time/completion data
│   ├── use-timer.ts                # useTimer — manages setInterval tick for active sessions
│   └── use-notifications.ts        # useNotifications — Web Notification API wrapper
├── lib/
│   ├── dag.ts                      # hasCycle, getBlockers, getDependents
│   ├── time.ts                     # formatDuration, formatTime helpers
│   ├── status.ts                   # status colors, labels, transition validation
│   └── constants.ts                # default settings, status color map
├── components/
│   ├── app-sidebar.tsx             # MODIFY — replace sample data with TaskFlow nav
│   ├── app-header.tsx              # Sticky header with SidebarTrigger + search + icons
│   ├── floating-timer-bar.tsx      # Fixed bottom bar — carousel/expanded active sessions
│   ├── root-layout.tsx             # SidebarProvider + Sidebar + SidebarInset + Header + Outlet + TimerBar
│   ├── task-card.tsx               # Reusable task card (dashboard, project detail, archive)
│   ├── markdown-renderer.tsx       # react-markdown + remark-gfm wrapper
│   ├── markdown-editor.tsx         # Textarea + preview toggle
│   ├── status-badge.tsx            # Colored status indicator
│   ├── priority-badge.tsx          # Priority indicator
│   ├── empty-state.tsx             # Reusable empty state component
│   └── dependency-picker.tsx       # Searchable task dependency selector
├── routes/
│   ├── dashboard.tsx               # Main task board — filterable by status/project
│   ├── create-task.tsx             # Create task form
│   ├── task-detail.tsx             # Task detail view + timer controls
│   ├── projects.tsx                # Project list/grid
│   ├── create-project.tsx          # Create project form
│   ├── project-detail.tsx          # Project detail/edit
│   ├── analytics.tsx               # Analytics dashboard with charts
│   ├── execution-timeline.tsx      # Execution timeline — charts + session table
│   ├── dependency-graph.tsx        # @xyflow/react dependency DAG
│   ├── archive.tsx                 # Archived/completed tasks
│   └── settings.tsx                # Configuration page
```

### Files to modify

```
src/index.css                       # Replace theme variables with Neon Flux palette (dark + light)
src/main.tsx                        # Add React Router BrowserRouter
src/App.tsx                         # Replace with router setup + root layout
src/components/app-sidebar.tsx      # Replace sample data with TaskFlow navigation
```

---

## Phase 1: Foundation (Types, DB, Theme, Layout)

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime dependencies**

```bash
npm install dexie dexie-react-hooks react-router react-markdown remark-gfm recharts @xyflow/react dagre @fontsource-variable/space-grotesk
```

- [ ] **Step 2: Install dev dependencies**

```bash
npm install -D @types/dagre vitest @testing-library/react @testing-library/jest-dom jsdom
```

- [ ] **Step 3: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

Create `src/test-setup.ts`:

```typescript
import '@testing-library/jest-dom'
```

- [ ] **Step 4: Add test script to package.json**

Add to scripts: `"test": "vitest run", "test:watch": "vitest"`

- [ ] **Step 5: Verify installation**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test-setup.ts
git commit -m "chore: install dependencies for TaskFlow MVP"
```

---

### Task 2: Define TypeScript types

**Files:**
- Create: `src/types/index.ts`

- [ ] **Step 1: Create types file**

```typescript
export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'paused'
  | 'blocked'
  | 'partial_done'
  | 'done'

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'

export interface Task {
  id?: number
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  projectId?: number
  dependencies: number[]
  links?: string[]
  tags?: string[]
  dueDate?: Date
  estimatedTime?: number
  createdAt: Date
  updatedAt: Date
}

export interface Project {
  id?: number
  name: string
  color: string
  description?: string
  createdAt: Date
}

export interface Session {
  id?: number
  taskId: number
  start: Date
  end?: Date
}

export interface SettingsMap {
  timerBarDisplayMode: 'carousel' | 'expanded'
  notificationInterval: number
  statusColors: Record<TaskStatus, string>
  glowIntensity: number
  backdropBlur: number
  shadowSpread: number
}

export interface Setting {
  id?: number
  key: keyof SettingsMap
  value: SettingsMap[keyof SettingsMap]
}

// Valid state transitions
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  not_started: ['in_progress', 'blocked'],
  in_progress: ['paused', 'blocked', 'partial_done', 'done'],
  paused: ['in_progress', 'blocked', 'partial_done', 'done'],
  blocked: ['not_started', 'in_progress'],
  partial_done: ['in_progress', 'done'],
  done: ['in_progress'],
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: define TypeScript types for Task, Project, Session, Setting"
```

---

### Task 3: Set up Dexie database

**Files:**
- Create: `src/db/database.ts`
- Test: `src/db/__tests__/database.test.ts`

- [ ] **Step 1: Write the database test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../database'

describe('TaskFlowDB', () => {
  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('should create a task', async () => {
    const id = await db.tasks.add({
      title: 'Test task',
      status: 'not_started',
      priority: 'medium',
      dependencies: [],

      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const task = await db.tasks.get(id)
    expect(task?.title).toBe('Test task')
  })

  it('should create a project', async () => {
    const id = await db.projects.add({
      name: 'Test project',
      color: '#de8eff',
      createdAt: new Date(),
    })
    const project = await db.projects.get(id)
    expect(project?.name).toBe('Test project')
  })

  it('should create a session', async () => {
    const taskId = await db.tasks.add({
      title: 'Timer task',
      status: 'in_progress',
      priority: 'medium',
      dependencies: [],

      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const sessionId = await db.sessions.add({
      taskId,
      start: new Date(),
    })
    const session = await db.sessions.get(sessionId)
    expect(session?.taskId).toBe(taskId)
    expect(session?.end).toBeUndefined()
  })

  it('should query tasks by status', async () => {
    await db.tasks.bulkAdd([
      { title: 'A', status: 'not_started', priority: 'low', dependencies: [], totalTime: 0, createdAt: new Date(), updatedAt: new Date() },
      { title: 'B', status: 'in_progress', priority: 'high', dependencies: [], totalTime: 0, createdAt: new Date(), updatedAt: new Date() },
      { title: 'C', status: 'not_started', priority: 'medium', dependencies: [], totalTime: 0, createdAt: new Date(), updatedAt: new Date() },
    ])
    const notStarted = await db.tasks.where('status').equals('not_started').toArray()
    expect(notStarted).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/database.test.ts`
Expected: FAIL — `../database` module not found.

- [ ] **Step 3: Create the database module**

```typescript
import Dexie, { type Table } from 'dexie'
import type { Task, Project, Session, Setting } from '@/types'

export class TaskFlowDB extends Dexie {
  tasks!: Table<Task>
  projects!: Table<Project>
  sessions!: Table<Session>
  settings!: Table<Setting>

  constructor() {
    super('TaskFlowDB')
    this.version(1).stores({
      tasks: '++id, projectId, status, *dependencies',
      projects: '++id, name',
      sessions: '++id, taskId, start, end',
      settings: '++id, key',
    })
  }
}

export const db = new TaskFlowDB()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db/__tests__/database.test.ts`
Expected: All 4 tests PASS. Note: requires `fake-indexeddb` for vitest. If tests fail due to missing IndexedDB, install it:

```bash
npm install -D fake-indexeddb
```

And add to `src/test-setup.ts`:

```typescript
import 'fake-indexeddb/auto'
import '@testing-library/jest-dom'
```

- [ ] **Step 5: Commit**

```bash
git add src/db/database.ts src/db/__tests__/database.test.ts src/test-setup.ts
git commit -m "feat: set up Dexie database with tasks, projects, sessions, settings tables"
```

---

### Task 4: DAG validation logic

**Files:**
- Create: `src/lib/dag.ts`
- Test: `src/lib/__tests__/dag.test.ts`

- [ ] **Step 1: Write DAG tests**

```typescript
import { describe, it, expect } from 'vitest'
import { hasCycle, getBlockers, getDependents } from '../dag'
import type { Task } from '@/types'

const makeTasks = (taskDefs: Array<{ id: number; dependencies: number[]; status?: string }>): Task[] =>
  taskDefs.map(({ id, dependencies, status }) => ({
    id,
    title: `Task ${id}`,
    status: (status ?? 'not_started') as Task['status'],
    priority: 'medium' as const,
    dependencies,
    createdAt: new Date(),
    updatedAt: new Date(),
  }))

describe('hasCycle', () => {
  it('returns false for no dependencies', () => {
    const tasks = makeTasks([{ id: 1, dependencies: [] }])
    expect(hasCycle(tasks, 1, 2)).toBe(false)
  })

  it('returns true for direct cycle', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [2] },
      { id: 2, dependencies: [] },
    ])
    // Adding dependency 2 -> 1 would create a cycle
    expect(hasCycle(tasks, 2, 1)).toBe(true)
  })

  it('returns true for indirect cycle', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [2] },
      { id: 2, dependencies: [3] },
      { id: 3, dependencies: [] },
    ])
    // Adding 3 -> 1 creates 1->2->3->1
    expect(hasCycle(tasks, 3, 1)).toBe(true)
  })

  it('returns false for valid dependency', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [] },
      { id: 2, dependencies: [1] },
      { id: 3, dependencies: [] },
    ])
    expect(hasCycle(tasks, 3, 1)).toBe(false)
  })
})

describe('getBlockers', () => {
  it('returns empty array when no dependencies', () => {
    const tasks = makeTasks([{ id: 1, dependencies: [] }])
    expect(getBlockers(tasks, 1)).toEqual([])
  })

  it('returns undone dependencies', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [], status: 'not_started' },
      { id: 2, dependencies: [], status: 'done' },
      { id: 3, dependencies: [1, 2], status: 'not_started' },
    ])
    const blockers = getBlockers(tasks, 3)
    expect(blockers).toHaveLength(1)
    expect(blockers[0].id).toBe(1)
  })
})

describe('getDependents', () => {
  it('returns tasks that depend on the given task', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [] },
      { id: 2, dependencies: [1] },
      { id: 3, dependencies: [1] },
      { id: 4, dependencies: [2] },
    ])
    const dependents = getDependents(tasks, 1)
    expect(dependents.map(t => t.id)).toEqual([2, 3])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/dag.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DAG utilities**

```typescript
import type { Task } from '@/types'

/**
 * Check if adding a dependency from `fromTaskId` to `toTaskId` would create a cycle.
 * "fromTaskId depends on toTaskId" — would toTaskId transitively depend on fromTaskId?
 */
export function hasCycle(tasks: Task[], fromTaskId: number, toTaskId: number): boolean {
  const taskMap = new Map(tasks.map(t => [t.id!, t]))
  const visited = new Set<number>()

  function dfs(currentId: number): boolean {
    if (currentId === fromTaskId) return true
    if (visited.has(currentId)) return false
    visited.add(currentId)

    const task = taskMap.get(currentId)
    if (!task) return false

    for (const depId of task.dependencies) {
      if (dfs(depId)) return true
    }
    return false
  }

  return dfs(toTaskId)
}

/**
 * Get all dependencies of a task that are not yet done (i.e., blockers).
 */
export function getBlockers(tasks: Task[], taskId: number): Task[] {
  const taskMap = new Map(tasks.map(t => [t.id!, t]))
  const task = taskMap.get(taskId)
  if (!task) return []

  return task.dependencies
    .map(depId => taskMap.get(depId))
    .filter((t): t is Task => t !== undefined && t.status !== 'done')
}

/**
 * Get all tasks that directly depend on the given task.
 */
export function getDependents(tasks: Task[], taskId: number): Task[] {
  return tasks.filter(t => t.dependencies.includes(taskId))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/dag.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dag.ts src/lib/__tests__/dag.test.ts
git commit -m "feat: implement DAG cycle detection and dependency utilities"
```

---

### Task 5: Status and time utility functions

**Files:**
- Create: `src/lib/status.ts`
- Create: `src/lib/time.ts`
- Create: `src/lib/constants.ts`
- Test: `src/lib/__tests__/status.test.ts`
- Test: `src/lib/__tests__/time.test.ts`

- [ ] **Step 1: Write status tests**

```typescript
import { describe, it, expect } from 'vitest'
import { canTransition, getStatusLabel, getStatusColor } from '../status'

describe('canTransition', () => {
  it('allows not_started -> in_progress', () => {
    expect(canTransition('not_started', 'in_progress')).toBe(true)
  })

  it('rejects not_started -> done', () => {
    expect(canTransition('not_started', 'done')).toBe(false)
  })

  it('allows done -> in_progress (reopen)', () => {
    expect(canTransition('done', 'in_progress')).toBe(true)
  })

  it('rejects done -> paused', () => {
    expect(canTransition('done', 'paused')).toBe(false)
  })
})

describe('getStatusLabel', () => {
  it('returns human-readable label', () => {
    expect(getStatusLabel('in_progress')).toBe('In Progress')
    expect(getStatusLabel('partial_done')).toBe('Partial Done')
  })
})
```

- [ ] **Step 2: Write time tests**

```typescript
import { describe, it, expect } from 'vitest'
import { formatDuration, computeSessionDuration, computeTotalTime } from '../time'

describe('formatDuration', () => {
  it('formats zero', () => {
    expect(formatDuration(0)).toBe('00:00:00')
  })

  it('formats hours, minutes, seconds', () => {
    const ms = (2 * 3600 + 15 * 60 + 30) * 1000
    expect(formatDuration(ms)).toBe('02:15:30')
  })

  it('handles large durations', () => {
    const ms = (100 * 3600 + 5 * 60 + 3) * 1000
    expect(formatDuration(ms)).toBe('100:05:03')
  })
})

describe('computeTotalTime', () => {
  it('sums durations of multiple completed sessions', () => {
    const sessions = [
      { id: 1, taskId: 1, start: new Date('2026-01-01T10:00:00'), end: new Date('2026-01-01T10:30:00') },
      { id: 2, taskId: 1, start: new Date('2026-01-01T11:00:00'), end: new Date('2026-01-01T11:45:00') },
    ]
    expect(computeTotalTime(sessions)).toBe((30 + 45) * 60 * 1000)
  })

  it('returns 0 for empty sessions', () => {
    expect(computeTotalTime([])).toBe(0)
  })
})

describe('computeSessionDuration', () => {
  it('computes duration for completed session', () => {
    const start = new Date('2026-01-01T10:00:00')
    const end = new Date('2026-01-01T10:30:00')
    expect(computeSessionDuration({ id: 1, taskId: 1, start, end })).toBe(30 * 60 * 1000)
  })

  it('computes duration for active session using now', () => {
    const start = new Date(Date.now() - 60000) // 1 minute ago
    const duration = computeSessionDuration({ id: 1, taskId: 1, start })
    expect(duration).toBeGreaterThanOrEqual(59000)
    expect(duration).toBeLessThan(62000)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement constants**

```typescript
import type { TaskStatus } from '@/types'

export const DEFAULT_STATUS_COLORS: Record<TaskStatus, string> = {
  not_started: '#484847',
  in_progress: '#00fbfb',
  paused: '#de8eff',
  blocked: '#ff6e84',
  partial_done: '#b90afc',
  done: '#69fd5d',
}

export const DEFAULT_NOTIFICATION_INTERVAL = 30 // minutes

export const DEFAULT_SETTINGS = {
  timerBarDisplayMode: 'carousel' as const,
  notificationInterval: DEFAULT_NOTIFICATION_INTERVAL,
  statusColors: DEFAULT_STATUS_COLORS,
  glowIntensity: 84,
  backdropBlur: 24,
  shadowSpread: 12,
}
```

- [ ] **Step 5: Implement status utilities**

```typescript
import type { TaskStatus } from '@/types'
import { VALID_TRANSITIONS } from '@/types'
import { DEFAULT_STATUS_COLORS } from './constants'

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

export function getStatusLabel(status: TaskStatus): string {
  return status
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function getStatusColor(status: TaskStatus, customColors?: Record<TaskStatus, string>): string {
  return (customColors ?? DEFAULT_STATUS_COLORS)[status]
}
```

- [ ] **Step 6: Implement time utilities**

```typescript
import type { Session } from '@/types'

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${hours >= 100 ? hours : pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function computeSessionDuration(session: Session): number {
  const end = session.end ?? new Date()
  return end.getTime() - session.start.getTime()
}

export function computeTotalTime(sessions: Session[]): number {
  return sessions.reduce((sum, s) => sum + computeSessionDuration(s), 0)
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/status.ts src/lib/time.ts src/lib/constants.ts src/lib/__tests__/status.test.ts src/lib/__tests__/time.test.ts
git commit -m "feat: add status transition validation and time formatting utilities"
```

---

### Task 6: Dexie reactive hooks

**Files:**
- Create: `src/hooks/use-tasks.ts`
- Create: `src/hooks/use-projects.ts`
- Create: `src/hooks/use-sessions.ts`
- Create: `src/hooks/use-settings.ts`
- Create: `src/hooks/use-timer.ts`

- [ ] **Step 1: Create use-tasks hook**

```typescript
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import type { TaskStatus } from '@/types'

export function useTasks(filter?: { status?: TaskStatus; projectId?: number }) {
  return useLiveQuery(() => {
    let query = db.tasks.toCollection()
    if (filter?.status) {
      query = db.tasks.where('status').equals(filter.status)
    }
    return query.toArray().then(tasks => {
      if (filter?.projectId !== undefined) {
        return tasks.filter(t => t.projectId === filter.projectId)
      }
      return tasks
    })
  }, [filter?.status, filter?.projectId])
}

export function useTask(id: number | undefined) {
  return useLiveQuery(
    () => (id !== undefined ? db.tasks.get(id) : undefined),
    [id]
  )
}
```

- [ ] **Step 2: Create use-projects hook**

```typescript
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'

export function useProjects() {
  return useLiveQuery(() => db.projects.toArray())
}

export function useProject(id: number | undefined) {
  return useLiveQuery(
    () => (id !== undefined ? db.projects.get(id) : undefined),
    [id]
  )
}
```

- [ ] **Step 3: Create use-sessions hook**

```typescript
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { computeTotalTime } from '@/lib/time'

export function useSessions(taskId?: number) {
  return useLiveQuery(() => {
    if (taskId !== undefined) {
      return db.sessions.where('taskId').equals(taskId).toArray()
    }
    return db.sessions.toArray()
  }, [taskId])
}

export function useActiveSessions() {
  return useLiveQuery(() =>
    db.sessions.filter(s => s.end === undefined).toArray()
  )
}

/**
 * Computes total time for a task. Pass `tick` from `useTimer()` to
 * force recalculation every second for active sessions.
 */
export function useTaskTotalTime(taskId: number | undefined, tick?: number) {
  const sessions = useSessions(taskId)
  if (!sessions) return 0
  // tick is used as a dependency signal — computeTotalTime reads Date.now() for active sessions
  void tick
  return computeTotalTime(sessions)
}
```

- [ ] **Step 4: Create use-settings hook**

```typescript
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import type { SettingsMap } from '@/types'
import { DEFAULT_SETTINGS } from '@/lib/constants'

export function useSetting<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
  const setting = useLiveQuery(() => db.settings.where('key').equals(key).first(), [key])
  return (setting?.value as SettingsMap[K]) ?? DEFAULT_SETTINGS[key]
}

export async function updateSetting<K extends keyof SettingsMap>(
  key: K,
  value: SettingsMap[K]
) {
  const existing = await db.settings.where('key').equals(key).first()
  if (existing) {
    await db.settings.update(existing.id!, { value })
  } else {
    await db.settings.add({ key, value })
  }
}
```

- [ ] **Step 5: Create use-analytics hook**

Create `src/hooks/use-analytics.ts`:

```typescript
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { computeTotalTime } from '@/lib/time'

interface AnalyticsData {
  totalFocusedTime: number
  tasksCompleted: number
  tasksInProgress: number
  totalTasks: number
  timePerProject: Array<{ projectId: number; projectName: string; color: string; totalTime: number }>
  statusDistribution: Record<string, number>
}

export function useAnalytics(dateRange?: { start: Date; end: Date }): AnalyticsData | undefined {
  return useLiveQuery(async () => {
    const allTasks = await db.tasks.toArray()
    let sessions = await db.sessions.toArray()

    if (dateRange) {
      sessions = sessions.filter(s =>
        s.start >= dateRange.start && s.start <= dateRange.end
      )
    }

    const projects = await db.projects.toArray()
    const projectMap = new Map(projects.map(p => [p.id!, p]))

    // Status distribution
    const statusDistribution: Record<string, number> = {}
    for (const task of allTasks) {
      statusDistribution[task.status] = (statusDistribution[task.status] ?? 0) + 1
    }

    // Time per project
    const projectTimeMap = new Map<number, number>()
    for (const session of sessions) {
      const task = allTasks.find(t => t.id === session.taskId)
      if (task?.projectId) {
        const current = projectTimeMap.get(task.projectId) ?? 0
        projectTimeMap.set(task.projectId, current + computeTotalTime([session]))
      }
    }

    const timePerProject = Array.from(projectTimeMap.entries()).map(([projectId, totalTime]) => {
      const project = projectMap.get(projectId)
      return {
        projectId,
        projectName: project?.name ?? 'Unassigned',
        color: project?.color ?? '#484847',
        totalTime,
      }
    })

    return {
      totalFocusedTime: computeTotalTime(sessions),
      tasksCompleted: allTasks.filter(t => t.status === 'done').length,
      tasksInProgress: allTasks.filter(t => t.status === 'in_progress').length,
      totalTasks: allTasks.length,
      timePerProject,
      statusDistribution,
    }
  }, [dateRange?.start?.getTime(), dateRange?.end?.getTime()])
}
```

- [ ] **Step 6: Create use-timer hook**

```typescript
import { useState, useEffect, useCallback } from 'react'
import { db } from '@/db/database'
import { canTransition } from '@/lib/status'
import type { Task } from '@/types'

export function useTimer(hasActiveSessions: boolean = true) {
  const [tick, setTick] = useState(0)

  // Only tick when there are active sessions to avoid unnecessary re-renders
  useEffect(() => {
    if (!hasActiveSessions) return
    const interval = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [hasActiveSessions])

  const startTask = useCallback(async (task: Task) => {
    if (task.status !== 'in_progress' && !canTransition(task.status, 'in_progress')) {
      throw new Error(`Cannot start task from status: ${task.status}`)
    }

    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      await db.tasks.update(task.id!, {
        status: 'in_progress',
        updatedAt: new Date(),
      })
      await db.sessions.add({
        taskId: task.id!,
        start: new Date(),
      })
    })
  }, [])

  const pauseTask = useCallback(async (task: Task) => {
    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      const activeSession = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()

      if (activeSession) {
        await db.sessions.update(activeSession.id!, { end: new Date() })
      }

      await db.tasks.update(task.id!, {
        status: 'paused',
        updatedAt: new Date(),
      })
    })
  }, [])

  const stopTask = useCallback(async (task: Task, finalStatus: 'done' | 'partial_done' = 'done') => {
    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      const activeSession = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()

      if (activeSession) {
        await db.sessions.update(activeSession.id!, { end: new Date() })
      }

      await db.tasks.update(task.id!, {
        status: finalStatus,
        updatedAt: new Date(),
      })
    })
  }, [])

  return { tick, startTask, pauseTask, stopTask }
}
```

- [ ] **Step 7: Verify everything compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/
git commit -m "feat: add Dexie reactive hooks for tasks, projects, sessions, settings, analytics, and timer"
```

---

### Task 7: Neon Flux theme — CSS variables

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Replace the theme in index.css**

Replace the `:root` and `.dark` blocks and font imports. Keep the `@import` lines and `@theme inline` block but update all variables. **Note:** The existing CSS uses `oklch()` color format — replace all values with hex colors from the Neon Flux palette. Key changes:

- Replace `@fontsource-variable/geist` with `@fontsource-variable/space-grotesk`
- Set `--radius: 0px` for sharp corners
- Map all shadcn CSS variables to Neon Flux hex colors
- Dark mode uses the full Neon Flux palette
- Light mode uses lighter surfaces with same accent hues adjusted for contrast
- Add utility classes for glows, pulse, scrollbar, and selection

The full CSS content is defined in the spec Section 7. Apply the dark palette as `.dark` variables and create a light variant for `:root` with:
- `--background: #f5f5f5`, `--foreground: #1a1a1a`
- `--primary: #b90afc` (primary-dim — darker purple for light bg contrast)
- `--secondary: #006a6a` (secondary-container — darker cyan)
- `--destructive: #d73357` (error-dim)
- Surfaces: white/gray tones
- Sidebar: lighter gray

Also add to the bottom of `index.css`:

```css
/* Neon Flux utility classes */
.glow-primary { box-shadow: 0 0 15px rgba(222, 142, 255, 0.3); }
.glow-secondary { box-shadow: 0 0 15px rgba(0, 251, 251, 0.3); }
.glow-tertiary { box-shadow: 0 0 15px rgba(105, 253, 93, 0.3); }
.pulse-active { animation: pulse-glow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes pulse-glow { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* Custom scrollbar */
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: var(--background); }
::-webkit-scrollbar-thumb { background: var(--border); }
::-webkit-scrollbar-thumb:hover { background: var(--primary); }

/* Selection */
::selection { background: var(--primary); color: var(--primary-foreground); }
```

- [ ] **Step 2: Add Google Fonts link for Material Symbols**

Add to `index.html` `<head>`:

```html
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
```

Add to `index.css`:

```css
.material-symbols-outlined {
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}
```

- [ ] **Step 3: Verify the dev server renders correctly**

Run: `npm run dev`
Expected: Page loads with dark background (#0e0e0e), Space Grotesk font, sharp corners. No visual regressions.

- [ ] **Step 4: Commit**

```bash
git add src/index.css index.html
git commit -m "feat: apply Neon Flux theme with dark and light mode CSS variables"
```

---

### Task 8: React Router setup and root layout

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/App.tsx`
- Create: `src/components/root-layout.tsx`

- [ ] **Step 1: Update main.tsx with BrowserRouter**

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

- [ ] **Step 2: Create root-layout.tsx**

```typescript
import { Outlet } from 'react-router'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'

export function RootLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        {/* AppHeader will be added in Task 10 */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
        {/* FloatingTimerBar will be added in Phase 3 */}
      </SidebarInset>
    </SidebarProvider>
  )
}
```

- [ ] **Step 3: Create a placeholder dashboard route**

Create `src/routes/dashboard.tsx`:

```typescript
export default function Dashboard() {
  return (
    <div className="p-8">
      <h1 className="text-5xl font-bold tracking-tighter uppercase">
        Command_Center
      </h1>
      <p className="text-muted-foreground text-xs tracking-widest uppercase mt-2">
        System nominal: All modules operational
      </p>
    </div>
  )
}
```

- [ ] **Step 4: Update App.tsx with routes**

```typescript
import { Routes, Route, Navigate } from 'react-router'
import { RootLayout } from '@/components/root-layout'
import Dashboard from '@/routes/dashboard'

export default function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        {/* More routes added in later tasks */}
      </Route>
    </Routes>
  )
}
```

- [ ] **Step 5: Verify dev server**

Run: `npm run dev`
Expected: App loads with sidebar, header area, and "Command_Center" heading. URL redirects from `/` to `/dashboard`.

- [ ] **Step 6: Commit**

```bash
git add src/main.tsx src/App.tsx src/components/root-layout.tsx src/routes/dashboard.tsx
git commit -m "feat: set up React Router with root layout and placeholder dashboard"
```

---

### Task 9: AppSidebar — Neon Flux navigation

**Files:**
- Modify: `src/components/app-sidebar.tsx`

- [ ] **Step 1: Replace app-sidebar.tsx with TaskFlow navigation**

Replace the entire file. Change the sidebar variant from `"floating"` to `"sidebar"` (docked, no rounded edges — matches the Neon Flux sharp aesthetic). Use the shadcn `Sidebar`, `SidebarContent`, `SidebarHeader`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarFooter` components. Navigation items from the spec (Section 6.1):

- Header: "TASKFLOW_OS" branding with version, styled per `main_dashboard.html` sidebar header
- Nav items: Terminal (→ /dashboard), Projects (→ /projects), Analytics (→ /analytics), Dependencies (→ /dependencies), Archive (→ /archive)
- Each item uses Material Symbols Outlined icon spans (not Lucide)
- Active item: use `isActive` prop based on current route via `useLocation()` from react-router
- Footer: Settings link (→ /settings), NEW TASK button (→ /tasks/new)
- Style active state: cyan text, left-2 border cyan, darker bg — match `configurations.html` sidebar

Use `NavLink` from react-router inside `SidebarMenuButton asChild` for automatic active detection.

Reference: `designs/pages/main_dashboard.html` lines 91-134 for exact classes and structure.

- [ ] **Step 2: Verify sidebar renders with correct styling**

Run: `npm run dev`
Expected: Sidebar shows all nav items with Material Symbols icons. Active item (Terminal/Dashboard) is highlighted in cyan. Clicking items navigates (even if pages are empty). NEW TASK button visible at bottom.

- [ ] **Step 3: Commit**

```bash
git add src/components/app-sidebar.tsx
git commit -m "feat: implement Neon Flux themed sidebar with TaskFlow navigation"
```

---

### Task 10: AppHeader — sticky header with search

**Files:**
- Create: `src/components/app-header.tsx`

- [ ] **Step 1: Create the header component**

Build a sticky header matching `main_dashboard.html` lines 138-157:

- Uses shadcn `SidebarTrigger` for the toggle button
- Search input: `surface-container-low` bg, bottom-border-only, uppercase tracking-widest, `QUERY_SYSTEM...` placeholder
- Right side: notification icon (Material Symbols), settings icon (links to /settings), user avatar placeholder (initials in a square)
- Sticky: `sticky top-0 z-30` with backdrop blur
- Border bottom: ghost border primary at 20% opacity

Reference: spec Section 6.2 and `main_dashboard.html` header.

- [ ] **Step 2: Add header to root-layout.tsx**

Import and place `<AppHeader />` inside `SidebarInset` before the `<main>` tag.

- [ ] **Step 3: Verify**

Run: `npm run dev`
Expected: Sticky header visible with search input, notification icon, settings icon, and user avatar. Sidebar toggle works.

- [ ] **Step 4: Commit**

```bash
git add src/components/app-header.tsx src/components/root-layout.tsx
git commit -m "feat: add sticky Neon Flux header with search, notifications, and sidebar trigger"
```

---

## Phase 2: Core CRUD Pages

### Task 11: Shared UI components — StatusBadge, PriorityBadge, EmptyState, TaskCard

**Files:**
- Create: `src/components/status-badge.tsx`
- Create: `src/components/priority-badge.tsx`
- Create: `src/components/empty-state.tsx`
- Create: `src/components/task-card.tsx`

- [ ] **Step 1: Create StatusBadge**

Small component: takes `status: TaskStatus`, renders a colored badge matching the design (pulse indicator dot + uppercase label + colored left border and bg tint). Uses `getStatusColor` and `getStatusLabel`.

- [ ] **Step 2: Create PriorityBadge**

Takes `priority: TaskPriority`, renders colored badge. Critical = error color, High = primary, Medium = secondary, Low = outline-variant.

- [ ] **Step 3: Create EmptyState**

Reusable: takes `icon` (Material Symbol name), `title`, `description`, optional `action` (ReactNode for a button). Centered layout with muted styling.

- [ ] **Step 4: Create TaskCard**

The main reusable task card matching `main_dashboard.html` task card design:
- Left border colored by status
- Task ID label, title, progress bar (from sessions), project color dot
- Hover: translate-x-1, border brightens
- Click: navigates to `/tasks/:id`
- Uses `useTaskTotalTime` for time display

Reference: `main_dashboard.html` lines 196-229 for exact structure.

- [ ] **Step 5: Verify components render**

Import TaskCard into Dashboard temporarily with mock data. Verify visual match.

- [ ] **Step 6: Commit**

```bash
git add src/components/status-badge.tsx src/components/priority-badge.tsx src/components/empty-state.tsx src/components/task-card.tsx
git commit -m "feat: add StatusBadge, PriorityBadge, EmptyState, and TaskCard components"
```

---

### Task 12: Create Project page

**Files:**
- Create: `src/routes/create-project.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build the create project form**

Match `create_project.html` layout:
- Left column: form with project name input, description textarea (markdown), color picker (preset neon swatches + custom)
- Right column: live preview showing a task card styled with the selected color
- Use shadcn `Input`, `Button` components styled to Neon Flux
- Color swatches: primary, secondary, tertiary, error, magenta, yellow + custom hex input
- Submit handler: `db.projects.add(...)` then navigate to `/projects`

Reference: `designs/pages/create_project.html` for exact layout.

- [ ] **Step 2: Add route to App.tsx**

```typescript
import CreateProject from '@/routes/create-project'
// In Routes:
<Route path="projects/new" element={<CreateProject />} />
```

- [ ] **Step 3: Verify**

Run: `npm run dev`, navigate to `/projects/new`. Fill form, submit, verify project appears in Dexie (check via browser DevTools → Application → IndexedDB).

- [ ] **Step 4: Commit**

```bash
git add src/routes/create-project.tsx src/App.tsx
git commit -m "feat: implement Create Project page with color picker and live preview"
```

---

### Task 13: Projects list page

**Files:**
- Create: `src/routes/projects.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build the projects grid**

- Uses `useProjects()` hook
- Grid of project cards: color-accented left border, project name, task count (from `useTasks({ projectId })`), description preview
- Empty state when no projects: "Create your first project" + link to `/projects/new`
- Each card links to `/projects/:id`
- "NEW PROJECT" button in header area

- [ ] **Step 2: Add route and verify**

Add `<Route path="projects" element={<Projects />} />` to App.tsx. Navigate, verify empty state, create a project, verify it appears.

- [ ] **Step 3: Commit**

```bash
git add src/routes/projects.tsx src/App.tsx
git commit -m "feat: implement Projects list page with grid layout"
```

---

### Task 14: Create Task page

**Files:**
- Create: `src/components/dependency-picker.tsx`
- Create: `src/components/markdown-editor.tsx`
- Create: `src/routes/create-task.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Create MarkdownEditor component**

Textarea + preview toggle. When preview mode is on, render content using `react-markdown` with `remark-gfm`. Toggle button switches between "EDIT" and "PREVIEW" modes.

- [ ] **Step 2: Create DependencyPicker component**

- Takes `selectedIds: number[]` and `onChange: (ids: number[]) => void`
- Queries all tasks via `useTasks()`
- Searchable list: filter by title
- Each item shows task title + status badge
- Click to toggle selection
- Selected items shown as removable chips above the list

- [ ] **Step 3: Build the create task form**

Match `create_task.html` layout:
- Left column: title input (large, headline font), MarkdownEditor for description, project select (from `useProjects()`), status select, priority select
- Right column: DependencyPicker, priority indicator bars, estimated time input
- Submit: validate DAG with `hasCycle`, then `db.tasks.add(...)`, navigate to `/dashboard`
- If DAG validation fails, show error message (no toast needed — inline error)

Reference: `designs/pages/create_task.html` for layout.

- [ ] **Step 4: Add route and verify**

Add `<Route path="tasks/new" element={<CreateTask />} />`. Navigate, fill form, submit, verify task in IndexedDB.

- [ ] **Step 5: Commit**

```bash
git add src/components/dependency-picker.tsx src/components/markdown-editor.tsx src/routes/create-task.tsx src/App.tsx
git commit -m "feat: implement Create Task page with dependency picker and markdown editor"
```

---

### Task 15: Task Detail page

**Files:**
- Create: `src/components/markdown-renderer.tsx`
- Create: `src/routes/task-detail.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Create MarkdownRenderer component**

Wrapper around `react-markdown` with `remark-gfm` plugin. Applies Neon Flux typography classes to rendered elements (headings, code blocks, lists, links). Code blocks get `surface-variant` background.

- [ ] **Step 2: Build the task detail page**

Match `task_details.html` layout:
- Hero section: StatusBadge, PriorityBadge, large title
- Metadata grid: project (from `useProject`), due date, estimated time, priority
- Description: MarkdownRenderer with edit toggle (switches to MarkdownEditor, saves on blur/confirm)
- Dependencies section: two columns — "Blocking" (tasks this blocks) and "Blocked By" (tasks this depends on)
- Right sidebar: Session Timeline — chronological list of sessions from `useSessions(taskId)`, showing start time, duration
- Timer controls: Play/Pause/Stop buttons using `useTimer()` — disable Play if task has unresolved blockers (via `getBlockers`)
- External links list with add/remove
- Tags display

Reference: `designs/pages/task_details.html` for layout.

- [ ] **Step 3: Add route and verify**

Add `<Route path="tasks/:id" element={<TaskDetail />} />`. Create a task, navigate to its detail page, verify all sections render.

- [ ] **Step 4: Commit**

```bash
git add src/components/markdown-renderer.tsx src/routes/task-detail.tsx src/App.tsx
git commit -m "feat: implement Task Detail page with markdown, dependencies, and timer controls"
```

---

### Task 16: Dashboard — task board

**Files:**
- Modify: `src/routes/dashboard.tsx`

- [ ] **Step 1: Build the full dashboard**

Replace placeholder with full implementation matching `main_dashboard.html`:

- Header stats row: computed from `useAnalytics` or direct queries — total active tasks, completed count, throughput %
- Task board: all 6 statuses as filterable groups. Default shows tasks grouped by status.
- Filter/group controls: buttons to toggle grouping (by status / by project)
- Each group: header with status color bar + count badge, then TaskCard list
- Empty state per group when no tasks match
- Empty state for entire dashboard when zero tasks exist
- Floating "NEW TASK" action if sidebar is collapsed

Reference: `designs/pages/main_dashboard.html` for the 3-column layout pattern (adapt to support all 6 statuses).

- [ ] **Step 2: Verify**

Create several tasks with different statuses. Verify they appear in correct groups. Click cards to navigate to detail.

- [ ] **Step 3: Commit**

```bash
git add src/routes/dashboard.tsx
git commit -m "feat: implement Dashboard with filterable task board grouped by status"
```

---

### Task 17: Project Detail / Edit page

**Files:**
- Create: `src/routes/project-detail.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build project detail page**

- Header: project name (editable), color swatch, description (markdown rendered)
- Edit mode: inline editing for name, MarkdownEditor for description, color picker
- Task list: all tasks for this project via `useTasks({ projectId })`
- Stats: task count by status, total time spent (sum of all task times)
- Delete project button with confirmation

- [ ] **Step 2: Add route and verify**

Add `<Route path="projects/:id" element={<ProjectDetail />} />`. Navigate from project list, verify data loads.

- [ ] **Step 3: Commit**

```bash
git add src/routes/project-detail.tsx src/App.tsx
git commit -m "feat: implement Project Detail page with inline editing and task list"
```

---

## Phase 3: Timer System & Floating Bar

### Task 18: Floating Timer Bar

**Files:**
- Create: `src/components/floating-timer-bar.tsx`
- Modify: `src/components/root-layout.tsx`

- [ ] **Step 1: Build the floating timer bar**

Match `main_dashboard.html` footer (lines 289-332):

- Fixed bottom, full-width, glassmorphism bg (`surface/80` + backdrop-blur-xl), tertiary ghost border top
- Uses `useActiveSessions()` to get running sessions and their tasks
- **Carousel mode (default):** shows one session at a time with chevron (`◀` `▶`) navigation. Counter badge `(2/3)`.
- **Expanded mode:** all sessions stacked vertically
- Toggle button between modes, persisted via `useSetting('timerBarDisplayMode')`
- Each session row: play icon, task title (truncated), live timer (from `useTimer().tick` + session start), pause button
- Timer display: `formatDuration(Date.now() - session.start.getTime())`
- Only visible when `activeSessions.length > 0`

- [ ] **Step 2: Add to root-layout.tsx**

Place `<FloatingTimerBar />` after `</main>` inside `SidebarInset`.

- [ ] **Step 3: Verify**

Start a task timer from task detail page. Verify floating bar appears at bottom. Start a second task. Verify chevron navigation works. Toggle expanded mode.

- [ ] **Step 4: Commit**

```bash
git add src/components/floating-timer-bar.tsx src/components/root-layout.tsx
git commit -m "feat: implement Floating Timer Bar with carousel and expanded modes"
```

---

### Task 19: Notification system

**Files:**
- Create: `src/hooks/use-notifications.ts`
- Modify: `src/components/root-layout.tsx`

- [ ] **Step 1: Create useNotifications hook**

```typescript
import { useEffect } from 'react'
import { db } from '@/db/database'
import { useActiveSessions } from './use-sessions'
import { useSetting } from './use-settings'

export function useNotifications() {
  const activeSessions = useActiveSessions()
  const interval = useSetting('notificationInterval')

  useEffect(() => {
    if (!activeSessions?.length) return
    if (Notification.permission === 'default') {
      Notification.requestPermission()
    }

    const timer = setInterval(async () => {
      if (Notification.permission !== 'granted') return
      for (const session of activeSessions) {
        const task = await db.tasks.get(session.taskId)
        if (!task) continue
        const project = task.projectId
          ? await db.projects.get(task.projectId)
          : undefined
        new Notification('TaskFlow', {
          body: `You are working on: ${task.title}${project ? ` (${project.name})` : ''}`,
          icon: '/favicon.ico',
        })
      }
    }, interval * 60 * 1000)

    return () => clearInterval(timer)
  }, [activeSessions?.length, interval])
}
```

- [ ] **Step 2: Add to root-layout.tsx**

Call `useNotifications()` inside the `RootLayout` component.

- [ ] **Step 3: Verify**

Start a task timer. Wait for notification interval (temporarily set to 0.1 minutes for testing). Verify browser notification fires.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-notifications.ts src/components/root-layout.tsx
git commit -m "feat: add Web Notifications for active task reminders"
```

---

## Phase 4: Analytics & Visualization

### Task 20: Analytics dashboard

**Files:**
- Create: `src/routes/analytics.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build analytics page**

Match `analytics.html` layout:

- Top metrics row (3 cards): Total Focused Time (sum all sessions), Tasks Completed (count done), Focus Velocity (computed metric)
- Status distribution donut: Recharts `PieChart` with `Cell` colors from status colors
- Project time allocation: Recharts `BarChart` horizontal — time per project
- System activity pulse: vertical timeline of recent sessions with icons and timestamps
- Empty state when no session data exists

Reference: `designs/pages/analytics.html` for exact layout.

- [ ] **Step 2: Add route and verify**

Add `<Route path="analytics" element={<Analytics />} />`. Create tasks, run timers, verify charts populate.

- [ ] **Step 3: Commit**

```bash
git add src/routes/analytics.tsx src/App.tsx
git commit -m "feat: implement Analytics dashboard with Recharts donut and bar charts"
```

---

### Task 21: Execution Timeline page

**Files:**
- Create: `src/routes/execution-timeline.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build execution timeline**

Match `execution_timeline.html` layout:

- Stats row: weekly output hours, deep work ratio, tasks completed, blocked time
- Stacked bar chart by day of week (Recharts `BarChart` stacked, neon colors)
- Day/Week/Month toggle buttons
- Session stream table: shadcn-styled table (use existing table patterns from the HTML) with status indicator, task ID + name, project, start time, computed duration, intensity badge
- Legend: color squares for different work categories

Reference: `designs/pages/execution_timeline.html` for full layout.

- [ ] **Step 2: Add route and verify**

Add `<Route path="analytics/timeline" element={<ExecutionTimeline />} />`. Verify with session data.

- [ ] **Step 3: Commit**

```bash
git add src/routes/execution-timeline.tsx src/App.tsx
git commit -m "feat: implement Execution Timeline with stacked charts and session table"
```

---

### Task 22: Dependency Graph page

**Files:**
- Create: `src/routes/dependency-graph.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build dependency graph**

Match `preffered_dependency_graph.html` layout BUT with Neon Flux colors (not the blue/slate from the mockup):

- Full-canvas `@xyflow/react` `ReactFlow` component
- Custom node component: task card style (status-colored left border, title, task ID, progress bar)
- Edges: colored by source task status, animated for in_progress tasks
- Layout: use `dagre` to auto-position nodes in a left-to-right DAG layout
- Background: `BackgroundVariant.Dots` with Neon Flux tint
- Floating legend panel: status color dots with labels (absolute positioned)
- Floating toolbar: zoom controls using ReactFlow's built-in `Controls`
- Right detail panel: when a node is clicked, show task details (ID, title, description, priority, dependencies chain) — use `Panel` from @xyflow/react or absolute positioned div
- Data: query all tasks via `useTasks()`, build nodes/edges from `task.dependencies`

- [ ] **Step 2: Add route and verify**

Add `<Route path="dependencies" element={<DependencyGraph />} />`. Create tasks with dependencies. Verify graph renders with connections.

- [ ] **Step 3: Commit**

```bash
git add src/routes/dependency-graph.tsx src/App.tsx
git commit -m "feat: implement interactive Dependency Graph with @xyflow/react and dagre layout"
```

---

## Phase 5: Settings, Archive & Polish

### Task 23: Configuration / Settings page

**Files:**
- Create: `src/routes/settings.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build settings page**

Match `configurations.html` layout:

- Left column: Status Color Channels — one row per TaskStatus with color swatch, name, hex value, and `<input type="color">` picker
- Glow intensity slider (0-100)
- Backdrop blur and shadow spread numeric inputs
- Right column: Live Component Preview — a sample TaskCard and buttons that update in real-time as settings change
- "COMMIT TO CORE" button: saves all settings via `updateSetting()`
- "RESET TO DEFAULTS" button: resets to `DEFAULT_SETTINGS`

Reference: `designs/pages/configurations.html` for exact layout.

- [ ] **Step 2: Add route and verify**

Add `<Route path="settings" element={<Settings />} />`. Change colors, verify preview updates. Save, reload, verify persistence.

- [ ] **Step 3: Commit**

```bash
git add src/routes/settings.tsx src/App.tsx
git commit -m "feat: implement Configuration page with status colors and live preview"
```

---

### Task 24: Archive page

**Files:**
- Create: `src/routes/archive.tsx`
- Modify: `src/App.tsx` (add route)

- [ ] **Step 1: Build archive page**

- Queries tasks with `status === 'done'`
- Similar layout to dashboard but focused on completed tasks
- Each card shows: title, completion date (`updatedAt`), total time, project
- Search/filter by project
- Option to reopen a task (transitions `done` → `in_progress`)
- Empty state when no completed tasks

- [ ] **Step 2: Add route and verify**

Add `<Route path="archive" element={<Archive />} />`. Complete some tasks, verify they appear in archive.

- [ ] **Step 3: Commit**

```bash
git add src/routes/archive.tsx src/App.tsx
git commit -m "feat: implement Archive page for completed tasks"
```

---

### Task 25: Header search functionality

**Files:**
- Modify: `src/components/app-header.tsx`

- [ ] **Step 1: Implement search**

- Search input already exists in header
- On input change: query `db.tasks` and `db.projects` filtering by title substring (case-insensitive)
- Dropdown results panel: absolute positioned below search input, grouped "TASKS" / "PROJECTS" sections
- Each result: title + status/color indicator
- Click navigates to `/tasks/:id` or `/projects/:id`
- Close dropdown on blur or Escape
- Use `useLiveQuery` with debounced search term for reactivity

- [ ] **Step 2: Verify**

Create tasks and projects. Type in search, verify results appear. Click result, verify navigation.

- [ ] **Step 3: Commit**

```bash
git add src/components/app-header.tsx
git commit -m "feat: add search functionality to header with task and project results"
```

---

### Task 26: Final route wiring and build verification

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Verify all routes are wired**

Ensure App.tsx has all routes:

```typescript
<Route element={<RootLayout />}>
  <Route index element={<Navigate to="/dashboard" replace />} />
  <Route path="dashboard" element={<Dashboard />} />
  <Route path="tasks/new" element={<CreateTask />} />
  <Route path="tasks/:id" element={<TaskDetail />} />
  <Route path="projects" element={<Projects />} />
  <Route path="projects/new" element={<CreateProject />} />
  <Route path="projects/:id" element={<ProjectDetail />} />
  <Route path="analytics" element={<Analytics />} />
  <Route path="analytics/timeline" element={<ExecutionTimeline />} />
  <Route path="dependencies" element={<DependencyGraph />} />
  <Route path="archive" element={<Archive />} />
  <Route path="settings" element={<Settings />} />
</Route>
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: No lint errors.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete TaskFlow MVP — all routes, timer, analytics, and dependency graph"
```
