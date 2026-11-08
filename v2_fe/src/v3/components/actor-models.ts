/// Model logos and helpers for ActorAvatar (kept out of the component file so
/// Fast Refresh keeps working). Logos are bundled, never hotlinked.
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg"
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg"
import copilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg"
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg"
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg"
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg"
import grok from "@lobehub/icons-static-svg/icons/grok.svg"
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg"
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg"
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg"
import openai from "@lobehub/icons-static-svg/icons/openai.svg"
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg"


/// `mono` logos are black glyphs; they are inverted in dark mode.
export const MODELS = {
  claude: { src: claude, label: "Claude" },
  codex: { src: codex, label: "Codex" },
  openai: { src: openai, label: "OpenAI", mono: true },
  deepseek: { src: deepseek, label: "DeepSeek" },
  gemini: { src: gemini, label: "Gemini" },
  qwen: { src: qwen, label: "Qwen" },
  kimi: { src: kimi, label: "Kimi" },
  cursor: { src: cursor, label: "Cursor", mono: true },
  copilot: { src: copilot, label: "GitHub Copilot", mono: true },
  ollama: { src: ollama, label: "Ollama", mono: true },
  mistral: { src: mistral, label: "Mistral" },
  grok: { src: grok, label: "Grok", mono: true },
} as const satisfies Record<string, { src: string; label: string; mono?: boolean }>

export type ModelId = keyof typeof MODELS
export type ActorStatus = "running" | "idle" | "blocked" | "review" | "done" | "failed" | "offline"
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl"

/// Best-effort model from free text (an agent's display name or identifier),
/// for rows that don't carry an explicit model.
export function guessModel(text: string | null | undefined): ModelId | null {
  const t = (text ?? "").toLowerCase()
  for (const id of Object.keys(MODELS) as ModelId[]) if (t.includes(id)) return id
  if (t.includes("gpt")) return "openai"
  return null
}

export function initialsOf(name: string): string {
  return (
    name
      .replace(/\(.*?\)/g, "")
      .trim()
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  )
}


const PROVIDER_LOGO: Record<string, ModelId> = { anthropic: "claude", openai: "openai", google: "gemini" }

/// The logo for an agent row (#1078): its stated model first, then its stated
/// provider, then a guess from the runtime and the name.
export function agentModelId(agent: { model?: string | null; provider?: string | null; runtime?: string | null; display_name?: string | null } | null | undefined): ModelId | null {
  if (!agent) return null
  const byProvider = agent.provider ? (PROVIDER_LOGO[agent.provider] ?? null) : null
  return guessModel(agent.model) ?? byProvider ?? guessModel(agent.runtime) ?? guessModel(agent.display_name)
}
