import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
} from 'frontend'

export const Default = () => (
  <TooltipProvider>
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <Button variant="outline">p95 latency</Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Measured over the last hour: 142 ms across 1.84B scanned rows.
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)
