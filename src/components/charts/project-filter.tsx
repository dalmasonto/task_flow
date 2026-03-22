import { useProjects } from '@/hooks/use-projects'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface ProjectFilterProps {
  value: string
  onChange: (value: string) => void
}

export function ProjectFilter({ value, onChange }: ProjectFilterProps) {
  const projects = useProjects()

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-48 bg-card border border-border text-[10px] tracking-widest uppercase h-auto py-2">
        <SelectValue placeholder="ALL PROJECTS" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all" className="text-[10px] uppercase tracking-widest">All Projects</SelectItem>
        {(projects ?? []).map(p => (
          <SelectItem key={p.id} value={String(p.id)} className="text-[10px] uppercase tracking-widest">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 inline-block" style={{ backgroundColor: p.color }} />
              {p.name}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
