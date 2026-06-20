import { Button } from 'frontend'

export const Default = () => <Button>Save changes</Button>

export const Variants = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <Button>Save changes</Button>
    <Button variant="secondary">Cancel</Button>
    <Button variant="outline">Preview diff</Button>
    <Button variant="ghost">Dismiss</Button>
    <Button variant="destructive">Delete branch</Button>
    <Button variant="danger">Discard</Button>
    <Button variant="link">View docs</Button>
  </div>
)

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <Button size="xs">Extra small</Button>
    <Button size="sm">Small</Button>
    <Button>Default</Button>
    <Button size="lg">Large</Button>
  </div>
)

export const Disabled = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <Button disabled>Save changes</Button>
    <Button variant="outline" disabled>
      Preview diff
    </Button>
  </div>
)
