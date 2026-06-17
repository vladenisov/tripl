import { useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
 * Project · Plan rules. The guardrails described in the mockup (naming
 * conventions, governance, PII & compliance) do not yet have backing API
 * endpoints, so every control here is presentation-only and operates on local
 * state. The footer "Save" is disabled to make the not-yet-wired status clear.
 */
export default function PlanRulesSection() {
  const [enforceNaming, setEnforceNaming] = useState(true)
  const [caseStyle, setCaseStyle] = useState('snake')
  const [pattern, setPattern] = useState('^[a-z][a-z0-9_]+$')

  const [requireReview, setRequireReview] = useState(true)
  const [requireOwner, setRequireOwner] = useState(true)
  const [minApprovals, setMinApprovals] = useState('1')
  const [autoDeprecate, setAutoDeprecate] = useState(false)

  const [detectPii, setDetectPii] = useState(true)
  const [blockPii, setBlockPii] = useState(false)
  const [retention, setRetention] = useState('90')

  const disabledSave = (
    <>
      <span className="flex-1 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
        Not yet connected to the backend.
      </span>
      <Button size="sm" disabled>
        <Save className="h-3 w-3" />
        Save
      </Button>
    </>
  )

  return (
    <div>
      <SHeader
        title="Plan rules"
        description="Guardrails that keep the tracking plan consistent as the team grows."
      />

      <SCard title="Naming conventions" footer={disabledSave}>
        <ToggleRow
          label="Enforce naming convention"
          hint="Block events whose names don't match the pattern below."
          value={enforceNaming}
          onChange={setEnforceNaming}
        />
        <Field label="Case style">
          <RadioCards
            value={caseStyle}
            onChange={setCaseStyle}
            columns={3}
            options={[
              { value: 'snake', label: 'snake_case', description: 'order_completed' },
              { value: 'camel', label: 'camelCase', description: 'orderCompleted' },
              { value: 'title', label: 'Title Case', description: 'Order Completed' },
            ]}
          />
        </Field>
        <Field label="Pattern" hint="Regular expression event names must satisfy." last>
          <TextInput value={pattern} onChange={setPattern} mono />
        </Field>
      </SCard>

      <SCard title="Governance" description="Who can change the plan and how changes ship." footer={disabledSave}>
        <ToggleRow
          label="Require review before live"
          hint="Events can't move to live without an approval."
          value={requireReview}
          onChange={setRequireReview}
        />
        <ToggleRow
          label="Require an owner per event"
          hint="Every event must name a responsible person."
          value={requireOwner}
          onChange={setRequireOwner}
        />
        <Field label="Minimum approvals">
          <Select
            value={minApprovals}
            onChange={setMinApprovals}
            options={[
              { value: '1', label: '1 approval' },
              { value: '2', label: '2 approvals' },
            ]}
          />
        </Field>
        <ToggleRow
          label="Auto-deprecate dormant events"
          hint="Flag events with no volume for a sustained window."
          value={autoDeprecate}
          onChange={setAutoDeprecate}
          last
        />
      </SCard>

      <SCard title="PII & compliance">
        <ToggleRow
          label="Detect PII automatically"
          hint="Scan field values and flag likely personal data."
          value={detectPii}
          onChange={setDetectPii}
        />
        <ToggleRow
          label="Block PII without a consent tag"
          value={blockPii}
          onChange={setBlockPii}
        />
        <Field
          label="Raw event retention"
          hint="How long individual events are stored before roll-up."
          last
        >
          <Select
            value={retention}
            onChange={setRetention}
            options={[
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
              { value: '365', label: '1 year' },
              { value: '0', label: 'Forever' },
            ]}
          />
        </Field>
      </SCard>
    </div>
  )
}
