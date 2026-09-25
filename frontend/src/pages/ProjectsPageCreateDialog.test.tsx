import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreateProjectDialog } from './ProjectsPageCreateDialog'

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CreateProjectDialog onClose={() => {}} existingSlugs={[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CreateProjectDialog', () => {
  it('is titled like the button that opens it (DS-29)', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Description/)).toHaveAccessibleName('Description (optional)')
  })

  it('marks a missing name inline, focuses it and sends nothing (AU-4)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    const name = screen.getByLabelText('Project name')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('Give the project a name.')
    expect(name).not.toHaveAttribute('required')
    await waitFor(() => expect(name).toHaveFocus())
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
