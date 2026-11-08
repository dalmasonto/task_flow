/// v3 pages that render without a session: marketing (group 1) and auth.
///
/// Auth still reuses the current AuthPage with a /v3 base path until its v3
/// rebuild (group 2).
import { Navigate, Route, Routes } from "react-router-dom"

import { hasStoredAuthSession } from "@/lib/auth-api"
import { AuthPage } from "@/pages/auth"

import { useV3Document } from "./V3App"
import { DocArticlePage, DocsIndexPage } from "./marketing/DocsPages"
import { LandingPage } from "./marketing/LandingPage"
import { PricingPage } from "./marketing/PricingPage"
import { V3_HOME, V3_LOGIN } from "./routes"

export function V3Public() {
  useV3Document()
  return (
    <Routes>
      <Route path="/v3" element={<LandingPage />} />
      <Route path="/v3/pricing" element={<PricingPage />} />
      <Route path="/v3/docs" element={<DocsIndexPage />} />
      <Route path="/v3/docs/*" element={<DocArticlePage />} />
      <Route path="/v3/login" element={<AuthPage mode="login" basePath="/v3" />} />
      <Route path="/v3/signup" element={<AuthPage mode="signup" basePath="/v3" />} />
      <Route path="/v3/reset-password" element={<AuthPage mode="reset" basePath="/v3" />} />
      <Route path="/v3/forgot-password" element={<AuthPage mode="reset" basePath="/v3" />} />
      <Route path="/v3/confirm-password/*" element={<AuthPage mode="confirm" basePath="/v3" />} />
      <Route path="*" element={<Navigate to={hasStoredAuthSession() ? V3_HOME : V3_LOGIN} replace />} />
    </Routes>
  )
}
