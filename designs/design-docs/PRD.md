Below is a **clear, implementation-ready PRD** for your task execution app, with emphasis on **state-driven UX, dependency graph integrity, and configurable UI colors tied to task status**.

---

# 🧾 Product Requirements Document (PRD)

## 1. Product Overview

### Product Name

**(Working)**: TaskFlow / FocusGraph / ExecOS (placeholder)

### Vision

A **local-first task execution system** optimized for **focus, dependency awareness, and time accountability**, not generic productivity.

### Core Philosophy

* Tasks are the atomic unit
* Projects are just groupings
* Execution > planning
* Awareness > complexity

---

## 2. Goals & Non-Goals

### Goals

* Enable users to **track real execution time**
* Provide **continuous focus reinforcement** via notifications
* Model **task dependencies explicitly (DAG)**
* Provide **end-of-day performance insights**

### Non-Goals (MVP)

* Team collaboration
* Real-time sync across devices
* Rich document editing
* Complex workflow automation

---

## 3. User Personas

### Primary User

* Solo builder / developer / operator
* Works on multiple parallel projects
* Needs:

  * Clarity on “what to do now”
  * Accountability
  * Lightweight system

---

## 4. Core Features

---

## 4.1 Task Management

### Functional Requirements

* Create task
* Edit task
* Delete task
* Assign to project (optional)
* Add external links (docs, GitHub, etc.)

---

### Task States

```text
- not_started
- in_progress
- paused
- blocked
- partial_done
- done
```

---

### State Rules

* Only one active state at a time
* State transitions must follow defined flow
* “blocked” requires dependencies

---

## 4.2 Project Management

* Create project
* Assign color (user-defined)
* Group tasks
* Projects are optional (global tasks allowed)

---

## 4.3 Dependency System (Critical)

### Requirements

* A task can depend on multiple tasks
* A task can block multiple tasks
* Must enforce:

  * No circular dependencies (DAG)
  * Visual indication of blocked tasks

---

### Behavior

* If dependency is not `done`, task can be:

  * marked `blocked`
* UI must clearly show:

  * blocking tasks
  * blocked tasks

---

## 4.4 Time Tracking (Core Feature)

### Actions

#### Play (Start Task)

* Set state → `in_progress`
* Start timer
* Create session record
* Trigger notification loop

#### Pause

* Stop timer
* Save session duration
* State → `paused`

---

### Multi-task Handling

* Either:

  * Allow multiple active tasks (v1 optional)
  * OR enforce single active task (simpler MVP)

---

## 4.5 Notification System

### Behavior

* Trigger every X minutes (default: 30)
* System notification:

```text
"You are working on: Task X (Project Y)"
```

---

### Configurable Settings

```ts
reminderIntervalMinutes: number
```

---

## 4.6 Analytics

### End-of-Day Dashboard

#### Metrics

* Total time worked
* Time per project
* Time per task
* Tasks completed
* Tasks started but not finished

---

### Visualizations

* Bar chart → time per project
* Timeline → sessions
* Pie chart → status distribution

---

## 5. UI / UX Design

---

## 5.1 Design Principles

* Minimal cognitive load
* Fast interactions (keyboard-first later)
* Clear state visibility
* Always show “current focus”

---

## 5.2 Layout

### Sidebar

* Projects
* All Tasks
* Analytics

---

### Main Panel

* Task list
* Grouped by:

  * Project OR
  * Status

---

### Task Detail Panel

* Description
* Dependencies
* Links
* Session history

---

### Floating Active Task Bar

```text
[ ▶ Task X ]   00:21:32   | Pause
```

---

## 6. Status-Based Color System (Configurable)

This is a **core UX differentiator**.

---

## 6.1 Default Status Colors

| Status       | Color (Light Mode) | Color (Dark Mode) | Meaning        |
| ------------ | ------------------ | ----------------- | -------------- |
| not_started  | Gray               | Slate             | Idle           |
| in_progress  | Blue               | Cyan              | Active         |
| paused       | Yellow             | Amber             | Interrupted    |
| blocked      | Red                | Red               | Cannot proceed |
| partial_done | Purple             | Violet            | Progress made  |
| done         | Green              | Emerald           | Completed      |

---

## 6.2 Tailwind Color Mapping Example

```ts
const statusColors = {
  not_started: "bg-gray-400",
  in_progress: "bg-blue-500",
  paused: "bg-yellow-500",
  blocked: "bg-red-500",
  partial_done: "bg-purple-500",
  done: "bg-green-500"
};
```

---

## 6.3 Configurable Theme System

### Requirement

User can override status colors

---

### Settings Model

```ts
type StatusColorConfig = {
  [key in TaskStatus]: {
    light: string;
    dark: string;
  };
};
```

---

### UI Controls

* Color picker per status
* Preview:

  * Task item
  * Badge
  * Graph

---

## 6.4 Visual Usage

### Task Item

* Left border color = status color
* Badge = status

---

### Graphs

* Use same color mapping for consistency

---

### Dependency Indicators

* Blocked tasks:

  * Red outline or icon
* Hover:

  * Show blocking tasks

---

## 7. Data Model

### Task

* id
* title
* status
* projectId
* dependencies[]
* totalTime
* timestamps

---

### Project

* id
* name
* color

---

### Session

* id
* taskId
* start
* end
* duration

---

## 8. Storage

### MVP

* IndexedDB (Dexie)

### Requirements

* Offline-first
* Fast reads/writes
* Persistent sessions

---

## 9. System Architecture

### Frontend

* Vite + React
* Zustand (state)
* shadcn/ui

### Desktop

* Tauri

---

## 10. Performance Requirements

* Task state update < 50ms
* Timer accuracy ±1s
* Notifications reliable in background

---

## 11. Future Considerations

---

### Sync

* CRDT (Automerge / Yjs)
* OR Django backend (fits your current stack)

---

### Advanced Features

* Dependency graph visualization
* Critical path analysis
* Smart task suggestions
* Weekly performance reports

---

## 12. MVP Definition

### Must Have

* Task CRUD
* Project CRUD
* Task states
* Play / Pause tracking
* Notifications
* Dependency linking
* Basic analytics
* Status color system (configurable)

---

### Out of Scope

* Collaboration
* Mobile app
* Cloud sync

---

## 13. Success Metrics

* Daily active usage
* Avg session duration per task
* Tasks completed per day
* % of time in “in_progress”

---

## 14. Key Risk Areas

* Poor dependency UX → confusion
* Notification fatigue
* Over-complication (must stay minimal)

---

## 15. Next Step

If you're moving to build:

I recommend:

1. Implement **data + state layer first (Dexie + Zustand)**
2. Then **Play/Pause + session tracking**
3. Then **notifications**
4. Then UI polish + colors
