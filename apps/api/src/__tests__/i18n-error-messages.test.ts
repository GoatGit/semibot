import { describe, it, expect } from 'vitest'
import {
  getErrorMessage,
  AUTH_TOKEN_MISSING,
  INTERNAL_ERROR,
  WEBHOOK_NOT_FOUND,
  VALIDATION_FAILED,
} from '../constants/errorCodes'

describe('i18n error messages', () => {
  describe('getErrorMessage', () => {
    it('should return Chinese message by default', () => {
      expect(getErrorMessage(AUTH_TOKEN_MISSING)).toBe('缺少认证令牌')
      expect(getErrorMessage(INTERNAL_ERROR)).toBe('服务内部错误')
    })

    it('should return Chinese message for zh-CN locale', () => {
      expect(getErrorMessage(AUTH_TOKEN_MISSING, 'zh-CN')).toBe('缺少认证令牌')
      expect(getErrorMessage(WEBHOOK_NOT_FOUND, 'zh-CN')).toBe('Webhook 不存在')
    })

    it('should return English message for en-US locale', () => {
      expect(getErrorMessage(AUTH_TOKEN_MISSING, 'en-US')).toBe('Authentication token is missing')
      expect(getErrorMessage(INTERNAL_ERROR, 'en-US')).toBe('Internal server error')
      expect(getErrorMessage(WEBHOOK_NOT_FOUND, 'en-US')).toBe('Webhook not found')
    })

    it('should fallback to Chinese for unknown locale', () => {
      expect(getErrorMessage(VALIDATION_FAILED, 'fr-FR')).toBe('数据校验失败')
      expect(getErrorMessage(VALIDATION_FAILED, 'ja-JP')).toBe('数据校验失败')
    })

    it('should return fallback for unknown error code', () => {
      expect(getErrorMessage('UNKNOWN_CODE')).toBe('未知错误')
      expect(getErrorMessage('UNKNOWN_CODE', 'en-US')).toBe('未知错误')
    })
  })
})
