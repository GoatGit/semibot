/**
 * LLM Repository — 本地文件存储代理
 */

import * as local from '../lib/llm-local-store'

export type {
  LocalLLMProviderRow as LLMProviderRow,
  LocalLLMModelRow as LLMModelRow,
  LocalLLMModelWithProvider as LLMModelWithProvider,
} from '../lib/llm-local-store'

export async function findProvidersByOrg() {
  return local.localFindProvidersByOrg()
}

export async function findSystemProviders() {
  return local.localFindSystemProviders()
}

export async function findProviderById(id: string) {
  return local.localFindProviderById(id)
}

export async function findModelsByOrg() {
  return local.localFindModelsByOrg()
}

export async function findSystemModels() {
  return local.localFindSystemModels()
}

export async function findModelsByProvider(providerId: string) {
  return local.localFindModelsByProvider(providerId)
}

export async function findModelById(id: string) {
  return local.localFindModelById(id)
}

export async function findModelByModelId(modelId: string) {
  return local.localFindModelByModelId(modelId)
}

export async function findModelsByCapability(capability: string) {
  return local.localFindModelsByCapability(capability)
}
