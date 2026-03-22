import { Routes, Route, Navigate } from 'react-router'
import { RootLayout } from '@/components/root-layout'
import Dashboard from '@/routes/dashboard'
import CreateProject from '@/routes/create-project'
import CreateTask from '@/routes/create-task'
import Projects from '@/routes/projects'

export default function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/new" element={<CreateProject />} />
        <Route path="tasks/new" element={<CreateTask />} />
      </Route>
    </Routes>
  )
}
