import { Link } from 'react-router'
import { useProjects } from '@/hooks/use-projects'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

export default function Projects() {
  const projects = useProjects()

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-5xl font-bold tracking-tighter uppercase">Projects</h1>
        <Button asChild>
          <Link to="/projects/new">New Project</Link>
        </Button>
      </div>

      {projects && projects.length === 0 ? (
        <EmptyState
          icon="grid_view"
          title="No Projects Yet"
          description="Create your first project to organize tasks"
          action={
            <Button asChild>
              <Link to="/projects/new">New Project</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects?.map((project) => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              className="bg-card p-6 border-l-4 transition-all hover:bg-accent hover:translate-x-1 block"
              style={{ borderColor: project.color }}
            >
              <h2 className="font-bold text-lg uppercase mb-2">{project.name}</h2>
              {project.description && (
                <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                  {project.description}
                </p>
              )}
              <p className="text-[10px] tracking-widest uppercase text-muted-foreground">
                {new Date(project.createdAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
