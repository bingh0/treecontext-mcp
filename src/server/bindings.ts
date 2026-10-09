/**
 * Project-fingerprint → store-name bindings.
 *
 * Before: store selection used a `.treecontext-store` file inside the
 * repository itself. A malicious checkout could ship that file and
 * redirect the local treecontext daemon to attach to somebody else's
 * store (security finding S3).
 *
 * Now: bindings live in `~/.treecontext/bindings.json`, keyed by a
 * fingerprint derived from the project's git remote URL (preferred) or
 * the realpath of the project root (fallback). The repo contents are
 * no longer part of the store-selection trust boundary.
 *
 * Legacy sticky files are migrated one-time — see `maybeMigrateSticky`.
 * After migration they are not written again.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dbg } from '../debug.js'

import { SAFE_STORE_RE } from '../tools/store-name.js'

const LEGACY_STICKY = '.treecontext-store'

function findProjectRoot(startDir: string): string {
  let current = startDir
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return startDir
}

function bindingsFilePath(): string {
  const override = process.env.TREECONTEXT_BINDINGS_FILE
  if (override) return override
  return join(homedir(), '.treecontext', 'bindings.json')
}

export interface Bindings {
  /**
   * `version` lets future migrations spot the shape. We ship v1; bump on
   * incompatible changes. Missing = legacy pre-file install.
   */
  version: 1
  projects: Record<string, { store: string; updatedAt: number; source: BindingSource }>
}

/**
 * `carried-forward` is succession's own audit trail (§3, amended
 * 2026-08-20): a binding this machine wrote without the user asking,
 * because the project's identity source changed under it. Kept distinct
 * from 'git'/'path' so `stores list` and the detector can tell an
 * adopted binding from a first one (O3).
 */
export type BindingSource = 'git' | 'path' | 'migrated-sticky' | 'explicit' | 'carried-forward'

function emptyBindings(): Bindings {
  return { version: 1, projects: {} }
}

/**
 * How the bindings file read went. Writers must know: an empty result
 * from a corrupt or symlinked file used to be indistinguishable from an
 * empty file, so the next write-through miss rewrote the whole file and
 * every other project's binding was lost (ruling 2026-08-15:
 * preserve, never clobber).
 *
 * 'corrupt' means the BYTES are bad (unparseable, wrong shape) — that
 * file is side-file-then-replace material. 'unreadable' means the READ
 * failed (EACCES, EMFILE, EIO): the file may be perfectly healthy, so
 * nothing may be side-filed or rewritten on its account (F review
 * 2026-08-15 — a transient fd-exhaustion during a capture burst must
 * not shrink the machine-wide bindings map to one entry).
 */
type BindingsHealth = 'ok' | 'absent' | 'symlink' | 'corrupt' | 'unreadable'

function readBindingsFile(): { bindings: Bindings; health: BindingsHealth } {
  const path = bindingsFilePath()
  if (!existsSync(path)) return { bindings: emptyBindings(), health: 'absent' }
  let raw: string
  try {
    // Refuse to read through a symlink — same threat model as S3.
    const st = lstatSync(path)
    if (st.isSymbolicLink()) {
      dbg('bindings', 'bindings file is a symlink; refusing to read', { path })
      return { bindings: emptyBindings(), health: 'symlink' }
    }
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    dbg('bindings', 'bindings file unreadable; resolution continues unpersisted', { error: String(err) })
    return { bindings: emptyBindings(), health: 'unreadable' }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Bindings>
    if (parsed.version === 1 && parsed.projects && typeof parsed.projects === 'object') {
      return { bindings: { version: 1, projects: validProjects(parsed.projects) }, health: 'ok' }
    }
    return { bindings: emptyBindings(), health: 'corrupt' }
  } catch {
    return { bindings: emptyBindings(), health: 'corrupt' }
  }
}

/**
 * Loaded values get the same safe-name gate as sticky and derived names:
 * the file lives outside the repo trust boundary but is still just JSON
 * on disk. An entry holding an out-of-class store name is dropped — its
 * project re-derives on its next resolution — and every other entry
 * survives untouched.
 */
function validProjects(projects: Bindings['projects']): Bindings['projects'] {
  const valid: Bindings['projects'] = {}
  for (const [fp, entry] of Object.entries(projects)) {
    if (entry && typeof entry === 'object' && typeof entry.store === 'string'
      && SAFE_STORE_RE.test(entry.store)) {
      valid[fp] = entry
    } else {
      dbg('bindings', 'dropping binding with unsafe store value', { fingerprint: fp })
    }
  }
  return valid
}

/**
 * The write lock (§3.6, added 2026-08-24). The atomic tmp+rename below
 * protects the BYTES of one write; nothing protected the read-modify-
 * write interval — two hooks minting first bindings for two different
 * projects both read the same map, and the second rename silently
 * dropped the first's entry. Every writer now holds `bindings.json.lock`
 * across a re-read and writes only its own delta over what is on disk
 * at that moment.
 *
 * Bounded, never load-bearing: a waiter gives up after ~2s and skips
 * the write — unpersisted degradation, the same posture as the symlink
 * and unreadable refusals, and the next resolution retries. A lock file
 * older than ~5s is stale (a healthy holder keeps it for milliseconds)
 * and is broken; two waiters racing the break is the pre-lock status
 * quo for one interval, not a new hazard.
 */
const BINDINGS_LOCK_WAIT_MS = 2_000
const BINDINGS_LOCK_STALE_MS = 5_000

