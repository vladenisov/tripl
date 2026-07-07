import {
  Activity,
  Archive,
  Cpu,
  Database,
  Key,
  Lock,
  Mail,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react'

/**
 * Navigation model for the full-takeover Settings area. Two top-level contexts
 * (Project / Workspace). Everything functional lives in the app sidebar now;
 * this holds only genuine configuration. Recreated from the design mockup
 * (design/tripl/project/settings-kit.jsx — SETTINGS_NAV).
 */

export type SettingsContext = 'project' | 'workspace'

export type SettingsNavItem = {
  id: string
  label: string
  icon: LucideIcon
  /** Route segment under /settings (e.g. 'project/general'). */
  path: string
  /** Owner-only sections are hidden for non-owners. */
  ownerOnly?: boolean
}

export type SettingsNavGroup = {
  label: string
  sub: string
  /** One-line descriptor framing the group's scope (rendered under the label). */
  desc: string
  items: SettingsNavItem[]
}

export const PROJECT_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Project',
    sub: 'Project',
    desc: "Configuration for this project's tracking plan",
    items: [
      { id: 'general', label: 'General', icon: SlidersHorizontal, path: 'project/general' },
      { id: 'plan-rules', label: 'Plan rules', icon: Shield, path: 'project/plan-rules' },
    ],
  },
]

export const WORKSPACE_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Workspace',
    sub: 'Workspace',
    desc: 'Shared across everyone in the workspace',
    items: [
      { id: 'members', label: 'Members', icon: Users, path: 'members' },
      { id: 'sources', label: 'Data sources', icon: Database, path: 'data-sources' },
      { id: 'apikeys', label: 'API keys', icon: Key, path: 'api-keys' },
    ],
  },
  {
    label: 'Account',
    sub: 'You',
    desc: 'Settings just for you',
    items: [
      { id: 'profile', label: 'Profile', icon: User, path: 'profile' },
      { id: 'security', label: 'Security', icon: Lock, path: 'security' },
    ],
  },
  {
    label: 'Instance',
    sub: 'Owner only',
    desc: 'Server-wide settings (owner only)',
    items: [
      { id: 'runtime', label: 'Runtime', icon: Cpu, path: 'instance/runtime', ownerOnly: true },
      { id: 'email', label: 'Email', icon: Mail, path: 'instance/email', ownerOnly: true },
      { id: 'ai', label: 'AI', icon: Sparkles, path: 'instance/ai', ownerOnly: true },
      {
        id: 'inst-security',
        label: 'Security & access',
        icon: Shield,
        path: 'instance/security',
        ownerOnly: true,
      },
      { id: 'storage', label: 'Storage', icon: Archive, path: 'instance/storage', ownerOnly: true },
      {
        id: 'observability',
        label: 'Observability',
        icon: Activity,
        path: 'instance/observability',
        ownerOnly: true,
      },
      { id: 'system', label: 'System', icon: Server, path: 'instance/system', ownerOnly: true },
    ],
  },
]

export const SETTINGS_NAV: Record<SettingsContext, SettingsNavGroup[]> = {
  project: PROJECT_GROUPS,
  workspace: WORKSPACE_GROUPS,
}

export const SETTINGS_STORAGE_KEY = 'tripl.settings'

/** First section path for a context (used when switching context). */
export function firstSectionPath(ctx: SettingsContext): string {
  return SETTINGS_NAV[ctx][0].items[0].path
}

/** Resolve which context owns a given section path. Defaults to 'workspace'. */
export function contextForPath(path: string): SettingsContext {
  return path.startsWith('project/') ? 'project' : 'workspace'
}

/** Group the visible workspace groups for a role (drops owner-only Instance). */
export function visibleGroups(ctx: SettingsContext, isOwner: boolean): SettingsNavGroup[] {
  return SETTINGS_NAV[ctx]
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.ownerOnly || isOwner),
    }))
    .filter((group) => group.items.length > 0)
}

/**
 * Every settings group (project + workspace) in one flat, owner-filtered list.
 * The settings nav no longer splits project vs workspace behind a segmented
 * toggle — all config lives under a single scrollable rail.
 */
export function visibleGroupsAll(isOwner: boolean): SettingsNavGroup[] {
  return [...visibleGroups('project', isOwner), ...visibleGroups('workspace', isOwner)]
}
