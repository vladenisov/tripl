import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SqlEditor } from './sql-editor'

describe('SqlEditor', () => {
  it('renders a ClickHouse editor with schema-aware SQL extensions', () => {
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={vi.fn()}
        dialect="clickhouse"
        tables={[
          {
            name: 'retention',
            columns: [{ name: 'device_id', data_type: 'String' }],
          },
        ]}
        ariaLabel="Fact metric SQL"
      />,
    )

    expect(screen.getByLabelText('Fact metric SQL')).toBeInTheDocument()
  })

  // tripl-h2sx.11: the Format button used to sit ON the editor, covering the
  // first line of any query wider than the box.
  it('puts Format under the editor rather than over it', () => {
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={vi.fn()}
        dialect="clickhouse"
        ariaLabel="Fact metric SQL"
      />,
    )

    const format = screen.getByRole('button', { name: 'Format' })
    expect(format).not.toHaveClass('absolute')
    expect(format.closest('.overflow-hidden')).toBeNull()
  })

  it('offers no Format row at all when the editor is read-only', () => {
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={vi.fn()}
        readOnly
        dialect="clickhouse"
        ariaLabel="Fact metric SQL"
      />,
    )

    expect(screen.queryByRole('button', { name: 'Format' })).toBeNull()
  })

  it('formats through the dialect formatter, not a re-indent', () => {
    const onChange = vi.fn()
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={onChange}
        dialect="clickhouse"
        ariaLabel="Fact metric SQL"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Format' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const formatted = onChange.mock.calls[0][0] as string
    expect(formatted).toMatch(/\n/)
    expect(formatted.toLowerCase()).toContain('from')
  })

  // tripl-h2sx.33: wrapping is CSS, not an extension — `EditorView.lineWrapping`
  // needs a VALUE import of a module seven suites mock with a default-only
  // factory. jsdom applies no stylesheet, so the component test can only pin the
  // hook, and the rule itself is pinned against the file.
  it('gives the stylesheet a hook that wraps the editor content', () => {
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={vi.fn()}
        dialect="clickhouse"
        ariaLabel="Fact metric SQL"
      />,
    )

    const hook = document.querySelector('.sql-editor')
    expect(hook).not.toBeNull()
    // The rule is `.sql-editor .cm-editor .cm-content`, so the hook has to be an
    // ANCESTOR of CodeMirror, not a sibling of it.
    expect(hook!.querySelector('.cm-editor .cm-content')).not.toBeNull()
  })

  it('wraps with a white-space value CodeMirror counts as wrapping', () => {
    // The height oracle reads the content element's computed `white-space` and
    // compares it against this list (@codemirror/view, ViewState.measure). A
    // value outside it — `wrap`, say — would look like it worked and leave every
    // line height measured as if nothing wrapped.
    const WRAPPING_WHITE_SPACE = ['pre-wrap', 'normal', 'pre-line', 'break-spaces']
    // Read off this file's own path, not the working directory: `?raw` comes
    // back empty because vitest stubs CSS imports, and cwd depends on where the
    // runner was started.
    const testPath = expect.getState().testPath
    if (!testPath) throw new Error('vitest did not report a testPath')
    const indexCss = readFileSync(resolve(dirname(testPath), '../index.css'), 'utf8')

    const rule = indexCss.match(/\.sql-editor\s+\.cm-editor\s+\.cm-content\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    const body = rule![1]

    const whiteSpace = body.match(/white-space:\s*([a-z-]+)/)?.[1]
    expect(WRAPPING_WHITE_SPACE).toContain(whiteSpace)
    // `.cm-content` is a flex item that ships `flex-shrink: 0`, so without this
    // it never narrows to the scroller and nothing wraps whatever white-space
    // says.
    expect(body).toMatch(/flex-shrink:\s*1/)
  })
})
