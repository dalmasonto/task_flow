import { useState, useEffect } from 'react'
import type { TaskStatus } from '@/types'
import { useSetting, updateSetting } from '@/hooks/use-settings'
import { DEFAULT_STATUS_COLORS, DEFAULT_SETTINGS } from '@/lib/constants'
import { getStatusLabel } from '@/lib/status'
import { seedDatabase } from '@/lib/seed'

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

  const [colors, setColors] = useState<Record<TaskStatus, string>>(savedColors)
  const [glowIntensity, setGlowIntensity] = useState(savedGlow)
  const [backdropBlur, setBackdropBlur] = useState(savedBlur)
  const [shadowSpread, setShadowSpread] = useState(savedSpread)
  const [operatorName, setOperatorName] = useState(savedOperatorName)
  const [systemName, setSystemName] = useState(savedSystemName)

  // Sync local state when saved values load from DB
  useEffect(() => { setColors(savedColors) }, [savedColors])
  useEffect(() => { setGlowIntensity(savedGlow) }, [savedGlow])
  useEffect(() => { setBackdropBlur(savedBlur) }, [savedBlur])
  useEffect(() => { setShadowSpread(savedSpread) }, [savedSpread])
  useEffect(() => { setOperatorName(savedOperatorName) }, [savedOperatorName])
  useEffect(() => { setSystemName(savedSystemName) }, [savedSystemName])

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
  }

  function handleReset() {
    setColors(DEFAULT_SETTINGS.statusColors)
    setGlowIntensity(DEFAULT_SETTINGS.glowIntensity)
    setBackdropBlur(DEFAULT_SETTINGS.backdropBlur)
    setShadowSpread(DEFAULT_SETTINGS.shadowSpread)
    setOperatorName(DEFAULT_SETTINGS.operatorName)
    setSystemName(DEFAULT_SETTINGS.systemName)
  }

  const previewColor = colors['in_progress']
  const pausedColor = colors['paused']

  return (
    <div className="max-w-6xl mx-auto">
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
        </div>

        {/* Right Column: Live Preview */}
        <div className="lg:col-span-5 space-y-8">
          <section className="sticky top-24">
            <div className="bg-accent/30 border-t border-tertiary/20 p-8">
              <h3 className="font-bold text-lg mb-8 flex items-center gap-2">
                <span className="w-2 h-2 bg-tertiary" /> LIVE COMPONENT PREVIEW
              </h3>

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
                    {getStatusLabel('in_progress')}
                  </div>
                </div>
                <h4 className="text-2xl font-black tracking-tight leading-none mb-4 uppercase">
                  Initialize Neural Link protocols
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
                    {getStatusLabel('paused')}
                  </div>
                </div>
                <h4 className="text-2xl font-black tracking-tight leading-none uppercase">
                  Database Sharding Stage 4
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
                <button
                  onClick={async () => {
                    await seedDatabase()
                    window.location.href = '/dashboard'
                  }}
                  className="w-full border border-destructive/40 text-destructive font-bold py-4 tracking-widest hover:bg-destructive/10 transition-all active:scale-95 uppercase text-xs"
                >
                  SEED_DATABASE
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
