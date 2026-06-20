import { Skeleton } from 'frontend'

export const Default = () => <Skeleton style={{ width: 240, height: 16 }} />

export const TextLines = () => (
  <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <Skeleton style={{ width: '100%', height: 12 }} />
    <Skeleton style={{ width: '90%', height: 12 }} />
    <Skeleton style={{ width: '60%', height: 12 }} />
  </div>
)

export const Shapes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Skeleton style={{ width: 40, height: 40, borderRadius: '9999px' }} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Skeleton style={{ width: 160, height: 12 }} />
      <Skeleton style={{ width: 100, height: 12 }} />
    </div>
  </div>
)

export const Card = () => (
  <div
    style={{
      width: 280,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: 16,
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
    }}
  >
    <Skeleton style={{ width: '100%', height: 96, borderRadius: 8 }} />
    <Skeleton style={{ width: '70%', height: 14 }} />
    <Skeleton style={{ width: '45%', height: 12 }} />
  </div>
)
