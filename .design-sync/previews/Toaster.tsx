import { Toaster } from 'frontend'

// Toaster (sonner) is an imperative toast REGION: it portals nothing until
// toast()/toast.error() is called at runtime, so a bare <Toaster /> renders
// blank. To keep the card meaningful we render the live <Toaster /> region
// PLUS static replicas of its toast styling built from the same tokens the
// component applies (bg-background / text-foreground / border-border / shadow-lg,
// muted-foreground description, primary action button).

function ToastShell({ children, width = 360 }: { children: React.ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid var(--border)',
        background: 'var(--background)',
        color: 'var(--foreground)',
        boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
        font: 'inherit',
      }}
    >
      {children}
    </div>
  )
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        marginTop: 4,
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        flexShrink: 0,
      }}
    />
  )
}

export const Region = () => (
  // The actual imperative region — renders nothing visible until a toast fires.
  <div style={{ position: 'relative', minHeight: 24 }}>
    <Toaster />
    <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
      &lt;Toaster /&gt; mounted (imperative region — empty until toast() is called)
    </span>
  </div>
)

export const SuccessToast = () => (
  <ToastShell>
    <Dot color="var(--success, #16a34a)" />
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Scan config saved</div>
      <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
        Monitoring will use the new baseline on the next run.
      </div>
    </div>
  </ToastShell>
)

export const ErrorWithAction = () => (
  <ToastShell width={400}>
    <Dot color="var(--danger, #dc2626)" />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Failed to publish scan</div>
      <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
        ClickHouse connection timed out after 30s.
      </div>
    </div>
    <button
      style={{
        alignSelf: 'center',
        padding: '6px 12px',
        fontSize: 13,
        fontWeight: 500,
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        background: 'var(--primary)',
        color: 'var(--primary-foreground)',
      }}
    >
      Retry
    </button>
  </ToastShell>
)

export const Stacked = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <ToastShell>
      <Dot color="var(--success, #16a34a)" />
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Annotation added</div>
        <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
          “v4.2 rollout” pinned to May 9.
        </div>
      </div>
    </ToastShell>
    <ToastShell>
      <Dot color="var(--accent)" />
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Export ready</div>
        <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
          12,480 rows · CSV
        </div>
      </div>
    </ToastShell>
  </div>
)
