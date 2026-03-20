import { describe, expect, it } from 'vitest'
import contextPoliciesRouter from '../routes/v1/context-policies'

describe('context-policies route wiring', () => {
  it('exports express router', () => {
    expect(contextPoliciesRouter).toBeTruthy()
    expect(typeof (contextPoliciesRouter as unknown as { use?: unknown }).use).toBe('function')
  })
})