/** Synchronous sleep: the resolver is synchronous end-to-end (hooks
 *  call it inside their own budget), so the wait must not yield. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function acquireBindingsLock(): (() => void) | null {
  const lockPath = `${bindingsFilePath()}.lock`
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + BINDINGS_LOCK_WAIT_MS
  while (true) {
    try {
      const fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
      try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
      return () => { try { unlinkSync(lockPath) } catch { /* already reclaimed as stale */ } }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        dbg('bindings', 'bindings lock unacquirable; skipping write', { error: String(err) })
        return null
      }
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > BINDINGS_LOCK_STALE_MS) {
        dbg('bindings', 'breaking stale bindings lock', { lockPath })
        try { unlinkSync(lockPath) } catch { /* another waiter won the break */ }
        continue
      }
    } catch { /* released between attempts — fall through to the bounded
                 retry rather than looping past the deadline forever */ }
    if (Date.now() >= deadline) {
      dbg('bindings', 'bindings lock still held; deferring write to the next resolution', { lockPath })
      return null
    }
    sleepSync(25)
  }
}

/**
 * Persist policy (ruling 2026-08-15, lock added 2026-08-24): a symlinked
 * bindings path is never written through or replaced — resolution
 * continues unpersisted. A corrupt or unknown-version file is side-filed
 * to `bindings.json.corrupt` before the rewrite, so a bad byte costs one
 * recoverable rename instead of every other project's binding. If the
 * side-file rename fails, the write is skipped rather than clobbering
 * evidence.
 *
 * `ownFingerprints` names the entries THIS caller minted. Under the
 * lock the file is re-read and only that delta is written over what is
 * on disk now — a concurrent writer's binding survives whether it
 * landed before our read or during our resolution. The re-read also
 * subsumes the corrupt-recheck rule (F review 2026-08-15): a verdict
 * captured at read time never drives a rename performed later, because
 * verdict and rename now happen under the same exclusion.
 */
function persistBindings(b: Bindings, health: BindingsHealth, ownFingerprints?: string[]): boolean {
  const path = bindingsFilePath()
  if (health === 'unreadable') {
    // The file may be healthy — a read failure earns no rewrite.
    dbg('bindings', 'bindings file was unreadable; skipping write', { path })
    return false
  }
  try {
    if (health === 'symlink' || lstatSync(path).isSymbolicLink()) {
      dbg('bindings', 'bindings file is a symlink; refusing to write', { path })
      return false
    }
  } catch { /* absent: nothing to refuse or side-file */ }
  const release = acquireBindingsLock()
  if (release === null) return false
  try {
    const fresh = readBindingsFile()
    if (fresh.health === 'symlink' || fresh.health === 'unreadable') return false
    if (fresh.health === 'corrupt') {
      try {
        // Clear a stale side-file first: Windows rename refuses to
        // replace an existing destination, and a permanently-failing
        // side-file would block every future persist.
        try { unlinkSync(`${path}.corrupt`) } catch { /* not present */ }
        renameSync(path, `${path}.corrupt`)
        dbg('bindings', 'side-filed corrupt bindings file', { path: `${path}.corrupt` })
      } catch (err) {
        dbg('bindings', 'could not side-file corrupt bindings; skipping write', { error: String(err) })
        return false
      }
    }
    let delta: Bindings['projects']
    if (ownFingerprints) {
      delta = {}
      for (const fp of ownFingerprints) {
        const entry = b.projects[fp]
        if (entry) delta[fp] = entry
      }
    } else {
      delta = b.projects
    }
    const base = fresh.health === 'ok' ? fresh.bindings.projects : {}
    saveBindings({ version: 1, projects: { ...base, ...delta } })
    return true
  } finally {
    release()
  }
}

function saveBindings(b: Bindings): void {
  writeBindingsAtomic(b)
}

/** The atomic tmp + rename with O_NOFOLLOW on the tmp, over ANY
 *  serializable value. `repointBindings` uses it to persist the RAW file
 *  object it rewrote — bystander entries and unknown fields included (B3)
 *  — through exactly the write discipline every other writer uses. */
