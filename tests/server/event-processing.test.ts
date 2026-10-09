import { describe, it, expect } from 'vitest'
import {
  classifyIntent,
  classifyExit,
  ErrorTracker,
  LoopDetector,
  attributeProject,
} from '../../src/server/event-processing.js'

describe('classifyIntent', () => {
  it('classifies questions by interrogative words', () => {
    expect(classifyIntent('How do I run this?')).toBe('question')
    expect(classifyIntent('what is the issue')).toBe('question')
    expect(classifyIntent('why did it fail')).toBe('question')
  })

  it('classifies questions by ? presence', () => {
    expect(classifyIntent('I want it to work, you know?')).toBe('question')
  })

  it('classifies directives by imperative verbs', () => {
    expect(classifyIntent('implement the login feature')).toBe('directive')
    expect(classifyIntent('please add tests')).toBe('directive')
  })

  it('classifies corrections by keywords', () => {
    expect(classifyIntent('actually, let us do it this way')).toBe('correction')
    expect(classifyIntent('never mind that approach')).toBe('correction')
  })

  it('classifies feedback by approval words', () => {
    expect(classifyIntent('looks good and works well')).toBe('feedback')
    expect(classifyIntent('👍')).toBe('feedback')
    expect(classifyIntent('yes')).toBe('feedback')
    expect(classifyIntent('no')).toBe('feedback')
  })

  it('defaults to info for plain statements', () => {
    expect(classifyIntent('I see that the file is missing.')).toBe('info')
  })

  it('is case-insensitive', () => {
    expect(classifyIntent('ACTUALLY we should go back')).toBe('correction')
    expect(classifyIntent('IMPLEMENT this')).toBe('directive')
  })

  it('uses only first ~200 chars for matching', () => {
    // If the question mark is past 200 chars, it shouldn't match.
    // But since the ? regex is lower.includes('?'), the string check ignores chars beyond 200.
    const longString = 'a'.repeat(201) + '?'
    expect(classifyIntent(longString)).toBe('info')
  })
})

describe('classifyExit', () => {
  it('detects error by "Error:" keyword', () => {
    expect(classifyExit('some output... Error: failed to load')).toBe('error')
  })

  it('detects error by exit code pattern', () => {
    expect(classifyExit('process exited with 1 instead of 0')).toBe('error')
    expect(classifyExit('process exit code 255')).toBe('error')
  })

  it('detects soft_fail by warning indicators', () => {
    expect(classifyExit('Warning: this is deprecated')).toBe('soft_fail')
    expect(classifyExit('SKIPPED test due to missing env')).toBe('soft_fail')
  })

  it('returns success for clean output', () => {
    expect(classifyExit('all ok done')).toBe('success')
  })

  it('error takes precedence over soft_fail', () => {
    expect(classifyExit('warning: could not find something. Error: failed.')).toBe('error')
  })
})

describe('ErrorTracker', () => {
  it('records and resolves errors by tool name', () => {
    const et = new ErrorTracker()
    const fp = et.recordError({ stagingId: 1, nodeId: 'n1', fingerprint: 'toolA', timestamp: 100 })
    expect(fp).toBe('toolA')
    expect(et.pendingCount).toBe(1)

    const resolved = et.tryResolve('toolA')
    expect(resolved?.nodeId).toBe('n1')
    expect(et.pendingCount).toBe(0)
  })

  it('returns null when no matching error exists', () => {
    const et = new ErrorTracker()
    expect(et.tryResolve('toolB')).toBeNull()
  })

  it('removes error after resolution', () => {
    const et = new ErrorTracker()
    et.recordError({ stagingId: 1, nodeId: 'n1', fingerprint: 'toolA', timestamp: 100 })
    et.tryResolve('toolA')
    expect(et.tryResolve('toolA')).toBeNull()
  })

  it('evicts oldest when exceeding maxPending', () => {
    const et = new ErrorTracker(2)
    et.recordError({ stagingId: 1, nodeId: 'n1', fingerprint: 'toolA', timestamp: 100 })
    et.recordError({ stagingId: 2, nodeId: 'n2', fingerprint: 'toolB', timestamp: 200 })
    et.recordError({ stagingId: 3, nodeId: 'n3', fingerprint: 'toolC', timestamp: 300 })
    expect(et.pendingCount).toBe(2)
    expect(et.tryResolve('toolA')).toBeNull() // evicted
    expect(et.tryResolve('toolB')?.nodeId).toBe('n2')
  })

  it('clear() removes all pending errors', () => {
    const et = new ErrorTracker()
    et.recordError({ stagingId: 1, nodeId: 'n1', fingerprint: 'toolA', timestamp: 100 })
    et.clear()
    expect(et.pendingCount).toBe(0)
  })
})

describe('LoopDetector', () => {
  it('returns null for non-repeating calls', () => {
    const ld = new LoopDetector()
    expect(ld.record('toolA', 'abc')).toBeNull()
    expect(ld.record('toolB', 'abc')).toBeNull()
    expect(ld.record('toolA', 'xyz')).toBeNull()
  })

  it('detects loops at threshold count', () => {
    const ld = new LoopDetector(20, 3)
    ld.record('toolA', 'same_content')
    ld.record('toolB', 'other')
    ld.record('toolA', 'same_content')
    const warning = ld.record('toolA', 'same_content')
    expect(warning).not.toBeNull()
    expect(warning?.toolName).toBe('toolA')
    expect(warning?.count).toBe(3)
  })

  it('uses content hash — different content = no loop', () => {
    const ld = new LoopDetector(20, 3)
    ld.record('toolA', 'content1')
    ld.record('toolA', 'content2')
    ld.record('toolA', 'content3')
    expect(ld.record('toolA', 'content4')).toBeNull()
  })

  it('trims window to windowSize', () => {
    const ld = new LoopDetector(3, 3)
    ld.record('toolA', 'c')
    ld.record('toolB', 'x')
    ld.record('toolB', 'y')
    ld.record('toolA', 'c') // first toolA is evicted, so count for toolA='c' is 1
    ld.record('toolA', 'c') // count is 2
    expect(ld.record('toolA', 'c')?.count).toBe(3)
  })

  it('clear() resets detection state', () => {
    const ld = new LoopDetector()
    ld.record('toolA', 'c')
    ld.record('toolA', 'c')
    ld.clear()
    expect(ld.record('toolA', 'c')).toBeNull() // count is 1 now
  })
})

describe('attributeProject', () => {
  it('uses store name with high confidence', () => {
    const a = attributeProject('my-proj', null, null)
    expect(a.project).toBe('my-proj')
    expect(a.confidence).toBe(1.0)
    expect(a.source).toBe('store_name')
  })

  it('ignores generic store names', () => {
    const a = attributeProject('default', null, '/path/to/cwd')
    expect(a.project).toBe('cwd')
    expect(a.source).toBe('cwd')
  })

  it('falls back to cwd last segment', () => {
    const a = attributeProject(null, null, '/a/b/my-app')
    expect(a.project).toBe('my-app')
    expect(a.confidence).toBe(0.5)
  })

  it('returns unknown with 0 confidence as fallback', () => {
    const a = attributeProject(null, null, null)
    expect(a.project).toBe('unknown')
    expect(a.confidence).toBe(0.0)
  })
})
