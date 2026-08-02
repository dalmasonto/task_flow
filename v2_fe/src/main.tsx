import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { TooltipProvider } from "@/components/ui/tooltip"
import { bootstrapTheme } from "@/lib/theme"
import { consumeOAuthRedirect } from "@/lib/auth-api"

bootstrapTheme()
// Must precede createRoot: an OAuth callback returns the bearer token in the URL
// fragment, and the auth gate reads stored auth SYNCHRONOUSLY on first render —
// a useEffect would land the token too late and strand the user on /login.
consumeOAuthRedirect()

// #119: react-dom's DEVELOPMENT build emits a `performance.measure()` entry per
// component render/effect (for the DevTools performance tracks) and nothing
// ever clears the User Timing buffer — a dev tab re-rendering on every
// realtime event accumulated 1.29M entries / 151 MB of heap (measured from a
// real heap timeline). Sweep the buffer periodically in dev. Entries only
// matter to a Performance-panel trace, and a trace records events LIVE while
// it runs, so sweeping between recordings loses nothing. The prod build emits
// no measures; this never ships.
if (import.meta.env.DEV) {
  window.setInterval(() => {
    performance.clearMeasures()
    performance.clearMarks()
    performance.clearResourceTimings()
  }, 30_000)
}

// Vite's BASE_URL is "/" for the server deploy and a custom-domain Pages site,
// or "/<repo>/" when built with `--base` for GitHub project pages. Router
// basename wants no trailing slash (and "" at root), so the same bundle routes
// correctly under either layout without a hardcoded path.
const routerBasename = import.meta.env.BASE_URL.replace(/\/$/, "")

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={routerBasename}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
)
