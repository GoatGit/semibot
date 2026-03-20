import { describe, expect, it, vi } from 'vitest'
import v1Router from '../routes/v1'

function getRouteHandler(path: string, method: 'get') {
  const stack = (v1Router as unknown as { stack: any[] }).stack ?? []
  const routeLayer = stack.find(
    (layer) => layer.route?.path === path && Boolean(layer.route?.methods?.[method])
  )
  if (!routeLayer) {
    throw new Error(`route not found: ${method.toUpperCase()} ${path}`)
  }
  const handlers = routeLayer.route.stack ?? []
  const finalLayer = handlers[handlers.length - 1]
  if (!finalLayer?.handle) {
    throw new Error(`handler not found: ${method.toUpperCase()} ${path}`)
  }
  return finalLayer.handle as (req: any, res: any) => void
}

describe('v1 docs route', () => {
  it('GET /docs returns migration and deprecated endpoint metadata', () => {
    const handler = getRouteHandler('/docs', 'get')
    const res = { json: vi.fn() } as any

    handler({}, res)

    expect(res.json).toHaveBeenCalledTimes(1)
    const payload = res.json.mock.calls[0][0]
    expect(payload?.success).toBe(true)
    expect(payload?.data?.endpoints?.control).toBe('/api/v1/control')
    expect(payload?.data?.endpoints?.evolutionCapabilities).toBe('/api/v1/evolution-capabilities')
    expect(payload?.data?.deprecated?.[0]).toMatchObject({
      path: '/api/v1/context-policies',
      successor: '/api/v1/evolution-capabilities',
    })
  })
})
