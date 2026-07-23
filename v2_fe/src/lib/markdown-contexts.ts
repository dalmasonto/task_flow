/// Contexts consumed by the chips inside `MarkdownRenderer`.
///
/// They live here rather than beside the component because a module that exports
/// both components and non-components breaks React Fast Refresh
/// (`react-refresh/only-export-components`) — editing the renderer would then
/// force a full reload instead of a hot swap.

import { createContext } from "react"

/// Lets a `TASK#<n>` chip open the task sheet without threading a callback
/// through every MarkdownRenderer. App provides the opener; chips consume it.
/// Null (the default) renders chips as inert styled text.
export const TaskChipContext = createContext<((taskId: number) => void) | null>(null)

/// #54: the active project's linked GitHub repo ("owner/name"), or null when the
/// project has none. A `#gh<n>` chip needs it to build an issue URL; without it
/// the chip renders inert and says why rather than linking nowhere.
export const GithubRepoContext = createContext<string | null>(null)

/// #55: opens the docked chat on a conversation, from anywhere in the app.
/// Deliberately the same shape as [[TaskChipContext]] — "click a reference
/// anywhere, open the thing" — so any surface can offer chat without threading a
/// callback down to it. Null (the default) means no dock is mounted.
export const ChatDockContext = createContext<((chatId: string) => void) | null>(null)
