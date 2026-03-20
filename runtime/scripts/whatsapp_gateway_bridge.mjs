#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

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
const sessionName = String(args['session-name'] || '').trim()
const authDir = String(args['auth-dir'] || '').trim()
const outboxDir = String(args['outbox-dir'] || '').trim()
const internalToken = String(args['internal-token'] || '').trim()
const inboundDir = path.join(path.dirname(outboxDir), 'inbound')

if (!runtimeUrl || !instanceId || !sessionName || !authDir || !outboxDir || !internalToken) {
  process.stderr.write(
    '[whatsapp-gateway] missing required args: runtime-url/instance-id/session-name/auth-dir/outbox-dir/internal-token\n'
  )
  process.exit(1)
}

fs.mkdirSync(authDir, { recursive: true })
fs.mkdirSync(outboxDir, { recursive: true })
fs.mkdirSync(inboundDir, { recursive: true })

let makeWASocket
let useMultiFileAuthState
let fetchLatestBaileysVersion
let DisconnectReason
let downloadMediaMessage
try {
  const mod = await import('@whiskeysockets/baileys')
  makeWASocket = mod.default
  useMultiFileAuthState = mod.useMultiFileAuthState
  fetchLatestBaileysVersion = mod.fetchLatestBaileysVersion
  DisconnectReason = mod.DisconnectReason
  downloadMediaMessage = mod.downloadMediaMessage
} catch (error) {
  process.stderr.write(`[whatsapp-gateway] missing dependency @whiskeysockets/baileys: ${String(error)}\n`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractText(message = {}) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  )
}

function detectAttachments(message = {}) {
  const items = []
  const pushItem = (kind, payload, fallbackExt, fallbackMime) => {
    if (!payload || typeof payload !== 'object') return
    items.push({
      kind,
      mime_type: String(payload.mimetype || fallbackMime || '').trim() || undefined,
      file_name: String(payload.fileName || '').trim() || undefined,
      fallback_ext: fallbackExt,
    })
  }
  if (message.documentMessage) pushItem('document', message.documentMessage, '.bin', 'application/octet-stream')
  if (message.imageMessage) pushItem('image', message.imageMessage, '.jpg', 'image/jpeg')
  if (message.videoMessage) pushItem('video', message.videoMessage, '.mp4', 'video/mp4')
  if (message.audioMessage) pushItem('audio', message.audioMessage, '.ogg', 'audio/ogg')
  return items
}

function safeFilename(name, fallback) {
  const raw = String(name || '').trim()
  const candidate = raw.split('/').pop()?.split('\\').pop() || ''
  const cleaned = candidate.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '')
  return cleaned || fallback
}

function guessExt(mimeType, fallback) {
  const mime = String(mimeType || '').trim().toLowerCase()
  if (!mime) return fallback
  if (mime.includes('jpeg')) return '.jpg'
  if (mime.includes('png')) return '.png'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('pdf')) return '.pdf'
  if (mime.includes('mp4')) return '.mp4'
  if (mime.includes('mpeg')) return '.mp3'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('zip')) return '.zip'
  return fallback
}

async function materializeAttachments(msg) {
  const descriptors = detectAttachments(msg?.message || {})
  if (!descriptors.length || typeof downloadMediaMessage !== 'function') return []
  const stored = []
  let index = 0
  for (const item of descriptors) {
    index += 1
    try {
      const content = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: undefined, reuploadRequest: sock.updateMediaMessage }
      )
      if (!content || !Buffer.isBuffer(content)) continue
      const ext = guessExt(item.mime_type, item.fallback_ext || '.bin')
      const fallbackName = `whatsapp_${msg?.key?.id || 'msg'}_${index}${ext}`
      const filename = safeFilename(item.file_name, fallbackName)
      const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
      const dest = path.join(inboundDir, `${ts}_${index}_${filename}`)
      fs.writeFileSync(dest, content)
      stored.push({
        kind: item.kind,
        mime_type: item.mime_type,
        file_name: filename,
        local_path: dest,
        stored_size: content.length,
        status: 'downloaded',
      })
    } catch (error) {
      process.stderr.write(`[whatsapp-gateway] attachment download failed: ${String(error)}\n`)
    }
  }
  return stored
}

