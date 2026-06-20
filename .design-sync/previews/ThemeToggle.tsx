import { ThemeProvider, ThemeToggle } from 'frontend'

export const Default = () => (
  <ThemeProvider defaultTheme="dark" storageKey="ds-preview-theme">
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 10,
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border)',
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg-muted)' }}>Appearance</span>
      <ThemeToggle />
    </div>
  </ThemeProvider>
)

export const InSidebarFooter = () => (
  <ThemeProvider defaultTheme="system" storageKey="ds-preview-theme-2">
    <div
      style={{
        width: 232,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        borderRadius: 12,
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.1 }}>
          Vlad Sokol
        </div>
        <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--fg-subtle)', lineHeight: 1.1 }}>
          Owner
        </div>
      </div>
      <ThemeToggle />
    </div>
  </ThemeProvider>
)
