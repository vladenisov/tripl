import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Button,
} from 'frontend'

export const Default = () => (
  <Sheet defaultOpen>
    <SheetTrigger asChild>
      <Button variant="outline">Column details</Button>
    </SheetTrigger>
    <SheetContent side="right">
      <SheetHeader>
        <SheetTitle>events_raw.user_id</SheetTitle>
        <SheetDescription>String column · profiled in the last scan</SheetDescription>
      </SheetHeader>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span style={{ color: 'var(--fg-subtle)' }}>Distinct values</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>4,182,005</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span style={{ color: 'var(--fg-subtle)' }}>Null fraction</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>0.02%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span style={{ color: 'var(--fg-subtle)' }}>Sensitivity</span>
          <span style={{ color: 'var(--warning)', fontWeight: 600 }}>PII</span>
        </div>
      </div>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="outline">Close</Button>
        </SheetClose>
        <Button>Edit metadata</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
)
