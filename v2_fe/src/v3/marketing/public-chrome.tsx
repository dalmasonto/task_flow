/// Public top bar and footer, from the design's `tf-public-nav` and
/// `tf-public-footer`. Used by the marketing pages and (variant "auth") by the
/// auth pages in group 2.
import { Link } from "react-router-dom"
import { MenuIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { hasStoredAuthSession } from "@/lib/auth-api"
import { cn } from "@/lib/utils"

import { V3_HOME } from "../routes"

export const GITHUB_URL = "https://github.com/dalmasonto/task_flow"
export const NPM_URL = "https://www.npmjs.com/package/@dalmasonto/taskflow-mcp"

const NAV_LINKS = [
  { id: "docs", label: "Docs", to: "/v3/docs" },
  { id: "pricing", label: "Pricing", to: "/v3/pricing" },
  { id: "github", label: "GitHub", href: GITHUB_URL },
] as const

export function BrandMark({ className }: { className?: string }) {
  return (
    <Link
      to="/v3"
      aria-label="TaskFlow home"
      className={cn("flex items-center gap-2 rounded-md font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring", className)}
    >
      <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h9" />
          <path d="M4 12h16" />
          <path d="M11 17h9" />
        </svg>
      </span>
      <span className="text-base">TaskFlow</span>
    </Link>
  )
}

const SHELL = "sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70"

function NavLink({ link, active }: { link: (typeof NAV_LINKS)[number]; active?: string }) {
  const cls = cn("rounded-md px-3 py-2 text-sm hover:text-foreground", link.id === active ? "font-medium text-foreground" : "text-muted-foreground")
  return "href" in link ? (
    <a href={link.href} rel="noopener" className={cls}>
      {link.label}
    </a>
  ) : (
    <Link to={link.to} aria-current={link.id === active ? "page" : undefined} className={cls}>
      {link.label}
    </Link>
  )
}

/// `variant="auth"` drops the section links and keeps only the wordmark plus the
/// opposite auth action, so sign-up and log-in stay focused.
export function PublicNav({ active, variant = "default", auth = "login" }: { active?: "home" | "pricing" | "docs"; variant?: "default" | "auth"; auth?: "login" | "signup" }) {
  // Signed in: the primary action opens the app instead of asking to sign up.
  const signedIn = hasStoredAuthSession()
  if (variant === "auth") {
    return (
      <header className={SHELL}>
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5">
          <BrandMark />
          <div className="flex items-center gap-1">
            <span className="hidden text-sm text-muted-foreground sm:inline">{auth === "login" ? "New to TaskFlow?" : "Already have an account?"}</span>
            <Button variant="ghost" nativeButton={false} render={<Link to={auth === "login" ? "/v3/signup" : "/v3/login"} />}>
              {auth === "login" ? "Create an account" : "Log in"}
            </Button>
          </div>
        </div>
      </header>
    )
  }
  return (
    <header className={SHELL}>
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-5">
        <BrandMark />
        <nav aria-label="Main" className="hidden items-center md:flex">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.id} link={l} active={active} />
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 md:flex">
          {signedIn ? (
            <Button nativeButton={false} render={<Link to={V3_HOME} />}>
              Open your workspace
            </Button>
          ) : (
            <>
              <Button variant="ghost" nativeButton={false} render={<Link to="/v3/login" />}>
                Log in
              </Button>
              <Button nativeButton={false} render={<Link to="/v3/signup" />}>
                Start a project
              </Button>
            </>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="ml-auto size-11 md:hidden" aria-label="Open menu" />}>
            <MenuIcon className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {NAV_LINKS.map((l) =>
              "href" in l ? (
                <DropdownMenuItem key={l.id} render={<a href={l.href} rel="noopener" />}>
                  {l.label}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={l.id} render={<Link to={l.to} />}>
                  {l.label}
                </DropdownMenuItem>
              ),
            )}
            <DropdownMenuSeparator />
            {signedIn ? (
              <DropdownMenuItem render={<Link to={V3_HOME} />}>Open your workspace</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem render={<Link to="/v3/login" />}>Log in</DropdownMenuItem>
                <DropdownMenuItem render={<Link to="/v3/signup" />}>Start a project</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

function FooterCol({ title, links }: { title: string; links: [label: string, to: string][] }) {
  return (
    <div>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map(([label, to]) => (
          <li key={label}>
            {to.startsWith("http") ? (
              <a href={to} rel="noopener" className="text-sm text-muted-foreground hover:text-foreground">
                {label}
              </a>
            ) : (
              <Link to={to} className="text-sm text-muted-foreground hover:text-foreground">
                {label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/// States the licence plainly because it decides who may use TaskFlow for free.
export function PublicFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
        <div className="max-w-xs">
          <Link to="/v3" className="font-semibold tracking-tight text-foreground">
            TaskFlow
          </Link>
          <p className="mt-3 text-sm text-muted-foreground">A shared board, chat and live terminals for teams of AI agents and the people who run them.</p>
        </div>
        <FooterCol
          title="Product"
          links={[
            ["Pricing", "/v3/pricing"],
            ["Docs", "/v3/docs"],
            ["Log in", "/v3/login"],
            ["Start a project", "/v3/signup"],
          ]}
        />
        <FooterCol
          title="Connect an agent"
          links={[
            ["Install the MCP", "/v3/docs/getting-started"],
            ["Agent setup", "/v3/docs/agents"],
            ["Self-hosting", "/v3/docs/self-hosting"],
          ]}
        />
        <FooterCol
          title="Source"
          links={[
            ["GitHub", GITHUB_URL],
            ["npm package", NPM_URL],
            ["Licence", "/v3/pricing"],
          ]}
        />
      </div>
      <div className="border-t border-border">
        <p className="mx-auto w-full max-w-6xl px-5 py-6 text-sm text-muted-foreground">
          Free for noncommercial use under the PolyForm Noncommercial License 1.0.0. Commercial use needs a licence.
        </p>
      </div>
    </footer>
  )
}

export function PublicPage({ active, children }: { active?: "home" | "pricing" | "docs"; children: ReactNode }) {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <PublicNav active={active} />
      {children}
      <PublicFooter />
    </div>
  )
}
