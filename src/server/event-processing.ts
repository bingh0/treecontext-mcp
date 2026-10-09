export type IntentType =
  | 'question'
  | 'directive'
  | 'correction'
  | 'feedback'
  | 'info'

export function classifyIntent(content: string): IntentType {
  const lower = content.substring(0, 200).toLowerCase().trim()

  if (/^(actually|no,|wait,|instead|scratch that|never mind|let me rephrase)/.test(lower) ||
      lower.includes('actually') || lower.includes('instead') || lower.includes('scratch that') ||
      lower.includes('never mind') || lower.includes('let me rephrase') || lower.includes('wait,')) {
    return 'correction'
  }

  if (/^(looks good|that works|perfect|great|thanks|nice|lgtm|approved|👍)/.test(lower) ||
      lower.includes('looks good') || lower.includes('that works') || lower.includes('perfect') ||
      lower.includes('great') || lower.includes('thanks') || lower.includes('nice') ||
      lower.includes('lgtm') || lower.includes('approved') || lower.includes('👍') ||
      lower === 'yes' || lower === 'no') {
    return 'feedback'
  }

  if (/^(what|how|why|where|when|which|is |are |do |does |can |could |would |should |will )/.test(lower) ||
      lower.includes('?')) {
    return 'question'
  }

  if (/\b(implement|create|add|fix|update|refactor|remove|delete|change|modify|write|build|deploy|run|test|review|make|set up|configure)\b/.test(lower)) {
    return 'directive'
  }

  return 'info'
}

export type ExitType = 'success' | 'soft_fail' | 'error'

export function classifyExit(toolContent: string): ExitType {
  const lower = toolContent.toLowerCase()
  if (lower.includes('error:') || lower.includes('failed') || lower.includes('fatal:') ||
      lower.includes('panic:') || lower.includes('traceback') || lower.includes('exception') ||
      lower.includes('enoent') || lower.includes('eacces') || lower.includes('eperm') ||
      lower.includes('cannot find') || lower.includes('command not found') ||
      /exit code [1-9]/.test(lower) || /exited with [1-9]/.test(lower)) {
    return 'error'
  }

  if (lower.includes('warning:') || lower.includes('warn') || lower.includes('deprecated') ||
      lower.includes('skipped') || lower.includes('timed out') || lower.includes('no such file')) {
    return 'soft_fail'
  }

  return 'success'
}

export interface ErrorRecord {
  stagingId: number
  nodeId: string
  fingerprint: string
  timestamp: number
}

export class ErrorTracker {
  private maxPending: number
  private pending: Map<string, ErrorRecord> = new Map()

  constructor(maxPending: number = 50) {
    this.maxPending = maxPending
  }

  recordError(record: ErrorRecord): string {
    if (this.pending.size >= this.maxPending) {
      let oldest: string | null = null
      let minTs = Infinity
      for (const [k, v] of this.pending.entries()) {
        if (v.timestamp < minTs) {
          minTs = v.timestamp
          oldest = k
        }
      }
      if (oldest) this.pending.delete(oldest)
    }
    this.pending.set(record.fingerprint, record)
    return record.fingerprint
  }

  tryResolve(toolName: string): ErrorRecord | null {
    const record = this.pending.get(toolName)
    if (record) {
      this.pending.delete(toolName)
      return record
    }
    return null
  }

  get pendingCount(): number {
    return this.pending.size
  }

  clear(): void {
    this.pending.clear()
  }
}

export interface LoopWarning {
  toolName: string
  count: number
  windowSize: number
  message: string
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(16)
}

export class LoopDetector {
  private window: Array<{ toolName: string; contentHash: string; timestamp: number }> = []
  private windowSize: number
  private threshold: number

  constructor(windowSize: number = 20, threshold: number = 3) {
    this.windowSize = windowSize
    this.threshold = threshold
  }

  record(toolName: string, content: string): LoopWarning | null {
    const contentHash = simpleHash(toolName + content.substring(0, 200))
    this.window.push({ toolName, contentHash, timestamp: Date.now() })
    if (this.window.length > this.windowSize) {
      this.window.shift()
    }

    let count = 0
    for (const item of this.window) {
      if (item.contentHash === contentHash) count++
    }

    if (count >= this.threshold) {
      return {
        toolName,
        count,
        windowSize: this.windowSize,
        message: `Loop detected: ${toolName} called ${count} times in last ${this.windowSize} events`
      }
    }

    return null
  }

  clear(): void {
    this.window = []
  }
}

export interface ProjectAttribution {
  project: string
  confidence: number
  source: 'store_name' | 'session_id' | 'cwd'
}

export function attributeProject(
  storeName: string | null | undefined,
  sessionId: string | null | undefined,
  cwd: string | null | undefined,
): ProjectAttribution {
  if (storeName && storeName !== 'default' && storeName !== 'treecontext') {
    return { project: storeName, confidence: 1.0, source: 'store_name' }
  }

  if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) && sessionId !== 'default') {
    return { project: sessionId, confidence: 0.7, source: 'session_id' }
  }

  if (cwd) {
    const parts = cwd.split(/[/\\]/).filter(Boolean)
    if (parts.length > 0) {
      const last = parts[parts.length - 1]
      if (last) {
        return { project: last, confidence: 0.5, source: 'cwd' }
      }
    }
  }

  return { project: 'unknown', confidence: 0.0, source: 'cwd' }
}
