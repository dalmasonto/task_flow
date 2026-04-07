import { useState, useEffect, useMemo, useCallback } from 'react'
import { toast } from 'sonner'
import type { TaskStatus } from '@/types'
import { useSetting, updateSetting } from '@/hooks/use-settings'
import { DEFAULT_STATUS_COLORS, DEFAULT_SETTINGS, FONT_OPTIONS } from '@/lib/constants'
import { getStatusLabel } from '@/lib/status'
import { useTasks } from '@/hooks/use-tasks'
import { seedDatabase } from '@/lib/seed'
import { playSuccess, playDelete, playClick } from '@/lib/sounds'
import { addNotification } from '@/hooks/use-app-notifications'
import { logActivity } from '@/hooks/use-activity-log'
import { db } from '@/db/database'
import { syncClearData } from '@/lib/sync-api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Switch } from '@/components/ui/switch'

const ALL_STATUSES: TaskStatus[] = [
  'not_started',
  'in_progress',
  'paused',
  'blocked',
  'partial_done',
  'done',
]

export default function Settings() {
  const savedColors = useSetting('statusColors')
  const savedGlow = useSetting('glowIntensity')
  const savedBlur = useSetting('backdropBlur')
  const savedSpread = useSetting('shadowSpread')
  const savedOperatorName = useSetting('operatorName')
  const savedSystemName = useSetting('systemName')
  const savedNotificationInterval = useSetting('notificationInterval')
  const savedBrowserNotifications = useSetting('browserNotificationsEnabled')
  const savedServerPort = useSetting('serverPort')
  const savedFontFamily = useSetting('fontFamily')
  const savedTerminalWidth = useSetting('terminalWidth')

  const [colors, setColors] = useState<Record<TaskStatus, string>>({ ...DEFAULT_STATUS_COLORS, ...savedColors })
  const [glowIntensity, setGlowIntensity] = useState(savedGlow)
  const [backdropBlur, setBackdropBlur] = useState(savedBlur)
  const [shadowSpread, setShadowSpread] = useState(savedSpread)
  const [operatorName, setOperatorName] = useState(savedOperatorName)
  const [systemName, setSystemName] = useState(savedSystemName)
  const [notificationInterval, setNotificationInterval] = useState(savedNotificationInterval)
  const [browserNotifications, setBrowserNotifications] = useState(savedBrowserNotifications)
  const [serverPort, setServerPort] = useState(savedServerPort)
  const [fontFamily, setFontFamily] = useState(savedFontFamily)
  const [terminalWidth, setTerminalWidth] = useState(savedTerminalWidth)

  // Sync local state when saved values load from DB
  useEffect(() => { setColors({ ...DEFAULT_STATUS_COLORS, ...savedColors }) }, [savedColors])
  useEffect(() => { setGlowIntensity(savedGlow) }, [savedGlow])
  useEffect(() => { setBackdropBlur(savedBlur) }, [savedBlur])
  useEffect(() => { setShadowSpread(savedSpread) }, [savedSpread])
  useEffect(() => { setOperatorName(savedOperatorName) }, [savedOperatorName])
  useEffect(() => { setSystemName(savedSystemName) }, [savedSystemName])
  useEffect(() => { setNotificationInterval(savedNotificationInterval) }, [savedNotificationInterval])
  useEffect(() => { setBrowserNotifications(savedBrowserNotifications) }, [savedBrowserNotifications])
  useEffect(() => { setServerPort(savedServerPort) }, [savedServerPort])
  useEffect(() => { setFontFamily(savedFontFamily) }, [savedFontFamily])
  useEffect(() => { setTerminalWidth(savedTerminalWidth) }, [savedTerminalWidth])

  function handleColorChange(status: TaskStatus, value: string) {
    setColors(prev => ({ ...prev, [status]: value }))
  }

  async function handleSave() {
    await updateSetting('statusColors', colors)
    await updateSetting('glowIntensity', glowIntensity)
    await updateSetting('backdropBlur', backdropBlur)
    await updateSetting('shadowSpread', shadowSpread)
    await updateSetting('operatorName', operatorName)
    await updateSetting('systemName', systemName)
    await updateSetting('notificationInterval', notificationInterval)
    await updateSetting('browserNotificationsEnabled', browserNotifications)
    await updateSetting('serverPort', serverPort)
    await updateSetting('fontFamily', fontFamily)
    await updateSetting('terminalWidth', terminalWidth)
    playSuccess()
    toast.success('Configuration committed to core')
    addNotification('Settings Saved', 'Configuration committed to core', 'success')
    logActivity('settings_saved', 'Configuration committed to core', { entityType: 'system' })
  }

  function handleReset() {
    setColors(DEFAULT_SETTINGS.statusColors)
    setGlowIntensity(DEFAULT_SETTINGS.glowIntensity)
    setBackdropBlur(DEFAULT_SETTINGS.backdropBlur)
    setShadowSpread(DEFAULT_SETTINGS.shadowSpread)
    setOperatorName(DEFAULT_SETTINGS.operatorName)
    setSystemName(DEFAULT_SETTINGS.systemName)
    setNotificationInterval(DEFAULT_SETTINGS.notificationInterval)
    setBrowserNotifications(DEFAULT_SETTINGS.browserNotificationsEnabled)
    setServerPort(DEFAULT_SETTINGS.serverPort)
    setFontFamily(DEFAULT_SETTINGS.fontFamily)
    setTerminalWidth(DEFAULT_SETTINGS.terminalWidth)
    playClick()
    toast.info('Settings reset to defaults — commit to apply')
  }

  async function handleClearData() {
    syncClearData()
    // Clear local IndexedDB
    await db.tasks.clear()
    await db.projects.clear()
    await db.sessions.clear()
    await db.notifications.clear()
    await db.activityLogs.clear()
    playDelete()
    toast.success('All data cleared')
    logActivity('data_cleared', 'All data cleared', { entityType: 'system' })
    window.location.href = '/dashboard'
  }

  async function handleSeed() {
    await seedDatabase()
    playSuccess()
    toast.success('Database seeded with sample data')
    logActivity('data_seeded', 'Database seeded with sample data', { entityType: 'system' })
    window.location.href = '/dashboard'
  }

  // Rotate through active tasks for preview cards
  const allTasks = useTasks()
  const activeTasks = useMemo(() => {
    if (!allTasks) return []
    return allTasks.filter(t =>
      t.status === 'in_progress' || t.status === 'paused' || t.status === 'partial_done' || t.status === 'blocked'
    )
  }, [allTasks])

  const [previewIndex, setPreviewIndex] = useState(0)

  useEffect(() => {
    if (activeTasks.length <= 1) return
    const timer = setInterval(() => {
      setPreviewIndex(i => (i + 1) % activeTasks.length)
    }, 60000)
    return () => clearInterval(timer)
  }, [activeTasks.length])

  const safeIndex = activeTasks.length > 0 ? previewIndex % activeTasks.length : 0
  const secondIndex = activeTasks.length > 1 ? (safeIndex + 1) % activeTasks.length : -1

  const nextPreview = useCallback(() => {
    if (activeTasks.length <= 1) return
    setPreviewIndex(i => (i + 1) % activeTasks.length)
  }, [activeTasks.length])

  const primaryTask = activeTasks[safeIndex]
  const secondaryTask = secondIndex >= 0 ? activeTasks[secondIndex] : null

  const primaryStatus = primaryTask?.status ?? 'in_progress'
  const secondaryStatus = secondaryTask?.status ?? 'paused'
  const previewColor = colors[primaryStatus] ?? colors['in_progress']
  const pausedColor = colors[secondaryStatus] ?? colors['paused']

  return (
    <div className="max-w-6xl mx-auto py-4">
      {/* Header */}
      <header className="mb-12 border-l-4 border-primary pl-6">
        <h1 className="text-5xl font-black uppercase tracking-tighter mb-2 text-on-surface">
          NEON FLUX <span className="text-primary">CORE</span>
        </h1>
        <p className="text-muted-foreground font-label uppercase tracking-widest text-xs">
          System Configuration / Visual Status Mapping
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Settings */}
        <div className="lg:col-span-7 space-y-8">
          {/* System Identity */}
          <section className="bg-accent/30 p-8 border-t border-secondary/20">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-secondary" /> SYSTEM IDENTITY
            </h3>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                  Operator_Name
                </label>
                <input
                  type="text"
                  value={operatorName}
                  onChange={(e) => setOperatorName(e.target.value)}
                  className="w-full bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-2 px-2 uppercase tracking-widest"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                  System_Designation
                </label>
                <input
                  type="text"
                  value={systemName}
                  onChange={(e) => setSystemName(e.target.value)}
                  className="w-full bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-2 px-2 uppercase tracking-widest"
                />
              </div>
            </div>
          </section>

          {/* Font Selection */}
          <section className="bg-accent/30 p-8 border-t border-primary/20">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-primary" /> TYPEFACE ENGINE
            </h3>
            <div className="space-y-3">
              {FONT_OPTIONS.map(font => (
                <button
                  key={font.value}
                  onClick={() => setFontFamily(font.value)}
                  className={`w-full flex items-center justify-between p-4 transition-colors ${
                    fontFamily === font.value
                      ? 'bg-primary/10 border border-primary/40'
                      : 'bg-accent/50 border border-transparent hover:bg-accent'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`w-3 h-3 border ${
                        fontFamily === font.value
                          ? 'bg-primary border-primary'
                          : 'border-muted-foreground/40'
                      }`}
                    />
                    <div className="text-left">
                      <p
                        className="text-sm font-bold uppercase tracking-widest"
                        style={{ fontFamily: font.css }}
                      >
                        {font.label}
                      </p>
                      <p
                        className="text-xs text-muted-foreground mt-1"
                        style={{ fontFamily: font.css }}
                      >
                        The quick brown fox jumps over the lazy dog — 0123456789
                      </p>
                    </div>
                  </div>
                  {fontFamily === font.value && (
                    <span className="text-[10px] uppercase tracking-widest text-primary font-bold">
                      Active
                    </span>
                  )}
                </button>
              ))}
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest mt-2">
                Changes apply after committing to core.
              </p>
            </div>
          </section>

          {/* Notification Settings */}
          <section className="bg-accent/30 p-8 border-t border-tertiary/20">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-tertiary" /> NOTIFICATION ENGINE
            </h3>
            <div className="space-y-6">
              {/* Browser notifications toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold block">
                    Browser_Notifications
                  </label>
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest mt-1">
                    Send system-level browser notifications while tasks are active
                  </p>
                </div>
                <Switch
                  checked={browserNotifications}
                  onCheckedChange={setBrowserNotifications}
                />
              </div>

              {/* Interval */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                  Reminder_Interval
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="1"
                    max="480"
                    value={notificationInterval}
                    onChange={(e) => setNotificationInterval(Number(e.target.value) || 1)}
                    className="w-20 bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-2 px-2 tabular-nums"
                  />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-widest">minutes</span>
                </div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                  How often to send reminders during active sessions. Internal bell notifications are always sent regardless of the toggle above.
                </p>
              </div>
            </div>
          </section>

          {/* Server Settings */}
          <section className="bg-accent/30 p-8 border-t border-secondary/20">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-secondary" /> SERVER CONFIG
            </h3>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                  HTTP/SSE_Port
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={serverPort}
                    onChange={(e) => setServerPort(Number(e.target.value) || 3456)}
                    className="w-28 bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-2 px-2 tabular-nums"
                  />
                </div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                  Port for the HTTP/SSE server. Used by the Tauri sidecar and MCP sync. Restart required after change.
                </p>
              </div>
            </div>
          </section>

          {/* Status Color Channels */}
          <section className="bg-accent/30 p-8 border-t border-primary/20">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-primary" /> STATUS COLOR CHANNELS
            </h3>
            <div className="space-y-4">
              {ALL_STATUSES.map(status => (
                <div
                  key={status}
                  className="flex items-center justify-between p-4 bg-accent/50 hover:bg-accent transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className="w-10 h-10 border border-white/10"
                      style={{
                        backgroundColor: colors[status],
                        boxShadow: colors[status] !== DEFAULT_STATUS_COLORS.not_started
                          ? `0 0 10px ${colors[status]}33`
                          : undefined,
                      }}
                    />
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest">
                        {getStatusLabel(status)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        HEX: {colors[status].toUpperCase()}
                      </p>
                    </div>
                  </div>
                  <input
                    type="color"
                    value={colors[status]}
                    onChange={e => handleColorChange(status, e.target.value)}
                    className="w-8 h-8 bg-transparent border-none cursor-pointer"
                  />
                </div>
              ))}
            </div>
          </section>

          {/* Glow Settings */}
          <section className="bg-accent/30 p-8 border-t border-secondary/20">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-secondary" /> PHOTON EMISSION (GLOW)
            </h3>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between mb-4">
                  <span className="text-[10px] uppercase tracking-widest font-bold">
                    Intensity Scale
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-secondary font-bold">
                    {glowIntensity}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={glowIntensity}
                  onChange={e => setGlowIntensity(Number(e.target.value))}
                  className="w-full h-1 bg-accent appearance-none cursor-pointer accent-secondary"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-accent border border-white/5">
                  <p className="text-[10px] text-muted-foreground uppercase mb-2">
                    Backdrop Blur
                  </p>
                  <input
                    type="number"
                    value={backdropBlur}
                    onChange={e => setBackdropBlur(Number(e.target.value))}
                    className="text-xl font-black bg-transparent border-none outline-none w-full"
                  />
                </div>
                <div className="p-4 bg-accent border border-white/5">
                  <p className="text-[10px] text-muted-foreground uppercase mb-2">
                    Shadow Spread
                  </p>
                  <input
                    type="number"
                    value={shadowSpread}
                    onChange={e => setShadowSpread(Number(e.target.value))}
                    className="text-xl font-black bg-transparent border-none outline-none w-full"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Agent Terminal Settings */}
          <section className="bg-accent/30 p-8 border-t border-primary/20">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <span className="w-2 h-2 bg-primary" /> AGENT TERMINAL
            </h3>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between mb-4">
                  <span className="text-[10px] uppercase tracking-widest font-bold">
                    Terminal Card Width
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-primary font-bold">
                    {terminalWidth}px
                  </span>
                </div>
                <input
                  type="range"
                  min={300}
                  max={800}
                  step={10}
                  value={terminalWidth}
                  onChange={e => setTerminalWidth(Number(e.target.value))}
                  className="w-full h-1 bg-accent appearance-none cursor-pointer accent-primary"
                />
                <div className="flex justify-between mt-2 text-[9px] text-muted-foreground uppercase tracking-widest">
                  <span>300px</span>
                  <span>800px</span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                Controls the width of each agent terminal card on the Agent Terminals page
              </p>
            </div>
          </section>
        </div>

        {/* Right Column: Live Preview */}
        <div className="lg:col-span-5 space-y-8">
          <section className="sticky top-24">
            <div className="bg-accent/30 border-t border-tertiary/20 p-8">
              <div className="flex items-center justify-between mb-8">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <span className="w-2 h-2 bg-tertiary" /> LIVE COMPONENT PREVIEW
                </h3>
                {activeTasks.length > 1 && (
                  <button
                    onClick={nextPreview}
                    className="text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground font-bold flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined text-sm">skip_next</span>
                    Next
                  </button>
                )}
              </div>

              {/* Preview Card - In Progress */}
              <div
                className="bg-card border-l-4 p-6 mb-8"
                style={{
                  borderColor: previewColor,
                  boxShadow: `0 0 ${shadowSpread}px ${previewColor}4d`,
                  backdropFilter: `blur(${backdropBlur}px)`,
                }}
              >
                <div className="flex justify-between items-start mb-4">
                  <div
                    className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest"
                    style={{
                      backgroundColor: `${previewColor}15`,
                      color: previewColor,
                      border: `1px solid ${previewColor}66`,
                    }}
                  >
                    {getStatusLabel(primaryStatus)}
                  </div>
                </div>
                <h4 className="text-2xl font-black tracking-tight leading-none mb-4 uppercase">
                  {primaryTask?.title ?? 'Initialize Neural Link protocols'}
                </h4>
                <div className="flex items-center gap-4 mb-6">
                  <div className="flex -space-x-2">
                    <div className="w-6 h-6 bg-accent border border-white/10 flex items-center justify-center text-[8px]">
                      JD
                    </div>
                    <div className="w-6 h-6 bg-accent border border-white/10 flex items-center justify-center text-[8px]">
                      AM
                    </div>
                  </div>
                  <div className="h-px bg-white/10 flex-grow" />
                  <div className="text-[10px] font-bold text-muted-foreground tracking-widest uppercase">
                    Aug 24
                  </div>
                </div>
                <div className="flex justify-between items-center pt-4 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-1.5 h-1.5 animate-pulse"
                      style={{ backgroundColor: previewColor }}
                    />
                    <span
                      className="text-[10px] uppercase tracking-widest font-bold"
                      style={{ color: previewColor }}
                    >
                      Kinetic Active
                    </span>
                  </div>
                </div>
              </div>

              {/* Preview Card - Paused */}
              <div
                className="bg-card border-l-4 p-6 opacity-60"
                style={{
                  borderColor: pausedColor,
                  boxShadow: `0 0 ${shadowSpread}px ${pausedColor}33`,
                }}
              >
                <div className="flex justify-between items-start mb-4">
                  <div
                    className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest"
                    style={{
                      backgroundColor: `${pausedColor}15`,
                      color: pausedColor,
                      border: `1px solid ${pausedColor}66`,
                    }}
                  >
                    {getStatusLabel(secondaryStatus)}
                  </div>
                </div>
                <h4 className="text-2xl font-black tracking-tight leading-none uppercase">
                  {secondaryTask?.title ?? 'Database Sharding Stage 4'}
                </h4>
              </div>

              {/* Action Buttons */}
              <div className="mt-8">
                <button
                  onClick={handleSave}
                  className="w-full bg-secondary text-secondary-foreground font-bold py-4 tracking-widest hover:shadow-[0_0_15px_rgba(0,251,251,0.3)] transition-all active:scale-95 uppercase text-xs"
                >
                  COMMIT TO CORE
                </button>
                <button
                  onClick={handleReset}
                  className="w-full mt-4 border border-muted-foreground/30 text-muted-foreground font-bold py-4 tracking-widest hover:bg-accent transition-all uppercase text-xs"
                >
                  RESET TO DEFAULTS
                </button>
              </div>

              {/* Seed Data (Dev) */}
              <div className="mt-8 pt-8 border-t border-destructive/20">
                <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 bg-destructive" /> DEV_TOOLS
                </h3>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-4">
                  Populate database with sample projects, tasks, dependencies, and sessions for UI testing.
                  This will clear all existing data.
                </p>
                <div className="flex gap-4">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button className="flex-1 border border-destructive/40 text-destructive font-bold py-4 tracking-widest hover:bg-destructive/10 transition-all active:scale-95 uppercase text-xs">
                        SEED_DATABASE
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle className="uppercase tracking-widest">Seed Database?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will clear all existing tasks, projects, and sessions, then populate with sample data. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleSeed} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                          Confirm Seed
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button className="flex-1 border border-destructive/40 text-destructive font-bold py-4 tracking-widest hover:bg-destructive/10 transition-all active:scale-95 uppercase text-xs">
                        CLEAR_DATA
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle className="uppercase tracking-widest">Clear All Data?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete all tasks, projects, and sessions. Your settings will be preserved. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleClearData} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                          Confirm Clear
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest mt-2">
                  Clear removes all tasks, projects, and sessions. Settings are preserved.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
