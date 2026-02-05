'use client'

import { useMemo } from 'react'
import clsx from 'clsx'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import type { ChartData } from '@/types'

/**
 * Chart - 图表组件
 *
 * 使用 Recharts 渲染图表，支持 line/bar/pie 类型
 */

export interface ChartProps {
  data: ChartData
  className?: string
  height?: number
}

// 图表颜色配置
const CHART_COLORS = [
  'var(--color-primary-500)',
  'var(--color-success-500)',
  'var(--color-warning-500)',
  'var(--color-error-500)',
  'var(--color-info-500)',
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
]

export function Chart({ data, className, height = 300 }: ChartProps) {
  // 将数据转换为 Recharts 格式
  const chartData = useMemo(() => {
    if (data.chartType === 'pie') {
      // 饼图数据格式
      return data.series[0]?.data.map((value, index) => ({
        name: data.xAxis?.data?.[index] || `项目 ${index + 1}`,
        value,
      })) || []
    }

    // 折线图/柱状图数据格式
    const xAxisData = data.xAxis?.data || []
    return xAxisData.map((label, index) => {
      const point: Record<string, string | number> = { name: label }
      data.series.forEach((series) => {
        point[series.name] = series.data[index] || 0
      })
      return point
    })
  }, [data])

  const renderChart = () => {
    switch (data.chartType) {
      case 'line':
        return (
          <LineChart data={chartData}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border-subtle)"
              vertical={false}
            />
            <XAxis
              dataKey="name"
              stroke="var(--text-tertiary)"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: 'var(--border-default)' }}
            />
            <YAxis
              stroke="var(--text-tertiary)"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: 'var(--border-default)' }}
              name={data.yAxis?.name}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                borderRadius: '8px',
                fontSize: '12px',
              }}
              labelStyle={{ color: 'var(--text-primary)' }}
              itemStyle={{ color: 'var(--text-secondary)' }}
            />
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
              iconType="circle"
              iconSize={8}
            />
            {data.series.map((series, index) => (
              <Line
                key={series.name}
                type="monotone"
                dataKey={series.name}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={2}
                dot={{ fill: CHART_COLORS[index % CHART_COLORS.length], r: 4 }}
                activeDot={{ r: 6 }}
              />
            ))}
          </LineChart>
        )

      case 'bar':
        return (
          <BarChart data={chartData}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border-subtle)"
              vertical={false}
            />
            <XAxis
              dataKey="name"
              stroke="var(--text-tertiary)"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: 'var(--border-default)' }}
            />
            <YAxis
              stroke="var(--text-tertiary)"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: 'var(--border-default)' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                borderRadius: '8px',
                fontSize: '12px',
              }}
              labelStyle={{ color: 'var(--text-primary)' }}
              cursor={{ fill: 'var(--interactive-hover)' }}
            />
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
              iconType="rect"
              iconSize={10}
            />
            {data.series.map((series, index) => (
              <Bar
                key={series.name}
                dataKey={series.name}
                fill={CHART_COLORS[index % CHART_COLORS.length]}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        )

      case 'pie':
        return (
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              paddingAngle={2}
              dataKey="value"
              label={({ name, percent }) =>
                `${name} ${(percent * 100).toFixed(0)}%`
              }
              labelLine={{ stroke: 'var(--text-tertiary)' }}
            >
              {chartData.map((_, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={CHART_COLORS[index % CHART_COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                borderRadius: '8px',
                fontSize: '12px',
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
              iconType="circle"
              iconSize={8}
            />
          </PieChart>
        )

      default:
        return (
          <div className="flex items-center justify-center h-full text-text-secondary">
            不支持的图表类型: {data.chartType}
          </div>
        )
    }
  }

  return (
    <div
      className={clsx(
        'rounded-lg border border-border-subtle',
        'bg-bg-surface p-4',
        className
      )}
    >
      {/* 标题 */}
      {data.title && (
        <h3 className="text-lg font-semibold text-text-primary mb-4">
          {data.title}
        </h3>
      )}

      {/* 图表 */}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {renderChart()}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

Chart.displayName = 'Chart'
