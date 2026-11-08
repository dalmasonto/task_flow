/// The one right-hand detail sheet (#5907 items 2 and 12). It reads the URL
/// (see lib/detail-params.ts) and shows a task, the new-task form or an
/// activity entry over whatever page is open, so that page stays mounted. On
/// a slow network the board doesn't reload, Back closes the sheet, and the
/// link can be shared. It fills the screen on a phone. Mounted once, in
/// V3Shell. New kinds of detail go here so every page shares one sheet.
import type { ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { Maximize2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"

import { ActivityDetail } from "../activity/ActivityDetail"
import { readDetail, withDetail } from "../lib/detail-params"
import { useDetail } from "../lib/use-detail"
import { TaskDetail } from "../tasks/TaskDetail"
import { TaskNewForm } from "../tasks/TaskNewForm"

function Frame({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border py-3 pr-12 pl-5">
        <SheetTitle className="min-w-0 flex-1 truncate text-base font-semibold">{title}</SheetTitle>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {description ? <SheetDescription className="sr-only">{description}</SheetDescription> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>
    </>
  )
}

export function DetailSheetHost() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const { close } = useDetail()
  const detail = readDetail(new URLSearchParams(search))

  return (
    <Sheet open={detail != null} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-2xl"
      >
        {detail?.kind === "task" ? (
          <TaskDetail
            key={detail.id}
            id={detail.id}
            onDeleted={close}
            frame={(title, actions, body) => (
              <Frame
                title={title}
                description="Task details"
                actions={
                  <>
                    {actions}
                    <Button variant="ghost" size="icon-sm" aria-label="Open as a full page" title="Open as a full page" render={<Link to={`/v3/tasks/${detail.id}`} />} nativeButton={false}>
                      <Maximize2Icon />
                    </Button>
                  </>
                }
              >
                {body}
              </Frame>
            )}
          />
        ) : detail?.kind === "new-task" ? (
          <Frame title="New task" description="Create a task">
            <TaskNewForm
              status={detail.status}
              column={detail.column ?? null}
              onCreated={(id) => navigate(`${pathname}${withDetail(search, { kind: "task", id })}`, { replace: true })}
              onCancel={close}
            />
          </Frame>
        ) : detail?.kind === "activity" ? (
          <Frame title="Activity" description="One activity entry in full">
            <ActivityDetail id={detail.id} />
          </Frame>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
