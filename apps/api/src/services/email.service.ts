/**
 * 邮件服务
 *
 * 当前先提供统一抽象，后续可替换为 SMTP/第三方邮件服务。
 */

import { createLogger } from '../lib/logger'

const emailLogger = createLogger('email')

export interface PasswordResetEmailInput {
  email: string
  resetToken: string
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
  const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000'
  const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(input.resetToken)}`

  // TODO: 接入真实邮件发送服务（SMTP/SES/SendGrid 等）
  emailLogger.info('Password reset email queued', { email: input.email, resetUrl })
}

