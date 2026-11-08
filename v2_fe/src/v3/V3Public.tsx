/// v3 pages that render without a session: marketing (group 1) and auth
/// (group 2).
///
/// Every page is a lazy chunk (reviewer, #MSG5695): App imports this file for
/// every visitor, v2 included, so nothing heavy may load eagerly here. The docs
/// pages in particular pull in every guide's text.
import { lazy, Suspense, type ComponentType } from "react"
import { Navigate, Route, Routes } from "react-router-dom"

import { hasStoredAuthSession } from "@/lib/auth-api"

import { useV3Document } from "./V3App"
import { PageLoading } from "./components/page-loading"
import { V3_HOME, V3_LOGIN } from "./routes"

/// `lazy` for a named export.
function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType })))
}

const LandingPage = lazyNamed(() => import("./marketing/LandingPage"), "LandingPage")
const PricingPage = lazyNamed(() => import("./marketing/PricingPage"), "PricingPage")
const DocsIndexPage = lazyNamed(() => import("./marketing/DocsPages"), "DocsIndexPage")
const DocArticlePage = lazyNamed(() => import("./marketing/DocsPages"), "DocArticlePage")
const LoginPage = lazyNamed(() => import("./auth/AuthPages"), "LoginPage")
const SignupPage = lazyNamed(() => import("./auth/AuthPages"), "SignupPage")
const ForgotPasswordPage = lazyNamed(() => import("./auth/AuthPages"), "ForgotPasswordPage")
const ResetPasswordPage = lazyNamed(() => import("./auth/AuthPages"), "ResetPasswordPage")
const ServerPickerPage = lazyNamed(() => import("./auth/ServerPickerPage"), "ServerPickerPage")

export function V3Public() {
  useV3Document()
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/v3" element={<LandingPage />} />
        <Route path="/v3/pricing" element={<PricingPage />} />
        <Route path="/v3/docs" element={<DocsIndexPage />} />
        <Route path="/v3/docs/*" element={<DocArticlePage />} />
        <Route path="/v3/login" element={<LoginPage />} />
        <Route path="/v3/signup" element={<SignupPage />} />
        <Route path="/v3/forgot-password" element={<ForgotPasswordPage />} />
        {/* Reset links from the email: /reset-password?token=… (v2's /confirm-password kept as an alias). */}
        <Route path="/v3/reset-password" element={<ResetPasswordPage />} />
        <Route path="/v3/confirm-password/*" element={<ResetPasswordPage />} />
        <Route path="/v3/server" element={<ServerPickerPage />} />
        <Route path="*" element={<Navigate to={hasStoredAuthSession() ? V3_HOME : V3_LOGIN} replace />} />
      </Routes>
    </Suspense>
  )
}
