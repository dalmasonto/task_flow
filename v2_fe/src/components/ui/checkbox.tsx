"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/// shadcn's checkbox on Base UI (the primitive family every other control in
/// `components/ui` is built on). Controlled with `checked` +
/// `onCheckedChange(checked)`; wrap it in a `<label>` to make the text a target.
///
/// `dark:data-checked:bg-primary` is load-bearing: `dark:bg-input/30` is the
/// more specific rule in dark mode, so without it a CHECKED box kept the faint
/// unchecked fill and drew its primary-foreground (near-black) check on it.
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-muted-foreground/45 bg-background shadow-xs outline-none transition-[border-color,box-shadow] hover:border-muted-foreground/75 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:bg-input/30 dark:data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <CheckIcon className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
