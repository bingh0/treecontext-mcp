/**
 * Release scan — refuse to pack while any tracked file names a private
 * identifier or carries a secret-shaped string.
 *
 * docs/public-release.md §3 ran this sweep by hand before each flip. The
 * public repository is a copy of this tree's tracked files with no history,
 * so the tree itself is the whole exposure: anything a `git ls-files` lists
 * ships. The sweep now runs in `npm run pack:beta`, after the release gate,
 * and exits 1 naming file:line for every hit.
 *
 * package-lock.json is skipped (registry integrity hashes are noise, and the
 * lockfile was verified to resolve only to registry.npmjs.org). This file is
 * skipped too: it has to spell the list it looks for.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '..')
const SKIP = new Set(['package-lock.json', relative(ROOT, SELF).split('\\').join('/')])

interface Rule {
  name: string
  re: RegExp
  /** A hit on a line this accepts is not a finding. */
  allow?: (match: RegExpExecArray, line: string) => boolean
}

/** Addresses that are public, placeholders, or documentation shapes. */
function allowedEmail(m: RegExpExecArray, line: string): boolean {
  const addr = m[0].toLowerCase()
  const [local, domain = ''] = addr.split('@')
  if (addr === 'noreply@anthropic.com') return true
  if (domain.startsWith('example.')) return true
  if (local === 'you' || local === 'user') return true
  // `git@github.com:owner/repo` is an SSH remote, not a mailbox.
  if (local === 'git') return true
  // RFC 2606 reserved names can never be anyone's address.
  if (/\.(?:invalid|test|example|localhost)$/.test(domain)) return true
  // `<user>@host`-style templates: the local part is a placeholder in brackets.
  if (line[m.index - 1] === '>' || line.slice(0, m.index).endsWith('<user>')) return true
  return false
}

const RULES: readonly Rule[] = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, allow: allowedEmail },
  { name: 'owner name', re: /Bing Ho/gi },
  { name: 'private mail relay', re: /duck\.com/gi },
  { name: 'private project', re: /reps-attic/gi },
  { name: 'username', re: /biho/gi },
  { name: 'machine name', re: /minisf/gi },
  { name: 'company', re: /quanths/gi },
  { name: 'username', re: /linus/gi },
  { name: 'home path', re: /\/home\/(?:biho|linus)/gi },
  { name: 'private name', re: /\bdawn\b/gi },
  { name: 'private project', re: /grocery/gi },
  { name: 'private name', re: /kelleher/gi },
  { name: 'private project', re: /agent-bdd-research/gi },
  { name: 'secret: API key', re: /sk-[a-z0-9]{8,}/g },
  { name: 'secret: AWS key', re: /AKIA[0-9A-Z]{12,}/g },
  { name: 'secret: GitHub token', re: /ghp_[0-9A-Za-z]{20,}/g, allow: (_m, line) => /example/i.test(line) },
  { name: 'secret: npm token', re: /npm_[0-9A-Za-z]{20,}/g },
  { name: 'secret: private key', re: /BEGIN (?:RSA|OPENSSH|PRIVATE)/g },
]

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(f => f.length > 0 && !SKIP.has(f))
}

function scan(): string[] {
  const hits: string[] = []
  for (const file of trackedFiles()) {
    let buf: Buffer
    try {
      buf = readFileSync(join(ROOT, file))
    } catch {
      continue // listed but deleted in the working tree: nothing to ship
    }
    if (buf.includes(0)) continue // binary: no text identifiers to read
    const lines = buf.toString('utf8').split('\n')
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        rule.re.lastIndex = 0
        for (const m of line.matchAll(rule.re)) {
          if (rule.allow?.(m as RegExpExecArray, line)) continue
          hits.push(`${file}:${i + 1}: ${rule.name}: ${m[0]}`)
        }
      }
    })
  }
  return hits
}

function main(): void {
  const hits = scan()
  if (hits.length > 0) {
    console.error('release-scan: REFUSING to pack — tracked files name private identifiers or secret shapes.\n')
    for (const h of hits) console.error(`  ${h}`)
    console.error(`\n${hits.length} hit(s). The public repository is a copy of these files; fix them before packing.`)
    process.exit(1)
  }
  console.error(`release-scan: ${trackedFiles().length} tracked files clean (package-lock.json and this script excluded).`)
}

main()
