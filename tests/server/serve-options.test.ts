/**
 * The serve-options ratchet (corpus audit D1's class fix).
 *
 * Five parsed options were once dropped between parseArgs and
 * startServer — the unit tests proved the args side, the server tests
 * proved the server side, and nothing spanned the call, so the HTTP
 * transport shipped dead and shielding shipped inert with a green
 * suite. serveOptionsFrom() is now the one seam, and this test walks
 * a fully-flagged parse through it: every serve-relevant CliArgs field
 * must land, with its parsed value, in the options object the server
 * actually receives.
 *
 * Adding a serve flag? It must appear in serveOptionsFrom AND in the
 * expectation below — the pairing is the ratchet.
 */
import { describe, it, expect } from 'vitest'
import { parseArgs, serveOptionsFrom } from '../../src/server/cli.js'

describe('serveOptionsFrom spans the parse→server seam', () => {
  it('a fully-flagged parse loses nothing on the way to startServer', () => {
    const args = parseArgs([
      'node', 'cli', 'serve',
      '--transport', 'stdio',
      '--read-only',
      '--no-sidecar',
      '--namespace', 'agent-x',
      '--instructions', 'none',
      '--shield-threshold', '4096',
      '--shield-dir', '/tmp/shield-x',
      '--secure-delete',
      '--lexical',
    ])
    expect(serveOptionsFrom(args)).toEqual({
      transport: 'stdio',
      readOnly: true,
      sidecar: false,
      namespace: 'agent-x',
      instructions: 'none',
      shieldThreshold: 4096,
      shieldDir: '/tmp/shield-x',
      secureDelete: true,
      backend: 'lexical',
    })
  })

  it('the policy flag flows through', () => {
    const args = parseArgs(['node', 'cli', 'serve', '--policy', 'contributor'])
    expect(serveOptionsFrom(args).policy).toBe('contributor')
  })

  it('defaults are the documented defaults', () => {
    const opts = serveOptionsFrom(parseArgs(['node', 'cli', 'serve']))
    expect(opts).toEqual({
      transport: 'stdio',
      readOnly: false,
      sidecar: true,
      namespace: 'project',
      instructions: 'brief',
      shieldThreshold: 0,
      secureDelete: false,
    })
  })
})
