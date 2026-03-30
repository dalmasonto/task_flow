# Daily Productivity Section — Analytics Page

## Summary

Add a new "Daily Productivity" section to the analytics page, placed between the Middle Section (status donut + project allocation) and the Charts Grid. Provides per-project, per-day breakdown of both time spent and tasks completed, with a date range selector.

## Components

### New: `DailyProductivity` component
- Location: `src/components/charts/daily-productivity.tsx`
- Contains: project filter, date range picker, tabs toggle, bar chart

### New: `useDailyProductivity` hook
- Location: `src/hooks/use-daily-productivity.ts`
- Queries Dexie for sessions and tasks, groups by day, filters by project + date range
- Returns data for both "time spent" and "tasks done" modes

### Reused
- `DateRangePicker` — existing shadcn Calendar-based range picker
- `ProjectFilter` — existing project dropdown
- `Tabs` — shadcn tabs for toggling between views

## Data Flow

### Time Spent Mode
1. Query all sessions from Dexie
2. Filter by date range (session.start within range)
3. If project selected, join with tasks table to filter by projectId
4. Group by day (ISO date), sum durations
5. Fill missing days with 0

### Tasks Done Mode
1. Query all tasks from Dexie
2. Filter to status === "done"
3. Filter by date range using task.updatedAt (when it was marked done)
4. If project selected, filter by projectId
5. Group by day (ISO date of updatedAt), count per day
6. Fill missing days with 0

## UI Spec

- Header: "Daily Productivity" with neon dot indicator
- Filter row: ProjectFilter (left) + DateRangePicker (right)
- Tabs: "Time Spent" | "Tasks Done" using shadcn Tabs
- Chart: Recharts BarChart, height 300px
  - Time Spent bars: `#00fbfb`
  - Tasks Done bars: `#69fd5d`
- Empty state when no data matches filters
- Default: last 30 days, all projects, "Time Spent" tab

## Integration

Insert `<DailyProductivity />` in `analytics.tsx` between the Middle Section and the Charts Grid `<div>`.
