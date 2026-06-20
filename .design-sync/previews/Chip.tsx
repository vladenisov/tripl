import { Chip } from 'frontend'

export const Default = () => <Chip tone="success">Synced</Chip>

export const Tones = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <Chip tone="neutral">Draft</Chip>
    <Chip tone="accent">Beta</Chip>
    <Chip tone="success">Synced</Chip>
    <Chip tone="warning">Stale</Chip>
    <Chip tone="danger">Failed</Chip>
    <Chip tone="info">Queued</Chip>
  </div>
)

export const Variants = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <Chip tone="success" variant="soft">
      Soft
    </Chip>
    <Chip tone="success" variant="outline">
      Outline
    </Chip>
    <Chip tone="neutral" variant="outline">
      Neutral outline
    </Chip>
    <Chip tone="danger" variant="outline">
      Outline danger
    </Chip>
  </div>
)

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <Chip tone="info" size="xs">
      v2.4.1
    </Chip>
    <Chip tone="info" size="sm">
      v2.4.1
    </Chip>
    <Chip tone="info" size="md">
      v2.4.1
    </Chip>
  </div>
)
