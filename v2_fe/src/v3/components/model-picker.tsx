/// Pick an agent's model from the ones TaskFlow has marks for.
import { cn } from "@/lib/utils"

import { ActorAvatar } from "./actor-avatar"
import { MODELS, type ModelId } from "./actor-models"

const PICKABLE: ModelId[] = ["claude", "codex", "gemini", "deepseek", "qwen", "cursor", "copilot", "kimi", "mistral", "ollama", "grok", "openai"]

export function ModelPicker({ value, onChange, name }: { value: ModelId; onChange: (m: ModelId) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={`${name}: model`} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {PICKABLE.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={cn(
            "flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-sm transition-colors",
            value === m ? "border-ring bg-accent ring-2 ring-ring/20" : "border-border hover:bg-accent/50",
          )}
        >
          <ActorAvatar model={m} name={MODELS[m].label} size="xs" />
          <span className="truncate">{MODELS[m].label}</span>
        </button>
      ))}
    </div>
  )
}
