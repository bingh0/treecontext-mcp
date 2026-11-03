import { describe, it, expect, afterEach } from 'vitest'
import {
  storeLockRow, probeStoreLock, setStoreLockProbeForTests, parseLsofOpeners, type StoreLockProcesses,
} from '../../src/server/installer.js'

// D175: doctor names the piece that is down and the one command that
// clears it — and claims no more about the lock holder than the platform
// can say. Linux names the holder (/proc/locks); Darwin's lsof cannot see
// fcntl locks and Windows has no lock-holder API, so there the one
// command stops every process with the store open. These render each
// platform's row from a fake probe, so all three shapes run on any OS.

const LABEL = 'store proj-1234'
const PATH = '/home/dev/.treecontext/stores/proj-1234/treecontext.db'
const WIN_PATH = 'C:\\Users\\dev\\.treecontext\\stores\\proj-1234\\treecontext.db'

const twoOpeners: StoreLockProcesses = {
  holders: [],
  openers: [{ pid: 4101, command: 'node' }, { pid: 4202, command: 'treecontext' }],
  canTellHolder: false,
}
const nothing: StoreLockProcesses = { holders: [], openers: [], canTellHolder: false }

describe('doctor store-lock row (D175)', () => {
  afterEach(() => setStoreLockProbeForTests(null))

  it('Linux with a holder and a bystander: kills the holder only, the bystander is not the cause', () => {
    const row = storeLockRow(LABEL, PATH, { holders: [4101], openers: [{ pid: 4202, command: 'node' }], canTellHolder: true }, 'linux')
    expect(row).toEqual({
      check: 'Store lock', status: 'error',
      detail: `${LABEL} is locked by another process (pid 4101) — reads and captures wait on it until it lets go; also open, and not the cause: pid 4202 (a running server or reader — leave it be)`,
      fix: 'kill 4101',
    })
  })

  it('macOS with two openers: says macOS cannot tell, one kill for both, nobody called "not the cause"', () => {
    const row = storeLockRow(LABEL, PATH, twoOpeners, 'darwin')
    expect(row.detail).toBe(`${LABEL} is locked by another process — reads and captures wait on it until it lets go; macOS cannot say which of the processes holding it open owns the lock: pid 4101 (node), pid 4202 (treecontext) — the fix stops every one of them, and a running server reopens the store on the next session`)
    expect(row.fix).toBe('kill 4101 4202')
    expect(row.detail).not.toContain('not the cause')
    expect(row.detail).not.toContain('this platform')
  })

  it('Windows with two openers: one bare taskkill for both (no cmd-only or PowerShell-only note), no lsof anywhere', () => {
    const row = storeLockRow(LABEL, WIN_PATH, twoOpeners, 'win32')
    expect(row.detail).toBe(`${LABEL} is locked by another process — reads and captures wait on it until it lets go; Windows cannot say which of the processes holding it open owns the lock: pid 4101 (node), pid 4202 (treecontext) — the fix stops every one of them, and a running server reopens the store on the next session`)
    expect(row.fix).toBe('taskkill /F /PID 4101 /PID 4202')
    expect(row.detail).not.toContain('not the cause')
    expect(`${row.detail}\n${row.fix}`).not.toContain('lsof')
    expect(row.fix).not.toMatch(/[&#]/)
  })

  it('an opener without a command label is named by pid alone', () => {
    const row = storeLockRow(LABEL, PATH, { holders: [], openers: [{ pid: 7 }], canTellHolder: false }, 'darwin')
    expect(row.detail).toMatch(/owns the lock: pid 7 — the fix stops every one of them/)
    expect(row.fix).toBe('kill 7')
  })

  it('nothing found on Linux, macOS and Windows: says so, and the Windows row never mentions lsof', () => {
    const tail = ' — reads and captures wait on it until it lets go; no process was found holding it open at the moment doctor looked'
    const linux = storeLockRow(LABEL, PATH, { ...nothing, canTellHolder: true }, 'linux')
    expect(linux.detail).toBe(`${LABEL} is locked by another process — reads and captures wait on it until it lets go`)
    expect(linux.fix).toBe(`lsof "${PATH}"   # the process holding a write lock (W) is the cause; stop that one`)
    const linuxBlind = storeLockRow(LABEL, PATH, nothing, 'linux')
    expect(linuxBlind.detail).toBe(`${LABEL} is locked by another process${tail}`)
    expect(linuxBlind.fix).toBe(`Run treecontext doctor again; if the lock persists, lsof "${PATH}" lists every process with the store open`)
    const mac = storeLockRow(LABEL, PATH, nothing, 'darwin')
    expect(mac.detail).toBe(`${LABEL} is locked by another process${tail}`)
    expect(mac.fix).toBe(`Run treecontext doctor again; if the lock persists, lsof "${PATH}" lists every process with the store open`)
    const win = storeLockRow(LABEL, WIN_PATH, nothing, 'win32')
    expect(win.detail).toBe(`${LABEL} is locked by another process${tail}`)
    expect(win.fix).toBe('Run treecontext doctor again; if the lock persists, close the other Claude Code and editor windows that use this project')
    expect(`${win.detail}\n${win.fix}`).not.toContain('lsof')
  })

  it('no Windows row ever contains "not the cause" or lsof, whatever the probe says', () => {
    for (const found of [twoOpeners, nothing, { ...twoOpeners, canTellHolder: true }]) {
      const row = storeLockRow(LABEL, WIN_PATH, found, 'win32')
      expect(`${row.detail}\n${row.fix}`).not.toMatch(/lsof|not the cause/)
    }
  })

  it('the probe seam replaces the platform probe and resets on null', () => {
    setStoreLockProbeForTests(() => twoOpeners)
    expect(probeStoreLock(PATH)).toBe(twoOpeners)
    setStoreLockProbeForTests(null)
    expect(probeStoreLock('/nonexistent/treecontext.db')).not.toBe(twoOpeners)
  })
})

// lsof -F pcfl as macOS printed it in CI run 41670918705: the test
// runner's worker had the store only memory-mapped (fd `txt`), the locker
// and a reader through descriptors. The mapped-only process is no opener:
// it holds no lock, and doctor's stop-every-opener fix killed it.
describe('lsof openers count descriptors, never mappings', () => {
  const MAC = ['p3224', 'cnode', 'ftxt', 'l ', 'p23122', 'cnode', 'f11', 'l ', 'p23166', 'cnode', 'f11', 'l ', ''].join('\n')
  it('a process with the store only mapped is not an opener; the descriptor holders are', () => {
    const { openers, holders } = parseLsofOpeners(MAC, 'darwin')
    expect([...openers.keys()].sort()).toEqual([23122, 23166])
    expect(openers.get(23122)).toBe('node')
    expect(holders.size).toBe(0)
  })
  it('a mapping and a descriptor in one process: an opener, by its descriptor', () => {
    const { openers } = parseLsofOpeners(['p7', 'cserve', 'ftxt', 'f12', ''].join('\n'), 'darwin')
    expect([...openers]).toEqual([[7, 'serve']])
  })
  it('a write-lock field names a holder off Linux, only on a descriptor', () => {
    const out = ['p8', 'cnode', 'f9', 'lW', 'p9', 'cnode', 'ftxt', 'lW', ''].join('\n')
    expect([...parseLsofOpeners(out, 'darwin').holders]).toEqual([8])
    expect(parseLsofOpeners(out, 'linux').holders.size).toBe(0)
  })
})
