import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from 'frontend'

const rows = [
  { name: 'user.signed_up', events: '1,284,902', last: '2 min ago', status: 'Active' },
  { name: 'query.executed', events: '842,177', last: '5 min ago', status: 'Active' },
  { name: 'invite.sent', events: '12,043', last: '1 hr ago', status: 'Active' },
  { name: 'export.completed', events: '3,201', last: '3 hr ago', status: 'Paused' },
]

export const Default = () => (
  <div style={{ width: 520 }}>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Event type</TableHead>
          <TableHead style={{ textAlign: 'right' }}>Events</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name}>
            <TableCell style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              {row.name}
            </TableCell>
            <TableCell style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {row.events}
            </TableCell>
            <TableCell style={{ color: 'var(--fg-subtle)' }}>{row.last}</TableCell>
            <TableCell
              style={{ color: row.status === 'Active' ? 'var(--success)' : 'var(--warning)' }}
            >
              {row.status}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
)

export const WithCaptionAndFooter = () => (
  <div style={{ width: 520 }}>
    <Table>
      <TableCaption>Top event types this week.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Event type</TableHead>
          <TableHead style={{ textAlign: 'right' }}>Events</TableHead>
          <TableHead style={{ textAlign: 'right' }}>Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 3).map((row) => (
          <TableRow key={row.name}>
            <TableCell style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              {row.name}
            </TableCell>
            <TableCell style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {row.events}
            </TableCell>
            <TableCell style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {row.name === 'user.signed_up' ? '58%' : row.name === 'query.executed' ? '38%' : '4%'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            2,139,122
          </TableCell>
          <TableCell style={{ textAlign: 'right' }}>100%</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  </div>
)
