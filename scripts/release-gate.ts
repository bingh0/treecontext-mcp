/**
 * Release gate — refuse to cut an artifact while a whole product surface has
 * a charter that has never executed.
 *
 * This exists because of 0.0.9-beta. `journal-install.feature` was added in
 * the same commit the release tarball was built from, all thirteen of its
 * scenarios unbound, and five field-reported defects then walked past a suite
 * that contained prose describing every one of them. The wip register was
 * honest the whole time — it said "awaiting the binding wave". Nothing
 * required anyone to read that before shipping.
 *
 * So: a whole-feature wip ruling now blocks `npm run pack:beta`. It is not a
 * veto — some releases genuinely do not touch the unbound surface, and the
 * owner is entitled to say so. It only demands that saying so be deliberate
 * and on the record for *that* release:
 *
 *   TREECONTEXT_RELEASE_ACCEPTS_UNBOUND="journal-policy" npm run pack:beta
 *
 * Each named feature must match a ruling. Naming one that is not ruled (or
 * misspelling one) fails rather than silently waving everything through, and
 * a bare `=1`-style catch-all is deliberately not supported: the override has
 * to name what is being accepted.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WHOLE_FEATURE_WIP } from '../tests/journal/wip-register.js'

const ENV_KEY = 'TREECONTEXT_RELEASE_ACCEPTS_UNBOUND'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The version a release *claims* lives in three files, and only one of them
 * is the one anybody edits. Both of the others have already shipped wrong:
 *
 * - package-lock.json's own `version` was left at 0.0.12-beta through the
 *   v0.0.13-beta and v0.0.14-beta tags. Harmless to consumers (the lockfile
 *   is not in the tarball) but it makes the tag describe the wrong build.
 * - README.md carries the install commands testers copy verbatim. Packing
 *   before bumping them means shipping a README that tells a tester to
 *   download a different release than the one being cut. That has already
 *   happened once and was caught by hand, late, after packing.
 *
 * Prose that names an old version on purpose ("0.0.9-beta wrote this entry
 * to ...") is left alone — only the lines a tester would actually run, plus
 * the banner that states which beta this is, have to agree.
 */
function checkVersionConsistency(version: string): string[] {
  const problems: string[] = []

  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    version?: string
    packages?: Record<string, { version?: string }>
  }
  for (const [where, found] of [
    ['package-lock.json version', lock.version],
    ['package-lock.json packages[""].version', lock.packages?.['']?.version],
  ] as const) {
    if (found !== version) problems.push(`${where} is ${found ?? '(absent)'}, package.json is ${version}`)
  }

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n')
  const isCopyPasted = /gh release download|npm install|git\+ssh|private beta|public beta/
  readme.forEach((line, i) => {
    if (!isCopyPasted.test(line)) return
    // The whole prerelease tag: `0.1.0-beta.1` must not read as `0.1.0-beta`.
    for (const m of line.matchAll(/\d+\.\d+\.\d+-(?:beta|rc)(?:\.\d+)?/g)) {
      if (m[0] !== version) problems.push(`README.md:${i + 1} names ${m[0]}, package.json is ${version}`)
    }
  })

  return problems
}

function main(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const drift = checkVersionConsistency(pkg.version)
  if (drift.length > 0) {
    console.error('release-gate: REFUSING to pack — the version this release claims is inconsistent.\n')
    for (const p of drift) console.error(`  ${p}`)
    console.error('\nRun `npm install` to resync the lockfile, and bump the README install commands.')
    process.exit(1)
  }

  if (WHOLE_FEATURE_WIP.length === 0) {
    console.log('release-gate: no whole-feature wip rulings — every charter surface is bound.')
    return
  }

  const accepted = (process.env[ENV_KEY] ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)

  const ruled = new Set(WHOLE_FEATURE_WIP.map(r => r.feature))
  const unknown = accepted.filter(a => !ruled.has(a))
  if (unknown.length > 0) {
    console.error(`release-gate: ${ENV_KEY} names features with no whole-feature ruling: ${unknown.join(', ')}`)
    console.error(`             ruled surfaces are: ${[...ruled].join(', ')}`)
    process.exit(1)
  }

  const blocking = WHOLE_FEATURE_WIP.filter(r => !accepted.includes(r.feature))
  if (blocking.length === 0) {
    console.log(`release-gate: proceeding — this release accepts ${accepted.join(', ')} as unbound.`)
    return
  }

  console.error('release-gate: REFUSING to pack.\n')
  console.error('These product surfaces have a charter that has never executed:\n')
  for (const r of blocking) {
    console.error(`  ${r.feature}   (ruled ${r.ruledOn})`)
    console.error(`    ${r.reason}\n`)
  }
  console.error('Bind the feature, or state that this release does not need it:\n')
  console.error(`  ${ENV_KEY}="${blocking.map(r => r.feature).join(',')}" npm run pack:beta\n`)
  process.exit(1)
}

main()
