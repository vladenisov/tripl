import { createElement } from 'react'
import { ClipboardList, Globe, Inbox, Mail, Send, Ticket, Webhook, type LucideIcon, type LucideProps } from 'lucide-react'

import type { AlertDestinationType } from '@/types'

import type { DestinationChannel } from './constants'

export interface ChannelMeta {
  channel: DestinationChannel
  label: string
  Icon: LucideIcon
}

// Channel catalogue — drives both the per-channel sections and the compact
// add-channel affordance, so every type stays addable from one place.
export const CHANNEL_META: ChannelMeta[] = [
  { channel: 'slack', label: 'Slack', Icon: Webhook },
  { channel: 'telegram', label: 'Telegram', Icon: Send },
  { channel: 'webhook', label: 'Webhook', Icon: Globe },
  { channel: 'email', label: 'Email', Icon: Mail },
  { channel: 'jira', label: 'Jira', Icon: Ticket },
  { channel: 'linear', label: 'Linear', Icon: ClipboardList },
]

/**
 * The channel as a reader names it — "Slack", not the raw `slack` / `demo_sink`
 * type the API carries (AL-3, AL-11). The demo sink is not a creatable
 * channel, so it is not in CHANNEL_META, but it is a destination people see.
 */
export function channelLabel(type: AlertDestinationType): string {
  if (type === 'demo_sink') return 'Demo sink (local)'
  return CHANNEL_META.find(meta => meta.channel === type)?.label ?? type
}

/** The channel's icon, or a generic one for the demo sink. */
export function channelIcon(type: AlertDestinationType): LucideIcon {
  return CHANNEL_META.find(meta => meta.channel === type)?.Icon ?? Inbox
}

/**
 * The channel's icon as an element. A component, so call sites render
 * `<ChannelGlyph type=… />` rather than a component picked during render.
 */
export function ChannelGlyph({ type, ...props }: { type: AlertDestinationType } & LucideProps) {
  return createElement(channelIcon(type), props)
}
