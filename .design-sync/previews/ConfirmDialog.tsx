import { ConfirmDialog } from 'frontend'

export const Danger = () => (
  <ConfirmDialog
    open
    title="Delete reconciliation rule?"
    message="This permanently removes the “checkout_completed revenue match” rule and its 142 historical runs. This action cannot be undone."
    confirmLabel="Delete rule"
    variant="danger"
    onConfirm={() => {}}
    onCancel={() => {}}
  />
)

export const Primary = () => (
  <ConfirmDialog
    open
    title="Publish branch to main?"
    message="Merging “fix/revenue-drift” will apply 3 plan-rule changes to production scans starting on the next schedule."
    confirmLabel="Publish"
    variant="primary"
    onConfirm={() => {}}
    onCancel={() => {}}
  />
)
