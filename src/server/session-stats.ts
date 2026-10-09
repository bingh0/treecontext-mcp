export interface LatencyBucket {
  count: number
  min: number
  max: number
  sum: number
}

export interface SessionStatsSnapshot {
  query: {
    total: number
    byMode: Record<string, number>
    latency: LatencyBucket
    resultCountTotal: number
  }
  insert: {
    total: number
    bySource: Record<string, number>
    latency: LatencyBucket
  }
  delete: { calls: number }
  clear: { calls: number }
  export: { calls: number; nodesExported: number }
  import: { calls: number; nodesImported: number }
  startedAt: string
}

function emptyBucket(): LatencyBucket {
  return { count: 0, min: Infinity, max: 0, sum: 0 }
}

function updateBucket(b: LatencyBucket, ms: number): void {
  b.count++
  b.sum += ms
  if (ms < b.min) b.min = ms
  if (ms > b.max) b.max = ms
}

function serializeBucket(b: LatencyBucket): LatencyBucket {
  return {
    count: b.count,
    min: b.count > 0 ? b.min : 0,
    max: b.max,
    sum: Math.round(b.sum),
  }
}

export class SessionStats {
  private _queryTotal = 0
  private _queryByMode: Record<string, number> = {}
  private _queryLatency = emptyBucket()
  private _queryResultCountTotal = 0

  private _insertTotal = 0
  private _insertBySource: Record<string, number> = {}
  private _insertLatency = emptyBucket()

  private _deleteCalls = 0
  private _clearCalls = 0

  private _exportCalls = 0
  private _exportNodes = 0
  private _importCalls = 0
  private _importNodes = 0

  private readonly _startedAt: string

  constructor() {
    this._startedAt = new Date().toISOString()
  }

  recordQuery(mode: string, latencyMs: number, resultCount: number): void {
    this._queryTotal++
    this._queryByMode[mode] = (this._queryByMode[mode] ?? 0) + 1
    updateBucket(this._queryLatency, latencyMs)
    this._queryResultCountTotal += resultCount
  }

  recordInsert(source: string, latencyMs: number): void {
    this._insertTotal++
    this._insertBySource[source] = (this._insertBySource[source] ?? 0) + 1
    updateBucket(this._insertLatency, latencyMs)
  }

  recordDelete(): void { this._deleteCalls++ }
  recordClear(): void { this._clearCalls++ }

  recordExport(nodeCount: number): void {
    this._exportCalls++
    this._exportNodes += nodeCount
  }

  recordImport(nodeCount: number): void {
    this._importCalls++
    this._importNodes += nodeCount
  }

  toJSON(): SessionStatsSnapshot {
    return {
      query: {
        total: this._queryTotal,
        byMode: { ...this._queryByMode },
        latency: serializeBucket(this._queryLatency),
        resultCountTotal: this._queryResultCountTotal,
      },
      insert: {
        total: this._insertTotal,
        bySource: { ...this._insertBySource },
        latency: serializeBucket(this._insertLatency),
      },
      delete: { calls: this._deleteCalls },
      clear: { calls: this._clearCalls },
      export: { calls: this._exportCalls, nodesExported: this._exportNodes },
      import: { calls: this._importCalls, nodesImported: this._importNodes },
      startedAt: this._startedAt,
    }
  }

  reset(): void {
    this._queryTotal = 0
    this._queryByMode = {}
    this._queryLatency = emptyBucket()
    this._queryResultCountTotal = 0
    this._insertTotal = 0
    this._insertBySource = {}
    this._insertLatency = emptyBucket()
    this._deleteCalls = 0
    this._clearCalls = 0
    this._exportCalls = 0
    this._exportNodes = 0
    this._importCalls = 0
    this._importNodes = 0
  }
}
