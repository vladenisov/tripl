import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from 'frontend'

export const Default = () => (
  <Card style={{ width: 360 }}>
    <CardHeader>
      <CardTitle>Production database</CardTitle>
      <CardDescription>ClickHouse cluster · us-east-1</CardDescription>
    </CardHeader>
    <CardContent style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span style={{ color: 'var(--fg-subtle)' }}>Rows scanned</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>1.84B</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span style={{ color: 'var(--fg-subtle)' }}>p95 latency</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>142 ms</span>
      </div>
    </CardContent>
    <CardFooter style={{ justifyContent: 'flex-end', gap: 8 }}>
      <Button variant="outline" size="sm">
        Details
      </Button>
      <Button size="sm">Run query</Button>
    </CardFooter>
  </Card>
)

export const HeaderContentFooter = () => (
  <Card style={{ width: 360 }}>
    <CardHeader>
      <CardTitle>Invite teammates</CardTitle>
      <CardDescription>Members can view dashboards and run saved queries.</CardDescription>
    </CardHeader>
    <CardContent>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-subtle)', lineHeight: 1.5 }}>
        You have 3 of 10 seats remaining on the Team plan. New members receive an email
        invitation valid for 7 days.
      </p>
    </CardContent>
    <CardFooter style={{ justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12, color: 'var(--fg-faint)' }}>7 seats used</span>
      <Button size="sm">Send invite</Button>
    </CardFooter>
  </Card>
)

export const ContentOnly = () => (
  <Card style={{ width: 280 }}>
    <CardContent style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Monthly spend
      </span>
      <span style={{ fontSize: 28, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>$2,480</span>
      <span style={{ fontSize: 12, color: 'var(--success)' }}>down 12% vs. last month</span>
    </CardContent>
  </Card>
)
