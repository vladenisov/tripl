import { SCard } from '@/components/settings/kit'

/**
 * One card that says what a section will offer once it is built, with no
 * control that could be mistaken for a setting (WS-37). Account sections used
 * to render each unbuilt feature as its own card of disabled inputs, switches
 * and buttons — honest, but most of the page was controls that do nothing.
 */
export function ComingLaterCard({
  items,
  description = 'Not available yet. Nothing here can be set today.',
}: {
  items: ReadonlyArray<{ title: string; detail: string }>
  description?: string
}) {
  return (
    <SCard title="Coming later" description={description}>
      <ul
        className="m-0 list-disc space-y-1.5 py-[15px] pl-[38px] pr-[18px] text-[12.5px] leading-[1.5]"
        style={{ color: 'var(--fg-subtle)' }}
      >
        {items.map((item) => (
          <li key={item.title}>
            <span className="font-medium" style={{ color: 'var(--fg)' }}>
              {item.title}
            </span>{' '}
            — {item.detail}
          </li>
        ))}
      </ul>
    </SCard>
  )
}