function writeBindingsAtomic(obj: unknown): void {
  const path = bindingsFilePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // Atomic write: tmp + rename, with O_NOFOLLOW on the tmp to block
  // symlink races inside ~/.treecontext.
  const tmp = `${path}.tmp.${process.pid}`
  try { unlinkSync(tmp) } catch { /* not present */ }
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  const fd = openSync(tmp, flags, 0o600)
  try {
    writeSync(fd, JSON.stringify(obj, null, 2) + '\n')
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/**
 * Point every binding that names `from` at `to` (docs/project-identity.md
 * §11c, `stores merge --repoint`): the second half of collapsing a split
 * pair, after the journals have already been merged.
 *
 * Deliberately narrow. This is file-level IO — read, rewrite the `store`
 * value, persist — through the SAME preserve-never-clobber save path
 * every other writer uses, with the same health handling: an unreadable
 * or symlinked bindings file is not written, a corrupt one is side-filed
 * first, and a concurrent repair is layered over rather than clobbered.
 * It touches NOTHING in resolution: no fingerprint is computed, no
 * succession is probed, and each entry's `source` and `updatedAt` are
 * carried through untouched — the binding is the same binding, pointed
 * at the surviving store.
 *
 * Returns how many entries named `from` and whether the write landed;
 * `persisted` is false exactly when `persistBindings` refused, so the
 * caller can say so instead of claiming a repoint that never reached
 * disk.
 */
export function repointBindings(
  from: string, to: string,
): { changed: number; persisted: boolean; health: BindingsHealth } {
  // The destination has to survive `validProjects` on the next read, or
  // the repoint would silently drop the very bindings it moved.
  if (!SAFE_STORE_RE.test(to)) throw new Error(`Refusing to repoint bindings at unsafe store name '${to}'`)
  // The same lock every writer holds (§3.6): the read below and the
  // write at the end are one read-modify-write, and a resolver landing
  // a first binding between them must survive it — and vice versa.
  const release = acquireBindingsLock()
  if (release === null) {
    return { changed: 0, persisted: false, health: readBindingsRaw().health }
  }
  try {
    return repointBindingsLocked(from, to)
  } finally {
    release()
  }
}

function repointBindingsLocked(
  from: string, to: string,
): { changed: number; persisted: boolean; health: BindingsHealth } {
  // B3: read the RAW bytes, NOT readBindingsFile — that runs every entry
  // through validProjects and DROPS any store name with a space, a '+', or
  // a non-ASCII byte, then persists the filtered map, permanently deleting
  // bystander entries the repoint never touched. Here only the entries
  // naming `from` are rewritten; every other entry (rejectable ones
  // included) and every unknown field is carried through byte-for-byte.
  const { raw, health } = readBindingsRaw()
  // B4: a corrupt / unreadable / symlinked file reads as no entries. That
  // is NOT "nothing matched" — the repoint could not even see the
  // bindings, and reporting success would tell the operator the split is
  // collapsed when it may be wide open. Distinguish it with persisted:false
  // and the health, and never touch the file.
  if (health !== 'ok' && health !== 'absent') {
    return { changed: 0, persisted: false, health }
  }
  if (health === 'absent' || raw === null) {
    // No bindings file at all: there is genuinely nothing to repoint.
    return { changed: 0, persisted: true, health }
  }
  const projects = raw['projects'] as Record<string, unknown>
  let changed = 0
  for (const entry of Object.values(projects)) {
    if (entry && typeof entry === 'object' && (entry as { store?: unknown }).store === from) {
      (entry as { store: string }).store = to
      changed++
    }
  }
  if (changed === 0) return { changed: 0, persisted: true, health }
  // Persist through the same atomic path, with the same symlink refusal
  // persistBindings applies — but WITHOUT the validProjects drop filter.
  const path = bindingsFilePath()
  try {
    if (lstatSync(path).isSymbolicLink()) {
      dbg('bindings', 'bindings file is a symlink; refusing to repoint', { path })
      return { changed, persisted: false, health: 'symlink' }
    }
  } catch { /* raced away: the write below fails closed on its own */ }
  try {
    writeBindingsAtomic(raw)
    return { changed, persisted: true, health }
  } catch (err) {
    dbg('bindings', 'could not persist repointed bindings', { error: String(err) })
    return { changed, persisted: false, health }
  }
}

/**
 * The bindings file as its raw parsed object — no validProjects filter, no
 * safe-name drop — with the same health classification the filtered reader
 * uses. `repointBindings` needs this so it can preserve bystander entries
 * (B3) and tell a failed read from an empty one (B4). The returned object
 * is the live parse; the caller rewrites it in place and writes it back.
 */
function readBindingsRaw(): { raw: Record<string, unknown> | null; health: BindingsHealth } {
  const path = bindingsFilePath()
  if (!existsSync(path)) return { raw: null, health: 'absent' }
  let bytes: string
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) {
      dbg('bindings', 'bindings file is a symlink; refusing to read raw', { path })
      return { raw: null, health: 'symlink' }
    }
    bytes = readFileSync(path, 'utf8')
  } catch (err) {
    dbg('bindings', 'bindings file unreadable for raw read', { error: String(err) })
    return { raw: null, health: 'unreadable' }
  }
  try {
    const parsed = JSON.parse(bytes) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed['version'] === 1 && parsed['projects'] && typeof parsed['projects'] === 'object') {
      // The WHOLE parsed object rides back — version, projects, and any
      // unknown top-level field a future writer added (B3).
      return { raw: parsed, health: 'ok' }
    }
    return { raw: null, health: 'corrupt' }
  } catch {
    return { raw: null, health: 'corrupt' }
  }
}

/** SHA-256(hex, 16-char prefix) of the canonical project identity. */
function fingerprint(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16)
}

/**
 * Every OTHER spelling of the same root (§3.5, added 2026-08-24): the
 * rungs of `realpathOr`'s ladder — native realpath, JS realpath, the
 * raw path as received — minus the rung the current identity hashed.
 * A binding minted while the ladder was degraded (native realpath
 * failing on a network share; an 8.3 short-form cwd; the pre-rc.2
 * JS-only canonicalization) lives under one of these, and probing
 * them is what lets the journal survive the degradation ending.
 */
function pathSpellingVariants(root: string): string[] {
  const variants = new Set<string>()
  try { variants.add(realpathSync.native(root)) } catch { /* unavailable for this path */ }
  try { variants.add(realpathSync(root)) } catch { /* unavailable for this path */ }
  variants.add(root)
  variants.delete(realpathOr(root))
  return [...variants]
}

