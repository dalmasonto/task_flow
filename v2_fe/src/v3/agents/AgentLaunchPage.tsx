/// Starting an agent (design: agent-launch.html). The design's "launch it in
/// tmux on machine X from the web" would be remote code execution on whoever
/// runs the connected agent, so it waits on Dalmas's call and a safeguarded
/// design (#MSG5779). Until then this is the honest version: how to start one
/// yourself so TaskFlow streams its terminal here.
import { Link } from "react-router-dom"
import { ShieldAlertIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

import { CopyBlock } from "../components/copy-block"
import { initCommand } from "../onboarding/onboarding-logic"
import { V3Shell } from "../shell/V3Shell"

export function AgentLaunchPage() {
  return (
    <V3Shell title="Start an agent">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Start an agent in tmux</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run an agent inside tmux and TaskFlow mirrors its terminal on the agent&apos;s page: you can watch it, send it keys, and answer its permission prompts from the
            dashboard.
          </p>
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">1. Give it a profile</h3>
          <p className="text-sm text-muted-foreground">
            Add the agent, then put the profile it gives you into the repo&apos;s <code className="font-mono text-xs">.taskflow.json</code>.
          </p>
          <Button variant="outline" size="sm" render={<Link to="/v3/agents/new" />} nativeButton={false}>
            Add an agent
          </Button>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">2. Install TaskFlow, once per machine</h3>
          <CopyBlock label="Terminal" text={initCommand([])} />
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">3. Start it in a tmux pane, in that repo</h3>
          <CopyBlock label="Terminal" text={"tmux new -s agents\nTASKFLOW_PROFILE=<profile> claude   # or codex, gemini, …"} />
          <p className="text-sm text-muted-foreground">
            It calls <code className="font-mono text-xs">whoami</code> on start, connects, and shows up live on the agents page. One profile per terminal, or two terminals
            share an inbox.
          </p>
        </section>

        <Alert className="rounded-xl">
          <ShieldAlertIcon />
          <AlertDescription className="text-foreground">
            Launching an agent from here on another machine isn&apos;t available. It would let the web run commands on that machine, so it needs the owner&apos;s local
            opt-in, a fixed list of what can start, and a confirm in that terminal first. That design is pending.
          </AlertDescription>
        </Alert>
      </div>
    </V3Shell>
  )
}
