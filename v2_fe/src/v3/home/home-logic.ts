/// Pure rules for the v3 home page (tested in home-logic.test.ts).

export function greeting(hour: number): string {
  if (hour < 5) return "Good evening"
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

/// Monday 00:00 local of the week containing `now`.
export function weekStart(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const back = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - back)
  return d
}

/// "5 agents are working across 3 projects. 4 things are waiting on you."
export function homeLine(working: number, projects: number, waiting: number): string {
  const a = working === 1 ? "1 agent is" : `${working} agents are`
  const p = projects === 1 ? "1 project" : `${projects} projects`
  const w = waiting === 0 ? "Nothing is waiting on you." : waiting === 1 ? "1 thing is waiting on you." : `${waiting} things are waiting on you.`
  return `${working ? `${a} working across ${p}.` : `No agent is working right now.`} ${w}`
}

/// The display name's first word, for "Good afternoon, Dalmas".
export function firstName(name: string | null | undefined): string {
  const n = (name ?? "").trim()
  if (!n || n.includes("@")) return ""
  return n.split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase())
}
