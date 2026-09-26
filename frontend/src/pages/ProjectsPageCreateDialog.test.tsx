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

  it('shows the URL a name becomes and folds the field under "Customize URL" (SH-29)', () => {
    renderDialog()

    expect(screen.getByLabelText('Project name')).toHaveAttribute('placeholder', 'e.g. iOS app')
    expect(screen.queryByLabelText(/slug/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Shop Web' } })
    expect(screen.getByText('/p/shop-web')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Customize URL' }))
    expect(screen.getByLabelText('Project URL')).toHaveValue('shop-web')
  })

  it('opens the URL field and marks it when the server says the slug is taken (SH-29)', async () => {
    // existingSlugs cannot rule this out: the list hides seeding and failed
    // demos, whose slugs are still held.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Project with this slug already exists' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    renderDialog()

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Shop Web' } })
    expect(screen.queryByLabelText('Project URL')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    const slug = await screen.findByLabelText('Project URL')
    expect(slug).toHaveValue('shop-web')
    expect(slug).toHaveAttribute('aria-invalid', 'true')
    expect(slug).toHaveAccessibleDescription(
      'Another project already uses this URL. Choose a different one.',
    )
    await waitFor(() => expect(slug).toHaveFocus())
    expect(screen.queryByText('Could not create project')).not.toBeInTheDocument()

    // Editing the slug clears the server's verdict on the old one.
    fireEvent.change(slug, { target: { value: 'shop-web-2' } })
    expect(slug).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText(/already uses this URL/)).not.toBeInTheDocument()
    expect(screen.queryByText('Could not create project')).not.toBeInTheDocument()
  })
})
