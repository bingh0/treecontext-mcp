/**
 * Vitest setup file: take the ambient variables product code resolves
 * real-machine state from out of every worker's own environment, before any
 * test file imports src.
 *
 * The spawn harness already strips LEAK_KEYS from the children it starts;
 * in-process tests had no such scrub. redirectHome sandboxes HOME, but
 * claudeUserConfigPath reads CLAUDE_CONFIG_DIR first — so on a machine whose
 * shell sets it (every CCS profile does), the in-process uninstall tests
 * emptied `mcpServers` in the developer's REAL `.claude.json`
 * (2026-10-13: uninstall-orphan-wrappers, uninstall-legacy-agents). CI sets
 * none of these, which is why it stayed green.
 *
 * NODE_OPTIONS stays: in-process it is the worker's own launch flags, not
 * machine state, and every spawn already strips it through the harness.
 * A test that needs one of these keys sets it itself, after this runs.
 */
import { LEAK_KEYS } from './cli-spawn.js'

for (const key of LEAK_KEYS) {
  if (key !== 'NODE_OPTIONS') delete process.env[key]
}
