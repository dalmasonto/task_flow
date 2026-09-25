"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

/// The app's modal, the sibling of `sheet.tsx`'s slide-over — same source
/// (`@base-ui/react/dialog`, one primitive, two looks), same `data-slot` on
/// every part, same export shape, so the two read as one family.
///
/// It is CENTRED and it is not dismissible by accident: Base UI owns the focus
/// trap, Escape, the aria wiring (`DialogTitle`/`DialogDescription` label the
/// popup for you) and focus restore to whatever opened it. That is the whole
/// reason this file exists rather than a div: `TaskRefNotice`
/// (`components/board.tsx`) had to hand-build a backdrop and a
/// `role="dialog"` section and still has no focus trap, and
/// `task-sheet.tsx`'s two-step delete exists because there was no way to ask
/// "are you sure?" — a `window.confirm` being off-brand.
///
/// Size and radius follow the app's modal look (`TaskRefNotice`'s
/// `w-[min(26rem,calc(100vw-2rem))]` + `rounded-xl` + `shadow-lg`), the surface
/// tokens follow `sheet.tsx` (`bg-popover`/`text-popover-foreground`). z-50 is
/// the sheet's own level, and the caller can raise it through `className` when
/// it must clear a dock (as `ComponentDialog` does at z-75/76).

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

/// The backdrop, once — `DialogContent` renders it for you, and both sheet and
/// dialog get the same dimming so a modal looks the same whichever it is.
function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  )
}

/// Portal + backdrop + popup, like `SheetContent` — one part to mount, so no
/// caller can put a popup on the screen without the backdrop behind it.
///
/// `outline-none` is deliberate: Base UI focuses the popup itself on a touch
/// open (so the keyboard does not spring up), and the default focus ring around
/// the whole dialog reads as a rendering bug.
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-popover bg-clip-padding p-4 text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  )
}

/// Actions sit at the END of the dialog, right-aligned, after whatever the
/// dialog is asking — the order every other confirmation in the app uses.
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-row justify-end gap-2", className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
