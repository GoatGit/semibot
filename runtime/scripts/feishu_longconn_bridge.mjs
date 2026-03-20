#!/usr/bin/env node

import * as lark from '@larksuiteoapi/node-sdk'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const val = argv[i + 1]
    if (!val || val.startsWith('--')) {
      out[name] = ''
      continue
    }
    out[name] = val
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const runtimeUrl = String(args['runtime-url'] || '').trim().replace(/\/+$/, '')
const instanceId = String(args['instance-id'] || '').trim()
const appId = String(args['app-id'] || '').trim()
const appSecret = String(args['app-secret'] || '').trim()
const domainRaw = String(args.domain || 'feishu').trim().toLowerCase()
const internalToken = String(args['internal-token'] || '').trim()

if (!runtimeUrl || !instanceId || !appId || !appSecret || !internalToken) {
  process.stderr.write(
    '[feishu-longconn] missing required args: runtime-url/instance-id/app-id/app-secret/internal-token\n'
  )
  process.exit(1)
}

const domain = domainRaw === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu

async function forwardEvent(eventType, data) {
  const payload = {
    schema: '2.0',
    header: {
      event_type: eventType,
      token: 'semibot-longconn',
    },
    event: data,
  }
  const url = `${runtimeUrl}/v1/integrations/feishu/events/internal?instance_id=${encodeURIComponent(instanceId)}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-semibot-internal-token': internalToken,
    },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const body = await resp.text()
    process.stderr.write(`[feishu-longconn] forward failed ${resp.status}: ${body}\n`)
  }
}

const wsClient = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.info,
  domain,
})

const eventDispatcher = new lark.EventDispatcher({})
  .register({
    'im.message.receive_v1': async (data) => {
      await forwardEvent('im.message.receive_v1', data)
    },
  })

wsClient.start({ eventDispatcher })
process.stdout.write(
  `[feishu-longconn] started instance=${instanceId} domain=${domainRaw}\n`
)

const stop = () => {
  try {
    wsClient.close()
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
