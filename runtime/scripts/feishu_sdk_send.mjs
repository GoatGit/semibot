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

function fail(message, details) {
  const payload = { ok: false, error: message, ...(details ? { details } : {}) }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const appId = String(args['app-id'] || '').trim()
const appSecret = String(args['app-secret'] || '').trim()
const receiveIdType = String(args['receive-id-type'] || 'chat_id').trim()
const receiveId = String(args['receive-id'] || '').trim()
const text = String(args.text || '').trim()
const domainRaw = String(args.domain || 'feishu').trim().toLowerCase()

if (!appId) fail('missing app-id')
if (!appSecret) fail('missing app-secret')
if (!receiveId) fail('missing receive-id')
if (!text) fail('missing text')

const domain = domainRaw === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu

async function main() {
  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain,
  })

  const resp = await client.im.message.create({
    params: {
      receive_id_type: receiveIdType,
    },
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  })

  if (!resp || typeof resp.code !== 'number') {
    fail('invalid_feishu_sdk_response')
  }
  if (resp.code !== 0) {
    fail('feishu_api_error', {
      code: resp.code,
      msg: resp.msg,
      request_id: resp.request_id,
    })
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      code: resp.code,
      request_id: resp.request_id,
      message_id: resp.data?.message_id || null,
    })}\n`
  )
}

main().catch((err) => {
  fail('feishu_sdk_exception', err instanceof Error ? err.message : String(err))
})
