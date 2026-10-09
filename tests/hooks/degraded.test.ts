import { describe, it, expect, vi, afterEach } from 'vitest'
import * as shared from '../../src/hooks/shared.js'
import { main as preCompactMain } from '../../src/hooks/pre-compact.js'
import { main as sessionStartMain } from '../../src/hooks/session-start.js'

describe('Degraded mode (Layer 3 graceful failures)', () => {
  let mockExit: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setupMocks() {
    // Silence the hook's own output; nothing asserts on it here.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
  }

  describe('pre-compact', () => {
    it('exits 0 when DB path is unreachable', () => {
      setupMocks()
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-1', cwd: '/tmp',
      })
      vi.spyOn(shared, 'resolveDbPath').mockReturnValue('/nonexistent/db/treecontext.db')

      expect(() => preCompactMain()).not.toThrow()
      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('exits 0 when stdin is malformed JSON', () => {
      setupMocks()
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({})

      expect(() => preCompactMain()).not.toThrow()
      expect(mockExit).toHaveBeenCalledWith(0)
    })
  })

  describe('session-start', () => {
    it('exits 0 when DB path is unreachable', () => {
      setupMocks()
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-1', cwd: '/tmp', source: 'clear',
      })
      vi.spyOn(shared, 'resolveDbPath').mockReturnValue('/nonexistent/db/treecontext.db')

      expect(() => sessionStartMain()).not.toThrow()
      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('exits 0 when stdin is malformed JSON', () => {
      setupMocks()
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({})

      expect(() => sessionStartMain()).not.toThrow()
      expect(mockExit).toHaveBeenCalledWith(0)
    })
  })
})
