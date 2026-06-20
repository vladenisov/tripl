import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from 'frontend'

export const Default = () => (
  <Select defaultValue="6h">
    <SelectTrigger style={{ width: 240 }}>
      <SelectValue placeholder="Select cadence" />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectLabel>Scan cadence</SelectLabel>
        <SelectItem value="1h">Every hour</SelectItem>
        <SelectItem value="6h">Every 6 hours</SelectItem>
        <SelectItem value="24h">Daily</SelectItem>
        <SelectSeparator />
        <SelectItem value="manual">Manual only</SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
)

export const Placeholder = () => (
  <Select>
    <SelectTrigger style={{ width: 240 }}>
      <SelectValue placeholder="Select a warehouse…" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="clickhouse">ClickHouse</SelectItem>
      <SelectItem value="bigquery">BigQuery</SelectItem>
      <SelectItem value="snowflake">Snowflake</SelectItem>
    </SelectContent>
  </Select>
)
