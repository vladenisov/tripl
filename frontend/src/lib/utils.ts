import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// The app's own type and radius scale (index.css @theme, DS-20). Without this
// tailwind-merge reads `text-body-sm` as a text COLOUR and drops it when a
// colour class follows (`cn("text-body-sm", "text-fg-subtle")`), and it would
// never let a later size override it.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["caption", "body-sm", "body", "lead", "title"],
      radius: ["control", "card"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getErrorMessage(error: unknown, fallback = 'Something went wrong.') {
  return error instanceof Error && error.message ? error.message : fallback
}
