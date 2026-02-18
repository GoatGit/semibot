#!/usr/bin/env tsx
/**
 * 创建超级管理员账号 CLI 脚本
 *
 * 用法：
 *   pnpm --filter @semibot/api create-admin
 *   # 或
 *   tsx apps/api/src/scripts/create-admin.ts
 *
 * 支持环境变量覆盖（方便 CI / Docker）：
 *   ADMIN_EMAIL=xxx ADMIN_PASSWORD=xxx ADMIN_NAME=xxx ORG_NAME=xxx tsx ...
 */

/* eslint-disable no-console */

import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import postgres from 'postgres'
import readline from 'readline'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/semibot'
const BCRYPT_ROUNDS = 10

// ─── helpers ────────────────────────────────────────────────────

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultValue ? ` (${defaultValue})` : ''
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base}-${Math.random().toString(36).substring(2, 8)}`
}

// ─── main ───────────────────────────────────────────────────────

async function main() {
  console.log('\n🔧 Semibot 超级管理员创建工具\n')

  const email    = process.env.ADMIN_EMAIL    || await prompt('邮箱', 'admin@semibot.dev')
  const password = process.env.ADMIN_PASSWORD || await prompt('密码', 'password123')
  const name     = process.env.ADMIN_NAME     || await prompt('姓名', 'Super Admin')
  const orgName  = process.env.ORG_NAME       || await prompt('组织名称', 'Semibot')

  if (!email || !password) {
    console.error('❌ 邮箱和密码不能为空')
    process.exit(1)
  }

  const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 5 })

  try {
    // 检查邮箱是否已存在
    const existing = await sql`SELECT id, role, org_id FROM users WHERE email = ${email}`
    if (existing.length > 0) {
      const user = existing[0]
      if (user.role === 'owner') {
        console.log(`⚠️  用户 ${email} 已存在，角色已是 owner，无需操作`)
      } else {
        // 升级为 owner
        await sql`UPDATE users SET role = 'owner', updated_at = NOW() WHERE id = ${user.id}`
        console.log(`✅ 已将 ${email} 从 ${user.role} 升级为 owner`)
      }
      await sql.end()
      return
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const userId = crypto.randomUUID()
    const orgId = crypto.randomUUID()
    const orgSlug = generateSlug(orgName)

    // 创建组织
    await sql`
      INSERT INTO organizations (id, name, slug, owner_id, plan)
      VALUES (${orgId}, ${orgName}, ${orgSlug}, ${userId}::uuid, 'pro')
    `

    // 创建用户
    await sql`
      INSERT INTO users (id, email, password_hash, name, org_id, role, email_verified, is_active)
      VALUES (${userId}, ${email}, ${passwordHash}, ${name}, ${orgId}, 'owner', true, true)
    `

    console.log('\n✅ 超级管理员创建成功！')
    console.log('─'.repeat(40))
    console.log(`  邮箱:   ${email}`)
    console.log(`  密码:   ${password}`)
    console.log(`  角色:   owner (全部权限)`)
    console.log(`  组织:   ${orgName} (${orgSlug})`)
    console.log(`  用户ID: ${userId}`)
    console.log(`  组织ID: ${orgId}`)
    console.log('─'.repeat(40))
  } catch (err) {
    console.error('❌ 创建失败:', (err as Error).message)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
