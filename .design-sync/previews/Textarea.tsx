import { Textarea } from 'frontend'

export const Default = () => (
  <div style={{ width: 420 }}>
    <Textarea defaultValue="Reconciles daily GMV against the finance ledger. Owner: data-platform." />
  </div>
)

export const Placeholder = () => (
  <div style={{ width: 420 }}>
    <Textarea placeholder="Describe what this reconciliation checks…" />
  </div>
)

export const Disabled = () => (
  <div style={{ width: 420 }}>
    <Textarea
      defaultValue="This check is archived and can no longer be edited."
      disabled
    />
  </div>
)

export const Tall = () => (
  <div style={{ width: 420 }}>
    <Textarea
      rows={5}
      defaultValue={`SELECT region, sum(amount) AS gmv
FROM events
WHERE day = today()
GROUP BY region`}
    />
  </div>
)
