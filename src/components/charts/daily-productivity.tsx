import { useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DateRangePicker } from './date-range-picker'
import { ProjectFilter } from './project-filter'
import { useDailyProductivity } from '@/hooks/use-daily-productivity'
import type { DateRange } from 'react-day-picker'

type Mode = 'time' | 'tasks'

const MODE_CONFIG = {
  time: {
    color: '#00fbfb',
    label: 'Hours',
    formatValue: (v: number) => `${v.toFixed(2)}h`,
    formatTick: (v: number) => `${v}h`,
    subtitle: 'Hours tracked per day',
  },
  tasks: {
    color: '#69fd5d',
    label: 'Tasks',
    formatValue: (v: number) => `${v}`,
    formatTick: (v: number) => `${v}`,
    subtitle: 'Tasks completed per day',
  },
} as const

export function DailyProductivity() {
  const [mode, setMode] = useState<Mode>('time')
  const [projectFilter, setProjectFilter] = useState('all')
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const to = new Date()
    const from = new Date()
    from.setDate(from.getDate() - 30)
    return { from, to }
  })

  const data = useDailyProductivity(mode, projectFilter, dateRange)
  const config = MODE_CONFIG[mode]

  const totalValue = data?.reduce((sum, d) => sum + d.value, 0) ?? 0
  const summary = mode === 'time'
    ? `${totalValue.toFixed(1)}h total`
    : `${totalValue} total`

  return (
    <section className="bg-card p-8">
      {/* Header row */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h3 className="text-xs tracking-widest uppercase font-bold flex items-center gap-2">
              <span className="w-2 h-2" style={{ backgroundColor: config.color }} />
              Daily Productivity
            </h3>
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
              {config.subtitle}
              {' — '}
              <span style={{ color: config.color }} className="font-bold">{summary}</span>
            </p>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <ProjectFilter value={projectFilter} onChange={setProjectFilter} />
            <DateRangePicker value={dateRange} onChange={setDateRange} />
          </div>
        </div>

        {/* Mode toggle */}
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList className="bg-muted/50">
            <TabsTrigger
              value="time"
              className="text-[10px] uppercase tracking-widest px-4"
            >
              <span className="material-symbols-outlined text-sm mr-1">schedule</span>
              Time Spent
            </TabsTrigger>
            <TabsTrigger
              value="tasks"
              className="text-[10px] uppercase tracking-widest px-4"
            >
              <span className="material-symbols-outlined text-sm mr-1">task_alt</span>
              Tasks Done
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Chart */}
      {data && data.length > 0 ? (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data}>
            <XAxis
              dataKey="label"
              tick={{ fill: '#adaaaa', fontSize: 9 }}
              interval={Math.max(0, Math.floor(data.length / 10))}
            />
            <YAxis
              tick={{ fill: '#adaaaa', fontSize: 10 }}
              tickFormatter={config.formatTick}
              allowDecimals={mode === 'time'}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(var(--card))',
                border: `1px solid ${config.color}33`,
                fontSize: 12,
              }}
              formatter={(value) => [config.formatValue(Number(value)), config.label]}
            />
            <Bar dataKey="value" fill={config.color} radius={0} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-12">
          No data for selected filters
        </p>
      )}
    </section>
  )
}
