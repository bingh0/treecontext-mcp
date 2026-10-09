import type { Migration } from '../migrations.js'
import m001 from './001_initial.js'
import m002 from './002_namespace.js'
import m003 from './003_modal_embeddings.js'
import m004 from './004_decay_rate_and_staging.js'
import m005 from './005_snapshots.js'
import m006 from './006_trigram_fts.js'
import m007 from './007_knn_blobs.js'
import m008 from './008_insert_generation.js'
import m009 from './009_session_stats.js'
import m010 from './010_flat_journal.js'
import m011 from './011_journal_last_accessed.js'
import m012 from './012_journal_trigram.js'
import m013 from './013_role_weighted_fts.js'
import m014 from './014_conversation_window_index.js'
import m015 from './015_session_identity_index.js'
import m016 from './016_staging_fidelity.js'
import m017 from './017_staging_unprocessed_index.js'
import m018 from './018_staging_preview_len.js'
import m019 from './019_drop_dead_tables.js'
import m020 from './020_staging_namespace.js'
import m021 from './021_store_as_arbiter.js'
import m022 from './022_interim_heal.js'
import m023 from './023_arbiter_backfill.js'
import m024 from './024_fingerprint_digest.js'
import m025 from './025_handoff_lane_index.js'
import m026 from './026_reference_index.js'
import m027 from './027_session_registry.js'

/** All known migrations, ordered by version ascending. */
export const migrations: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021, m022, m023, m024, m025, m026, m027]

/** The highest schema version this build understands. */
export const maxSupportedVersion = migrations.at(-1)!.version
