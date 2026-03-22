import { useMemo } from 'react'
import { Link } from 'react-router'
import { useProjects } from '@/hooks/use-projects'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

function ProjectCard({ project }: { project: { id?: number; name: string; color: string; type: string; description?: string; createdAt: Date } }) {
  return (
    <Link
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
  )
}

export default function Projects() {
  const projects = useProjects()

  const { activeProjects, projectIdeas } = useMemo(() => {
    if (!projects) return { activeProjects: [], projectIdeas: [] }
    return {
      activeProjects: projects.filter(p => p.type === 'active_project'),
      projectIdeas: projects.filter(p => p.type === 'project_idea'),
    }
  }, [projects])

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
        <div className="space-y-12">
          {/* Active Projects */}
          <section>
            <div className="flex items-center gap-3 border-b border-secondary/20 pb-4 mb-6">
              <span className="w-1.5 h-6 bg-secondary" />
              <h2 className="text-xs font-bold tracking-widest uppercase text-secondary">
                Active Projects
              </h2>
              <span className="text-[10px] text-secondary/60 bg-secondary/10 px-2 py-0.5">
                {activeProjects.length.toString().padStart(2, '0')}
              </span>
            </div>
            {activeProjects.length === 0 ? (
              <p className="text-xs text-muted-foreground uppercase tracking-widest py-8 text-center">
                No active projects
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {activeProjects.map(project => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            )}
          </section>

          {/* Project Ideas */}
          <section>
            <div className="flex items-center gap-3 border-b border-primary/20 pb-4 mb-6">
              <span className="w-1.5 h-6 bg-primary" />
              <h2 className="text-xs font-bold tracking-widest uppercase text-primary">
                Project Ideas
              </h2>
              <span className="text-[10px] text-primary/60 bg-primary/10 px-2 py-0.5">
                {projectIdeas.length.toString().padStart(2, '0')}
              </span>
            </div>
            {projectIdeas.length === 0 ? (
              <p className="text-xs text-muted-foreground uppercase tracking-widest py-8 text-center">
                No project ideas yet
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {projectIdeas.map(project => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
