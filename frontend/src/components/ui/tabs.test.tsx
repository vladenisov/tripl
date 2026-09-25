import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

describe('TabsContent focus indicator', () => {
  // Radix makes the panel a Tab stop (tabIndex=0). The global :focus-visible
  // outline lives in @layer base and loses to `outline-none`, so the panel has
  // to bring its own ring or keyboard focus lands on something invisible.
  it('is focusable and carries its own focus-visible ring', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
      </Tabs>,
    )
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('tabindex', '0')
    expect(panel.className).toMatch(/focus-visible:ring-\[3px\]/)
    expect(panel.className).toMatch(/focus-visible:ring-ring\/50/)
  })
})
