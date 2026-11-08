/// What onboarding carries from step to step.
///
/// The agents' ids, names and profiles go in sessionStorage, so a reload mid-way
/// keeps your place. The KEYS never do: they're shown once and held in memory
/// only, so a reload loses them (the connect step then says to make new ones on
/// the Agents page) rather than parking secrets in browser storage.
import type { LinkedAgent } from "./onboarding-logic"

const KEY = "taskflow.v3.onboarding"

type Stored = { projectId: string | null; agents: Omit<LinkedAgent, "key">[]; kickoffId: number | null }

const keys = new Map<number, string>()

function read(): Stored {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Stored | null
    return v ?? { projectId: null, agents: [], kickoffId: null }
  } catch {
    return { projectId: null, agents: [], kickoffId: null }
  }
}

function write(v: Stored) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    // Private mode etc.: onboarding still works within this page's memory.
  }
}

export const onboardingStore = {
  projectId: () => read().projectId,
  setProject(projectId: string) {
    write({ ...read(), projectId, agents: [], kickoffId: null })
  },
  agents(): LinkedAgent[] {
    return read().agents.map((a) => ({ ...a, key: keys.get(a.agentId) ?? null }))
  },
  setAgents(agents: LinkedAgent[]) {
    keys.clear()
    for (const a of agents) if (a.key) keys.set(a.agentId, a.key)
    // Keys stay in memory only; everything else may persist for this tab.
    const safe = agents.map((a) => ({ model: a.model, displayName: a.displayName, profile: a.profile, agentId: a.agentId }))
    write({ ...read(), agents: safe, kickoffId: null })
  },
  kickoffId: () => read().kickoffId,
  setKickoff(id: number) {
    write({ ...read(), kickoffId: id })
  },
  clear() {
    keys.clear()
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      /* nothing to clear */
    }
  },
}