/**
 * The environment identity reads run under. EVERY GIT_* variable is
 * scrubbed — the earlier three-var scrub missed the ones that actually
 * redirect git (GIT_CONFIG_COUNT/KEY_n/VALUE_n inject config pairs,
 * GIT_CONFIG_GLOBAL/SYSTEM swap config files; Phase-3 review S2, and
 * repo-controlled env blocks are a real carrier here). The wholesale
 * GIT_* deny-list is what closes S2: every injection vector S2 targets is
 * an environment variable, and all of them are removed here.
 *
 * Global and system config are DELIBERATELY NOT suppressed (M7). Pinning
 * GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1 would break
 * `safe.directory`, which lives only in global/system config — so a
 * root-owned, bind-mounted, or NFS checkout would fail `rev-parse` with
 * "dubious ownership", identity would silently degrade git→path, and a
 * fresh empty store would be minted: the exact split this program exists
 * to kill. The config files are not an injection carrier the env scrub
 * leaves open, so suppressing them bought nothing and cost the
 * safe.directory escape hatch.
 */
export function identityEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v
  }
  return env
}

function gitRemoteUrl(cwd: string): string | null {
  try {
    const out = execSync('git config --get remote.origin.url', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: identityEnv(),
    }).trim()
    return out || null
  } catch { return null }
}

/**
 * All three roots from ONE `rev-parse` (§3.4, amended 2026-08-20). The
 * worktree fix must not add a subprocess: `resolveDbPath` runs per hook
 * fire in a fresh process inside the 8s budget (finding A1), and
 * `rev-parse` answers every question from the same process.
 *
 * `--git-dir` and `--git-common-dir` are printed RELATIVE to git's
 * PHYSICAL cwd from a primary checkout ('.git' at the top level,
 * '../.git' one directory down) and absolute from a linked worktree —
 * so they are meaningful only once resolved, and only against
 * `realpath(cwd)`: the caller's cwd is lexical (hook payloads carry
 * whatever the host sent), and resolving a relative offset against a
 * SYMLINKED cwd of different depth lands in an arbitrary ancestor —
 * two unrelated repos then collapse onto one identity (Phase-1 review
 * 2026-08-20, F1 — reproduced, data-corrupting).
 */
export function gitRoots(cwd: string): {
  toplevel: string
  gitDir: string | null
  commonDir: string | null
  /** Where `<gitDir>/gitdir` says the registered worktree lives —
   *  git's own back-pointer, read only when gitDir wears the
   *  worktrees/ shape. Null when absent or unreadable: fail closed. */
  backPointerRoot: string | null
} | null {
  try {
    const out = execSync('git rev-parse --show-toplevel --git-dir --git-common-dir', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: identityEnv(),
    })
    const lines = out.split('\n').map((l) => l.trim())
    const toplevel = lines[0]
    if (!toplevel) return null
    const physicalCwd = realpathOr(cwd)
    // Distrust a toplevel that does not CONTAIN the cwd it came from
    // (Phase-3 review S1, reproduced): a repo-local `core.worktree` in
    // a hostile tarball's own .git/config makes rev-parse print any
    // path the attacker names — before any worktree guard can fire.
    // Whatever git claims, this process is standing in `cwd`; a
    // toplevel that is not an ancestor of it is a forgery or a
    // misconfiguration, and both fall back to findProjectRoot(cwd) —
    // the hostile directory itself, which is the correct answer.
    const rel = relative(realpathOr(toplevel), physicalCwd)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    const at = (raw: string | undefined): string | null => (raw ? resolvePath(physicalCwd, raw) : null)
    const gitDir = at(lines[1])
    const commonDir = at(lines[2])
    let backPointerRoot: string | null = null
    if (gitDir && basename(dirname(gitDir)) === 'worktrees') {
      try {
        const registered = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()
        // Resolved against gitDir: worktree.useRelativePaths registers
        // a relative path; absolute registrations pass through resolve.
        if (registered) backPointerRoot = realpathOr(dirname(resolvePath(gitDir, registered)))
      } catch (err) {
        // ENOENT is "no registration" — no redirect, roots still usable.
        // Any OTHER errno (EACCES, EMFILE, EIO) is a read that may have
        // failed transiently: treat the whole probe as failed rather
        // than mint a permanent second binding off a fd-exhaustion blip
        // (Phase-3 review F4 — the same corrupt-vs-unreadable doctrine
        // the bindings reader lives by).
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          dbg('bindings', 'worktree back-pointer unreadable; identity probe abandoned', { error: String(err) })
          return null
        }
      }
    }
    return { toplevel, gitDir, commonDir, backPointerRoot }
  } catch { return null }
}

/** Path comparison for the worktree test only: git prints POSIX
 *  separators even on Windows, while `resolve` yields native ones, so a
 *  raw `===` would read every Windows checkout as a linked worktree and
 *  re-key its binding. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+/g, '/').replace(/(.)\/+$/, '$1')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/**
 * The PRIMARY repository root of a checkout (§3.4, amended 2026-08-20).
 * Pure — every shape is pinned without git fixtures.
 *
 * Redirect ONLY on the genuine linked-worktree signature, which needs
 * BOTH dirs (Phase-1 review 2026-08-20, F2/F4 — the bare
 * common-dir-parent inference reopened S3): a real linked worktree has
 * `gitDir = <common>/worktrees/<name>` under `commonDir =
 * <primary>/.git`. A hand-written `.git` FILE saying `gitdir:
 * /victim/.git` — one attacker-authored line in an unpacked tarball —
 * yields gitDir === commonDir and fails the worktrees test, so a
 * hostile checkout keeps its own toplevel instead of adopting a
 * victim's journal (the exact redirect the S3 bindings move exists to
 * prevent). `--separate-git-dir` fails it the same way. The
 * `basename(commonDir) === '.git'` guard then keeps SUBMODULE
 * worktrees (common dir `<super>/.git/modules/<name>`) and bare-repo
 * worktrees (common dir `proj.git`) on their own toplevel.
 */
