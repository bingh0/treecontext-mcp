import { describe, it, expect } from 'vitest'
import { CAPTURE_PLATFORMS } from '../../src/server/installer.js'
import { AGENTS } from '../../src/server/agents.js'

/**
 * `install` writes MCP configuration for every agent it detects, but hook
 * configuration only for platforms whose adapter has been exercised
 * against live payloads. A hook entry a user can see in their settings
 * reads as a promise that capture is running; making that promise on an
 * unverified adapter is what this guard prevents.
 */
describe('capture-platform guard', () => {
  it('lists only platforms with a live-payload verification pass', () => {
    expect([...CAPTURE_PLATFORMS]).toEqual(['claude'])
  })

  it('every verified slug is a real agent that defines hooks', () => {
    for (const slug of CAPTURE_PLATFORMS) {
      const agent = AGENTS.find(a => a.slug === slug)
      expect(agent, `no agent registered for verified slug "${slug}"`).toBeDefined()
      expect(agent!.hooks, `verified agent "${slug}" defines no hooks`).toBeDefined()
    }
  })

  it('leaves agents with unverified adapters out of the set', () => {
    // These have adapters in-tree; none has earned its pass yet. When one
    // does, this test is the deliberate place that ruling gets recorded.
    for (const slug of ['vscode', 'cursor', 'codex', 'gemini', 'opencode']) {
      expect(CAPTURE_PLATFORMS.has(slug)).toBe(false)
    }
  })

  it('does not gate MCP registration — the tools work anywhere', () => {
    const withMcpButNoCapture = AGENTS.filter(a => !CAPTURE_PLATFORMS.has(a.slug))
    expect(withMcpButNoCapture.length).toBeGreaterThan(0)
    for (const agent of withMcpButNoCapture) {
      expect(Object.keys(agent.configPath).length).toBeGreaterThan(0)
    }
  })
})
