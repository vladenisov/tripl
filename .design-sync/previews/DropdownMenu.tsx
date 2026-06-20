import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Button,
} from 'frontend'

export const Default = () => (
  <DropdownMenu defaultOpen>
    <DropdownMenuTrigger asChild>
      <Button variant="outline">Dataset actions</Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" style={{ width: 220 }}>
      <DropdownMenuLabel>events_raw</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem>
        Run scan now
        <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem>
        Open in editor
        <DropdownMenuShortcut>⌘E</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem>Duplicate</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive">
        Delete dataset
        <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
)
