import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { WELCOME_PILLARS } from '@/components/workspace-welcome-pillars'
import { DEMO_PROVISION_ESTIMATE } from '@/demo/provisioningPhases'
import { Plus, Sparkles } from 'lucide-react'

interface WorkspaceWelcomeProps {
  canCreateProject: boolean
  isProvisioningDemo: boolean
  onGenerateDemo: () => void
  onCreateProject: () => void
}

/**
 * Post-registration welcome hero for the empty workspace (tripl-odrj.1):
 * explains what tripl is and offers the two ways in — a generated demo or an
 * empty project. Replaces the all-zero stat band until the first project exists.
 */
export function WorkspaceWelcome({
  canCreateProject,
  isProvisioningDemo,
  onGenerateDemo,
  onCreateProject,
}: WorkspaceWelcomeProps) {
  return (
    <section className="space-y-8 py-4">
      <div className="mx-auto flex max-w-2xl flex-col items-center space-y-3 text-center">
        <Chip tone="accent" size="sm">
          Tracking plan operations
        </Chip>
        <h2 className="m-0 text-[26px] font-semibold leading-tight tracking-[-0.02em]">
          Keep your product analytics honest
        </h2>
        <p className="m-0 text-[13.5px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
          tripl is the single place where your team writes down what you <em>intend</em> to track,
          checks it against what your apps are <em>actually</em> sending, and gets a heads-up the
          moment the numbers start to look wrong.
        </p>
        <p className="m-0 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          No new SDK to ship and nothing to re-instrument — tripl connects to the data warehouse
          you already have (ClickHouse, BigQuery, or PostgreSQL) and only ever reads from it.
        </p>
      </div>

      {canCreateProject ? (
        <div className="mx-auto flex max-w-2xl flex-col justify-center gap-x-8 gap-y-4 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-1.5 sm:items-center sm:text-center">
            <Button onClick={onGenerateDemo} disabled={isProvisioningDemo}>
              <Sparkles className="h-3.5 w-3.5" />
              {isProvisioningDemo ? 'Generating…' : 'Generate demo project'}
            </Button>
            <p className="m-0 max-w-[280px] text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
              Builds a complete example in {DEMO_PROVISION_ESTIMATE} — local synthetic data, real
              scans and monitors. Reset or delete it any time.
            </p>
          </div>
          <div className="flex flex-col gap-1.5 sm:items-center sm:text-center">
            <Button variant="outline" onClick={onCreateProject}>
              <Plus className="h-3.5 w-3.5" />
              New project
            </Button>
            <p className="m-0 max-w-[280px] text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
              Start empty and connect your own warehouse.
            </p>
          </div>
        </div>
      ) : (
        <p
          className="mx-auto max-w-md text-center text-[12.5px]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          Ask a workspace owner or editor to create the first project — you&apos;ll see it here as
          soon as it exists.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        {WELCOME_PILLARS.map((pillar) => (
          <Card
            key={pillar.id}
            className="gap-0 p-0"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <CardContent className="space-y-2 px-4 py-4">
              <div className="flex items-center gap-2.5">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  <pillar.icon className="h-4 w-4" />
                </div>
                <p
                  className="m-0 text-[10px] font-semibold uppercase tracking-[0.07em]"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  {pillar.eyebrow}
                </p>
              </div>
              <h3 className="m-0 text-[13.5px] font-semibold tracking-tight">{pillar.title}</h3>
              <p className="m-0 text-[12px] leading-[1.5]" style={{ color: 'var(--fg-muted)' }}>
                {pillar.description}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-center text-[12px]"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
          color: 'var(--fg-muted)',
        }}
      >
        <span>
          Scan the warehouse → collect metrics → watch the charts — the same loop your real
          project runs on a schedule.
        </span>
        <a
          href="https://vladenisov.github.io/tripl/"
          target="_blank"
          rel="noreferrer"
          className="font-medium hover:underline"
          style={{ color: 'var(--accent)' }}
        >
          Read the concepts →
        </a>
      </div>
    </section>
  )
}
