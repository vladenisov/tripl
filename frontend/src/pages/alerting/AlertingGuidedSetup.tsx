import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Panel } from '@/components/settings/kit'
import { useCanWrite } from '@/lib/permissions'

import type { DestinationChannel } from './constants'

interface ChannelMeta {
  channel: DestinationChannel
  label: string
  Icon: LucideIcon
}

interface AlertingGuidedSetupProps {
  channels: ChannelMeta[]
  onPickChannel: (channel: DestinationChannel) => void
}

interface Step {
  n: number
  title: string
  body: string
}

// A single guided flow replaces the three separate empty boxes (routing rules,
// destinations, inbox) that used to render side by side before anything is set
// up. It walks a newcomer through the one real path: pick a channel → create a
// destination → attach the first rule.
const STEPS: readonly Step[] = [
  {
    n: 1,
    title: 'Pick a channel',
    body: 'Choose where alerts land — Slack, Telegram, email, a webhook, or an issue tracker.',
  },
  {
    n: 2,
    title: 'Create a destination',
    body: 'Add the channel credentials. Matched signals get delivered here.',
  },
  {
    n: 3,
    title: 'Add your first rule',
    body: 'A rule prefilled on the new destination decides which anomaly signals route to it.',
  },
]

export function AlertingGuidedSetup({ channels, onPickChannel }: AlertingGuidedSetupProps) {
  // The three steps stay on screen for a viewer — they explain what alerting is
  // on a project that has none, which is exactly the question a viewer landing
  // here has. Only the buttons that would 403 come off, and the last step says
  // who does it instead (tripl-oxkt.9).
  const canWrite = useCanWrite()
  return (
    <Panel title="Set up alerting" subtitle="No destinations or rules yet">
      <div className="space-y-6 p-5">
        <p className="max-w-prose text-sm text-muted-foreground">
          Alerting routes active anomaly signals to the channels your team already watches. Three
          steps and you are live.
        </p>

        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step) => (
            <li
              key={step.n}
              className="rounded-lg border p-4"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
            >
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                {step.n}
              </div>
              <div className="mt-3 text-sm font-medium text-foreground">{step.title}</div>
              <p className="mt-1 text-xs text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>

        {canWrite ? (
          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground">Start by picking a channel</span>
            <div className="flex flex-wrap items-center gap-2">
              {channels.map(({ channel, label, Icon }) => (
                <Button key={channel} variant="outline" size="sm" onClick={() => onPickChannel(channel)}>
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Your account has the viewer role, so the first destination is created by an editor or
            owner. Once one exists, incidents and their deliveries show up here for everyone.
          </p>
        )}
      </div>
    </Panel>
  )
}
