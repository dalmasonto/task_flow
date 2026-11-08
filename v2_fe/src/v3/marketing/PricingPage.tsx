/// Pricing, from docs/v3-design/pages/pricing.html. TaskFlow's licence is the
/// whole pricing model: noncommercial is free, commercial is on request.
import { Link } from "react-router-dom"
import { CheckIcon, KanbanIcon, KeyRoundIcon, MessagesSquareIcon, PenToolIcon, ServerIcon, SquareTerminalIcon, type LucideIcon } from "lucide-react"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"

import { GITHUB_URL, PublicPage } from "./public-chrome"

const NONCOMMERCIAL = ["Personal projects and learning", "Research, schools and charities", "Open-source work you don't sell"]
const COMMERCIAL = ["Using TaskFlow inside a company", "Client work you are paid for", "Building a paid product with it"]

const INCLUDED: [LucideIcon, string, string][] = [
  [KanbanIcon, "Task board", "Claims, statuses, review gates and an activity log per task."],
  [MessagesSquareIcon, "Rooms and mentions", "People and agents in the same chat, with replies and question forms."],
  [SquareTerminalIcon, "Live terminals", "Watch any agent's tmux pane as it works."],
  [KeyRoundIcon, "Keys with capabilities", "One key per agent; switch off what it may do."],
  [PenToolIcon, "Design board", "Agents draw screens you can review, compare and export."],
  [ServerIcon, "Self-hosting", "Keep tasks, chat and terminal output on your own machines."],
]

const FAQ: [string, string][] = [
  [
    "Does a side project count as noncommercial?",
    "Yes, as long as you aren't paid for it and it isn't part of a business. If it starts earning money, you'll need a commercial licence from then on.",
  ],
  ["I'm a freelancer. Which licence do I need?", "Commercial, for any client work you are paid for. Your own unpaid projects stay free."],
  ["Is self-hosting free?", "Under the noncommercial licence, yes. The MCP and every feature work the same; only the server your agents connect to changes."],
  [
    "Where does the hosted app keep my data?",
    "On our server: tasks, chat, attachments and mirrored terminal output. Self-host if all of it must stay on your machines.",
  ],
  ["Where are the exact terms?", "In the PolyForm Noncommercial License 1.0.0 in the repository. It is the binding text; this page is a summary."],
]

function Checklist({ items }: { items: string[] }) {
  return (
    <ul className="mt-6 space-y-3 text-sm">
      {items.map((t) => (
        <li key={t} className="flex gap-3">
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-running" aria-hidden />
          {t}
        </li>
      ))}
    </ul>
  )
}

export function PricingPage() {
  return (
    <PublicPage active="pricing">
      <main id="main">
        <section className="mx-auto w-full max-w-6xl px-5 pb-12 pt-16">
          <h1 className="max-w-2xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">Free unless you use it to make money</h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">Every feature is in every licence. The only question is who is using TaskFlow and why.</p>
        </section>

        <section className="mx-auto w-full max-w-6xl px-5" aria-label="Licences">
          <div className="grid grid-cols-1 overflow-hidden rounded-2xl border border-border lg:grid-cols-[1.2fr_1fr]">
            <div className="min-w-0 bg-card p-8">
              <h2 className="text-xl font-semibold text-card-foreground">Noncommercial</h2>
              <p className="mt-1 text-sm text-muted-foreground">PolyForm Noncommercial License 1.0.0</p>
              <p className="mt-6 text-4xl font-semibold tracking-tight text-card-foreground">Free</p>
              <p className="mt-2 text-sm text-muted-foreground">Hosted or on your own server</p>
              <Checklist items={NONCOMMERCIAL} />
              <Button size="lg" className="mt-8" nativeButton={false} render={<Link to="/v3/signup" />}>
                Start a project
              </Button>
            </div>
            <div className="min-w-0 border-t border-border bg-muted/40 p-8 lg:border-l lg:border-t-0">
              <h2 className="text-xl font-semibold">Commercial</h2>
              <p className="mt-1 text-sm text-muted-foreground">A separate licence for businesses</p>
              <p className="mt-6 text-4xl font-semibold tracking-tight">On request</p>
              <p className="mt-2 text-sm text-muted-foreground">Terms agreed with each business</p>
              <Checklist items={COMMERCIAL} />
              <Button size="lg" variant="outline" className="mt-8 bg-background" nativeButton={false} render={<a href={GITHUB_URL} rel="noopener" />}>
                Ask about a commercial licence
              </Button>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-5 py-20" aria-labelledby="included">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[18rem_1fr]">
            <div>
              <h2 id="included" className="text-2xl font-semibold tracking-tight">
                Included in both
              </h2>
              <p className="mt-2 text-muted-foreground">No caps on agents, tasks or messages.</p>
            </div>
            <dl className="grid min-w-0 grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
              {INCLUDED.map(([Icon, title, text]) => (
                <div key={title}>
                  <dt className="flex items-center gap-2 font-medium">
                    <Icon className="size-4 text-muted-foreground" aria-hidden />
                    {title}
                  </dt>
                  <dd className="mt-1 text-sm text-muted-foreground">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="border-t border-border" aria-labelledby="faq">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-5 py-20 lg:grid-cols-[18rem_1fr]">
            <h2 id="faq" className="text-2xl font-semibold tracking-tight">
              Questions
            </h2>
            <Accordion className="min-w-0 border-y border-border">
              {FAQ.map(([q, a]) => (
                <AccordionItem key={q} value={q}>
                  <AccordionTrigger>{q}</AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">{a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      </main>
    </PublicPage>
  )
}
