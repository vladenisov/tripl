import { createContext, useContext } from 'react'

export type TweaksPanelContextValue = {
  open: boolean
  setOpen: (next: boolean) => void
}

const NOOP_CONTEXT: TweaksPanelContextValue = {
  open: false,
  setOpen: () => {},
}

export const TweaksPanelContext = createContext<TweaksPanelContextValue>(NOOP_CONTEXT)

export function useTweaksPanel(): TweaksPanelContextValue {
  return useContext(TweaksPanelContext)
}
