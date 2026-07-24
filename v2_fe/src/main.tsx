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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
)
