#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function parseArgs(argv) {
  const args = {}
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !key.startsWith('--')) continue
    args[key.slice(2)] = value
  }
  return args
}

function writeState(file, patch) {
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {}
  const next = { ...current, ...patch }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf-8')
}

function trimTail(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-20)
    .join('\n')
}

function runStep(command, args, env) {
  return spawnSync(command, args, {
    encoding: 'utf-8',
    env,
    cwd: env.SEMIBOT_HOME,
  })
}

function main() {
  const args = parseArgs(process.argv)
  const stateFile = String(args['state-file'] || '').trim()
  const manifestUrl = String(args['manifest-url'] || '').trim()
  const home = String(args.home || '').trim()

  if (!stateFile || !manifestUrl || !home) process.exit(2)

  const launcher = path.join(home, 'releases', 'current', 'workspace', 'runtime', 'scripts', 'semibot')
  const env = {
    ...process.env,
    SEMIBOT_HOME: home,
  }

  writeState(stateFile, {
    status: 'stopping',
    workerPid: process.pid,
    manifestUrl,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message: '正在停止旧服务',
    error: null,
  })

  runStep(launcher, ['down'], env)

  writeState(stateFile, {
    status: 'upgrading',
    message: '正在安装新版本',
  })

  const upgrade = runStep(launcher, ['upgrade', '--manifest-url', manifestUrl], env)
  if (upgrade.status !== 0) {
    writeState(stateFile, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: '升级失败',
      error: [trimTail(upgrade.stdout), trimTail(upgrade.stderr)].filter(Boolean).join('\n'),
    })
    process.exit(upgrade.status || 1)
  }

  writeState(stateFile, {
    status: 'restarting',
    message: '正在重启服务',
  })

  const restart = runStep(launcher, ['ui', '--no-open', '--health-timeout', '60'], env)
  if (restart.status !== 0) {
    writeState(stateFile, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: '重启失败',
      error: [trimTail(restart.stdout), trimTail(restart.stderr)].filter(Boolean).join('\n'),
    })
    process.exit(restart.status || 1)
  }

  writeState(stateFile, {
    status: 'succeeded',
    finishedAt: new Date().toISOString(),
    message: '升级完成',
    error: null,
  })
}

main()
