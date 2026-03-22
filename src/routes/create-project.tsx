import { useState, useRef } from 'react'
import { useNavigate } from 'react-router'
import { db } from '@/db/database'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { playSuccess } from '@/lib/sounds'
import { addNotification } from '@/hooks/use-app-notifications'
import { logActivity } from '@/hooks/use-activity-log'
import type { ProjectType } from '@/types'

const PRESET_COLORS = [
  { name: 'Primary', value: '#de8eff' },
  { name: 'Secondary', value: '#00fbfb' },
  { name: 'Tertiary', value: '#69fd5d' },
  { name: 'Error', value: '#ff6e84' },
  { name: 'Magenta', value: '#ff00ff' },
  { name: 'Yellow', value: '#ffeb3b' },
]

export default function CreateProject() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#de8eff')
  const [projectType, setProjectType] = useState<ProjectType>('active_project')
  const [showCustom, setShowCustom] = useState(false)
  const customColorRef = useRef<HTMLInputElement>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    await db.projects.add({
      name: name.trim(),
      color,
      type: projectType,
      description: description.trim() || undefined,
      createdAt: new Date(),
    })
    playSuccess()
    toast.success(`Project "${name.trim()}" deployed`)
    addNotification('Project Created', `New project: ${name.trim()}`, 'success')
    logActivity('project_created', `Created project: ${name.trim()}`, { entityType: 'project' })
    navigate('/projects')
  }

  const handleCancel = () => {
    navigate(-1)
  }

  const isPreset = PRESET_COLORS.some((c) => c.value === color)

  return (
    <div className="p-8">
      {/* Header */}
      <p className="text-xs font-bold text-primary tracking-widest uppercase">
        Initialize Module
      </p>
      <h1 className="text-5xl font-bold tracking-tighter uppercase mt-1">
        Create_Project
      </h1>

      {/* Two-column layout */}
      <form onSubmit={handleSubmit} className="mt-10 grid grid-cols-1 lg:grid-cols-12 gap-10">
        {/* Left column: Form */}
        <div className="lg:col-span-7 space-y-8">
          {/* Project Name */}
          <div className="space-y-3">
            <label className="text-xs font-bold text-muted-foreground tracking-widest uppercase block">
              Project_Identity
            </label>
            <input
              type="text"
              placeholder="Enter project designation..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-transparent border-0 border-b border-border text-2xl font-bold tracking-tight placeholder:text-muted-foreground/40 placeholder:text-2xl placeholder:font-bold focus:border-secondary focus:ring-0 focus:outline-none py-3 px-2 transition-colors"
              required
            />
          </div>

          {/* Description */}
          <div className="space-y-3">
            <label className="text-xs font-bold text-muted-foreground tracking-widest uppercase block">
              Scope_Description
            </label>
            <textarea
              placeholder="Define project parameters..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full bg-transparent border-0 border-b border-border text-sm placeholder:text-muted-foreground/40 placeholder:text-sm focus:border-secondary focus:ring-0 focus:outline-none py-3 px-2 resize-y transition-colors"
            />
          </div>

          {/* Project Type */}
          <div className="space-y-3">
            <label className="text-xs font-bold text-muted-foreground tracking-widest uppercase block">
              Project_Classification
            </label>
            <Select value={projectType} onValueChange={(v) => setProjectType(v as ProjectType)}>
              <SelectTrigger className="w-full bg-card border border-border text-xs tracking-widest uppercase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active_project" className="text-xs uppercase tracking-widest">
                  Active Project
                </SelectItem>
                <SelectItem value="project_idea" className="text-xs uppercase tracking-widest">
                  Project Idea
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Color Picker */}
          <div className="space-y-3">
            <label className="text-xs font-bold text-muted-foreground tracking-widest uppercase block">
              Neon_Accent_Signature
            </label>
            <div className="flex flex-wrap gap-3">
              {PRESET_COLORS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => {
                    setColor(preset.value)
                    setShowCustom(false)
                  }}
                  className={cn(
                    'w-10 h-10 rounded-none transition-all flex items-center justify-center',
                    color === preset.value
                      ? 'outline outline-2 outline-offset-2'
                      : 'hover:scale-110'
                  )}
                  style={{
                    backgroundColor: preset.value,
                    outlineColor: color === preset.value ? preset.value : undefined,
                  }}
                  title={preset.name}
                >
                  {color === preset.value && (
                    <span className="material-symbols-outlined text-sm text-black font-bold">
                      check
                    </span>
                  )}
                </button>
              ))}

              {/* Custom color button */}
              <button
                type="button"
                onClick={() => {
                  setShowCustom(true)
                  setTimeout(() => customColorRef.current?.click(), 100)
                }}
                className={cn(
                  'w-10 h-10 rounded-none border border-dashed border-border flex items-center justify-center transition-all hover:border-foreground',
                  showCustom && !isPreset && 'outline outline-2 outline-offset-2'
                )}
                style={
                  showCustom && !isPreset
                    ? { backgroundColor: color, outlineColor: color }
                    : undefined
                }
                title="Custom color"
              >
                {showCustom && !isPreset ? (
                  <span className="material-symbols-outlined text-sm text-black font-bold">
                    check
                  </span>
                ) : (
                  <span className="material-symbols-outlined text-sm text-muted-foreground">
                    add
                  </span>
                )}
              </button>

              <input
                ref={customColorRef}
                type="color"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value)
                  setShowCustom(true)
                }}
                className="sr-only"
                tabIndex={-1}
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4 pt-4">
            <Button
              type="submit"
              className="bg-primary text-primary-foreground font-bold tracking-widest uppercase hover:shadow-[0_0_20px_rgba(222,142,255,0.4)] px-8 py-5 rounded-none"
            >
              Deploy_Project
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              className="border border-border text-muted-foreground hover:text-foreground hover:border-foreground font-bold tracking-widest uppercase px-8 py-5 rounded-none bg-transparent"
            >
              Cancel
            </Button>
          </div>
        </div>

        {/* Right column: Live Preview */}
        <div className="lg:col-span-5">
          <label className="text-xs font-bold text-muted-foreground tracking-widest uppercase block mb-4">
            Live_Preview
          </label>
          <div className="border border-border bg-card p-6 rounded-none">
            {/* Mock task card */}
            <div
              className="border-l-4 bg-muted/30 p-4 rounded-none"
              style={{ borderLeftColor: color }}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className="text-xs font-bold tracking-widest uppercase"
                  style={{ color }}
                >
                  {name || 'Project Name'}
                </span>
                <span className="text-xs text-muted-foreground tracking-widest uppercase">
                  Not_Started
                </span>
              </div>
              <h3 className="text-sm font-bold tracking-tight mb-1">
                Sample Task Entry
              </h3>
              <p className="text-xs text-muted-foreground">
                {description || 'Task description will appear here with the selected accent color.'}
              </p>
              <div className="flex items-center gap-3 mt-3">
                <span
                  className="inline-block w-2 h-2 rounded-none"
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs text-muted-foreground tracking-wider uppercase">
                  Medium Priority
                </span>
              </div>
            </div>

            {/* Second mock card (dimmed) */}
            <div
              className="border-l-4 bg-muted/10 p-4 rounded-none mt-3 opacity-40"
              style={{ borderLeftColor: color }}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className="text-xs font-bold tracking-widest uppercase"
                  style={{ color }}
                >
                  {name || 'Project Name'}
                </span>
                <span className="text-xs text-muted-foreground tracking-widest uppercase">
                  In_Progress
                </span>
              </div>
              <h3 className="text-sm font-bold tracking-tight mb-1">
                Another Task Entry
              </h3>
              <p className="text-xs text-muted-foreground">
                Additional tasks will inherit this accent color.
              </p>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}
