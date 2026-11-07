/// The v3 app (authenticated). Rendered by App's v3 branch inside
/// V3WorkspaceContext, after App has opened the one realtime stream.
///
/// Pages are ported one by one (stage 2). Until a page lands, its route shows an
/// honest "not ported yet" state with a link to the v2 page that still works.
import { useEffect } from "react"
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { ArrowUpRightIcon, HammerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

import { V3_HOME } from "./routes"
import { activeNavId, V2_FALLBACK, V3_NAV } from "./shell/nav"
import { V3Shell } from "./shell/V3Shell"

/// While a /v3 route is mounted, <html> carries `v3` so the scoped design tokens
/// (tokens.css) apply, including to portalled dialogs and popovers.
export function useV3Document() {
  useEffect(() => {
    const root = document.documentElement
    root.classList.add("v3")
    return () => root.classList.remove("v3")
  }, [])
}

function NotPortedYet() {
  const { pathname } = useLocation()
  const id = activeNavId(pathname)
  const item = V3_NAV.flatMap((g) => g.items).find((i) => i.id === id)
  const v2 = id ? V2_FALLBACK[id] : undefined
  return (
    <V3Shell title={item?.label ?? "Not found"}>
      <Empty className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HammerIcon />
          </EmptyMedia>
          <EmptyTitle>{item ? `${item.label} is being rebuilt for v3` : "There's no page here"}</EmptyTitle>
          <EmptyDescription>
            {item ? "Everything still works in the current app while this page is ported." : "Check the address, or pick a page from the sidebar."}
          </EmptyDescription>
        </EmptyHeader>
        {v2 ? (
          <EmptyContent>
            <Button nativeButton={false} render={<Link to={v2} />}>
              Open in the current app
              <ArrowUpRightIcon />
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </V3Shell>
  )
}

export function V3App() {
  useV3Document()
  return (
    <Routes>
      <Route path="/v3/home" element={<Navigate to={V3_HOME} replace />} />
      <Route path="*" element={<NotPortedYet />} />
    </Routes>
  )
}
