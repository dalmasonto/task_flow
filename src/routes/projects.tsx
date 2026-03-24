import { useMemo } from 'react'
import { Link } from 'react-router'
import { useProjects } from '@/hooks/use-projects'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

function ProjectCard({ project }: { project: { id?: number; name: string; color: string; type: string; description?: string; createdAt: Date } }) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className="bg-card p-6 border-l-4 transition-all hover:bg-accent hover:translate-x-1 block"
      style={{ borderColor: project.color }}
    >
      <h2 className="font-bold text-lg uppercase mb-2">{project.name}</h2>
      {project.description && (
        <div className="line-clamp-2 mb-3">
          <MarkdownRenderer content={project.description} compact className="text-muted-foreground" />
        </div>
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

function ProjectGrid({ projects, emptyMessage }: { projects: Array<{ id?: number; name: string; color: string; type: string; description?: string; createdAt: Date }>; emptyMessage: string }) {
  if (projects.length === 0) {
    return (
      <p className="text-xs text-muted-foreground uppercase tracking-widest py-8 text-center">
        {emptyMessage}
      </p>
    )
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {projects.map(project => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
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
        <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase">Projects</h1>
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
        <Tabs defaultValue="active" className="w-full">
          <TabsList className="bg-accent/30 border border-border">
            <TabsTrigger
              value="active"
              className="text-xs uppercase tracking-widest data-[state=active]:bg-secondary/10 data-[state=active]:text-secondary"
            >
              Active Projects
              <span className="ml-2 text-[10px] bg-secondary/10 px-1.5 py-0.5">
                {activeProjects.length.toString().padStart(2, '0')}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="ideas"
              className="text-xs uppercase tracking-widest data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
            >
              Project Ideas
              <span className="ml-2 text-[10px] bg-primary/10 px-1.5 py-0.5">
                {projectIdeas.length.toString().padStart(2, '0')}
              </span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-6">
            <ProjectGrid projects={activeProjects} emptyMessage="No active projects" />
          </TabsContent>

          <TabsContent value="ideas" className="mt-6">
            <ProjectGrid projects={projectIdeas} emptyMessage="No project ideas yet" />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
