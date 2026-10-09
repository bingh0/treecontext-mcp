import { readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { countNodesIn } from '../../helpers/store-fixtures.js'
import type { MediaRef } from '../../../src/core/types.js'
import { type World, T0, openLiveStore, reopenAsLaterSession, exportNode, mediaOf, rawMediaOf, insertAttachment } from '../world.js'

// ── journal-media ───────────────────────────────────────────────────────


/**
 * The media wave's world: the file on disk behind a media_ref, and what the
 * journal kept of it.
 *
 * `attachedPath` lives here now. It sat in the core World only because
 * journal-storage had a field by the same name meaning something else
 * entirely (the archive file a restore reads back, since renamed
 * archivePath) — a name collision, never sharing.
 */
export interface MediaWorld extends World {
  /** The attached file itself, on disk. */
  attachedPath?: string
  /** The file: URI form of the attached path, as the ref carries it. */
  attachedUri?: string
  /** Bytes written to that file, so a later read can prove identity. */
  markerBytes?: Buffer
  /** The media reference as re-read out of the store. */
  extracted?: Record<string, unknown>
}

export const mediaDefiner = (reg: Registry<MediaWorld>): void => {
  // S1: description + reference in, bytes never in.
  reg.define(/^a file the user attached to the conversation$/, async (w: MediaWorld) => {
    await openLiveStore(w)
    // Distinctive marker bytes: their absence from the DB file is checkable.
    w.markerBytes = Buffer.from('JOURNAL-BYTES-MARKER-7f3a9c'.repeat(8))
    w.attachedPath = join(w.dir!, 'dashboard.png')
    writeFileSync(w.attachedPath, w.markerBytes)
    w.attachedUri = pathToFileURL(w.attachedPath).href
  })
  reg.define(/^the agent inserts a node describing it with a media reference$/, async (w: MediaWorld) => {
    w.nodeId = await insertAttachment(w, 'Screenshot of the failing dashboard, red latency spike at 14:02', {
      uri: w.attachedUri!,
      mimeType: 'image/png',
      filename: 'dashboard.png',
      extension: 'png',
    })
  })
  reg.define(/^the entry holds the description text, the URI, and the MIME type$/, (w: MediaWorld) => {
    const node = exportNode(w, w.nodeId!)
    expect(node['content']).toBe('Screenshot of the failing dashboard, red latency spike at 14:02')
    const media = mediaOf(node)
    expect(media.uri).toBe(w.attachedUri)
    expect(media.mimeType).toBe('image/png')
    // And the raw row agrees with the export surface.
    expect(rawMediaOf(w, w.nodeId!).uri).toBe(w.attachedUri)
  })
  // Round-2 R11 note: the raw scan below is a tripwire for the obvious
  // failure (bytes copied verbatim). It is complemented by the decoded
  // check, so bytes smuggled THROUGH the content codec are caught too.
  reg.define(/^the file's bytes are absent from the store$/, (w: MediaWorld) => {
    // Scan the database file AND its WAL: the attachment's bytes must
    // appear in neither. The marker is long and non-compressible-away.
    for (const suffix of ['', '-wal']) {
      const p = w.dbPath! + suffix
      if (!existsSync(p)) continue
      expect(
        readFileSync(p).includes(w.markerBytes!),
        `attachment bytes found in ${p}`,
      ).toBe(false)
    }
    // …and not smuggled through the content codec either: decode every
    // row and look again. A raw scan alone would miss a compressed copy.
    const marker = w.markerBytes!.toString('utf8')
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      for (const r of raw.prepare('SELECT content FROM nodes').all() as Array<{ content: unknown }>) {
        expect(
          decodeContent(r.content as string | Buffer | null).includes(marker),
          'attachment bytes found in decoded row content',
        ).toBe(false)
      }
    } finally {
      raw.close()
    }
  })

  // S2: recall through the description, across sessions.
  reg.define(/^a journaled attachment described in the agent's words$/, async (w: MediaWorld) => {
    await openLiveStore(w)
    w.attachedUri = 'file:///captures/flamegraph-run4.svg'
    w.nodeId = await insertAttachment(w, 'Flamegraph showing the quadratic rescan in the ingestion loop', {
      uri: w.attachedUri,
      mimeType: 'image/svg+xml',
    })
  })
  reg.define(/^a later session searches words from that description$/, async (w: MediaWorld) => {
    await reopenAsLaterSession(w)
    w.results = await w.store!.query('quadratic rescan ingestion', { topK: 5 })
  })
  reg.define(/^the media entry is a hit and carries its URI$/, (w: MediaWorld) => {
    const hit = w.results!.find((r) => r.nodeId === w.nodeId)
    expect(hit, 'journaled attachment is not a hit').toBeTruthy()
    const media = hit!.metadata?.['_media'] as MediaRef | undefined
    expect(media, 'hit carries no media reference').toBeTruthy()
    expect(media!.uri).toBe(w.attachedUri)
  })

  // S3: class recall via MIME prefix — two-sided.
  reg.define(/^journaled attachments of mixed types$/, async (w: MediaWorld) => {
    await openLiveStore(w)
    w.nodeIds = [
      await insertAttachment(w, 'artifact one: architecture diagram of the store', { uri: 'file:///a/diagram.png', mimeType: 'image/png' }),
      await insertAttachment(w, 'artifact two: design review recording', { uri: 'file:///a/review.pdf', mimeType: 'application/pdf' }),
    ]
    // A plain entry sharing the query word — must never match a media class.
    w.nodeIds.push((await w.store!.insert('artifact three: a plain note with no attachment')).nodeId)
  })
  reg.define(/^a query filters by MIME prefix$/, async (w: MediaWorld) => {
    w.results = await w.store!.query('artifact', { topK: 10, mediaFilter: { mimePrefix: 'image/' } })
  })
  reg.define(/^every entry whose media reference matches the prefix is returned$/, (w: MediaWorld) => {
    // The dead-filter guard: an empty result set fails here.
    expect(w.results!.map((r) => r.nodeId)).toContain(w.nodeIds![0])
  })
  reg.define(/^entries without a matching reference are absent$/, (w: MediaWorld) => {
    const ids = w.results!.map((r) => r.nodeId)
    expect(ids).not.toContain(w.nodeIds![1]) // pdf: wrong prefix
    expect(ids).not.toContain(w.nodeIds![2]) // no media at all
  })

  // S3b: filename and extension filters, same two-sided contract.
  reg.define(/^journaled attachments with distinct filenames and extensions$/, async (w: MediaWorld) => {
    await openLiveStore(w)
    w.nodeIds = [
      await insertAttachment(w, 'evidence item: quarterly report draft', {
        uri: 'file:///docs/report-v1.pdf', mimeType: 'application/pdf', filename: 'report-v1.pdf', extension: 'pdf',
      }),
      await insertAttachment(w, 'evidence item: store layout diagram', {
        uri: 'file:///docs/diagram.png', mimeType: 'image/png', filename: 'diagram.png', extension: 'png',
      }),
    ]
    w.nodeIds.push((await w.store!.insert('evidence item: plain note, nothing attached')).nodeId)
  })
  reg.define(/^one query filters by a filename substring and another by an exact extension$/, async (w: MediaWorld) => {
    const byName = await w.store!.query('evidence item', { topK: 10, mediaFilter: { filename: 'report' } })
    const byExt = await w.store!.query('evidence item', { topK: 10, mediaFilter: { extension: 'png' } })
    w.results = [...byName, ...byExt]
    w.descriptions = [byName.map((r) => r.nodeId).join(','), byExt.map((r) => r.nodeId).join(',')]
  })
  reg.define(/^each filter returns exactly the entries whose reference matches it$/, (w: MediaWorld) => {
    expect(w.descriptions![0]).toBe(w.nodeIds![0]) // filename 'report' → the pdf alone
    expect(w.descriptions![1]).toBe(w.nodeIds![1]) // extension 'png' → the diagram alone
  })
  reg.define(/^entries with no reference or a non-matching one are absent from both$/, (w: MediaWorld) => {
    const ids = w.results!.map((r) => r.nodeId)
    expect(ids).not.toContain(w.nodeIds![2])
    expect(ids.filter((id) => id === w.nodeIds![0])).toHaveLength(1)
    expect(ids.filter((id) => id === w.nodeIds![1])).toHaveLength(1)
  })

  // S4: several attachments are several entries.
  reg.define(/^three files attached in one message$/, async (w: MediaWorld) => {
    await openLiveStore(w)
  })
  reg.define(/^the agent describes and inserts each one$/, async (w: MediaWorld) => {
    const session = { session_id: 'media-triplet-session' }
    w.descriptions = [
      'First capture: the crash backtrace screenshot',
      'Second capture: heap profile before the leak fix',
      'Third capture: heap profile after the leak fix',
    ]
    w.nodeIds = []
    for (let i = 0; i < 3; i++) {
      w.nodeIds.push(
        await insertAttachment(w, w.descriptions[i]!, { uri: `file:///msg/attach-${i + 1}.png`, mimeType: 'image/png' }, {
          createdAt: T0 + i * 10,
          metadata: session,
        }),
      )
    }
  })
  reg.define(/^three entries exist, each holding one reference and its own description$/, (w: MediaWorld) => {
    expect(new Set(w.nodeIds).size).toBe(3)
    for (let i = 0; i < 3; i++) {
      const node = exportNode(w, w.nodeIds![i]!)
      expect(node['content']).toBe(w.descriptions![i])
      expect(mediaOf(node).uri).toBe(`file:///msg/attach-${i + 1}.png`)
    }
  })
  reg.define(/^each is findable by its own description's words$/, async (w: MediaWorld) => {
    const probes = ['crash backtrace screenshot', 'heap profile before', 'heap profile after']
    for (let i = 0; i < 3; i++) {
      const hits = await w.store!.query(probes[i]!, { topK: 3 })
      expect(hits.map((r) => r.nodeId), `probe "${probes[i]}" missed its entry`).toContain(w.nodeIds![i])
    }
  })
  reg.define(/^the conversation window around any of them recovers the other two$/, async (w: MediaWorld) => {
    const hits = await w.store!.query('heap profile before', { topK: 1, conversationWindow: 2 })
    expect(hits).toHaveLength(1)
    const win = hits[0]!.window
    expect(win, 'hit carries no conversation window').toBeTruthy()
    const neighborIds = [...(win!.before ?? []), ...(win!.after ?? [])].map((e) => e.nodeId)
    expect(neighborIds).toContain(w.nodeIds![0])
    expect(neighborIds).toContain(w.nodeIds![2])
  })

  // S5: no dedup for media events.
  reg.define(/^a file already journaled with a morning description$/, async (w: MediaWorld) => {
    await openLiveStore(w)
    w.attachedUri = 'file:///shared/spec-draft.pdf'
    w.nodeIds = [
      await insertAttachment(w, 'Spec draft as reviewed in the morning session', { uri: w.attachedUri, mimeType: 'application/pdf' }, { createdAt: T0 }),
    ]
  })
  reg.define(/^the same file is attached again with an afternoon description$/, async (w: MediaWorld) => {
    w.nodeIds!.push(
      await insertAttachment(w, 'Spec draft again, now with the afternoon comments', { uri: w.attachedUri!, mimeType: 'application/pdf' }, { createdAt: T0 + 3600 }),
    )
  })
  reg.define(/^both entries survive with their own descriptions and timestamps$/, (w: MediaWorld) => {
    expect(new Set(w.nodeIds).size).toBe(2)
    const a = exportNode(w, w.nodeIds![0]!)
    const b = exportNode(w, w.nodeIds![1]!)
    expect(a['content']).not.toBe(b['content'])
    expect(a['createdAt']).toBe(T0)
    expect(b['createdAt']).toBe(T0 + 3600)
    expect(mediaOf(a).uri).toBe(mediaOf(b).uri)
  })

  // S6: extracted metadata verbatim.
  reg.define(/^a media reference inserted with extracted details such as dimensions or duration$/, async (w: MediaWorld) => {
    await openLiveStore(w)
    w.extracted = { width: 1920, height: 1080, duration_s: 12.5, codec: 'h264' }
    w.nodeId = await insertAttachment(w, 'Screen recording of the flaky login flow', {
      uri: 'file:///rec/login-flake.mp4',
      mimeType: 'video/mp4',
      extracted: w.extracted,
    })
  })
  reg.define(/^the entry is exported$/, (w: MediaWorld) => {
    w.exported = { nodes: [exportNode(w, w.nodeId!)] }
  })
  reg.define(/^the extracted details return exactly as inserted$/, (w: MediaWorld) => {
    expect(mediaOf(w.exported!.nodes[0]!).extracted).toEqual(w.extracted)
    expect(rawMediaOf(w, w.nodeId!).extracted).toEqual(w.extracted)
  })

  // S7: dangling link honesty.
  reg.define(/^a journaled attachment whose file has since moved or been deleted$/, async (w: MediaWorld) => {
    await openLiveStore(w)
    w.attachedPath = join(w.dir!, 'transient-notes.pdf')
    writeFileSync(w.attachedPath, 'ephemeral')
    w.attachedUri = pathToFileURL(w.attachedPath).href
    w.nodeId = await insertAttachment(w, 'Working notes PDF from the whiteboard session', {
      uri: w.attachedUri,
      mimeType: 'application/pdf',
    })
    rmSync(w.attachedPath)
  })
  reg.define(/^the entry is queried and exported$/, async (w: MediaWorld) => {
    w.results = await w.store!.query('whiteboard session notes', { topK: 5 })
    w.exported = { nodes: [exportNode(w, w.nodeId!)] }
  })
  reg.define(/^the description and the recorded URI return unchanged$/, (w: MediaWorld) => {
    expect(w.results!.map((r) => r.nodeId)).toContain(w.nodeId)
    const node = w.exported!.nodes[0]!
    expect(node['content']).toBe('Working notes PDF from the whiteboard session')
    expect(mediaOf(node).uri).toBe(w.attachedUri)
  })

  // S8: refusal without a description.
  reg.define(/^a journal accepting insertions$/, async (w: MediaWorld) => {
    await openLiveStore(w)
  })
  reg.define(/^an insert attempt carries a media reference and no descriptive text$/, async (w: MediaWorld) => {
    try {
      await w.store!.insert('   ', { mediaRef: { uri: 'file:///bare/ref.png', mimeType: 'image/png' } })
    } catch (err) {
      w.insertError = err
    }
  })
  reg.define(/^the insert is rejected$/, (w: MediaWorld) => {
    expect(w.insertError, 'bare media reference was accepted').toBeTruthy()
    expect(String(w.insertError)).toMatch(/descript/i)
    // And nothing was written: the live store holds zero rows.
    expect(countNodesIn(w.dbPath!)).toBe(0)
  })
}

