import { Kbd } from 'frontend'

export const Default = () => <Kbd>⌘K</Kbd>

export const Combos = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Kbd>⌘K</Kbd>
    <Kbd>⌘S</Kbd>
    <Kbd>⌘⇧P</Kbd>
    <Kbd>Esc</Kbd>
    <Kbd>↵</Kbd>
    <Kbd>⌥</Kbd>
  </div>
)

export const InContext = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--fg-subtle)' }}>Open command palette</span>
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--fg-subtle)' }}>Save query</span>
      <Kbd>⌘</Kbd>
      <Kbd>S</Kbd>
    </div>
  </div>
)
