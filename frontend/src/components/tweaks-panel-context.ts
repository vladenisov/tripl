import { createContext } from 'react'

export type TweaksPanelContextValue = {
  open: boolean
  setOpen: (next: boolean) => void
}

const NOOP_CONTEXT: TweaksPanelContextValue = {
  open: false,
  setOpen: () => {},
}

export const TweaksPanelContext = createContext<TweaksPanelContextValue>(NOOP_CONTEXT)
