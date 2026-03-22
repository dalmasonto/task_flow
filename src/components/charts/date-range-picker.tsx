import { useState } from 'react'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import type { DateRange } from 'react-day-picker'

interface DateRangePickerProps {
  value: DateRange | undefined
  onChange: (range: DateRange | undefined) => void
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)

  const formatRange = () => {
    if (!value?.from) return 'Select date range'
    const from = value.from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    if (!value.to) return from
    const to = value.to.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return `${from} — ${to}`
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="text-[10px] uppercase tracking-widest font-bold bg-card border border-border px-3 py-2 h-auto hover:bg-accent"
        >
          <span className="material-symbols-outlined text-sm mr-2 text-muted-foreground">date_range</span>
          {formatRange()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="range"
          selected={value}
          onSelect={onChange}
          numberOfMonths={2}
        />
        <div className="border-t border-border px-4 py-2 flex justify-between">
          <Button
            variant="ghost"
            className="text-[10px] uppercase tracking-widest text-muted-foreground h-auto py-1"
            onClick={() => { onChange(undefined); setOpen(false) }}
          >
            Clear
          </Button>
          <Button
            variant="ghost"
            className="text-[10px] uppercase tracking-widest text-secondary h-auto py-1"
            onClick={() => setOpen(false)}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
