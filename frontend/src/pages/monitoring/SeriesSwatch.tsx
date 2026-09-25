/** A legend swatch; a dashed series gets a hollow, dashed ring like its line. */
export function SeriesSwatch({ color, dash }: { color: string; dash?: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={dash
        ? { border: `2px dashed ${color}` }
        : { backgroundColor: color }}
    />
  )
}
