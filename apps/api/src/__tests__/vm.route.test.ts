import { describe, it, expect, vi } from 'vitest'

const { mockScheduler } = vi.hoisted(() => ({
  mockScheduler: {
    getUserVMStatus: vi.fn(),
    forceRebootstrap: vi.fn(),
  },
}))

vi.mock('../scheduler/vm-scheduler', () => mockScheduler)

import vmRouter from '../routes/v1/vm'

describe('vm route wiring', () => {
  it('exports express router', () => {
    expect(vmRouter).toBeTruthy()
    expect(typeof (vmRouter as unknown as { use?: unknown }).use).toBe('function')
  })
})
