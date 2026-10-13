import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/perf/**'],
    // In-process tests must not read the developer's agent profile or
    // treecontext seams (see the file for the incident it closes).
    setupFiles: ['tests/helpers/scrub-ambient-env.ts'],
    // Charter scenarios that drive real subprocesses (the install wave, and
    // journal-policy's read-only capture gate) outlive the 5s default: the
    // ingestion loop alone polls on a 5s interval, so observing that it did
    // NOT run takes longer than observing that it did. gherkin-node-test has
    // no per-scenario timeout hook, so this is set globally. Windows gets
    // twenty times as long: on the hosted runner the 12000-row fixtures of
    // the two whole-journal export scenarios take 90-200 s (3-5 s on
    // Linux) — the runner's per-insert cost, not a product path, which the
    // export itself shows by doing nothing per row.
    // Elsewhere, 120 s: the mature-journal seeds behind the broad
    // orientation scenarios (D266) take ~7 s on a developer machine and
    // crossed 30 s on the hosted Linux runner in the beta.2 matrix
    // (2026-10-11, Node 22 lane) — runner load, not a product path.
    testTimeout: process.platform === 'win32' ? 600_000 : 120_000,
    // The merged provider: vitest's V8 collector for the workers, plus the
    // raw V8 coverage of every subprocess the charter suite spawns, folded
    // through the same remapper (scripts/coverage/provider.ts). `npm run
    // test:coverage` sets NODE_V8_COVERAGE so the children report; a bare
    // `vitest --coverage` covers the workers only and says so.
    //
    // No thresholds here: the 90/85/90/90 that stood until 2026-09-13 were
    // never run in CI and read the workers alone (72% lines against a
    // suite that verifies through subprocesses). The R4' gate — 100% of
    // what no written ruling excludes — is measured on the three-lane
    // merged report (scripts/coverage/merge.ts) and lands as its own dated
    // step once the exclusion rulings exist.
    coverage: {
      provider: 'custom',
      customProviderModule: './scripts/coverage/provider.ts',
      include: ['src/**/*.ts'],
      exclude: ['src/**/types.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json', 'html'],
    },
    typecheck: {
      enabled: true,
    },
  },
})
