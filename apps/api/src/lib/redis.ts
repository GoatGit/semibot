/**
 * Redis 客户端 — 已替换为内存实现
 *
 * 所有导出与原 redis.ts 接口保持一致，调用方无需修改。
 */
export * from './mem-store'
export { default } from './mem-store'