async function forwardEvent(type, data) {
  const url = `${runtimeUrl}/v1/integrations/whatsapp/events/internal?instance_id=${encodeURIComponent(instanceId)}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-semibot-internal-token': internalToken,
    },
    body: JSON.stringify({ type, data, bot_id: sessionName }),
  })
  if (!resp.ok) {
    const body = await resp.text()
    process.stderr.write(`[whatsapp-gateway] forward failed ${resp.status}: ${body}\n`)
  }
}

async function createSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const versionInfo = await fetchLatestBaileysVersion().catch(() => null)
  const sock = makeWASocket({
    auth: state,
    version: versionInfo?.version,
    printQRInTerminal: true,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ['Semibot', 'Chrome', '1.0'],
  })
  sock.ev.on('creds.update', saveCreds)
  return sock
}

let sock = await createSocket()

async function processOutbox() {
  const files = fs.readdirSync(outboxDir).filter((name) => name.endsWith('.json')).sort()
  for (const name of files) {
    const full = path.join(outboxDir, name)
    try {
      const raw = fs.readFileSync(full, 'utf8')
      const cmd = JSON.parse(raw)
      if (cmd?.type === 'send_message') {
        const chatId = String(cmd.chat_id || '').trim()
        const text = String(cmd.text || '').trim()
        const files = Array.isArray(cmd.files) ? cmd.files : []
        if (chatId && text) {
          await sock.sendMessage(chatId, { text })
        }
        for (const file of files) {
          const localPath = String(file?.local_path || '').trim()
          if (!chatId || !localPath || !fs.existsSync(localPath)) continue
          const filename = String(file?.filename || path.basename(localPath)).trim() || path.basename(localPath)
          const mimetype = String(file?.mime_type || 'application/octet-stream').trim() || 'application/octet-stream'
          await sock.sendMessage(chatId, {
            document: fs.readFileSync(localPath),
            fileName: filename,
            mimetype,
          })
        }
      }
      fs.unlinkSync(full)
    } catch (error) {
      process.stderr.write(`[whatsapp-gateway] outbox command failed ${name}: ${String(error)}\n`)
    }
  }
}

async function outboxLoop() {
  while (true) {
    await processOutbox().catch((error) => {
      process.stderr.write(`[whatsapp-gateway] outbox loop error: ${String(error)}\n`)
    })
    await sleep(1000)
  }
}

sock.ev.on('connection.update', async (update) => {
  const connection = update?.connection || ''
  if (update?.qr) {
    process.stdout.write(`[whatsapp-gateway] qr instance=${instanceId}\n`)
  }
  if (connection === 'open') {
    process.stdout.write(`[whatsapp-gateway] connected instance=${instanceId}\n`)
  }
  if (connection === 'close') {
    const statusCode = update?.lastDisconnect?.error?.output?.statusCode
    const loggedOut = statusCode === DisconnectReason?.loggedOut
    process.stderr.write(`[whatsapp-gateway] closed instance=${instanceId} loggedOut=${String(loggedOut)}\n`)
    if (!loggedOut) {
      sock = await createSocket()
    }
  }
})

sock.ev.on('messages.upsert', async (event) => {
  try {
    const messages = Array.isArray(event?.messages) ? event.messages : []
    for (const msg of messages) {
      if (!msg?.key || msg.key.fromMe) continue
      const chatId = String(msg.key.remoteJid || '').trim()
      if (!chatId) continue
      const text = extractText(msg.message || {})
      const attachments = await materializeAttachments(msg)
      await forwardEvent('message_upsert', {
        id: msg.key.id || '',
        chat_id: chatId,
        sender_id: msg.key.participant || chatId,
        sender_name: '',
        chat_type: chatId.endsWith('@g.us') ? 'group' : 'dm',
        text,
        attachments,
      })
    }
  } catch (error) {
    process.stderr.write(`[whatsapp-gateway] messages.upsert error: ${String(error)}\n`)
  }
})

outboxLoop().catch((error) => {
  process.stderr.write(`[whatsapp-gateway] outbox loop crashed: ${String(error)}\n`)
  process.exit(1)
})

const stop = async () => {
  try {
    if (sock) {
      await sock.logout().catch(() => {})
      await sock.end?.()
    }
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
