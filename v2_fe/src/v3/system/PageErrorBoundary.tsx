/// Something went wrong (design: error.html): a page that throws while
/// rendering, or whose code chunk fails to load, shows this instead of a blank
/// screen. Keyed by the route in V3App, so moving to another page clears it.
///
/// A chunk that fails to load almost always means a new version was deployed
/// while this tab was open (the old chunk names are gone), so that case says
/// so and offers a reload rather than "try again", which would fail the same
/// way.
import { Component, type ErrorInfo, type ReactNode } from "react"
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

import { V3Shell } from "../shell/V3Shell"
import { isChunkLoadError } from "./system-logic"

type State = { error: Error | null }

export class PageErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console for whoever debugs it; the page shows a short form.
    console.error("[v3] page error", error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const stale = isChunkLoadError(error)
    return (
      <V3Shell title="Something went wrong">
        <div className="mx-auto mt-16 flex max-w-md flex-col items-center text-center">
          <span className="inline-flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <TriangleAlertIcon className="size-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold">{stale ? "A newer version is available" : "This page didn't load"}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {stale
              ? "TaskFlow was updated while this tab was open. Reload to get the new version; nothing you saved is lost."
              : "Something on this page broke. Your saved work is safe. Try again, or go somewhere else and come back."}
          </p>
          <div className="mt-5 flex gap-2">
            {stale ? (
              <Button onClick={() => window.location.reload()}>
                <RefreshCwIcon />
                Reload
              </Button>
            ) : (
              <Button onClick={() => this.setState({ error: null })}>
                <RefreshCwIcon />
                Try again
              </Button>
            )}
            <Button variant="outline" nativeButton={false} render={<a href="/v3/overview" />}>
              Go to overview
            </Button>
          </div>
          {!stale ? <p className="mt-6 max-w-full truncate font-mono text-xs text-muted-foreground">{error.message || error.name}</p> : null}
        </div>
      </V3Shell>
    )
  }
}
