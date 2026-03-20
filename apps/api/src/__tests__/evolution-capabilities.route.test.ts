import { describe, expect, it } from 'vitest'
import evolutionCapabilitiesRouter from '../routes/v1/evolution-capabilities'

describe('evolution-capabilities route wiring', () => {
  it('exports express router', () => {
    expect(evolutionCapabilitiesRouter).toBeTruthy()
    expect(typeof (evolutionCapabilitiesRouter as unknown as { use?: unknown }).use).toBe('function')
  })
})

