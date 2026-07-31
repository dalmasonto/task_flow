import { Link } from 'react-router'

export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center max-w-md space-y-6">
        <div className="space-y-2">
          <h1 className="text-7xl font-headline font-bold tracking-tighter text-primary">404</h1>
          <div className="h-1 w-16 bg-secondary mx-auto" />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-headline uppercase tracking-widest text-muted-foreground">
            Route not found
          </p>
          <p className="text-xs text-muted-foreground/70">
            The page you're looking for doesn't exist or has been moved.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-xs font-headline uppercase tracking-widest hover:bg-primary/90 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">home</span>
            Dashboard
          </Link>
          <button
            onClick={() => window.history.back()}
            className="inline-flex items-center gap-2 px-4 py-2 border border-border text-xs font-headline uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Go back
          </button>
        </div>

        <p className="text-[10px] text-muted-foreground/40 font-mono uppercase tracking-widest">
          ERR::ROUTE_NOT_FOUND
        </p>
      </div>
    </div>
  )
}
