import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useSessions } from '@/hooks/use-sessions'
import { computeSessionDuration } from '@/lib/time'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function FocusByDayOfWeek() {
  const sessions = useSessions()

  const chartData = useMemo(() => {
    if (!sessions || sessions.length === 0) return []

    // Accumulate hours and count weeks per day
    const dayTotals = Array(7).fill(0)
    const dayCounts = Array(7).fill(0)
    const seenWeeks = Array.from({ length: 7 }, () => new Set<string>())

    for (const s of sessions) {
      const day = s.start.getDay()
      const weekKey = `${s.start.getFullYear()}-W${Math.ceil((s.start.getDate()) / 7)}`
      dayTotals[day] += computeSessionDuration(s)
      seenWeeks[day].add(weekKey)
    }

    for (let i = 0; i < 7; i++) {
      dayCounts[i] = Math.max(seenWeeks[i].size, 1)
    }

    return DAYS.map((name, i) => ({
      name,
      avgHours: Math.round((dayTotals[i] / dayCounts[i] / 3600000) * 100) / 100,
      totalHours: Math.round((dayTotals[i] / 3600000) * 100) / 100,
    }))
  }, [sessions])

  const maxAvg = Math.max(...chartData.map(d => d.avgHours), 0)

  return (
    <section className="bg-card p-8">
      <div className="mb-8">
        <h3 className="text-xs tracking-widest uppercase font-bold flex items-center gap-2">
          <span className="w-2 h-2 bg-tertiary" /> Focus Hours by Day of Week
        </h3>
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
          Average hours per day — reveals your rhythm
        </p>
      </div>

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
            <XAxis dataKey="name" tick={{ fill: '#adaaaa', fontSize: 10 }} />
            <YAxis tick={{ fill: '#adaaaa', fontSize: 10 }} tickFormatter={(v) => `${v}h`} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(105,253,93,0.2)', fontSize: 12 }}
              formatter={(value, name) => [
                `${Number(value).toFixed(2)}h`,
                name === 'avgHours' ? 'Avg/Week' : 'Total',
              ]}
            />
            <Bar dataKey="avgHours" radius={0}>
              {chartData.map((entry, i) => (
                <rect key={i} fill={entry.avgHours >= maxAvg * 0.8 ? '#69fd5d' : '#69fd5d60'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-12">
          No session data
        </p>
      )}
    </section>
  )
}
