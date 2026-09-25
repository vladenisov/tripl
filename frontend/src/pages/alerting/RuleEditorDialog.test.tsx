import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import type { AlertDestination } from '@/types'

import { defaultRuleForm, type RuleFormState } from './constants'
import { RuleEditorDialog } from './RuleEditorDialog'

function makeDestination(overrides: Partial<AlertDestination> = {}): AlertDestination {
  return {
    id: 'dest-1',
    project_id: 'proj-1',
    type: 'telegram',
    name: 'TG',
    held_count: 0,
    enabled: true,
    webhook_set: false,
    bot_token_set: true,
    chat_id: '-100',
    target_url_set: false,
    webhook_header_name: null,
    email_recipients: null,
    email_from_address: null,
    email_subject_template: null,
    jira_base_url: null,
    jira_auth_email: null,
    jira_api_token_set: false,
    jira_project_key: null,
    jira_issue_type: null,
    linear_api_key_set: false,
    linear_team_id: null,
    linear_state_id: null,
    linear_label_ids: null,
    is_local: false,
    delivery_count: 0,
    incident_count: 0,
    rules: [],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

/**
 * The dialog with its form state held the way MonitorsSection holds it, so
 * what is asserted is what the section would send.
 */
function Harness({
  initial = { ...defaultRuleForm(), name: 'Checkout drops' },
  onSubmit,
  error = null,
}: {
  initial?: RuleFormState
  onSubmit: (form: RuleFormState) => void
  error?: unknown
}) {
  const [ruleForm, setRuleForm] = useState(initial)
  return (
    <RuleEditorDialog
      open
      onClose={() => {}}
      slug="demo"
      destinations={[makeDestination()]}
      destinationId="dest-1"
      onDestinationIdChange={() => {}}
      isEditing={false}
      ruleForm={ruleForm}
      setRuleForm={setRuleForm}
      eventTypes={[]}
      scans={[]}
      onSubmit={() => onSubmit(ruleForm)}
      isPending={false}
      isError={error !== null}
      error={error}
    />
  )
}

function renderDialog(props: Parameters<typeof Harness>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Harness {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('RuleEditorDialog — numbers can be cleared and are checked (ALR-16)', () => {
  it('lets the cooldown be emptied instead of snapping it to 0, and refuses to save it', () => {
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })

    const cooldown = screen.getByLabelText('Cooldown minutes')
    fireEvent.change(cooldown, { target: { value: '' } })
    expect(cooldown).toHaveValue(null)

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(cooldown).toHaveAttribute('aria-invalid', 'true')
    expect(cooldown).toHaveAccessibleDescription(/Enter a number/)
  })

  it('submits what was typed once it is valid', () => {
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })

    fireEvent.change(screen.getByLabelText('Cooldown minutes'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ cooldown_minutes: '30' })
  })
})

describe('RuleEditorDialog — inline validation instead of browser bubbles (AL-28)', () => {
  it('names an empty rule name under its field and does not submit', async () => {
    const onSubmit = vi.fn()
    renderDialog({ onSubmit, initial: defaultRuleForm() })

    const name = screen.getByLabelText('Name')
    expect(name).not.toHaveAttribute('required')
    expect(name.closest('form')).toHaveAttribute('novalidate')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('Required')
    // The refused submit moves focus to the first highlighted field.
    await waitFor(() => expect(name).toHaveFocus())
  })

  it('titles the dialog in sentence case', () => {
    renderDialog({ onSubmit: vi.fn() })
    expect(screen.getByRole('dialog', { name: 'New alert rule' })).toBeInTheDocument()
  })
})

describe('RuleEditorDialog — direction (ALR-14)', () => {
  it('names the two boxes for what they are, under one legend', () => {
    renderDialog({ onSubmit: vi.fn() })

    const group = screen.getByRole('group', { name: 'Notify on' })
    expect(within(group).getByLabelText('Spikes (up)')).toBeChecked()
    expect(within(group).getByLabelText('Drops (down)')).toBeChecked()
    expect(screen.queryByText('Up only')).toBeNull()
  })

  it('says so as soon as both are unticked, and does not save', () => {
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })

    fireEvent.click(screen.getByLabelText('Spikes (up)'))
    fireEvent.click(screen.getByLabelText('Drops (down)'))

    expect(screen.getByRole('group', { name: 'Notify on' }))
      .toHaveAccessibleDescription(/at least one direction/)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('RuleEditorDialog — scopes (ALR-15)', () => {
  it('refuses a rule that watches no signal at all', () => {
    const onSubmit = vi.fn()
    renderDialog({
      onSubmit,
      initial: {
        ...defaultRuleForm(),
        name: 'Nothing',
        include_project_total: false,
        include_event_types: false,
        include_events: false,
      },
    })

    expect(screen.getByRole('group', { name: 'Signals' })).toHaveAccessibleDescription(/signal kind/)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('RuleEditorDialog — an empty filter row is not dropped (ALR-5)', () => {
  it('names the row and refuses to save, instead of saving a broader rule', () => {
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })

    fireEvent.click(screen.getByRole('button', { name: /Add filter/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/Pick at least one value, or remove this filter/)).toBeInTheDocument()
  })
})

describe('RuleEditorDialog — server errors sit beside their fields (ALR-8)', () => {
  it('attaches a field error to its input, without Pydantic\'s prefix', () => {
    const error = new ApiError('cooldown_minutes: Value error, too short', 422)
    error.fields = [{ loc: ['body', 'cooldown_minutes'], msg: 'Value error, too short', type: 'value_error' }]
    renderDialog({ onSubmit: vi.fn(), error })

    const cooldown = screen.getByLabelText('Cooldown minutes')
    expect(cooldown).toHaveAttribute('aria-invalid', 'true')
    expect(cooldown).toHaveAccessibleDescription('too short')
    expect(screen.queryByText(/Value error/)).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Check the highlighted fields.')
  })

  it('prints anything with no field as one plain sentence', () => {
    renderDialog({ onSubmit: vi.fn(), error: new Error('Value error, Rule limit reached') })

    expect(screen.getByRole('alert')).toHaveTextContent('Rule limit reached')
    expect(screen.queryByText(/Value error/)).toBeNull()
  })
})
