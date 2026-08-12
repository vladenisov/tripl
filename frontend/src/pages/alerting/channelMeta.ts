import { ClipboardList, Globe, Mail, Send, Ticket, Webhook, type LucideIcon } from 'lucide-react'

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
