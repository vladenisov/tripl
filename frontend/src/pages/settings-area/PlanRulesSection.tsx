import { Chip } from '@/components/primitives/chip'
import { SCard, SHeader } from '@/components/settings/kit'

/**
 * The guardrails this page will hold once they exist. Naming conventions,
 * governance and PII handling have no API behind them — no endpoint, no
 * column, no worker reads any of it.
 */
const PLANNED_RULES: ReadonlyArray<{ title: string; items: readonly string[] }> = [
  {
    title: 'Naming conventions',
    items: [
      'Reject event names that do not match a chosen case style (snake_case, camelCase or Title Case) or a pattern.',
    ],
  },
  {
    title: 'Governance',
    items: [
      'Require an approval, or a minimum number of them, before an event moves to live.',
      'Require every event to name a responsible person.',
      'Flag events that have had no volume for a sustained window.',
    ],
  },
  {
    title: 'PII & compliance',
    items: [
      'Scan field values for likely personal data, and block it without a consent tag.',
      'Set how long raw events are kept before roll-up.',
    ],
  },
]

/**
 * Project · Plan rules: a description of a feature that is not built.
 *
 * It was first a page of live controls pre-set to a governed state, which an
 * owner could read as proof their plan was protected (tripl-x2ho), and then a
 * page of dozens of disabled switches, radios and selects set to "off" — honest,
 * but still a quarter of the settings rail spent on controls that do nothing
 * (WS-37). What is left is one card that says what the rules will cover, with
 * no control that could be mistaken for a setting.
 */
export default function PlanRulesSection() {
  return (
    <div>
      <SHeader
        title="Plan rules"
        description="Guardrails for the tracking plan. None of them run today: no event name is checked, and nothing is required before an event goes live."
        actions={<Chip tone="warning" size="md">Not built yet</Chip>}
      />

      <SCard
        title="Coming later"
        description="What these rules will cover once they are built. There is nothing to configure yet."
      >
        <div className="space-y-4 px-[18px] py-[15px]">
          {PLANNED_RULES.map((group, index) => (
            <section key={group.title} aria-labelledby={`plan-rules-${index}`}>
              <h3
                id={`plan-rules-${index}`}
                className="m-0 text-body font-medium"
              >
                {group.title}
              </h3>
              <ul
                className="m-0 mt-1 list-disc space-y-0.5 pl-5 text-body-sm leading-[1.5]"
                style={{ color: 'var(--fg-subtle)' }}
              >
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </SCard>
    </div>
  )
}
