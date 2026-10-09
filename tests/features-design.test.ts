/**
 * Design-tier corpus runner — gherkin-node-test's vitest adapter executes
 * features/design/ (builder-derived platform specs), one runFeatures call
 * per test file per gnt's contract. Step bodies live in tests/steps/, one
 * definer module per feature, mapped here by basename.
 *
 * The executor migration ran 2026-08-25/26: the map filled tier by tier
 * (hooks → root → persistence → server) while a transitional `wip` list
 * shrank to empty, at which point @amiceli/vitest-cucumber retired. A
 * feature added to features/design/ without a definer entry here fails
 * the run loudly — gnt's own discovery ratchet — and whole-feature debt
 * needs a ruling in the journal register, which the release gate reads.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { runFeatures } from 'gherkin-node-test/vitest'
import { stopDefiner } from './steps/stop.steps.js'
import { toolEventFidelityDefiner } from './steps/tool-event-fidelity.steps.js'
import { userPromptFidelityDefiner } from './steps/user-prompt-fidelity.steps.js'
import { contentCodecDefiner } from './steps/content-codec.steps.js'
import { fingerprintDigestDefiner } from './steps/fingerprint-digest.steps.js'
import { ftsDualCapDefiner } from './steps/fts-dual-cap.steps.js'
import { retentionDemotionDefiner } from './steps/retention-demotion.steps.js'
import { roleWeightedFtsDefiner } from './steps/role-weighted-fts.steps.js'
import { storeAsArbiterDefiner } from './steps/store-as-arbiter.steps.js'
import { telemetryPrivacyDefiner } from './steps/telemetry-privacy.steps.js'
import { debugLogSharingDefiner } from './steps/debug-log-sharing.steps.js'
import { hookDispatchDefiner } from './steps/hook-dispatch.steps.js'
import { outputShieldingDefiner } from './steps/output-shielding.steps.js'
import { backupCliDefiner } from './steps/backup-cli.steps.js'
import { storesListDefiner } from './steps/stores-list.steps.js'
import { ingestionFidelityDefiner } from './steps/ingestion-fidelity.steps.js'
import { configFileDefiner } from './steps/config-file.steps.js'
import { backupVisibilityDefiner } from './steps/backup-visibility.steps.js'
import { storesMergeDefiner } from './steps/stores-merge.steps.js'
import { backupLifecycleDefiner } from './steps/backup-lifecycle.steps.js'
import { backupSweepDefiner } from './steps/backup-sweep.steps.js'
import { storeBindingsDefiner } from './steps/store-bindings.steps.js'
import { flatStoreC4ReadViewDefiner } from './steps/flat-store-c4-read-view.steps.js'
import { flatStoreConversationWindowDefiner } from './steps/flat-store-conversation-window.steps.js'
import { flatStoreDedupDefiner } from './steps/flat-store-dedup.steps.js'
import { flatStoreRoleWeightsDefiner } from './steps/flat-store-role-weights.steps.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

runFeatures(join(HERE, '../features/design'), {
  'stop': stopDefiner,
  'tool-event-fidelity': toolEventFidelityDefiner,
  'user-prompt-fidelity': userPromptFidelityDefiner,
  'content-codec': contentCodecDefiner,
  'fingerprint-digest': fingerprintDigestDefiner,
  'fts-dual-cap': ftsDualCapDefiner,
  'retention-demotion': retentionDemotionDefiner,
  'role-weighted-fts': roleWeightedFtsDefiner,
  'store-as-arbiter': storeAsArbiterDefiner,
  'telemetry-privacy': telemetryPrivacyDefiner,
  'debug-log-sharing': debugLogSharingDefiner,
  'hook-dispatch': hookDispatchDefiner,
  'output-shielding': outputShieldingDefiner,
  'backup-cli': backupCliDefiner,
  'stores-list': storesListDefiner,
  'ingestion-fidelity': ingestionFidelityDefiner,
  'config-file': configFileDefiner,
  'backup-visibility': backupVisibilityDefiner,
  'stores-merge': storesMergeDefiner,
  'backup-lifecycle': backupLifecycleDefiner,
  'backup-sweep': backupSweepDefiner,
  'store-bindings': storeBindingsDefiner,
  'flat-store-c4-read-view': flatStoreC4ReadViewDefiner,
  'flat-store-conversation-window': flatStoreConversationWindowDefiner,
  'flat-store-dedup': flatStoreDedupDefiner,
  'flat-store-role-weights': flatStoreRoleWeightsDefiner,
}, {
  manifest: join(HERE, '../features/design/run-manifest.ndjson'),
})