export function primaryRepoRoot(
  toplevel: string,
  gitDirResolved: string | null,
  commonDirResolved: string | null,
  /** The worktree top that `<gitDir>/gitdir` — git's own registration
   *  back-pointer — says this gitDir belongs to. REQUIRED to match the
   *  toplevel (Phase-2 review S1): a `.git` file chained to a REAL
   *  worktree's gitdir (`gitdir: /victim/.git/worktrees/name`) wears
   *  the full worktrees/ signature, but the back-pointer names the
   *  victim's genuine worktree, not the impostor directory. Null —
   *  absent, unreadable — never redirects: fail closed. */
  backPointerRoot: string | null,
): string {
  if (!commonDirResolved || !gitDirResolved) return toplevel
  if (basename(commonDirResolved) !== '.git') return toplevel
  if (basename(dirname(gitDirResolved)) !== 'worktrees') return toplevel
  if (!samePath(dirname(dirname(gitDirResolved)), commonDirResolved)) return toplevel
  if (!backPointerRoot || !samePath(backPointerRoot, toplevel)) return toplevel
  const parent = dirname(commonDirResolved)
  return samePath(parent, toplevel) ? toplevel : parent
}

/**
 * The git facts identity is derived from, fetched once. Succession
 * (§3) reads only these and the filesystem — no probe may fetch more
 * (R3, and S3's boundary in §3.3).
 */
interface GitFacts {
  url: string | null
  /** primary root per §3.4; null outside a repository */
  primaryRoot: string | null
}

function gitFacts(cwd: string): GitFacts {
  const url = gitRemoteUrl(cwd)
  const roots = gitRoots(cwd)
  return {
    url,
    primaryRoot: roots
      ? primaryRepoRoot(roots.toplevel, roots.gitDir, roots.commonDir, roots.backPointerRoot)
      : null,
  }
}

function realpathOr(p: string): string {
  // `.native` because git canonicalizes: on Windows, `--show-toplevel`
  // prints the expanded long path while the JS realpath preserves 8.3
  // short names (`RUNNER~1`), so a cwd that ARRIVES in short form —
  // %TEMP% is one on every GitHub runner — never contains-compares or
  // samePath-compares equal to any git-derived path. Every identity
  // then falls through the §3.4 containment guard to the lexical
  // fallback: stickies unread, worktrees minting their own stores
  // (v0.1.0-rc.1's Windows lane, all five failures). POSIX output is
  // identical between the two implementations, so no existing binding
  // re-keys.
  try { return realpathSync.native(p) } catch {
    try { return realpathSync(p) } catch { return p }
  }
}

function identityFrom(cwd: string, facts: GitFacts): { identity: string; source: 'git' | 'path'; root: string } {
  const root = facts.primaryRoot ?? findProjectRoot(cwd)
  if (facts.url) return { identity: `git:${facts.url}`, source: 'git', root }
  return { identity: `path:${realpathOr(root)}`, source: 'path', root }
}

/**
 * The project root a store binding resolves `cwd` to: the primary
 * repository root (worktrees fold to it), else the nearest directory
 * holding `.git`, else `cwd` itself. The config loader discovers the
 * project's `treecontext.toml` here, so a server started from a
 * subdirectory reads the same file as one started from the root — the
 * file and the store follow one project directory (D255).
 */
export function projectRootFor(cwd: string): string {
  return identityFrom(cwd, gitFacts(cwd)).root
}

/**
 * Canonical identity for a project directory. Prefers the git remote URL
 * (stable across renames, clones, and machines). Falls back to the
 * realpath of the repo/working root so a directory move is detected as
 * a new project rather than silently attaching to a stale store.
 */
export function projectIdentity(cwd: string): { identity: string; source: 'git' | 'path' } {
  const { identity, source } = identityFrom(cwd, gitFacts(cwd))
  return { identity, source }
}

/**
 * One-time migration, read side: if a legacy `.treecontext-store` exists
 * at the repo root, contains a safe name, and is not a symlink, return
 * its value for adoption into bindings.json. Deleting the sticky is the
 * CALLER's job, and only after the binding actually persisted — when the
 * bindings file cannot be written (symlink refusal), the sticky must
 * survive as the source of the name, or the next run derives a different
 * store and the data splits.
 */
function readLegacySticky(projectRoot: string): string | null {
  const target = join(projectRoot, LEGACY_STICKY)
  if (!existsSync(target)) return null
  try {
    const st = lstatSync(target)
    if (st.isSymbolicLink()) return null
    const name = readFileSync(target, 'utf8').trim()
    if (!name || !SAFE_STORE_RE.test(name)) return null
    return name
  } catch {
    return null
  }
}

// ── Succession (§3, amended 2026-08-20) ──────────────────────────────

