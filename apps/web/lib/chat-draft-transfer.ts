const initialSessionFiles = new Map<string, File[]>()

export function setInitialSessionFiles(sessionId: string, files: File[]): void {
  if (!sessionId) return
  initialSessionFiles.set(sessionId, files)
}

export function takeInitialSessionFiles(sessionId: string): File[] {
  if (!sessionId) return []
  const files = initialSessionFiles.get(sessionId) || []
  initialSessionFiles.delete(sessionId)
  return files
}
