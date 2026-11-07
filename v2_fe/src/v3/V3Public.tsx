/// v3 pages that render without a session: the landing page and auth.
///
/// Foundation stage: auth reuses the current AuthPage with a /v3 base path, and
/// the landing page sends you on (to the app if signed in, else to sign in).
/// Both get their v3 rebuild in the stage-2 port.
import { Navigate, useLocation } from "react-router-dom"

import { hasStoredAuthSession } from "@/lib/auth-api"
import { AuthPage } from "@/pages/auth"

import { useV3Document } from "./V3App"
import { V3_HOME, V3_LOGIN } from "./routes"

export function V3Public() {
  useV3Document()
  const { pathname } = useLocation()
  const path = pathname.replace(/\/$/, "")
  if (path === "/v3/login") return <AuthPage mode="login" basePath="/v3" />
  if (path === "/v3/signup") return <AuthPage mode="signup" basePath="/v3" />
  if (path === "/v3/reset-password") return <AuthPage mode="reset" basePath="/v3" />
  if (path.startsWith("/v3/confirm-password")) return <AuthPage mode="confirm" basePath="/v3" />
  // The landing page and the not-yet-ported public pages.
  return <Navigate to={hasStoredAuthSession() ? V3_HOME : V3_LOGIN} replace />
}
