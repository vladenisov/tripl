import { createContext, useContext } from 'react'

/**
 * Marks the top-bar search button. A palette opened by the global Ctrl+K has no
 * trigger to hand focus back to on Esc, so it falls back to this element
 * (tripl-jfm3.68).
 */
export const COMMAND_PALETTE_TRIGGER_ATTR = 'data-command-palette-trigger'

export type CommandPaletteContextValue = {
  open: boolean
  setOpen: (next: boolean) => void
}

const NOOP_CONTEXT: CommandPaletteContextValue = {
  open: false,
  setOpen: () => {},
}

export const CommandPaletteContext = createContext<CommandPaletteContextValue>(NOOP_CONTEXT)

export function useCommandPalette(): CommandPaletteContextValue {
  return useContext(CommandPaletteContext)
}
