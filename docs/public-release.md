# Public release plan — treecontext-mcp

Ruled 2026-08-15: the public name is **`treecontext-mcp`** (the npm
reservation `treecontext-mcp@0.0.0` has been held since 2026-08-07;
`treecontext` is unreserved on npm and stays that way). This document
is the checklist between "RC cut" and "the repo is public and the
package installs from npm" — what renames, what ships, what was checked
before the flip. It is itself a release artifact: the project is a
public aBDD exemplar, and the release process is part of the record.

## 1. Naming

| Surface | Today | At release |
| --- | --- | --- |
| npm package | `treecontext` (unpublished; tarball installs) | `treecontext-mcp` |
| GitHub repo | the development repo (+ CI mirror), stays **private** | **new** `bingh0/treecontext-mcp`, fresh history, opt-in file copy (see §1a) |
| CLI binary | `treecontext` | `treecontext` (unchanged — the command is the product name) |
| MCP tool namespace | `treecontext_*` | `treecontext_*` (unchanged — renaming the agent surface would churn every installed config and skill for zero user value) |
| Hook/launcher scripts | `tc-*` | `tc-*` (unchanged) |

The split is deliberate: **`treecontext-mcp` is the package and repo
identity; `treecontext` is the product identity** (binary, tool prefix,
store directory `~/.treecontext`). One rename at the distribution
layer, zero churn at the installed-surface layer.

Name-clearance findings (2026-08-15): no fork named `treecontext-mcp`
exists on any of the release accounts — the GitHub name is already
free; nothing needs deleting. The original development repo
(`treecontext-mcp` on the original account, private, created
2026-03-11) is a separate lineage: the current repo began as a fresh
history at `0.9.0-beta.1` and does not contain it. The original
remains, private, as the archive of the tree era.

### 1a. The publication mechanism: fresh repo, opt-in copy

Ruled 2026-08-15 (the gnt/gct/ccr pattern): the public repo is a
**new, empty `bingh0/treecontext-mcp`** populated by copying the
release file set from this repo at the 0.1 release — **no commit
history carries over**, and every file is individually scrutinized
before it is copied. This inverts the safety posture from
"sweep the history and hope" to "nothing ships unless it was looked
at": the private repo (this one, and its CI mirror) remains the
development home; git history, session-era notes, and anything not on
the manifest simply never exist publicly.

Consequences:

- The §3 sanitization sweep becomes a *second* line of defense run
  over the copy destination, not the primary control.
- The copy manifest (§2a) is the primary control, maintained here and
  checked at release time: `git ls-files` in the new repo must equal
  the manifest exactly.
- Public issue links point at the new repo from day one; the private
  repo's URLs need no scrubbing (it stays private), but the shipped
  files' URLs must point at `bingh0/treecontext-mcp` — same edit list
  as the old rename plan, applied to the copies (or committed here
  just before the copy, since the strings are correct for the public
  repo either way): `package.json` (`name`, `repository`, `homepage`,
  `bugs`), `README.md`, `AGENTS.md`, `docs/hooks/opencode.md`,
  `docs/hooks/vscode.md`, `src/server/cli.ts` (--npx message),
  `src/server/installer.ts` (config template header, doctor issues
  pointer), `CHANGELOG.md` (release-download commands).