/**
 * Every RAW spelling of one remote URL (§3.2, amended 2026-08-20).
 *
 * The probe must emit raw spellings, not canonical ones: a predecessor's
 * fingerprint hashes the URL string it was bound under, so probing two
 * canonical forms would miss the commonest clone URL of all
 * (`https://host/org/repo.git`). The stored identity stays the raw URL —
 * normalizing THAT would re-key every existing git binding.
 *
 * The current spelling is excluded: its fingerprint is the miss that
 * started the probe. Renames and org moves are NOT covered — they change
 * the host/org/repo triple itself, so no spelling of it can find the old
 * binding (§3.2's disclosed residual, same class as A11).
 */
export function gitUrlVariants(rawUrl: string): string[] {
  const parsed = parseRemoteUrl(rawUrl)
  if (!parsed) return []
  const { host, path } = parsed
  const https = `https://${host}/${path}`
  const scp = `git@${host}:${path}`
  const ssh = `ssh://git@${host}/${path}`
  const forms = [
    https, `${https}.git`, `${https}/`, `${https}.git/`,
    scp, `${scp}.git`,
    ssh, `${ssh}.git`,
  ]
  return [...new Set(forms)].filter((f) => f !== rawUrl)
}

/** host/org-path/repo triple, or null when the remote is not a
 *  host-addressed URL (a local path, a `file://` remote, garbage). */
function parseRemoteUrl(rawUrl: string): { host: string; path: string } | null {
  const url = rawUrl.trim()
  if (!url) return null
  let host: string
  let path: string
  const schemed = url.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)\/(.*)$/)
  if (schemed) {
    host = schemed[1] ?? ''
    path = schemed[2] ?? ''
  } else {
    // scp-style `[user@]host:path`. A Windows drive letter wears the same
    // shape (`C:\src\repo`) and is not a remote host.
    if (/^[A-Za-z]:[\\/]/.test(url)) return null
    const scp = url.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/)
    if (!scp) return null
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  }
  host = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '')
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  if (!host || !path) return null
  // A multi-segment path (gitlab subgroups) is preserved whole.
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null
  return { host, path }
}

/**
 * Bound predecessors of a successor identity, in the two classes §3
 * gives different powers.
 */
export interface SuccessionCandidates {
  /** Bound predecessors naming the SAME directory the successor identity
   *  names — root-identical, so no sibling can be hiding behind them. */
  adoptable: { identitySource: 'git' | 'path'; store: string }[]
  /** Bound predecessors in strict subdirectories: disclosed, never
   *  adopted (§3.1 — a subdirectory predecessor can always have an
   *  unseen twin, and bindings hold no identity to rule one out). */
  disclosed: { dir: string; store: string }[]
}

export type SuccessionDecision =
  | { action: 'adopt'; store: string; fromIdentitySource: 'git' | 'path'; disclosed: { dir: string; store: string }[] }
  | { action: 'derive'; conflict: string[] | null; disclosed: { dir: string; store: string }[] }

/**
 * §3's resolution rule, pure so it is pinned without git fixtures:
 * zero bound adoptable predecessors derive fresh, one store among them
 * is adopted, and two or more fail CLOSED (R4) — a project's journal is
 * never guessed at. Disclosures ride along in every branch: a
 * predecessor journal exists whatever this resolution did with it.
 */
export function decideSuccession(candidates: SuccessionCandidates): SuccessionDecision {
  const { adoptable, disclosed } = candidates
  const stores = [...new Set(adoptable.map((a) => a.store))].sort()
  const only = stores[0]
  if (stores.length === 1 && only) {
    const winner = adoptable.find((a) => a.store === only)!
    return { action: 'adopt', store: only, fromIdentitySource: winner.identitySource, disclosed }
  }
  return { action: 'derive', conflict: stores.length > 1 ? stores : null, disclosed }
}

/**
 * The directories whose path identities are strict-subdirectory
 * predecessors: `cwd` itself and every ancestor below the primary root
 * (trigger 2 — `git init` above a directory that bound before it).
 * Empty when cwd IS the root, and empty when cwd is not under the root
 * at all rather than walking to the filesystem root.
 */
function subdirectoryPredecessors(cwd: string, root: string): string[] {
  const stop = realpathOr(root)
  let cur = realpathOr(cwd)
  const dirs: string[] = []
  while (!samePath(cur, stop)) {
    const parent = dirname(cur)
    if (parent === cur) return []
    dirs.push(cur)
    cur = parent
  }
  return dirs
}

/**
 * Collect bound predecessors. Reads ONLY the already-fetched remote URL
 * and the filesystem (realpath) — both already inputs to
 * `projectIdentity`, so the store-selection trust boundary is unchanged
 * (R3, §3.3). No subprocess is spawned here: url and root arrive from
 * the two git calls resolution already pays for, and the probe's whole
 * cost is a realpath and a sha256 per candidate (bounding A1).
 */
