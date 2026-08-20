import { Chip } from '@/components/primitives/chip'
import {
  Field,
  RadioCards,
  SCard,
  Select,
  SHeader,
  TextInput,
  ToggleRow,
} from '@/components/settings/kit'

/**
 * Every select here opens on `unset`. A disabled select reading "1 approval" or
 * "90 days" is a policy claim, and there is no such policy — retention in
 * particular is the kind of claim a reader could take to a compliance review.
 * The real choices stay in the list because they are what the built version is
 * meant to offer.
 */
const UNSET = 'unset'

const MIN_APPROVAL_OPTIONS = [
  { value: UNSET, label: 'Not set' },
  { value: '1', label: '1 approval' },
  { value: '2', label: '2 approvals' },
]

const RETENTION_OPTIONS = [
  { value: UNSET, label: 'Not set' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '0', label: 'Forever' },
]

/**
 * Project · Plan rules. Naming conventions, governance and PII handling have no
 * API behind them — no endpoint, no column, no worker reads any of it — so this
 * whole page is a drawing of a feature that does not exist yet.
 *
 * It used to be a drawing nobody could tell from a working page (tripl-x2ho):
 * every control was a live `useState` pre-set to a governed state ("Enforce
 * naming convention" on, snake_case selected, the regex ^[a-z][a-z0-9_]+$ in
 * the Pattern box, review required, an owner required, 1 approval), and the only
 * warning was a 12px "Not yet connected to the backend." at the far LEFT of two
 * card footers — ~600px from the Save button it explained, and missing from the
 * third card entirely. An owner could read this page as proof that their
 * tracking plan was protected and stop worrying about it. None of it was true.
 *
 * So the status now sits in the header, where the page's own claim used to be;
 * every control is `disabled`, which the kit renders unmistakably (transparent
 * well, dashed border, muted text — components/settings/input-style.ts); and
 * every value shows the state that is actually true — off, unselected, unset —
 * instead of a policy nobody chose. The two Save footers are gone: there was
 * nothing behind them to save, and a disabled Save only argues that the values
 * above it are settings.
 */
export default function PlanRulesSection() {
  return (
    <div>
      <SHeader
        title="Plan rules"
        description="How the tracking plan's guardrails will look once they are built. None of them run today: no event name is checked, nothing is required before an event goes live, and no control on this page can be switched on or saved."
        actions={<Chip tone="warning" size="md">Not built yet</Chip>}
      />

      {/* Every hint on this page is written in the conditional. They used to be
          statements of fact — "Events can't move to live without an approval",
          "Every event must name a responsible person", "How long individual
          events are stored before roll-up" — which is exactly the sentence an
          owner would quote back at you, and none of it is true of any release
          shipped so far. They now say what the control would do. */}
      <SCard title="Naming conventions">
        <ToggleRow
          label="Enforce naming convention"
          hint="Events whose names don't match the pattern below would be rejected."
          value={false}
          disabled
        />
        <Field label="Case style">
          {/* No value matches an option, so nothing renders selected. A filled
              teal radio on snake_case was a choice this project never made. */}
          <RadioCards
            groupLabel="Case style"
            value=""
            disabled
            columns={3}
            options={[
              { value: 'snake', label: 'snake_case', description: 'order_completed' },
              { value: 'camel', label: 'camelCase', description: 'orderCompleted' },
              { value: 'title', label: 'Title Case', description: 'Order Completed' },
            ]}
          />
        </Field>
        <Field label="Pattern" hint="The regular expression event names would have to satisfy." last>
          {/* Placeholder, not value: the regex shows the shape the field will
              take without asserting that this project has one. */}
          <TextInput value="" placeholder="^[a-z][a-z0-9_]+$" mono disabled />
        </Field>
      </SCard>

      <SCard title="Governance" description="Who can change the plan and how changes ship.">
        <ToggleRow
          label="Require review before live"
          hint="An approval would be needed before an event moves to live."
          value={false}
          disabled
        />
        <ToggleRow
          label="Require an owner per event"
          hint="Every event would have to name a responsible person."
          value={false}
          disabled
        />
        <Field label="Minimum approvals">
          <Select value={UNSET} options={MIN_APPROVAL_OPTIONS} disabled />
        </Field>
        <ToggleRow
          label="Auto-deprecate dormant events"
          hint="Events with no volume for a sustained window would be flagged."
          value={false}
          disabled
          last
        />
      </SCard>

      <SCard title="PII & compliance">
        <ToggleRow
          label="Detect PII automatically"
          hint="Field values would be scanned for likely personal data."
          value={false}
          disabled
        />
        <ToggleRow label="Block PII without a consent tag" value={false} disabled />
        <Field
          label="Raw event retention"
          hint="How long individual events would be kept before roll-up."
          last
        >
          <Select value={UNSET} options={RETENTION_OPTIONS} disabled />
        </Field>
      </SCard>
    </div>
  )
}
