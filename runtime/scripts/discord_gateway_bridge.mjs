#!/usr/bin/env node

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
const botToken = String(args['bot-token'] || '').trim()
const internalToken = String(args['internal-token'] || '').trim()

if (!runtimeUrl || !instanceId || !botToken || !internalToken) {
  process.stderr.write('[discord-gateway] missing required args: runtime-url/instance-id/bot-token/internal-token\n')
  process.exit(1)
}

let Client
let GatewayIntentBits
let Partials
try {
  const discord = await import('discord.js')
  Client = discord.Client
  GatewayIntentBits = discord.GatewayIntentBits
  Partials = discord.Partials
} catch (error) {
  process.stderr.write(`[discord-gateway] missing dependency discord.js: ${String(error)}\n`)
  process.exit(1)
}

async function forwardEvent(type, data, botUserId) {
  const payload = {
    type,
    data,
    bot_user_id: botUserId || '',
  }
  const url = `${runtimeUrl}/v1/integrations/discord/events/internal?instance_id=${encodeURIComponent(instanceId)}`
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
    process.stderr.write(`[discord-gateway] forward failed ${resp.status}: ${body}\n`)
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

client.once('ready', () => {
  process.stdout.write(`[discord-gateway] started instance=${instanceId} user=${client.user?.id || 'unknown'}\n`)
})

client.on('messageCreate', async (message) => {
  try {
    if (!message) return
    const payload = {
      id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId,
      content: message.content || '',
      author: message.author
        ? {
            id: message.author.id,
            username: message.author.username,
            bot: Boolean(message.author.bot),
          }
        : {},
      mentions: Array.from(message.mentions?.users?.values?.() || []).map((user) => ({
        id: user.id,
        username: user.username,
        bot: Boolean(user.bot),
      })),
      attachments: Array.from(message.attachments?.values?.() || []).map((file) => ({
        id: file.id,
        filename: file.name,
        url: file.url,
        content_type: file.contentType,
        size: file.size,
      })),
    }
    await forwardEvent('message_create', payload, client.user?.id)
  } catch (error) {
    process.stderr.write(`[discord-gateway] messageCreate error: ${String(error)}\n`)
  }
})

client.login(botToken).catch((error) => {
  process.stderr.write(`[discord-gateway] login failed: ${String(error)}\n`)
  process.exit(1)
})

const stop = async () => {
  try {
    await client.destroy()
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
