import { useState, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useSessions } from '@/hooks/use-sessions'
import { computeSessionDuration } from '@/lib/time'
import { DateRangePicker } from './date-range-picker'
import type { DateRange } from 'react-day-picker'

export function DailyActivity() {
  const sessions = useSessions()
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    // Default to last 30 days
    const to = new Date()
    const from = new Date()
    from.setDate(from.getDate() - 30)
    return { from, to }
  })

  const chartData = useMemo(() => {
    if (!sessions) return []

    const filtered = sessions.filter(s => {
      if (dateRange?.from && s.start < dateRange.from) return false
      if (dateRange?.to) {
        const endOfDay = new Date(dateRange.to)
        endOfDay.setHours(23, 59, 59, 999)
        if (s.start > endOfDay) return false
      }
      return true
    })

    // Group by day
    const dayMap = new Map<string, number>()
    for (const s of filtered) {
      const day = s.start.toISOString().slice(0, 10)
      const current = dayMap.get(day) ?? 0
      dayMap.set(day, current + computeSessionDuration(s))
    }

    // Fill in missing days
    const days: Array<{ date: string; label: string; hours: number }> = []
    if (dateRange?.from && dateRange?.to) {
      const cursor = new Date(dateRange.from)
      const end = new Date(dateRange.to)
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10)
        const ms = dayMap.get(key) ?? 0
        days.push({
          date: key,
          label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          hours: Math.round((ms / 3600000) * 100) / 100,
        })
        cursor.setDate(cursor.getDate() + 1)
      }
    } else {
      // No range — show all data sorted
      Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([date, ms]) => {
          days.push({
            date,
            label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            hours: Math.round((ms / 3600000) * 100) / 100,
          })
        })
    }

    return days
  }, [sessions, dateRange])

  return (
    <section className="bg-card p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h3 className="text-xs tracking-widest uppercase font-bold flex items-center gap-2">
            <span className="w-2 h-2 bg-secondary" /> Daily Session Activity
          </h3>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            Total hours worked per day
          </p>
        </div>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <XAxis
              dataKey="label"
              tick={{ fill: '#adaaaa', fontSize: 9 }}
              interval={Math.max(0, Math.floor(chartData.length / 10))}
            />
            <YAxis tick={{ fill: '#adaaaa', fontSize: 10 }} tickFormatter={(v) => `${v}h`} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(0,251,251,0.2)', fontSize: 12 }}
              formatter={(value) => [`${Number(value).toFixed(2)}h`, 'Hours']}
            />
            <Bar dataKey="hours" fill="#00fbfb" radius={0} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-12">
          No session data for selected range
        </p>
      )}
    </section>
  )
}
