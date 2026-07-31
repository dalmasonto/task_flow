import { db } from '@/db/database'

export async function seedDatabase() {
  // Clear existing data
  await db.tasks.clear()
  await db.projects.clear()
  await db.sessions.clear()

  const now = new Date()
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000)
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 3600000)

  // --- Projects ---
  const [p1, p2, p3] = await db.projects.bulkAdd([
    { name: 'TaskFlow', color: '#de8eff', type: 'active_project', description: 'The task execution app itself — **dogfooding** at its finest.\n\n- [ ] Core CRUD\n- [ ] Timer system\n- [x] Dependency graph\n- [ ] Analytics', createdAt: daysAgo(30) },
    { name: 'CyberCore API', color: '#00fbfb', type: 'active_project', description: 'High-performance REST API powering the backend infrastructure. Built with Rust + Axum.', createdAt: daysAgo(45) },
    { name: 'NeonVault', color: '#69fd5d', type: 'active_project', description: 'Encrypted local-first data vault for sensitive credentials and secrets management.', createdAt: daysAgo(20) },
    { name: 'HoloBoard', color: '#ff00ff', type: 'project_idea', description: 'AR-powered kanban board that projects tasks onto physical surfaces. Still in concept phase.', createdAt: daysAgo(10) },
    { name: 'SyncMesh', color: '#ffeb3b', type: 'project_idea', description: 'P2P sync protocol for local-first apps using CRDTs. Research project.', createdAt: daysAgo(5) },
  ], { allKeys: true })

  // --- Tasks ---
  // TaskFlow tasks
  const [t1, t2, t3, t4, t5] = await db.tasks.bulkAdd([
    { title: 'Set up Dexie database schema', status: 'done', priority: 'critical', projectId: p1, dependencies: [], tags: ['infrastructure', 'database'], description: 'Define IndexedDB tables for tasks, projects, sessions, and settings using Dexie.js ORM.', createdAt: daysAgo(28), updatedAt: daysAgo(25) },
    { title: 'Implement timer system', status: 'done', priority: 'high', projectId: p1, dependencies: [], tags: ['core', 'timer'], description: 'Multiple concurrent timers with play/pause/stop.\n\n```ts\nconst { startTask, pauseTask, stopTask } = useTimer()\n```', createdAt: daysAgo(25), updatedAt: daysAgo(20) },
    { title: 'Build dependency graph visualization', status: 'in_progress', priority: 'high', projectId: p1, dependencies: [], tags: ['visualization', 'xyflow'], description: 'Interactive DAG using `@xyflow/react` with dagre layout algorithm.', estimatedTime: 8 * 3600000, createdAt: daysAgo(15), updatedAt: hoursAgo(2) },
    { title: 'Add analytics dashboard', status: 'not_started', priority: 'medium', projectId: p1, dependencies: [], tags: ['analytics', 'recharts'], description: 'Donut chart for status distribution, bar charts for time allocation per project.', estimatedTime: 6 * 3600000, createdAt: daysAgo(10), updatedAt: daysAgo(10) },
    { title: 'Implement notification system', status: 'blocked', priority: 'medium', projectId: p1, dependencies: [], tags: ['notifications'], description: 'Web Notifications API with configurable interval. Requires timer system to be complete.', createdAt: daysAgo(8), updatedAt: daysAgo(8) },
  ], { allKeys: true })

  // Wire dependencies: analytics depends on timer, notifications depends on timer
  await db.tasks.update(t4, { dependencies: [t2] })
  await db.tasks.update(t5, { dependencies: [t2, t3] })

  // CyberCore API tasks
  const [t6, t7, t8, t9] = await db.tasks.bulkAdd([
    { title: 'Design API schema with OpenAPI spec', status: 'done', priority: 'critical', projectId: p2, dependencies: [], tags: ['api', 'design'], description: 'Full OpenAPI 3.1 specification for all endpoints.', createdAt: daysAgo(40), updatedAt: daysAgo(35) },
    { title: 'Implement authentication middleware', status: 'done', priority: 'critical', projectId: p2, dependencies: [], tags: ['auth', 'security'], description: 'JWT-based auth with refresh token rotation and rate limiting.', createdAt: daysAgo(35), updatedAt: daysAgo(28) },
    { title: 'Build CRUD endpoints for resources', status: 'in_progress', priority: 'high', projectId: p2, dependencies: [], tags: ['api', 'crud'], description: 'RESTful endpoints for all core resources.\n\n- [x] Users\n- [x] Projects\n- [ ] Tasks\n- [ ] Sessions', estimatedTime: 12 * 3600000, createdAt: daysAgo(28), updatedAt: hoursAgo(5) },
    { title: 'Set up CI/CD pipeline', status: 'paused', priority: 'medium', projectId: p2, dependencies: [], tags: ['devops', 'ci'], description: 'GitHub Actions workflow for test → build → deploy to Fly.io.', createdAt: daysAgo(20), updatedAt: daysAgo(12) },
  ], { allKeys: true })

  // Wire: CRUD depends on API schema + auth, CI/CD depends on CRUD
  await db.tasks.update(t8, { dependencies: [t6, t7] })
  await db.tasks.update(t9, { dependencies: [t8] })

  // NeonVault tasks
  const [t10, t11, t12] = await db.tasks.bulkAdd([
    { title: 'Research encryption algorithms', status: 'done', priority: 'critical', projectId: p3, dependencies: [], tags: ['research', 'crypto'], description: 'Compare AES-256-GCM vs XChaCha20-Poly1305 for local storage encryption.', createdAt: daysAgo(18), updatedAt: daysAgo(14) },
    { title: 'Implement vault storage engine', status: 'partial_done', priority: 'high', projectId: p3, dependencies: [], tags: ['core', 'storage'], description: 'Encrypted key-value store backed by IndexedDB with streaming decryption.', estimatedTime: 16 * 3600000, createdAt: daysAgo(14), updatedAt: daysAgo(3) },
    { title: 'Build vault UI with master password', status: 'not_started', priority: 'medium', projectId: p3, dependencies: [], tags: ['ui', 'security'], description: 'Unlock screen, credential list, add/edit/delete with copy-to-clipboard.', estimatedTime: 10 * 3600000, createdAt: daysAgo(5), updatedAt: daysAgo(5) },
  ], { allKeys: true })

  // Wire: storage depends on research, UI depends on storage
  await db.tasks.update(t11, { dependencies: [t10] })
  await db.tasks.update(t12, { dependencies: [t11] })

  // Unassigned tasks
  await db.tasks.bulkAdd([
    { title: 'Write project README files', status: 'not_started', priority: 'low', dependencies: [], tags: ['docs'], description: 'Comprehensive READMEs with setup instructions, architecture diagrams, and contribution guides.', createdAt: daysAgo(7), updatedAt: daysAgo(7) },
    { title: 'Set up shared ESLint config', status: 'not_started', priority: 'low', dependencies: [], tags: ['tooling', 'dx'], description: 'Unified linting rules across all projects in the monorepo.', createdAt: daysAgo(3), updatedAt: daysAgo(3) },
  ])

  // --- Sessions (time tracking history) ---
  // Task 1 (done) — 2 sessions
  await db.sessions.bulkAdd([
    { taskId: t1, start: new Date(daysAgo(28).getTime() + 9 * 3600000), end: new Date(daysAgo(28).getTime() + 11.5 * 3600000) },
    { taskId: t1, start: new Date(daysAgo(27).getTime() + 14 * 3600000), end: new Date(daysAgo(27).getTime() + 16 * 3600000) },
  ])

  // Task 2 (done) — 3 sessions
  await db.sessions.bulkAdd([
    { taskId: t2, start: new Date(daysAgo(24).getTime() + 10 * 3600000), end: new Date(daysAgo(24).getTime() + 13 * 3600000) },
    { taskId: t2, start: new Date(daysAgo(23).getTime() + 9 * 3600000), end: new Date(daysAgo(23).getTime() + 12 * 3600000) },
    { taskId: t2, start: new Date(daysAgo(22).getTime() + 14 * 3600000), end: new Date(daysAgo(22).getTime() + 17.5 * 3600000) },
  ])

  // Task 3 (in_progress) — 2 completed sessions + 1 active
  await db.sessions.bulkAdd([
    { taskId: t3, start: new Date(daysAgo(10).getTime() + 9 * 3600000), end: new Date(daysAgo(10).getTime() + 12 * 3600000) },
    { taskId: t3, start: new Date(daysAgo(5).getTime() + 14 * 3600000), end: new Date(daysAgo(5).getTime() + 16.5 * 3600000) },
    { taskId: t3, start: hoursAgo(1) }, // active session!
  ])

  // Task 6 (done)
  await db.sessions.bulkAdd([
    { taskId: t6, start: new Date(daysAgo(39).getTime() + 10 * 3600000), end: new Date(daysAgo(39).getTime() + 14 * 3600000) },
    { taskId: t6, start: new Date(daysAgo(38).getTime() + 9 * 3600000), end: new Date(daysAgo(38).getTime() + 11 * 3600000) },
  ])

  // Task 7 (done)
  await db.sessions.bulkAdd([
    { taskId: t7, start: new Date(daysAgo(34).getTime() + 10 * 3600000), end: new Date(daysAgo(34).getTime() + 15 * 3600000) },
  ])

  // Task 8 (in_progress) — 1 completed + 1 active
  await db.sessions.bulkAdd([
    { taskId: t8, start: new Date(daysAgo(7).getTime() + 9 * 3600000), end: new Date(daysAgo(7).getTime() + 13 * 3600000) },
    { taskId: t8, start: hoursAgo(3) }, // active session!
  ])

  // Task 10 (done)
  await db.sessions.bulkAdd([
    { taskId: t10, start: new Date(daysAgo(17).getTime() + 10 * 3600000), end: new Date(daysAgo(17).getTime() + 14 * 3600000) },
  ])

  // Task 11 (partial_done)
  await db.sessions.bulkAdd([
    { taskId: t11, start: new Date(daysAgo(12).getTime() + 9 * 3600000), end: new Date(daysAgo(12).getTime() + 13 * 3600000) },
    { taskId: t11, start: new Date(daysAgo(8).getTime() + 14 * 3600000), end: new Date(daysAgo(8).getTime() + 18 * 3600000) },
  ])
}
