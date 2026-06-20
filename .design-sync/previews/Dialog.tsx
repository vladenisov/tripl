import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Button,
} from 'frontend'

export const Default = () => (
  <Dialog defaultOpen>
    <DialogTrigger asChild>
      <Button variant="outline">Edit connection</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit ClickHouse connection</DialogTitle>
        <DialogDescription>
          Update the host and credentials Tripl uses to reach your warehouse. Changes apply on the
          next scheduled scan.
        </DialogDescription>
      </DialogHeader>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
          Host
          <input
            defaultValue="clickhouse.prod.internal:9440"
            readOnly
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              color: 'var(--fg)',
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
          Username
          <input
            defaultValue="tripl_reader"
            readOnly
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              color: 'var(--fg)',
            }}
          />
        </label>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button>Save changes</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)