- Ongoing development stays here; releases flow private → public as
  copied snapshots per release until (owner's later call) development
  itself moves.

## 2. Document dispositions

Ruling context (2026-08-15): treecontext-mcp — like gnt/gct/gt/ccr —
is a **public aBDD exemplar**. The process artifacts (feature corpus,
fences, adversarial-review records, design notes, charter) are not
internal residue to prune; they are half the point of publishing. The
default disposition is therefore *stays, as-is*; the table lists only
what needs an action.

| Document | Disposition |
| --- | --- |
| `README.md` | **Rewrite install section at release**: gh-release tarball flow → `npm install -g treecontext-mcp`; issues links follow the rename. Everything else stays. |
| `CHANGELOG.md` | Stays. Beta entries are the record; the 0.1.0 entry consolidates at tag time. |
| `DESIGN.md`, `ARCHITECTURE.md` | **New (this change)** — the orienting and system documents, front doors for the exemplar. |
| `docs/release-charter-0.1.md` | Stays verbatim — the charter-with-gate is a core aBDD process artifact. |
| `tests/journal/README.md` | Stays — the charter suite's method doc. One edit: the `~/Documents/gherkin-node-test` local path becomes the published package/repo reference. |
| `features/OUT-OF-SCOPE.md` | Stays verbatim (the 2026-08-25 reorg merged the two former fences into it, bodies unchanged) — the fence IS the exemplar's negative space. |
| `tests/journal/ADVERSARIAL-REVIEW-*.md` | Stay — the review record is process evidence. |
| `docs/review-2026-08-24-audit-run-1.md` | **New (2026-08-24)** — findings from the first `/audit` field run over this corpus; drives the pre-flip `DESIGN.md` and fence-hygiene work. Stays: it is the exemplar being audited by its own toolchain. Census: `docs/**` count in §2a rises by one. |
| `tests/server/design/*.md`, `docs/session-identity.md`, `docs/sidecar-blob-scope.md`, `docs/resume-pointer-lifecycle.md` | Stay — design notes with their rulings and dates. |
| `docs/security.md`, `docs/hooks/*` | Stay (already written for users). |
| `bench/README.md`, `bench/NOTICE.md` | Stay; `bench/history.jsonl` gets an owner skim before the flip (measurement data from this machine — expected clean, verify once). |
| `LICENSE` | Stays (MIT, "treecontext contributors"). |

## 2a. Copy manifest (draft 2026-08-15 — the scrutiny checklist)

Current tracked-file census: 297 files. Disposition by group; the
owner's per-file pass walks this table and ticks groups off. **SHIP**
means copy verbatim (after the URL edits in §1a); **HOLD** means it
never leaves the private repo; **EDIT** means it ships after a named
change.

| Group (files) | Disposition | Notes |
| --- | --- | --- |
| `src/**` (97) | SHIP | The package. All URL sites already enumerated in §1a. |
| `tests/**` + `features/**` (the 2026-08-25 reorg moved the `.feature` corpus and merged the fences under `features/`) | SHIP, two exceptions below | The corpus IS the exemplar: features, fence, ADVERSARIAL-REVIEW records, design notes, guard tests, wip registers. |
| `tests/fixtures/test-store.msgpack` | **HOLD — deleted 2026-08-15** | Dead fixture: referenced by nothing since the tree-era `import` command became a tombstone. A binary blob that cannot be eyeballed has no place in an opt-in manifest; removed from this repo in the same change that ruled it. |
| `run-manifest.ndjson` (repo root) | SHIP | Generated pass/fail record; regenerates on every run; part of the gnt exemplar story. |
| `docs/**` (12) | SHIP | Including this file — the release process is process evidence. `docs/public-release.md` ships with §3's identifier list kept generic (it already is). |
| `bench/**` (25) | SHIP | Measurement harness + `history.jsonl` (LongMemEval metrics — clean, exemplar-relevant) + `NOTICE.md` attribution. Owner skim of `history.jsonl` stands. |
| Root docs: `README.md`, `DESIGN.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `AGENTS.md`, `LICENSE` | SHIP / EDIT | README install section rewrites to npm at publish; CHANGELOG's tarball commands update; AGENTS.md gnt link → published repo. |
| Build/config: `package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, `.oxlintrc.json`, `.npmrc`, `.gitignore`, `typings/` | SHIP | `.npmrc` is one line (`legacy-peer-deps=true`) — verified harmless. Lockfile ships (resolves only to registry.npmjs.org — verified). |
| `scripts/` (2: `install-smoke.ts`, `release-gate.ts`) | SHIP | Both are exemplar-relevant release tooling; tarball name updates with the package rename. |
| `.github/workflows/ci.yml` | SHIP after read-through | The minute-diet comments describe CI economics generically; one read-through at copy time. |
| `.github/ISSUE_TEMPLATE/beta-report.yml` | EDIT | Reframe from private-beta reporting to public issue intake at release. |

Release-time check: `git ls-files` in `bingh0/treecontext-mcp` equals
this manifest minus HOLDs, with zero unlisted files. Anything new
added to the private repo between now and release lands in this table
in the same change that adds it.

## 3. Sanitization audit (run 2026-08-15, re-run before the flip)

Swept every tracked file for private identifiers. Findings:

- **Clean**: no work email, no absolute machine paths, no private
  account names, no university references anywhere in tracked files.
- **Commit history**: single author identity, the public noreply
  address, from the fresh-start root commit — nothing to rewrite.
- **`package.json` author alias**: intentional (matches the npm
  maintainer identity on the reservation).
- **Repo URLs** (the development repo's): all intended-public; covered by
  the rename checklist above.
- Re-run before the flip: `git grep -iE '<the private-identifier
  list>'` plus a skim of `bench/history.jsonl` and any new fixtures.
- **Re-run 2026-10-08, before the beta.1 flip** (every tracked file,
  `package-lock.json` excluded): no username, machine name, company,
  work email or absolute private path anywhere; the only secret-shaped
  string is a visibly fake token in a handoff test fixture. Fixed: the
  `package.json` author alias (now "treecontext contributors", the
  LICENSE holder); the beta tester's private platform, written as
  "the orchestration platform" in the docket, fence, needs ledger and
  the attribution proposal; three private store names in the two
  identity documents, written as `research-project`, `second-project`
  and `third-project`; one fiction sentinel in a test. The docket
  records the generalization and both chain heads (D246). Still
  intended-public and rewritten at the flip: the development repo's
  URLs (eight files) become `bingh0/treecontext-mcp` (done in the
  beta.1 release prep).
- **The sweep is now a gate** (2026-10-08, the beta.1 release prep):
  `scripts/release-scan.ts` runs in `npm run pack:beta` right after the
  release gate, scans every tracked file (`package-lock.json` and the
  script itself excluded) for the private-identifier list and secret
  shapes, and refuses to pack with `file:line` for every hit. Run it on
  its own with `npm run release-scan`.

## 4. Ecosystem coupling and ordering

treecontext-mcp stands alone at runtime (zero runtime dependency on
the gherkin toolchain) but is coupled at the **spec layer**:

- `gherkin-node-test` (gnt) is the charter suite's linter+executor —
  already published to npm (`0.9.0`), so the dev-dependency graph is
  public-safe today. The dialect subset is pinned so every `.feature`
  stays portable to the Rust sibling (gct).
- `gherkin-trace` (gt): planned coupling; not a dependency yet.
- **Metapackage** (ruled 2026-08-15): once gnt, treecontext-mcp, and
  gt are all released, an npm metapackage bundles them. Nothing in this
  release blocks on it; treecontext-mcp publishes standalone first.
- Exemplar bar (ruled 2026-08-15): as a public aBDD example alongside
  gnt/gct/gt/ccr, the feature corpus, the design docs, and the
  architecture docs are release deliverables held to the same
  thoroughness as the code. Coverage completeness is release-gated by
  the existing guards (orphan ratchet, wip registers, release-gate).

## 5. Release step sequence

1. **RC**: tag `v0.1.0-rc.1` on the private repo (owner-gated; §4 of
   the charter). The tag push runs the full three-OS matrix.
2. **Closed-beta soak** on the RC: zero data-loss-class reports plus a
   verified migration from the oldest supported store version
   (charter §4 items 5–6).
3. **Docs pass during the soak**: DESIGN.md/ARCHITECTURE.md cold-read,
   README install-section rewrite staged behind the publish.
4. **URL + name edits** (§1a list) land here, on the private repo —
   the strings point at the public repo before the copy does.
5. **Create empty `bingh0/treecontext-mcp` and copy the manifest**
   (§2a): per-file opt-in scrutiny, no history; verify
   `git ls-files` in the new repo equals the manifest minus HOLDs;
   run the §3 sweep over the destination as the second check; wire CI
   on the new repo and see the full matrix green there.
6. **Publish `treecontext-mcp@0.1.0`** over the reservation, from the
   public repo; verify `npm install -g treecontext-mcp && treecontext
   doctor` on a clean machine per platform (the matrix's package jobs
   are the rehearsal).
7. Metapackage: separate effort, after gt releases.
