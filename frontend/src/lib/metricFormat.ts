/**
 * Shared metric value formatting (tripl-nxk2.1).
 *
 * Convention: a metric whose unit is '%' stores FRACTIONS (0.08 for an 8 %
 * conversion), so every display multiplies by 100. All other units render the
 * stored value unchanged, matching the historical MetricsCatalog behavior
 * exactly.
 */

// Precision rule shared with the metrics catalog: whole numbers at >= 100,
// two decimals below.
function roundForDisplay(value: number): number {
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100
}

export function isPercentUnit(unit: string | null | undefined): boolean {
  return unit?.trim() === '%'
}

/**
 * Human-readable metric value with its unit suffix. Percent units render the
 * stored fraction ×100 ('8 %'); other units keep the raw value ('123 ms').
 */
export function formatMetricValue(value: number | null | undefined, unit: string | null): string {
  if (value === null || value === undefined) return '—'
  if (isPercentUnit(unit)) {
    return `${roundForDisplay(value * 100).toLocaleString()} %`
  }
  const text = roundForDisplay(value).toLocaleString()
  return unit ? `${text} ${unit}` : text
}

/**
 * Tick/tooltip formatter for metric charts. Percent units render compact ×100
 * values ('8%', '0.5%'); anything else keeps the chart's historical
 * compact-count behavior ('8', '1.5k', '2.5M').
 */
export function metricAxisFormatter(unit: string | null): (value: number) => string {
  if (isPercentUnit(unit)) {
    return value => `${roundForDisplay(value * 100).toLocaleString()}%`
  }
  return value => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
    return String(value)
  }
}
