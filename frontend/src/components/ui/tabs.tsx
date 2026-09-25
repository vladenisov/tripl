import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cn } from "@/lib/utils"

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />
}

/*
 * The app's tab idiom, not shadcn's pill: a hairline under the strip and a 2px
 * accent underline on the active tab, as the hand-rolled tablists on the scan,
 * event-type and alerting screens draw it. Those can move onto this primitive
 * (and its arrow-key roving and tabpanel wiring) without changing how they
 * look (DS-35).
 */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "text-muted-foreground flex w-full items-end gap-1 overflow-x-auto border-b border-border",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "-mb-px inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-body-sm font-medium text-fg-muted outline-none transition-colors hover:text-foreground disabled:pointer-events-none disabled:text-fg-faint data-[state=active]:border-accent data-[state=active]:text-foreground",
        "focus-visible:rounded-t-md focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      // Radix gives the panel tabIndex=0, so it is a Tab stop and needs its own
      // indicator: the global :focus-visible outline sits in @layer base and
      // loses to `outline-none` (DS-2).
      className={cn(
        "flex-1 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
