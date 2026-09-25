import * as React from "react"
import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      // --scroll-x-bg: a ui/Table inside the card paints its sideways-scroll
      // fades in the card's colour rather than --bg, which in dark mode drew a
      // darker band across the card (DS-34; see .tripl-scroll-x in index.css).
      className={cn("bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm [--scroll-x-bg:var(--card)]", className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1.5 px-6 @container/card-header", className)}
      {...props}
    />
  )
}

type CardTitleProps = React.ComponentProps<"h3"> & {
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
}

function CardTitle({ className, as: As = "h3", ...props }: CardTitleProps) {
  return (
    <As
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6", className)}
      {...props}
    />
  )
}

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle }
