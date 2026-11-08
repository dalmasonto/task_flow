/// The v3 app (authenticated). Rendered by App's v3 branch inside
/// V3WorkspaceContext, after App has opened the one realtime stream.
///
/// Pages are ported one by one (stage 2). Until a page lands, its route shows an
/// honest "not ported yet" state with a link to the v2 page that still works.
import { lazy, Suspense, type ComponentType } from "react"
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { ArrowUpRightIcon, HammerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Toaster } from "@/components/ui/sonner"

import { V3_HOME } from "./routes"
import { activeNavId, V2_FALLBACK, V3_NAV } from "./shell/nav"
import { useIsDark } from "./shell/theme-action"
import { V3Shell } from "./shell/V3Shell"
import { useV3Document } from "./use-v3-document"
import { PageLoading } from "./components/page-loading"

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

/// `lazy` for a named export. Every v3 page is its own chunk (reviewer, #MSG5695).
function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType })))
}

const OnboardingTeamPage = lazyNamed(() => import("./onboarding/OnboardingPages"), "OnboardingTeamPage")
const OnboardingProjectPage = lazyNamed(() => import("./onboarding/OnboardingPages"), "OnboardingProjectPage")
const OnboardingAgentsPage = lazyNamed(() => import("./onboarding/OnboardingPages"), "OnboardingAgentsPage")
const OnboardingConnectPage = lazyNamed(() => import("./onboarding/OnboardingPages"), "OnboardingConnectPage")
const OnboardingHelloPage = lazyNamed(() => import("./onboarding/OnboardingPages"), "OnboardingHelloPage")
const ProjectNewPage = lazyNamed(() => import("./projects/ProjectNewPage"), "ProjectNewPage")
const DesignPage = lazyNamed(() => import("./design/DesignPage"), "DesignPage")

export function V3App() {
  useV3Document()
  const dark = useIsDark()
  return (
    <>
      {/* One toaster for all of v3; its theme follows the app's own dark class. */}
      <Toaster theme={dark ? "dark" : "light"} position="bottom-right" />
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/v3/home" element={<Navigate to={V3_HOME} replace />} />
          {/* Onboarding (group 2): full-screen, no app shell, as in the design. */}
          <Route path="/v3/onboarding" element={<OnboardingTeamPage />} />
          <Route path="/v3/onboarding/project" element={<OnboardingProjectPage />} />
          <Route path="/v3/onboarding/agents" element={<OnboardingAgentsPage />} />
          <Route path="/v3/onboarding/connect" element={<OnboardingConnectPage />} />
          <Route path="/v3/onboarding/hello" element={<OnboardingHelloPage />} />
          {/* App shell (group 3). */}
          <Route path="/v3/projects/new" element={<ProjectNewPage />} />
        <Route path="/v3/design" element={<DesignPage />} />
          <Route path="*" element={<NotPortedYet />} />
        </Routes>
      </Suspense>
    </>
  )
}
