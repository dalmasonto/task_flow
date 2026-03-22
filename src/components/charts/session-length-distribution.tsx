import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useSessions } from '@/hooks/use-sessions'
import { computeSessionDuration } from '@/lib/time'

const BUCKETS = [
  { label: '<15m', max: 15 * 60000 },
  { label: '15-30m', max: 30 * 60000 },
  { label: '30-60m', max: 60 * 60000 },
  { label: '1-2h', max: 2 * 3600000 },
  { label: '2-4h', max: 4 * 3600000 },
  { label: '4h+', max: Infinity },
]

export function SessionLengthDistribution() {
  const sessions = useSessions()

  const chartData = useMemo(() => {
    if (!sessions) return []

    const counts = Array(BUCKETS.length).fill(0)

    for (const s of sessions) {
      if (!s.end) continue // skip active sessions
      const duration = computeSessionDuration(s)
      for (let i = 0; i < BUCKETS.length; i++) {
        if (i === 0 && duration < BUCKETS[0].max) {
          counts[0]++
          break
        }
        if (i > 0 && duration >= BUCKETS[i - 1].max && duration < BUCKETS[i].max) {
          counts[i]++
          break
        }
      }
    }

    return BUCKETS.map((bucket, i) => ({
      name: bucket.label,
      count: counts[i],
    }))
  }, [sessions])

  const totalCompleted = chartData.reduce((s, d) => s + d.count, 0)
  const deepWorkCount = chartData.slice(3).reduce((s, d) => s + d.count, 0) // 1h+
  const deepWorkPct = totalCompleted > 0 ? Math.round((deepWorkCount / totalCompleted) * 100) : 0

  return (
    <section className="bg-card p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h3 className="text-xs tracking-widest uppercase font-bold flex items-center gap-2">
            <span className="w-2 h-2 bg-primary" /> Session Length Distribution
          </h3>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            How long are your typical work sessions?
          </p>
        </div>
        <div className="text-right">
          <span className="text-2xl font-bold text-primary">{deepWorkPct}%</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest block">Deep Work (1h+)</span>
        </div>
      </div>

      {totalCompleted > 0 ? (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
            <XAxis dataKey="name" tick={{ fill: '#adaaaa', fontSize: 10 }} />
            <YAxis tick={{ fill: '#adaaaa', fontSize: 10 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(222,142,255,0.2)', fontSize: 12 }}
              formatter={(value) => [`${value} sessions`, 'Count']}
            />
            <Bar dataKey="count" fill="#de8eff" radius={0} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-12">
          No completed sessions to analyze
        </p>
      )}
    </section>
  )
}