function probeSuccession(
  cwd: string,
  source: 'git' | 'path',
  facts: GitFacts,
  root: string,
  bindings: Bindings,
): SuccessionCandidates {
  const boundStore = (identity: string): string | null =>
    bindings.projects[fingerprint(identity)]?.store ?? null

  const adoptable: SuccessionCandidates['adoptable'] = []
  // Path-source adoptable predecessors are the OTHER SPELLINGS of the
  // same root (§3.5, added 2026-08-24): every rung of realpathOr's
  // ladder names the one directory the resolver is standing in, so each
  // is root-identical by construction — the directory-vs-subdirectory
  // hazard §3.1 guards against cannot arise. Trigger 2 (a subdirectory
  // predecessor) stays disclosure-only.
  if (source === 'path') {
    for (const spelling of pathSpellingVariants(root)) {
      const bySpelling = boundStore(`path:${spelling}`)
      if (bySpelling) adoptable.push({ identitySource: 'path', store: bySpelling })
    }
  }
  if (source === 'git' && facts.url) {
    // The path-fallback predecessor is probed under every spelling too
    // (§3.5): a project bound while realpath was degraded, then given a
    // remote, is the same directory under a different rung.
    for (const p of [realpathOr(root), ...pathSpellingVariants(root)]) {
      const byPath = boundStore(`path:${p}`)
      if (byPath) adoptable.push({ identitySource: 'path', store: byPath })
    }
    for (const variant of gitUrlVariants(facts.url)) {
      const byUrl = boundStore(`git:${variant}`)
      if (byUrl) adoptable.push({ identitySource: 'git', store: byUrl })
    }
  }

  const disclosed: SuccessionCandidates['disclosed'] = []
  for (const dir of subdirectoryPredecessors(cwd, root)) {
    const store = boundStore(`path:${dir}`)
    if (store) disclosed.push({ dir, store })
  }
  return { adoptable, disclosed }
}

/**
 * What succession did, for the caller to say out loud. Silence is the
 * whole failure mode this program exists to kill (R2).
 */
export type SuccessionEvent =
  | { kind: 'adopted'; store: string; fromIdentitySource: 'git' | 'path' }
  | { kind: 'predecessorDisclosed'; dir: string; store: string }
  | { kind: 'conflict'; stores: string[] }

export interface ResolveOptions {
  /**
   * Called when a binding is first written. Receives the derived name
   * so callers can log the decision to stderr.
   */
  onNewBinding?(info: { fingerprint: string; store: string; source: string }): void
  /**
   * Called when a legacy sticky is successfully migrated.
   */
  onStickyMigrated?(info: { projectRoot: string; store: string }): void
  /**
   * Called when a predecessor identity is adopted, disclosed, or found
   * ambiguous (§3). A caller that passes nothing still gets the
   * succession — the binding records it as 'carried-forward' — but says
   * nothing about it.
   */
  onSuccession?(info: SuccessionEvent): void
}

export interface ResolveResult {
  storeName: string
  fingerprint: string
  source: 'binding' | 'git' | 'path' | 'migrated-sticky' | 'carried-forward'
}

/**
 * Report the store already bound to `cwd`, or null if none is recorded.
 *
 * resolveStoreName is a write-through resolver: on a miss it derives a
 * name and persists the binding. That is correct for anything about to
 * open a store and wrong for anything merely describing the setup —
 * `doctor` used it once and left a binding behind for every directory it
 * was run from. Read-only callers want this instead: it answers only from
 * what is already recorded and never writes.
 */
export function lookupStoreName(cwd: string): string | null {
  const facts = gitFacts(cwd)
  const { identity } = identityFrom(cwd, facts)
  const bound = readBindingsFile().bindings.projects[fingerprint(identity)]?.store
  if (bound) return bound
  // A legacy project whose one-time sticky migration has not fired yet
  // HAS a store — refusing to see it misdiagnoses the project as never
  // having used treecontext (F review 2026-08-15). Read-only: the
  // sticky is left in place for the write-through path to migrate.
  // Deliberately probe-free (§4): diagnosing a split is doctor's job,
  // and this surface must never even hint at a binding it did not find.
  const repoRoot = facts.primaryRoot
  return repoRoot ? readLegacySticky(repoRoot) : null
}

/**
 * The recorded bindings, for reporting surfaces only (§4, amended
 * 2026-08-20). The split detector must see what is WRITTEN DOWN, not
 * what resolution would write down: it takes this file's parse, its
 * symlink refusal (S3), and its safe-name gate, and nothing else — no
 * identity derivation, no git subprocess, no write-through. Even
 * `lookupStoreName` is too much for it, because that resolves an
 * identity for one directory; a detector describing the whole machine
 * has no directory and no business deriving one.
 *
 * The result is a copy: mutating it cannot reach the file.
 */
export function readBindingsSnapshot(): Bindings {
  const { bindings } = readBindingsFile()
  return { version: 1, projects: { ...bindings.projects } }
}

/**
 * Resolve the store name for `cwd`. Looks up the fingerprint in
 * bindings.json; on miss, derives a name, writes a new binding, and
 * returns it. This replaces the repo-local sticky-file resolution path.
 */
