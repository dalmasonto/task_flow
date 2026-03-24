import { Routes, Route, Navigate } from 'react-router'
import { useServer } from '@/hooks/use-server'
import { useSync } from '@/hooks/use-sync'
import { useFont } from '@/hooks/use-font'
import { RootLayout } from '@/components/root-layout'
import Dashboard from '@/routes/dashboard'
import CreateProject from '@/routes/create-project'
import CreateTask from '@/routes/create-task'
import Projects from '@/routes/projects'
import TaskDetail from '@/routes/task-detail'
import ProjectDetail from '@/routes/project-detail'
import Analytics from '@/routes/analytics'
import ExecutionTimeline from '@/routes/execution-timeline'
import DependencyGraph from '@/routes/dependency-graph'
import Settings from '@/routes/settings'
import Archive from '@/routes/archive'
import ActivityPulse from '@/routes/activity-pulse'
import BulkCreateTasks from '@/routes/bulk-create-tasks'
import NotFound from '@/routes/not-found'

export default function App() {
  useServer()
  useSync()
  useFont()

  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/new" element={<CreateProject />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="tasks/new" element={<CreateTask />} />
        <Route path="tasks/bulk" element={<BulkCreateTasks />} />
        <Route path="tasks/:id" element={<TaskDetail />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="analytics/timeline" element={<ExecutionTimeline />} />
        <Route path="activity" element={<ActivityPulse />} />
        <Route path="dependencies" element={<DependencyGraph />} />
        <Route path="settings" element={<Settings />} />
        <Route path="archive" element={<Archive />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
