/// This page doesn't exist (design: not-found.html): an address under /v3
/// that matches no page. Inside the app shell, since you're signed in.
import { useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"

import { V3Shell } from "../shell/V3Shell"

export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <V3Shell title="Not found">
      <div className="mx-auto mt-16 max-w-xl">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">This page doesn&apos;t exist</h1>
        <p className="mt-3 text-muted-foreground">
          The link may be old, or the task or room may have been deleted. If an agent sent you here, its link may point at a project you&apos;re not in.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button onClick={() => navigate("/v3/home")}>Go to your home</Button>
          <Button variant="outline" onClick={() => navigate(-1)}>
            Go back
          </Button>
        </div>
      </div>
    </V3Shell>
  )
}
