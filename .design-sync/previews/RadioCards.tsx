import { RadioCards } from 'frontend'

export const Default = () => (
  <div style={{ width: 420 }}>
    <RadioCards
      value="balanced"
      options={[
        { value: 'fast', label: 'Fast', description: 'Lower accuracy, results in seconds.' },
        { value: 'balanced', label: 'Balanced', description: 'Recommended for most reconciliations.' },
        { value: 'thorough', label: 'Thorough', description: 'Highest accuracy, slower to compute.' },
      ]}
    />
  </div>
)

export const TwoColumns = () => (
  <div style={{ width: 560 }}>
    <RadioCards
      value="weekly"
      columns={2}
      options={[
        { value: 'hourly', label: 'Hourly', description: 'Every 60 minutes.' },
        { value: 'daily', label: 'Daily', description: 'Once at midnight UTC.' },
        { value: 'weekly', label: 'Weekly', description: 'Monday mornings.' },
        { value: 'manual', label: 'Manual', description: 'Trigger runs yourself.' },
      ]}
    />
  </div>
)

export const PlainOptions = () => (
  <div style={{ width: 420 }}>
    <RadioCards
      value="dark"
      options={[
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'Match system' },
      ]}
    />
  </div>
)