export function resolveStoreName(cwd: string, opts?: ResolveOptions): ResolveResult {
  const facts = gitFacts(cwd)
  const { identity, source, root } = identityFrom(cwd, facts)
  const repoRoot = facts.primaryRoot
  const fp = fingerprint(identity)
  dbg('bindings', 'resolving store', { cwd, source, fingerprint: fp, hasRepoRoot: !!repoRoot })

  const { bindings, health } = readBindingsFile()
  const existing = bindings.projects[fp]
  if (existing) {
    // FIRST, always: a project that already has a binding is never
    // re-pointed by succession (§7). Repairing the splits that predate
    // this rule is parts 2 and 3's job, under backup and disclosure.
    dbg('bindings', 'found existing binding', { store: existing.store, source: existing.source })
    return { storeName: existing.store, fingerprint: fp, source: 'binding' }
  }

  // The probe is the same answer for both branches below; compute it at
  // most once (its cost is realpath + sha256 per candidate — A1).
  let probed: SuccessionCandidates | null = null
  const candidates = (): SuccessionCandidates =>
    (probed ??= probeSuccession(cwd, source, facts, root, bindings))
  // Disclosures ride EVERY branch — the sticky branch included
  // (Phase-1 review 2026-08-20, F3: it returned before the disclosure
  // loop, so a legacy project with a bound subdirectory predecessor
  // migrated in silence, the exact failure mode R2 exists to kill).
  const disclosePredecessors = (): void => {
    for (const pred of candidates().disclosed) {
      dbg('bindings', 'predecessor journal in a subdirectory; disclosed, not adopted', pred)
      opts?.onSuccession?.({ kind: 'predecessorDisclosed', dir: pred.dir, store: pred.store })
    }
  }

  // Try legacy sticky migration before falling back to derived names.
  const migrated = repoRoot ? readLegacySticky(repoRoot) : null
  if (migrated) {
    // The sticky is the same directory's own legacy record, so it wins
    // over any predecessor identity. When they disagree the project has
    // two journals — logged here, reported by the detector (§4).
    const disagreeing = candidates().adoptable.filter((a) => a.store !== migrated)
    if (disagreeing.length) {
      dbg('bindings', 'sticky and predecessor identity name different stores; sticky wins (§3, amended 2026-08-20)',
        { sticky: migrated, predecessors: [...new Set(disagreeing.map((a) => a.store))] })
    }
    disclosePredecessors()
    bindings.projects[fp] = {
      store: migrated,
      updatedAt: Date.now(),
      source: 'migrated-sticky',
    }
    if (persistBindings(bindings, health, [fp])) {
      try { unlinkSync(join(repoRoot!, LEGACY_STICKY)) } catch { /* best-effort cleanup */ }
      opts?.onStickyMigrated?.({ projectRoot: repoRoot!, store: migrated })
      opts?.onNewBinding?.({ fingerprint: fp, store: migrated, source: 'migrated-sticky' })
    }
    return { storeName: migrated, fingerprint: fp, source: 'migrated-sticky' }
  }

  // Succession (§3): this identity is new, but the project it names may
  // not be. Announced at THIS moment and only this one — after the
  // binding lands, the fingerprint hits `existing` above and the probe
  // never runs again for this identity.
  const decision = decideSuccession(candidates())
  disclosePredecessors()
  if (decision.action === 'adopt') {
    // The predecessor binding is left exactly as it is: both keys
    // resolve to one journal, and no byte moves (§3.1).
    dbg('bindings', 'carrying the journal forward to a new identity', { store: decision.store, source })
    bindings.projects[fp] = {
      store: decision.store,
      updatedAt: Date.now(),
      source: 'carried-forward',
    }
    // Announcements are guarded on the persist, like the sticky
    // branch's (Phase-1 review 2026-08-20, F7): on an unwritable
    // bindings file this branch re-runs every hook fire, and
    // announcing "carried forward" for a binding that was never
    // recorded would log a falsehood forever. Resolution still
    // returns the adopted store — unpersisted degradation, as
    // everywhere else in this file.
    if (persistBindings(bindings, health, [fp])) {
      opts?.onSuccession?.({
        kind: 'adopted', store: decision.store, fromIdentitySource: decision.fromIdentitySource,
      })
      opts?.onNewBinding?.({ fingerprint: fp, store: decision.store, source: 'carried-forward' })
    }
    return { storeName: decision.store, fingerprint: fp, source: 'carried-forward' }
  }
  if (decision.conflict) {
    dbg('bindings', 'predecessor identities name different stores; deriving fresh (R4)', { stores: decision.conflict })
    opts?.onSuccession?.({ kind: 'conflict', stores: decision.conflict })
  }

  // Derive a fresh name: git slug preferred, else basename + identity hash.
  const derived = deriveName(root, identity)
  dbg('bindings', 'creating new binding', { store: derived, source })
  bindings.projects[fp] = {
    store: derived,
    updatedAt: Date.now(),
    source,
  }
  // Guarded on the persist like every other branch's announcement (F7
  // doctrine): on a deferred or refused write this branch re-runs next
  // fire, and announcing a binding that never reached disk each time
  // would log the same falsehood forever.
  if (persistBindings(bindings, health, [fp])) {
    opts?.onNewBinding?.({ fingerprint: fp, store: derived, source })
  }
  return { storeName: derived, fingerprint: fp, source }
}

/** `projectRoot` is passed in rather than re-derived: it costs a
 *  subprocess, and the resolver already holds the primary root (§3.4). */
function deriveName(projectRoot: string, identity: string): string {
  const url = identity.startsWith('git:') ? identity.slice(4) : null
  if (url) {
    const slug = slugFromGitUrl(url)
    if (slug) return slug
  }
  const base = projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'unnamed'
  const safeBase = base.replace(/[^A-Za-z0-9._-]/g, '-') || 'unnamed'
  const hash = createHash('sha1').update(identity).digest('hex').slice(0, 6)
  return `${safeBase}-${hash}`
}

function slugFromGitUrl(url: string): string | null {
  // Operates on the URL we already captured — deriving a name never
  // re-runs git. (cli.ts once had a subprocess twin, gitRemoteSlug,
  // retired 2026-08-24 as dead code.)
  const m = url.match(/[/:]([A-Za-z0-9._-]+?)(?:\.git)?\/?$/)
  if (!m) return null
  const name = m[1]
  if (!name || !SAFE_STORE_RE.test(name)) return null
  return name
}
