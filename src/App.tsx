import { Routes, Route, Navigate } from 'react-router'
import { RootLayout } from '@/components/root-layout'
import Dashboard from '@/routes/dashboard'

export default function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
      </Route>
    </Routes>
  )
}
