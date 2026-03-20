/**
 * 环境变量加载 - 必须在所有其他模块之前导入
 *
 * ESM 中 import 语句会被提升，导致模块级代码在 dotenv.config() 之前执行。
 * 将 dotenv 加载放在独立模块中，并作为 index.ts 的第一个 import，
 * 确保环境变量在其他模块读取 process.env 之前已加载。
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..') // apps/api
const projectRoot = resolve(appRoot, '..', '..') // monorepo root

// 优先加载 apps/api/.env.local，再加载根目录 .env.local / .env
config({ path: resolve(appRoot, '.env.local') })
config({ path: resolve(projectRoot, '.env.local') })
config({ path: resolve(projectRoot, '.env') })
