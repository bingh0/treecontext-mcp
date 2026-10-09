#!/usr/bin/env node
/**
 * CLI entry point for treecontext MCP server.
 *
 * Usage:
 *   treecontext serve --transport stdio
 *   treecontext serve --store my-project --transport stdio
 *   treecontext serve --project-dir /path/to/project
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename as baseOfPath, dirname as dirOfPath, join, relative as relativePath, resolve as resolvePath, isAbsolute, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadedConfig } from './config.js'
import type { MigrationBackup } from '../persistence/backup-verdict.js'
import { lookupStoreName, resolveStoreName } from './bindings.js'
// The parse guard and doctor's advice must agree on addressability;
// both import the dependency-free store-name leaf (importing stores.ts
// here pulled the whole migration ladder into every CLI spawn).
import { SAFE_STORE_RE, isCliAddressableStoreName } from '../tools/store-name.js'
// policy.ts is a dependency-free leaf — safe in every CLI spawn.
import { POLICIES, captureEnabled, effectivePolicy, type Policy } from './policy.js'
import { dbg, warn } from '../debug.js'

const STORES_DIR = join(homedir(), '.treecontext', 'stores')

export { SAFE_STORE_RE }

// ── Argument parsing ───────────────────────────────────────────────

export interface CliArgs {
  command: 'serve' | 'import' | 'export' | 'viz' | 'embed' | 'stores' | 'backup' | 'install' | 'uninstall' | 'doctor' | 'init' | 'daemon' | 'ccr' | 'config'
  /** `export <path>` / `import <path>`: the handoff file (D199). */
  handoffPath: string | null
  /** `export --whole`: the whole journal instead of the summaries. */
  exportWhole: boolean
  /** `config <key> <value…>`: the one key is checkpoint-interval. */
  configKey: string | null
  /** The value words of `config <key> <value…>`, joined by single spaces. */
  configValue: string | null
  /** Sub-action for the `stores` command. */
  storesAction: 'list' | 'rm' | 'prune' | 'sweep' | 'merge'
  /** Sub-action for the `ccr` command. */
  ccrAction: 'wire'
  /** Which pane files `ccr wire` lists, in cycle order. */
  ccrPanes: ('journal' | 'threads' | 'trail')[]
  /** Target store name for `stores rm` / `stores prune <name>`, and the
   *  SOURCE store of `stores merge <src> <dst>`. */
  storesTarget: string | null
  /** The DESTINATION store of `stores merge <src> <dst>`. */
  storesTarget2: string | null
  /** `stores merge --backup`: take fresh backups of both stores first. */
  storesBackup: boolean
  /** `stores merge --repoint`: point bindings naming <src> at <dst>. */
  storesRepoint: boolean
  /** Actually perform destructive operations (required for rm/prune). */
  yes: boolean
  /** stdio is the only transport: HTTP was tombstoned for 0.1. */
  transport: 'stdio'
  store: string | null
  /**
   * Namespace scope within the store. Agents sharing a store but wanting
   * independent trees use distinct namespaces (e.g. 'project', 'agent-a').
   * Default 'project'.
   */
  namespace: string
  projectDir: string | null
  /** Enable conversation capture ingestion loop. */
  capture: boolean
  /** Write the sidecar panes beside the store on each drain. */
  sidecar: boolean
  /** Disable mutating MCP tools at registration time. */
  readOnly: boolean
  /** Run a lexical FlatStore backend (FTS5 bm25, no embedder). */
  lexical: boolean
  /** Tool-access policy. Null means derived from readOnly. */
  policy: Policy | null
  /** Explicit config file path. Null = auto-discover. */
  configPath: string | null
  /** Security S6: enable PRAGMA secure_delete on the database. */
  secureDelete: boolean
  /** B1: backup destination path. */
  backupDst: string | null
  /** B1: overwrite existing backup. */
  force: boolean
  /** Byte threshold for output shielding. 0 = disabled (default). */
  shieldThreshold: number
  /** Directory for shielded output files. */
  shieldDir: string | null
  /** Store-byte budget from the config file's `[retention] max_store_bytes`
   *  (D141). Config-only, no flag: null leaves the library default. */
  maxStoreBytes: number | null
  /** Session cap from the config file's `[retention] max_sessions` (D141).
   *  Config-only, no flag: null leaves the library default. */
  maxSessions: number | null
  /** Dry-run mode for install/uninstall. */
  dryRun: boolean
  /** Specific agent slugs for install/uninstall. */
  installAgents: string[] | null
  /** Use npx in generated MCP configs instead of bare command. */
  useNpx: boolean
  /** Install capture hooks for platforms with an unverified adapter. */
  experimentalCapture: boolean
  /** Uninstall only hook config, leaving MCP registration in place. */
  hooksOnly: boolean
  /** Dump debug logs to stdout (doctor --dump-logs). */
  dumpLogs: boolean
  /** Verbose diagnostic output (default: true) — stderr and the log file;
   *  the log file only under serve (D258). Disable with --no-debug. */
  debug: boolean
  /** Handshake instructions variant: brief (default) or none ('verbose' tombstoned). */
  instructions: 'brief' | 'none'
  /** Set of flags explicitly provided on the command line. Used to decide
   *  when a config-file value should win over the CliArgs default. */
  provided: Set<string>
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'serve',
    handoffPath: null,
    exportWhole: false,
    configKey: null,
    configValue: null,
    storesAction: 'list',
    ccrAction: 'wire',
    ccrPanes: ['journal'],
    storesTarget: null,
    storesTarget2: null,
    storesBackup: false,
    storesRepoint: false,
    yes: false,
    transport: 'stdio',
    store: null,
    namespace: 'project',
    projectDir: null,
    capture: false,
    sidecar: true,
    readOnly: false,
    lexical: false,
    policy: null,
    configPath: null,
    secureDelete: false,
    backupDst: null,
    force: false,
    shieldThreshold: 0,
    shieldDir: null,
    maxStoreBytes: null,
    maxSessions: null,
    instructions: 'brief',
    dryRun: false,
    installAgents: null,
    useNpx: false,
    experimentalCapture: false,
    hooksOnly: false,
    dumpLogs: false,
    debug: true,
    provided: new Set<string>(),
  }
  const mark = (name: string): void => { args.provided.add(name) }

  let i = 2 // skip node and script path
  while (i < argv.length) {
    const arg = argv[i]!
    switch (arg) {
      case 'serve':
        args.command = 'serve'
        break
      case 'import':
      case 'export': {
        // The handoff's terminal door (D199): `export <path>` writes the
        // file the export tool writes, `import <path>` reads it. The one
        // positional is the file.
        args.command = arg
        const file = argv[i + 1]
        if (!file || file.startsWith('-')) {
          error(`${arg} requires a handoff file: treecontext ${arg} <path>${arg === 'export' ? ' [--whole --yes]' : ''}`)
        }
        args.handoffPath = file
        i++
        break
      }
      case '--whole':
        args.exportWhole = true
        break
      case 'viz':
      case 'embed': {
        // Tombstone commands: swallow the historical positional
        // ('import dump.msgpack', 'viz <store>') so the stale invocation
        // reaches its curated tombstone message — the recovery pointer
        // exists precisely for that audience, and the strict-positional
        // guard below must not preempt it with 'Unexpected argument'.
        args.command = arg
        const legacyArg = argv[i + 1]
        if (legacyArg && !legacyArg.startsWith('-')) i++
        break
      }
      case 'backup': {
        args.command = 'backup'
        // Next positional is the destination path.
        const dst = argv[i + 1]
        if (dst && !dst.startsWith('-')) {
          args.backupDst = dst
          i++
        }
        break
      }
      case 'install':
        args.command = 'install'
        break
      case 'uninstall':
        args.command = 'uninstall'
        break
      case 'doctor':
        args.command = 'doctor'
        break
      case 'init':
        args.command = 'init'
        break
      case 'config': {
        // `config checkpoint-interval <value…>` (D156): the value is said
        // the way a developer says it, "20 rounds or 45 minutes", so every
        // following positional is a word of it, quoted or not.
        args.command = 'config'
        const key = argv[i + 1]
        if (key !== 'checkpoint-interval') {
          error(`config: the one setting is checkpoint-interval — e.g. treecontext config checkpoint-interval "20 rounds or 45 minutes"`)
        }
        args.configKey = key
        i++
        const words: string[] = []
        while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) { words.push(argv[i + 1]!); i++ }
        if (words.length === 0) error('config checkpoint-interval needs a value, e.g. "20 rounds", "45 minutes", "20 rounds or 45 minutes", or "off"')
        args.configValue = words.join(' ')
        break
      }
      case 'daemon': {
        args.command = 'daemon'
        // Swallow ANY sub-action positional; the command is a tombstone
        // and 'daemon restart' must reach it like start/stop/status do.
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) i++
        break
      }
      case 'ccr': {
        args.command = 'ccr'
        // One sub-action today. Named rather than implied so `ccr status`
        // or `ccr unwire` can arrive later without breaking `ccr wire`.
        const next = argv[i + 1]
        if (next === 'wire') { args.ccrAction = next; i++ }
        else if (next !== undefined && !next.startsWith('-')) error(`unknown ccr action ${JSON.stringify(next)} — the only one is: wire`)
        break
      }
      case '--pane': {
        const value = argv[i + 1]
        if (!value || value.startsWith('-')) error('--pane requires a name: journal, threads, trail, or all')
        const wanted = value === 'all' ? ['journal', 'threads', 'trail'] : value.split(',')
        for (const name of wanted) {
          if (name !== 'journal' && name !== 'threads' && name !== 'trail') {
            error(`--pane ${JSON.stringify(name)} is not a pane — the panes are journal, threads, trail (or all)`)
          }
        }
        args.ccrPanes = wanted as ('journal' | 'threads' | 'trail')[]
        mark('pane')
        i++
        break
      }
      case 'stores': {
        args.command = 'stores'
        // Optional sub-action as the next positional.
        const next = argv[i + 1]
        if (next === 'list' || next === 'rm' || next === 'prune' || next === 'sweep' || next === 'merge') {
          args.storesAction = next
          i++
          // For `stores rm <name>` accept one more positional. A store
          // name, not a path: the shell branch of runStores enumerates
          // the target directory, so an unvalidated `../..` here walks
          // outside the stores root (S9 still blocks the deletion, but
          // rm must not describe what it will never remove).
          if (next === 'rm') {
            const target = argv[i + 1]
            if (!target || target.startsWith('-')) error('stores rm requires a store name')
            // The same predicate doctor's advice fork uses — the two
            // surfaces cannot disagree about which names are stranded.
            if (!isCliAddressableStoreName(target)) {
              error('store name must match [A-Za-z0-9._-]+ (and not ".", "..", or start with "-")')
            }
            args.storesTarget = target
            i++
          }
          // `stores merge <src> <dst>` takes TWO positionals. Unlike rm,
          // the addressability and stores-root checks are NOT done here:
          // §11c requires every merge precondition to refuse with its own
          // message, and a parse-time rejection would answer for them
          // with the parser's. The parser only insists the two names are
          // present and are not flags.
          if (next === 'merge') {
            const source = argv[i + 1]
            const dest = argv[i + 2]
            if (!source || source.startsWith('-') || !dest || dest.startsWith('-')) {
              error('stores merge requires a source and a destination store: treecontext stores merge <src> <dst>')
            }
            args.storesTarget = source
            args.storesTarget2 = dest
            i += 2
          }
        }
        break
      }
      case '--backup':
        args.storesBackup = true
        break
      case '--repoint':
        args.storesRepoint = true
        break
      case '--yes':
      case '-y':
        args.yes = true
        break
      case '--config':
        i++
        // A trailing --config silently fell back to auto-discovery — the
        // one flag whose whole job is naming a file loaded a different
        // file without saying so. Missing value errors like every parse
        // error (ruling 2026-08-15, standing defect dispositions).
        if (argv[i] === undefined) error('--config requires a path')
        args.configPath = argv[i]!
        break
      case '--transport':
        i++
        // HTTP transport tombstone (0.1 corpus-audit ruling, 2026-08-12):
        // both of its consumers — the stateless embedding daemon and the
        // shared multi-client daemon — left with the tree era, the
        // library never needed a transport at all, and the audit proved
        // the surface unused (its options were dropped at the
        // startServer call and no one ever noticed). Reinstatement is a
        // feature request with a corpus, not a flag flip.
        if (argv[i] === 'http' || argv[i] === 'streamable-http') {
          error('the HTTP transport was removed for 0.1 (its tree-era consumers are gone and it was unused); serve is stdio-only')
        }
        if (argv[i] !== 'stdio') {
          error(`Unsupported transport: ${argv[i] ?? '(missing)'} (expected "stdio")`)
        }
        args.transport = 'stdio'
        mark('transport')
        break
      case '--port':
      case '--host':
        error(`${arg} was removed with the HTTP transport (0.1); serve is stdio-only`)
        break
      case '--store':
        i++
        args.store = argv[i] ?? null
        break
      case '--namespace': {
        i++
        const ns = argv[i]
        if (!ns || !SAFE_STORE_RE.test(ns)) error('--namespace must match [A-Za-z0-9._-]+')
        args.namespace = ns
        break
      }
      case '--project-dir':
        i++
        args.projectDir = argv[i] ?? null
        break
      case '--read-only':
        args.readOnly = true
        break
      case '--lexical':
        args.lexical = true
        mark('lexical')
        break
      case '--no-lexical':
        args.lexical = false
        mark('lexical')
        break
      case '--policy': {
        i++
        const p = argv[i]
        // One vocabulary (pass-3): the validator, the error message,
        // and the type all come from POLICIES — a fourth policy added
        // there cannot be silently rejected here.
        if (!p || !(POLICIES as readonly string[]).includes(p)) {
          error(`--policy must be one of: ${POLICIES.join(', ')}`)
        }
        args.policy = p as Policy
        break
      }

      case '--shield-threshold': {
        i++
        const val = argv[i]
        const n = parseInt(val ?? '', 10)
        if (isNaN(n) || n < 0) {
          console.error(`Invalid --shield-threshold: ${val}`)
          process.exit(1)
        }
        args.shieldThreshold = n
        mark('shieldThreshold')
        break
      }
      case '--shield-dir':
        i++
        args.shieldDir = argv[i] ?? null
        mark('shieldDir')
        break
      case '--http-token':
      case '--insecure-http':
      case '--http-max-body-bytes':
        error(`${arg} was removed with the HTTP transport (0.1); serve is stdio-only`)
        break
      case '--secure-delete':
        args.secureDelete = true
        break
      case '--force':
        args.force = true
        break
      case '--capture':
        args.capture = true
        mark('capture')
        break
      case '--no-capture':
        args.capture = false
        mark('capture')
        break
      case '--sidecar':
        args.sidecar = true
        mark('sidecar')
        break
      case '--no-sidecar':
        args.sidecar = false
        mark('sidecar')
        break
      // Legacy code-tool flags (code index deleted 2026-07-25, see
      // features/OUT-OF-SCOPE.md): accepted as inert no-ops so
      // pre-deletion configs keep launching; the installer no longer
      // writes them.
      case '--code-index':
      case '--code-annotation':
      case '--no-code-index':
      case '--no-code-annotation':
      case '--code-hints':
      case '--no-code-hints':
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--dump-logs':
        args.dumpLogs = true
        break
      case '--agent': {
        i++
        const agentName = argv[i]
        if (agentName) {
          if (!args.installAgents) args.installAgents = []
          args.installAgents.push(agentName)
        }
        break
      }
      case '--experimental-capture':
        args.experimentalCapture = true
        break
      case '--hooks-only':
        args.hooksOnly = true
        break
      case '--npx':
        // The beta ships to npm under the `beta` dist-tag, which a bare
        // `npx -y` does not resolve: it would fetch `latest` (the name
        // reservation, not a build) and leave a config pointing at a server
        // that never starts. Refuse loudly rather than write a silently dead
        // entry.
        console.error(
          'treecontext: --npx is unavailable during the beta — npx resolves the latest tag, not the beta.\n' +
          '  Install the package globally instead:\n' +
          '    npm install -g treecontext-mcp@beta\n' +
          '  Then re-run `treecontext install` without --npx.',
        )
        process.exit(2)
        break
      case '--debug':
        args.debug = true
        mark('debug')
        break
      case '--no-debug':
        args.debug = false
        mark('debug')
        break
      case '--instructions': {
        i++
        const variant = argv[i]
        if (variant === 'verbose') {
          // Accepting a variant the build no longer has and silently
          // serving brief was the operator-facing twin of the
          // never-advertise rule (corpus audit D4).
          error("--instructions verbose was removed with the tree era (one backend, one instruction set); use brief")
        }
        if (variant !== 'brief' && variant !== 'none') {
          console.error(`Invalid --instructions value: ${variant ?? '(missing)'} (expected brief|none)`)
          process.exit(1)
        }
        args.instructions = variant
        mark('instructions')
        break
      }
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      case '--version':
        printVersion()
        process.exit(0)
        break
      default:
        if (arg.startsWith('-')) {
          error(`Unknown flag: ${arg}`)
        }
        // A bare positional no command claimed is a typo or a shell-split
        // name ('stores rm notes copy' arrives here as 'copy'), and
        // silently dropping it re-aims the command at whatever DID parse
        // — with --yes, at a store the user never named. Refuse instead.
        error(`Unexpected argument: ${arg}`)
    }
    i++
  }

  // Owner ruling 2026-08-01 (install charter: "experimental capture is an
  // opt-in by name"): the flag alone would opt in EVERY detected
  // unverified platform at once — refuse unless the platform is named.
  if (args.experimentalCapture && (!args.installAgents || args.installAgents.length === 0)) {
    error('--experimental-capture requires --agent <name>: capture on an unverified platform is an opt-in by name, not a blanket switch')
  }

  return args
}

function error(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function printUsage(): void {
  console.error(`treecontext — a searchable chat-session journal for AI coding agents

Usage:
  treecontext serve [options]
  treecontext install [-y] [--dry-run] [--force] [--agent <name>] [--experimental-capture (requires --agent)]
  treecontext uninstall [-y] [--dry-run] [--agent <name>] [--hooks-only]
  treecontext doctor
  treecontext doctor --dump-logs
  treecontext init [--force] [--dry-run]
  treecontext config checkpoint-interval <value> [--store X]
  treecontext hook <event>
  treecontext backup <dst> [--store X] [--force]
  treecontext export <path> [--whole --yes] [--force] [--store X] [--namespace N]
  treecontext import <path> [--store X] [--namespace N]
  treecontext ccr wire [--pane journal|threads|trail|all] [--dry-run] [--force]
  treecontext stores list|rm <name>|prune|sweep [--store X] [--yes]
  treecontext stores merge <src> <dst> [--backup] [--repoint] [--yes]

Commands:
  serve                Start the MCP server (stdio transport)
  install              Auto-detect coding agents and register treecontext MCP
  uninstall            Remove treecontext from all coding agents
  ccr wire             List this project's pane in ccr's config so its
                       sidecar can draw it (merges; never clobbers)
  doctor               Check installation health and dependencies
  doctor --dump-logs   Print recent debug logs (for sharing with developer)
  init                 Add treecontext instructions to AGENTS.md in current directory
  config checkpoint-interval <value>
                       How often the stop hook asks the agent for a bookmark,
                       for this directory's store: "20 rounds", "45 minutes",
                       "20 rounds or 45 minutes" (the default), or "off".
                       Echoes the setting back as it will behave.
  hook <event>         Dispatch a hook event (session-start, pre-compact, etc.)
  export <path>        Write a handoff file for a teammate: this project's
                       chapter summaries and subagent summaries, the same
                       file the export tool writes. --whole exports the
                       whole journal instead; captured tool output can
                       hold secrets, tokens and keys, so it writes only
                       with --yes after the warning. An existing file
                       that is not a handoff is never overwritten
                       unless --force is passed.
  import <path>        Import a teammate's handoff file into this
                       project's store. Everything new lands, anything
                       already present is left alone; every entry is
                       marked as imported from that file.
  backup <dst>         Live-backup the store to a new SQLite file.
                       Uses the SQLite Online Backup API for consistency.
                       Refuses to overwrite unless --force is passed.
  stores               Inspect and clean up ~/.treecontext/stores
                       list (default): show all stores
                       rm <name>: delete one store (requires --yes)
                       prune: delete stray home-hash stores with no leaves
                              (dry-run; requires --yes to delete)
                       merge <src> <dst>: copy every namespace of <src>
                              into <dst> when one project ended up with
                              two journals. <src> is never deleted.
                              --backup takes fresh backups of both first
                              (without it, a backup of both from today
                              must already exist); --repoint moves every
                              binding naming <src> to <dst>; --yes
                              confirms, like the other destructive ops.

Serve options:
  --transport <mode>   MCP transport: "stdio" (the only mode; HTTP removed in 0.1)
  --store <name>       Store name (default: auto-derived from project)
  --namespace <name>   Namespace within the store (default: project).
  --capture            Enable conversation capture ingestion loop.
                       Multi-agent workflows use distinct namespaces
                       per agent sharing one store.
  --no-sidecar         Do not write the sidecar panes (sidecar.json,
                       sidecar-threads.json) beside the store on each
                       drain. Written by default; only the server that
                       owns the drain writes them.
  --project-dir <dir>  Project directory for auto-store resolution
  --lexical            Force the lexical FTS5 bm25 backend explicitly (also
                       opens a tree-era store's rows over BM25). Without it,
                       the store's recorded mode decides; tree-era stores
                       refuse loudly (the tree backend no longer ships).
  --instructions <v>   Handshake instructions variant: brief (default)
                       or none (for clients whose SessionStart hook
                       already delivers the orientation trigger)
  --read-only          Shorthand for --policy read_only.
  --policy <name>      Tool-access policy (default: full):
                         full        — all 8 tools
                         read_only   — query/status/export
                         contributor — read_only + insert
                                       (no delete/clear/import)
  --shield-threshold N Byte threshold for output shielding (0 = disabled, default: 0)
  --shield-dir PATH    Directory for shielded output files (default: ~/.treecontext/shield)
  --secure-delete      PRAGMA secure_delete + wipe-on-clear: overwrite
                       deleted rows so they cannot be recovered from the
                       database file (see docs/security.md §3)

Install options:
  --agent <name>       Install for a specific agent only (repeatable)
  --force              Overwrite existing config even if already valid
  --npx                Unavailable during the beta (install globally instead)
  --experimental-capture
                       Also install capture hooks for agents whose adapter
                       is unverified (Copilot/VS Code). MCP tools always
                       install; this opts into unproven capture.

Uninstall options:
  --agent <name>       Uninstall for a specific agent only (repeatable)
  --hooks-only         Remove hook config but keep MCP registration,
                       instructions and the reference skill. Clears hooks
                       left behind on a platform install does not manage.

Common options:
  --config <path>      TOML config file. Auto-discovers
                       $TREECONTEXT_CONFIG, ./treecontext.toml, then
                       ~/.treecontext/config.toml when omitted.
  --debug              Verbose diagnostic output (default: on): to stderr
                       and ~/.treecontext/logs/; under serve, to the log
                       file only, stderr kept for warnings and errors.
                       Also enabled via TREECONTEXT_DEBUG=1 env var.
  --no-debug           Disable debug output.
  --help, -h           Show this help
  --version            Show version`)
}

function printVersion(): void {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname ?? '.', '../../package.json'), 'utf8'),
    ) as { version: string }
    console.error(`treecontext ${pkg.version}`)
  } catch {
    console.error('treecontext (unknown version)')
  }
}

// ── Auto-store resolution ──────────────────────────────────────────

export function resolveAutoStore(projectDir: string | null): string {
  const cwd = projectDir
    ?? process.env.TREECONTEXT_PROJECT_DIR
    ?? process.cwd()

  // Trust model: the project's store is picked by fingerprint, not by
  // a file inside the repo. A malicious checkout can no longer hijack
  // store selection by dropping a `.treecontext-store` (security S3).
  // Legacy sticky files are migrated one-time into bindings.json.
  const result = resolveStoreName(cwd, {
    onNewBinding: ({ store, source, fingerprint }) => {
      log(`Auto-store bound ${store} (fingerprint=${fingerprint}, source=${source})`)
    },
    onStickyMigrated: ({ projectRoot, store }) => {
      log(`Migrated legacy .treecontext-store (${projectRoot}) → bindings.json (${store})`)
    },
    // Succession is announced, never silent — the whole failure mode was
    // silence (R2, docs/project-identity.md §2).
    onSuccession: (info) => {
      if (info.kind === 'adopted') {
        log(`Journal carried forward: this project's ${info.fromIdentitySource} identity changed; `
          + `keeping store ${info.store}`)
      } else if (info.kind === 'predecessorDisclosed') {
        logWarning(`A predecessor journal exists at ${info.dir} (store ${info.store}); not auto-adopted `
          + '— run `treecontext doctor` to reunite them')
      } else {
        logWarning(`Predecessor journals disagree (${info.stores.join(', ')}); deriving a fresh store rather `
          + 'than guess which one this project owns')
      }
    },
  })
  if (result.source === 'binding') {
    log(`Store from binding: ${result.storeName}`)
  }
  return result.storeName
}

/**
 * Read-only twin of resolveAutoStore: answers from what is already bound
 * and never writes. For commands that describe or copy a store rather
 * than open one — `backup` used the write-through resolver and left a
 * minted binding behind for every unbound directory it ran from (ruling
 * 2026-08-15: backup resolves read-only and errors when unbound).
 */
export function lookupAutoStore(projectDir: string | null): string | null {
  const cwd = projectDir
    ?? process.env.TREECONTEXT_PROJECT_DIR
    ?? process.cwd()
  return lookupStoreName(cwd)
}

/**
 * True when serving `--store storeName` must be refused: a BARE name
 * (paths pass through untouched), no existing store directory, and a
 * name the CLI cannot address later. Ruling 2026-08-11 (fence:
 * features/OUT-OF-SCOPE.md): refuse at creation only — stores rm
 * and doctor's advice refuse out-of-class names, so letting creation
 * mint them built stores only hand-deletion could reclaim. Existing
 * stores open regardless: a guard that locks a tester out of data they
 * already have is the one thing this tool never does.
 */
export function refusesNewStoreName(storeName: string, storeDirExists: boolean): boolean {
  const bare = !storeName.includes('/') && !storeName.includes('\\') && !isAbsolute(storeName)
  return bare && !storeDirExists && !isCliAddressableStoreName(storeName)
}

export function resolveStorePath(storeName: string): string {
  // If it looks like a path (contains separators or is absolute), use as-is.
  // Check both forward and back slashes for cross-platform compatibility.
  if (storeName.includes('/') || storeName.includes('\\') || isAbsolute(storeName)) {
    return storeName
  }
  return join(STORES_DIR, storeName, 'treecontext.db')
}


/**
 * Every serve option that derives purely from parsed CLI args, in one
 * testable place. Corpus audit D1 (2026-08-12): five parsed options
 * were silently dropped at the startServer call — the HTTP transport
 * died unused and shielding shipped inert, while unit tests proved the
 * args side and server tests proved the server side. ANY new serve
 * flag must flow through here; serve-options.test.ts enumerates the
 * fields and fails when a CliArgs serve field goes missing.
 */
export function serveOptionsFrom(args: CliArgs): {
  transport: 'stdio'
  readOnly: boolean
  sidecar: boolean
  namespace: string
  instructions: 'brief' | 'none'
  shieldThreshold: number
  secureDelete: boolean
  shieldDir?: string
  policy?: Policy
  backend?: 'lexical'
  maxStoreBytes?: number
  maxSessions?: number
} {
  return {
    transport: args.transport,
    readOnly: args.readOnly,
    sidecar: args.sidecar,
    namespace: args.namespace,
    instructions: args.instructions,
    shieldThreshold: args.shieldThreshold,
    // Applied at the database wrap, not inside startServer — but carried
    // here so the D1 ratchet enumerates it: it was wired out-of-band at
    // the open site, exactly the shape that shipped shielding inert.
    secureDelete: args.secureDelete,
    ...(args.shieldDir ? { shieldDir: args.shieldDir } : {}),
    ...(args.policy ? { policy: args.policy } : {}),
    ...(args.lexical ? { backend: 'lexical' as const } : {}),
    ...retentionOptionsFrom(args),
  }
}

/** The config file's `[retention]` keys as store-open options (D141) —
 *  one spelling for every door that opens a store with a sweep behind it,
 *  which today is serve alone (import and merge never sweep). */
export function retentionOptionsFrom(args: CliArgs): { maxStoreBytes?: number; maxSessions?: number } {
  return {
    ...(args.maxStoreBytes !== null ? { maxStoreBytes: args.maxStoreBytes } : {}),
    ...(args.maxSessions !== null ? { maxSessions: args.maxSessions } : {}),
  }
}

/** True once this process is `serve`: from then on its informational
 *  lines are diagnostics and go through `dbg`, to the log file only (D258)
 *  — a line on a serving server's stderr reads as an error in the
 *  client's own log. Every other command keeps talking on stderr. */
let servingClient = false

function log(msg: string): void {
  if (servingClient) dbg('serve', msg)
  else console.error(`[treecontext] ${msg}`)
}

/** A line worth the operator's attention: stderr always, and the log file
 *  too while serving, so `doctor --dump-logs` keeps the whole story. */
function logWarning(msg: string): void {
  warn(`[treecontext] ${msg}`)
}

// ── Handoff commands (D199) ────────────────────────────────────────

/** The project directory, resolved exactly as the store is: `--project-dir`,
 *  then TREECONTEXT_PROJECT_DIR, then the working directory. */
export function resolveProjectDir(projectDir: string | null): string {
  return resolvePath(projectDir ?? process.env.TREECONTEXT_PROJECT_DIR ?? process.cwd())
}

/** A path for the file's head and labels: relative to the project when it
 *  lies inside it (as the tool door always does), absolute otherwise. */
function projectRelative(projectRoot: string, abs: string): string {
  const r = relativePath(projectRoot, abs)
  return r !== '' && r !== '..' && !r.startsWith(`..${pathSep}`) && !isAbsolute(r) ? r.split(pathSep).join('/') : abs
}

async function openHandoffStore(args: CliArgs, storeName: string, create: boolean): Promise<import('../memory-store.js').MemoryStore> {
  const dbPath = resolveStorePath(storeName)
  if (!existsSync(dbPath)) {
    if (!create) error(`no store at ${dbPath} — has this project used treecontext yet?`)
    // An import may be the first thing a project's journal ever holds.
    mkdirSync(join(dbPath, '..'), { recursive: true, mode: 0o700 })
  }
  const { default: BetterSqlite3 } = await import('better-sqlite3')
  const { wrapBetterSqlite } = await import('../persistence/better-sqlite.js')
  const { createMemoryStore } = await import('../memory-store-factory.js')
  const { ensureDbFileMode } = await import('../persistence/better-sqlite.js')
  // The store opens as serve opens it, so the same store and form write
  // the same file through either door.
  const store = await createMemoryStore({
    database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
    namespace: args.namespace,
    ownsDatabase: true,
    migrate: true,
    // No [retention] figures (D141 review): neither door through here can
    // sweep. Export only reads, and importJson copies through
    // persistedNode, never insert() — the valve's one trigger. The
    // project's server sweeps imported rows by the file's figures on its
    // next insert. Pinned in tests/server/retention-config.test.ts.
  })
  ensureDbFileMode(dbPath)
  return store
}

async function runExport(args: CliArgs): Promise<void> {
  const { buildHandoff, writeHandoffFile, isHandoffFile, SECRETS_WARNING } = await import('../handoff.js')
  // Read-only store resolution, like backup: exporting must not mint a
  // binding for whatever directory it ran in.
  const storeName = args.store ?? lookupAutoStore(args.projectDir)
  if (!storeName) {
    error('export found no store bound to this directory. Run it from a project '
      + 'that has used treecontext, or name the store: treecontext export <path> --store <name>')
  }
  const form = args.exportWhole ? 'whole' as const : 'summaries' as const
  const store = await openHandoffStore(args, storeName, false)
  try {
    if (form === 'whole' && !args.yes) {
      // D177: the warning comes before anything is written.
      const { total } = store.handoffRows('whole', 0)
      console.error(`treecontext: ${SECRETS_WARNING}`)
      console.error(`Nothing was written. To export the whole journal (${total} ${total === 1 ? 'entry' : 'entries'}) anyway, re-run with --whole --yes.`)
      process.exitCode = 1
      return
    }
    if (form === 'whole') console.error(`treecontext: ${SECRETS_WARNING}`)
    const project = resolveProjectDir(args.projectDir)
    let projectRoot = project
    try { projectRoot = realpathSync.native(project) } catch { /* as resolved */ }
    // A shell path is the shell's: relative to where the command ran.
    const abs = resolvePath(args.handoffPath!)
    let shown = projectRelative(projectRoot, abs)
    if (shown === abs) {
      // Compare through the real path of the file's directory too, so a
      // project reached through a link still names the file relatively.
      try { shown = projectRelative(projectRoot, join(realpathSync.native(dirOfPath(abs)), baseOfPath(abs))) } catch { /* not there yet */ }
    }
    // Never over a file that is not itself a handoff (D234), from a shell
    // too, unless the developer says --force.
    if (existsSync(abs) && !args.force && !isHandoffFile(abs)) {
      error(`${args.handoffPath} already exists and is not a treecontext handoff file; nothing was written (--force overwrites it)`)
    }
    const outsideProject = shown === abs
    const built = buildHandoff(store, {
      form, project: baseOfPath(project) || project,
      // A file outside the project is named by its basename alone: the
      // head is read on another machine, where this one's paths mean nothing.
      path: outsideProject ? baseOfPath(abs) : shown, outsideProject,
    })
    writeHandoffFile(abs, built.text)
    console.log(`Wrote ${built.entries} ${built.entries === 1 ? 'entry' : 'entries'} to ${shown}.`)
  } finally {
    await store.close()
  }
}

async function runImport(args: CliArgs): Promise<void> {
  const file = args.handoffPath!
  // The tree era's import read a Python msgpack dump; that file is not a
  // handoff, and saying so beats a JSON parse error.
  if (/\.msgpack$/i.test(file)) {
    error('`import` of a Python msgpack dump was removed with the tree era (deletion phase 2026-07-25); '
      + 'use a pre-deletion build: git tag pre-deletion-phase. `treecontext import <file>` now imports a handoff file.')
  }
  const { importToldMessage, exporterName } = await import('../handoff.js')
  const abs = resolvePath(file)
  let json: string
  try {
    json = readFileSync(abs, 'utf8')
  } catch (err) {
    error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const project = resolveProjectDir(args.projectDir)
  let projectRoot = project
  try { projectRoot = realpathSync.native(project) } catch { /* as resolved */ }
  let label = projectRelative(projectRoot, abs)
  if (label === abs) {
    try { label = projectRelative(projectRoot, realpathSync.native(abs)) } catch { /* as given */ }
  }
  // The import writes, so it resolves the store as the hooks and serve
  // do — the store this project's agent reads.
  const storeName = args.store ?? resolveAutoStore(args.projectDir)
  const store = await openHandoffStore(args, storeName, true)
  try {
    // A file read from a shell is still a handoff (D165, D222): marked as
    // imported from that file, the importer being this shell's user.
    let result: Awaited<ReturnType<typeof store.importJson>>
    try {
      result = await store.importJson(json, {
        label,
        readOnly: true,
        handoff: { file: label, importer: `shell:${exporterName()}` },
        fromFile: true,
      })
    } catch (err) {
      // Never echo a fragment of a file that is not a handoff (D234).
      if (err instanceof SyntaxError) error(`${file} is not a handoff file`)
      throw err
    }
    console.log(importToldMessage(result))
  } finally {
    await store.close()
  }
}


// Exported as a binding seam: the backup-{sweep,lifecycle}.feature
// scenarios assert what the stores commands SAY, and console output is
// only honest to test through the function that actually prints it.
export async function runStores(args: CliArgs): Promise<void> {
  const {
    listStores,
    pruneStrayStores,
    removeStore,
    describeStore,
    formatBytes,
    isLiveRollback,
    verdictLabel,
    DEFAULT_STORES_DIR,
  } = await import('../tools/stores.js')
  const { listMigrationBackups } = await import('../persistence/backup-verdict.js')

  if (args.storesAction === 'list') {
    const rows = listStores()
    if (rows.length === 0) {
      console.log(`No stores in ${DEFAULT_STORES_DIR}`)
      return
    }
    // SIZE is the database alone; BACKUPS is the pre-migration split —
    // at-a-glance only, doctor stays the authoritative disk-debt surface
    // (stores-list.feature; fence amendment 2026-08-12). NOTE labels the
    // two states a bare listing misreads: strays and spare-rule shells.
    const header = ['NAME', 'LEAVES', 'TOTAL', 'SIZE', 'BACKUPS', 'NOTE'].join('\t')
    console.log(header)
    for (const r of rows) {
      console.log([
        r.name,
        r.leafNodes ?? '-',
        r.totalNodes ?? '-',
        formatBytes(r.sizeBytes),
        // Presence, not bytes: a zero-byte backup (interrupted copy) must
        // still show, or a 'shell' row renders with an empty backups cell
        // (fifth-pass review).
        r.backups.length > 0 ? formatBytes(r.backupBytes) : '',
        r.shell ? 'shell' : r.stray ? 'stray' : '',
      ].join('\t'))
    }
    return
  }

  if (args.storesAction === 'rm') {
    const target = args.storesTarget
    if (!target) error('stores rm requires a store name')
    const storePath = join(DEFAULT_STORES_DIR, target)
    const desc = describeStore(storePath, target)

    // One spelling per outcome, shared by the shell and normal paths —
    // the two hand-written tails had drifted apart within a week of the
    // shell branch landing (second-pass review).
    const logWouldSpare = (b: MigrationBackup): void => {
      log(`Would leave ${b.fileName} behind (verdict: ${verdictLabel(b)}) — a live rollback.`)
    }
    const reportRemoval = (took: MigrationBackup[], spared: MigrationBackup[], failed: Array<{ name: string; error: string }>, shell: boolean): void => {
      if (failed.length > 0) {
        // Partial: name what stuck instead of claiming the directory
        // gone or losing the whole report to a generic fatal.
        log(`Could not fully remove ${storePath} — re-run after fixing the failures below.`)
      } else if (spared.length === 0) {
        log(`Removed ${storePath}`)
      } else {
        // "Removed <path>" for a directory still on disk is a lie the
        // next `stores list` exposes; say what actually happened.
        const s = spared.length > 1 ? 's' : ''
        log(shell
          ? `The directory at ${storePath} survives as a shell around the spared backup${s}.`
          : `Removed the database at ${storePath} — the directory survives as a shell around the spared backup${s}.`)
      }
      for (const b of took) {
        log(shell ? `Removed orphaned verified backup ${b.fileName}` : `Removed backup ${b.fileName}`)
      }
      for (const b of spared) {
        log(
          `Backup ${b.fileName} was left behind because its verdict is `
          + `${verdictLabel(b)} — it is a live rollback, remove it by hand.`,
        )
      }
      for (const f of failed) log(`Failed to remove ${f.name}: ${f.error}`)
      if (failed.length > 0) process.exitCode = 2
    }

    if (!desc.dbExists) {
      // A shell is not "no store": the database is gone but backups
      // remain. rm never takes a spared (live-rollback) backup — on the
      // first run or any later one — but a shell holding VERIFIED
      // backups is the reclaimable orphan state (ruling 2026-08-10):
      // explicit rm is exactly the by-hand act that removes it
      // (backup-lifecycle.feature). describeStore already enumerated the
      // backups — one walk, one truth (fifth-pass review).
      const shellBackups = desc.backups
      if (shellBackups.length > 0) {
        const orphans = shellBackups.filter((b) => !isLiveRollback(b))
        const rollbacks = shellBackups.filter(isLiveRollback)
        if (orphans.length === 0) {
          for (const b of rollbacks) {
            log(
              `Only a spared backup remains at ${storePath}: ${b.fileName} `
              + `(${formatBytes(b.sizeBytes)}, verdict: ${verdictLabel(b)}). `
              + `It is a live rollback — remove it by hand.`,
            )
          }
          process.exit(1)
        }
        if (!args.yes) {
          // With nothing spared, --yes removes the DIRECTORY — the
          // preview must say so, not only name the files inside it.
          if (rollbacks.length === 0) {
            log(
              `Would remove ${storePath} and its orphaned verified backup${orphans.length > 1 ? 's' : ''} `
              + `${orphans.map((b) => b.fileName).join(', ')} — its live store is gone. `
              + `Re-run with --yes to confirm.`,
            )
          } else {
            for (const b of orphans) {
              log(
                `Would remove orphaned verified backup ${b.fileName} `
                + `(${formatBytes(b.sizeBytes)}) — its live store is gone; the `
                + `directory survives as a shell. Re-run with --yes to confirm.`,
              )
            }
          }
          for (const b of rollbacks) logWouldSpare(b)
          return
        }
        const { took, spared, failed } = removeStore(storePath)
        reportRemoval(took, spared, failed, true)
        return
      }
      log(`No store at ${storePath}`)
      process.exit(1)
    }

    if (!args.yes) {
      // Preview facts come from describeStore's one enumeration; the
      // --yes path learns the same facts from removeStore itself.
      const backups = desc.backups
      const wouldTake = backups.filter((b) => !isLiveRollback(b))
      const wouldSpare = backups.filter(isLiveRollback)
      const taking = wouldTake.length > 0
        ? ` and its pre-migration backup${wouldTake.length > 1 ? 's' : ''} `
          + wouldTake.map((b) => b.fileName).join(', ')
        : ''
      log(
        `Would remove ${storePath} (${desc.leafNodes ?? '?'} leaves, `
        + `${formatBytes(desc.sizeBytes)})${taking}. Re-run with --yes to confirm.`,
      )
      for (const b of wouldSpare) logWouldSpare(b)
      return
    }
    const { took, spared, failed } = removeStore(storePath)
    reportRemoval(took, spared, failed, false)
    return
  }

  // Part 3 of the identity program (docs/project-identity.md §5, §11c):
  // two journals for one project become one. Every precondition lives in
  // the tool module and refuses with its own message; this branch is the
  // dispatch and the exit code.
  if (args.storesAction === 'merge') {
    const source = args.storesTarget
    const dest = args.storesTarget2
    if (!source || !dest) {
      error('stores merge requires a source and a destination store: treecontext stores merge <src> <dst>')
    }
    const { mergeStores } = await import('../tools/store-merge.js')
    const outcome = await mergeStores({
      src: source,
      dst: dest,
      storesDir: DEFAULT_STORES_DIR,
      backup: args.storesBackup,
      yes: args.yes,
      repoint: args.storesRepoint,
      log,
    })
    if (outcome.status === 'refused') error(outcome.message)
    return
  }

  if (args.storesAction === 'sweep') {
    const { sweepMigrationBackups } = await import('../tools/stores.js')
    // `--store` scopes the sweep to one store's backups. A bare NAME,
    // like rm's target — the sweep enumerates the stores root, so a
    // path here has nothing to name — and refused when no such store
    // exists: a typo silently sweeping nothing would read as "already
    // clean".
    if (args.store !== null) {
      if (!isCliAddressableStoreName(args.store)) {
        error('store name must match [A-Za-z0-9._-]+ (and not ".", "..", or start with "-")')
      }
      if (!existsSync(join(DEFAULT_STORES_DIR, args.store))) {
        error(`stores sweep found no store named '${args.store}' under ${DEFAULT_STORES_DIR}`)
      }
    }
    const result = sweepMigrationBackups(DEFAULT_STORES_DIR, {
      dryRun: !args.yes, ...(args.store !== null ? { store: args.store } : {}),
    })
    if (result.items.length === 0 && result.orphanSidecars.length === 0) {
      log(args.store !== null
        ? `No pre-migration backups found for store '${args.store}'.`
        : 'No pre-migration backups found.')
      return
    }
    if (!args.yes) {
      for (const item of result.items) {
        log(
          `${item.store}: ${item.backup.fileName} (${formatBytes(item.backup.sizeBytes)}) — `
          + (item.eligible ? 'eligible' : `refused: ${item.reason}`),
        )
      }
      for (const s of result.orphanSidecars) {
        log(`${s.store}: ${s.fileName} — orphaned verdict sidecar (its backup is gone); would remove`)
      }
      const eligible = result.items.filter((i) => i.eligible).length
      log(`Dry-run: ${eligible} of ${result.items.length} backup(s) eligible. Re-run with --yes to delete.`)
      return
    }
    for (const item of result.deleted) {
      log(`Deleted ${item.store}: ${item.backup.fileName} (${formatBytes(item.backup.sizeBytes)})`)
    }
    for (const { item, error: err } of result.failed) {
      log(`Failed to delete ${item.store}: ${item.backup.fileName} — ${err}`)
    }
    for (const s of result.orphanSidecars) {
      if (s.removed) log(`Removed orphaned verdict sidecar ${s.store}: ${s.fileName}`)
      else log(`Failed to remove orphaned verdict sidecar ${s.store}: ${s.fileName} — ${s.error}`)
    }
    for (const { item, error: err } of result.strandedSidecars) {
      log(
        `Note: the verdict sidecar of ${item.backup.fileName} could not be removed `
        + `(${err}) — a later sweep will reclaim it.`,
      )
    }
    const refused = result.items.filter((i) => !i.eligible)
    for (const item of refused) {
      log(`Refused ${item.store}: ${item.backup.fileName} — ${item.reason}`)
    }
    log(`${formatBytes(result.freedBytes)} freed`)
    // Refusals, failed backup deletions, and failed orphan-sidecar
    // removals in a --yes run are a partial completion, and the exit
    // status says so (backup-sweep.feature). A stranded sidecar is not:
    // its BACKUP was reclaimed, and the residue self-heals next sweep.
    const sidecarFailures = result.orphanSidecars.filter((s) => !s.removed).length
    if (refused.length > 0 || result.failed.length > 0 || sidecarFailures > 0) process.exitCode = 2
    return
  }

  // prune
  const { candidates, deleted, spared, errors } = pruneStrayStores(DEFAULT_STORES_DIR, {
    dryRun: !args.yes,
  })
  if (candidates.length === 0) {
    log('No stray stores found')
    return
  }
  if (!args.yes) {
    log(`Dry-run: ${candidates.length} stray store(s) would be removed:`)
    for (const c of candidates) {
      log(`  ${c.name} (${formatBytes(c.sizeBytes)})`)
      // The dry-run promises what --yes delivers, spare rule included —
      // a preview that hides the surviving shell undersells the outcome.
      for (const b of listMigrationBackups(c.path).filter(isLiveRollback)) {
        log(`    would leave ${b.fileName} behind (verdict: ${verdictLabel(b)}) — a live rollback.`)
      }
    }
    log('Re-run with --yes to actually delete')
    return
  }
  for (const name of deleted) log(`Removed ${name}`)
  for (const { name, backups } of spared) {
    log(`Removed the database of ${name} — the directory survives as a shell.`)
    for (const b of backups) {
      log(
        `${name}: backup ${b.fileName} was left behind because its verdict is `
        + `${verdictLabel(b)} — it is a live rollback, remove it by hand.`,
      )
    }
  }
  for (const { name, error: err } of errors) log(`Failed to remove ${name}: ${err}`)
  // A failed removal is a partial completion, same convention as the
  // sweep's exit 2 — `prune --yes && ...` must not sail past an EACCES.
  if (errors.length > 0) process.exitCode = 2
}

/**
 * Merge TOML-file values onto a CliArgs. Fields whose CLI flag was
 * explicitly provided (tracked via `args.provided`) win; otherwise the
 * config file replaces the hard-coded CliArgs default.
 */
export function applyConfigFile(args: CliArgs, cfg: LoadedConfig): void {
  const p = args.provided
  const s = cfg.server
  // transport/port/host config keys are tolerated but ignored: the HTTP
  // transport left in 0.1 (retired-section tolerance, same posture as
  // the tree-era keys).
  if (s.capture !== undefined && !p.has('capture')) args.capture = s.capture
  if (s.sidecar !== undefined && !p.has('sidecar')) args.sidecar = s.sidecar
  if (s.shieldThreshold !== undefined && !p.has('shieldThreshold')) {
    args.shieldThreshold = s.shieldThreshold
  }
  if (s.shieldDir !== undefined && !p.has('shieldDir')) {
    args.shieldDir = s.shieldDir
  }
  // [retention] (D141): config-only keys — no flag can shadow them.
  const r = cfg.retention ?? {}
  if (r.maxStoreBytes !== undefined) args.maxStoreBytes = r.maxStoreBytes
  if (r.maxSessions !== undefined) args.maxSessions = r.maxSessions
}

// ── stdio error disposition ─────────────────────────────────────────
//
// Two dispositions, and which one a command line earns is the whole
// point: a LONG-LIVED process whose peer walked away must survive it,
// and a ONE-SHOT command whose output did not land must say so.

/** Armed at most once — the hook fast path, hooks/shared.ts and the
 *  serve branch all reach for it, and a second pair of no-ops would
 *  only inflate the listener count. */
let stormProofed = false

/**
 * A dead stdio peer must never become an exception storm (spin bug,
 * diagnosed live 2026-08-30). Electron-family clients (VS Code's
 * Copilot CLI observed) abandon a spawned server's stderr socket
 * while stdin stays open; the next write raises EPIPE, which — with
 * no 'error' listener on the stream — becomes an uncaughtException,
 * whose handler logs to the same dead stream: a self-sustaining
 * 100%-CPU loop that not even SIGTERM can enter (CPU profile of a
 * live orphan was entirely Socket._write → ErrnoException →
 * console.error). A listener makes the failure inert: the stream
 * destroys itself and every later write is swallowed. stdout death
 * additionally ends a serve session — that shutdown wiring lives with
 * the other stdio-lifecycle handlers in server.ts; this guard is only
 * the storm-proofing.
 *
 * ONLY the storm-safety paths get it: serve, the hook fast path, and
 * (through hooks/shared.ts) the wrapper-dispatched hook entry points.
 * Arming it for every subcommand — as ab58c27 did, first thing in
 * main() — swallowed the write failures of ordinary one-shot commands
 * too, so `treecontext export <id> | head -1` printed a truncated
 * record and exited 0, indistinguishable from success (rc.6 review).
 * Those commands take armFailFastStdio instead.
 */
export function armStormProofStdio(): void {
  if (stormProofed) return
  stormProofed = true
  process.stdout.on('error', () => { /* peer gone; writes are no-ops now */ })
  process.stderr.on('error', () => { /* peer gone; writes are no-ops now */ })
}

/**
 * The disposition every OTHER subcommand earns: a write that failed is
 * not a write that happened. An early-closing consumer (`| head -1`) or
 * a full filesystem must leave a non-zero exit behind it, because
 * truncated output that exits 0 is a lie the caller cannot detect.
 *
 * `streams`/`exit` are injected only by the unit test — a real pipe
 * close is awkward to stage and the disposition is the whole claim.
 */
export function armFailFastStdio(
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  exit: (code: number) => void = process.exit,
): void {
  let dying = false
  const die = (name: 'stdout' | 'stderr') => (err: NodeJS.ErrnoException): void => {
    // One report, one exit: the line below writes to a stream that may
    // itself be the dead one, and its own error re-enters here.
    if (dying) return
    dying = true
    // EPIPE is the ordinary `treecontext export <id> | head -1` shape —
    // the consumer left, which is nothing the command did wrong and
    // needs no diagnostic. Anything else (ENOSPC on a full filesystem)
    // gets its one line. 141 is the shell's own spelling for a death on
    // a closed pipe (128 + SIGPIPE); everything else is a plain 1.
    if (err.code !== 'EPIPE') {
      try { streams.stderr.write(`[treecontext] ${name} write failed: ${err.message}\n`) } catch { /* the exit code says the rest */ }
    }
    exit(err.code === 'EPIPE' ? 141 : 1)
  }
  streams.stdout.on('error', die('stdout'))
  streams.stderr.on('error', die('stderr'))
}

async function main(): Promise<void> {
  // Hook fast path (ruling 2026-08-15: hook exits are NEVER non-zero).
  // A hook invocation is `<cli> hook <event>` — argv[2] is 'hook', the
  // ONE spelling the installed wrappers emit — and a hook consumes no
  // TOML, so it dispatches before parseArgs and before any config load.
  // Parse junk, a corrupt config file, a module that fails to load: all
  // exit 0 with the reason in the debug log (the wrapper discards
  // stderr anyway). Capture may be lost for a reason, never for a
  // formality. On the success path this returns without exiting: each
  // hook's main() finishes its async work on the event loop and exits 0
  // itself.
  //
  // The single spelling is the ring's boundary on purpose (F review
  // 2026-08-15): a flag-first `--no-debug hook <event>` used to route
  // through parseArgs, whose error() exits 1 — a hole in the guarantee
  // enforced by a second hand-copied dispatch block. Flags before the
  // hook token now make it an ordinary (refusable) command line, not a
  // hook.
  if (process.argv[2] === 'hook') {
    // Before the first write of the run: the host that spawned this hook
    // is exactly the Electron-family client that abandons stderr, and a
    // storm primed during startup is the same storm.
    armStormProofStdio()
    try {
      const { enableDebug } = await import('../debug.js')
      enableDebug()
      const { dispatchHook } = await import('./hook-dispatch.js')
      const evt = process.argv[3]
      await dispatchHook(evt && !evt.startsWith('-') ? evt : '')
    } catch (err) {
      try {
        const { logFatal } = await import('../debug.js')
        logFatal('hook', err)
      } catch { /* the exit code stays 0 regardless */ }
      process.exit(0)
    }
    return
  }

  const args = parseArgs(process.argv)

  // The stdio disposition, chosen the moment the command is known and
  // before the first `log()` line: serve outlives its peer and must
  // never storm, every other command is a one-shot whose output IS its
  // result. The sliver ahead of this — parseArgs itself — writes only
  // on the refusal paths, which exit non-zero either way.
  if (args.command === 'serve') armStormProofStdio()
  else armFailFastStdio()
  // A serving server keeps stderr for warnings, errors and fatals; its
  // diagnostics, the startup facts included, go to the log file (D258).
  servingClient = args.command === 'serve'

  // Enable debug logging unless explicitly disabled.
  // Default is on so users get diagnostics without extra config.
  if (args.debug || process.env.TREECONTEXT_DEBUG === '1') {
    const { enableDebug } = await import('../debug.js')
    // A dry run must leave the disk exactly as it found it — diagnosis still
    // goes to stderr, it just does not open a log file to say so. A
    // serving server writes its diagnosis to the file alone (D258).
    enableDebug({ stderrOnly: args.dryRun, fileOnly: servingClient })
    args.debug = true
  }

  const { loadConfigFile } = await import('./config.js')
  let cfg: import('./config.js').LoadedConfig
  try {
    cfg = loadConfigFile(args.configPath, args.projectDir ?? undefined)
  } catch (err) {
    // doctor exists to diagnose exactly this file, and install carries
    // the purpose-built repair (side-file + fresh template) — dying at
    // config load left BOTH fix channels blocked by the problem they
    // fix (F2 + F review, 2026-08-15). uninstall consumes no TOML
    // either; a corrupt config must not be able to hold it hostage.
    // Every other command still fails loudly — an operator who asked
    // for that configuration deserves the error.
    if (args.command !== 'doctor' && args.command !== 'install' && args.command !== 'uninstall') throw err
    log(`Config unreadable, continuing without it: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    cfg = { server: {}, retention: {}, path: null }
  }
  if (cfg.path) log(`Config: ${cfg.path}`)
  applyConfigFile(args, cfg)

  if (args.command === 'install') {
    const { install } = await import('./installer.js')
    await install({
      yes: args.yes,
      dryRun: args.dryRun,
      force: args.force,
      agents: args.installAgents,
      useNpx: args.useNpx,
      debug: args.debug,
      // Lexical is the current default backend for treecontext; write it into
      // agent configs unless the user explicitly opted out with --no-lexical.
      // (The low-level `serve` command stays explicit — configs always pass
      // the flag, so a wrapper-launched server runs lexical regardless.)
      lexical: args.provided.has('lexical') ? args.lexical : true,
      experimentalCapture: args.experimentalCapture,
    })
    return
  }

  if (args.command === 'uninstall') {
    const { uninstall } = await import('./installer.js')
    const removed = await uninstall({
      yes: args.yes,
      dryRun: args.dryRun,
      agents: args.installAgents,
      hooksOnly: args.hooksOnly,
    })
    // A refused part (scripts a copy still runs) is not a finished uninstall.
    if (removed.some(r => r.refused)) process.exitCode = 1
    return
  }

  if (args.command === 'doctor') {
    // --dump-logs ADDS the logs; it does not replace the diagnosis. It used
    // to substitute, and doctor's own closing text tells the user to send
    // that output to the developer — so the flag meant for reporting a bug
    // stripped out the only part that diagnoses one. A Windows beta report
    // arrived as five near-empty log files and no checks, and the broken
    // hook paths it was sent to explain were sitting in a check that never
    // ran.
    const { doctor, dumpDebugLogs } = await import('./installer.js')
    await doctor()
    if (args.dumpLogs) await dumpDebugLogs()
    return
  }

  if (args.command === 'init') {
    const { upsertInstructions } = await import('./installer.js')
    const target = join(process.cwd(), 'AGENTS.md')
    const result = upsertInstructions(target, args.force, args.dryRun)
    if (result.status === 'skipped') {
      console.log(`${target} already contains treecontext instructions (use --force to update)`)
    } else if (result.status === 'dry-run') {
      console.log(`Would ${existsSync(target) ? 'update' : 'create'}: ${target}`)
    } else {
      console.log(`${result.status}: ${target}`)
    }
    return
  }

  if (args.command === 'config') {
    const { parseCheckpointInterval, describeCheckpointInterval, writeCheckpointInterval } = await import('../checkpoints.js')
    const interval = parseCheckpointInterval(args.configValue ?? '')
    if (interval === null) {
      error(`checkpoint-interval: ${JSON.stringify(args.configValue)} names no interval — say it in rounds and or minutes, e.g. "20 rounds or 45 minutes", or "off"`)
    }
    // The same resolution the hooks use, so the setting lands in exactly
    // the store whose Stop hook reads it.
    const storeName = args.store ?? resolveAutoStore(args.projectDir)
    const dbPath = resolveStorePath(storeName)
    const { openHookDb } = await import('../hooks/shared.js')
    const db = openHookDb(dbPath)
    try {
      writeCheckpointInterval(db, interval, args.configValue!)
    } finally {
      db.close()
    }
    console.log(`checkpoint interval: ${describeCheckpointInterval(interval)}`)
    console.log(`(store "${storeName}": ${dbPath})`)
    return
  }

  if (args.command === 'export') {
    await runExport(args)
    return
  }

  if (args.command === 'import') {
    await runImport(args)
    return
  }

  if (args.command === 'backup') {
    if (!args.backupDst) error('backup requires a destination path: treecontext backup <dst>')
    const { backupStore } = await import('../persistence/backup.js')
    // Read-only resolution (ruling 2026-08-15): copying a store must not
    // mint a binding for the directory it happens to run from.
    const storeName = args.store ?? lookupAutoStore(args.projectDir)
    if (!storeName) {
      error('backup found no store bound to this directory. Run it from a project '
        + 'that has used treecontext, or name the store: treecontext backup <dst> --store <name>')
    }
    const srcPath = resolveStorePath(storeName)
    log(`Backing up ${srcPath} → ${args.backupDst}`)
    await backupStore(srcPath, args.backupDst, { force: args.force })
    log('Backup complete')
    return
  }

  if (args.command === 'embed') {
    error('`embed` was removed with the tree era (deletion phase 2026-07-25); the lexical backend needs no embedder')
  }

  if (args.command === 'ccr') {
    const {
      ccrConfigPath, planWire, applyWire, panePathsFor, cycleHint, ccrInstanceDirs, toJsonPath,
    } = await import('./ccr-pane.js')
    // Read-only store resolution, the same ruling backup follows: naming a
    // pane must not mint a binding for the directory it happened to run in.
    const storeName = args.store ?? lookupAutoStore(args.projectDir)
    if (!storeName) {
      error('ccr wire found no store bound to this directory. Run it from a project '
        + 'that has used treecontext, or name the store: treecontext ccr wire --store <name>')
    }
    // A store NAME, not a path: joined onto the stores root below, an
    // unvalidated `../..` names a pane outside the tree and writes that
    // path into another program's config. Same guard the other
    // store-addressing commands apply (S9).
    if (!isCliAddressableStoreName(storeName)) {
      error(`ccr wire: ${JSON.stringify(storeName)} is not a store name this command can address`)
    }
    const storeDir = join(STORES_DIR, storeName)
    const panePaths = panePathsFor(storeDir, args.ccrPanes)
    const configPath = ccrConfigPath()
    const plan = planWire({ panePaths, configPath, force: args.force })
    if (plan.refusal !== null) error(plan.refusal)

    if (args.dryRun) {
      log(`Dry run — would write ${configPath}:`)
      log(plan.content ?? '(no change: this project\'s pane is already listed)')
    } else if (plan.content === null) {
      log(`Already wired: ${configPath} lists this project's pane${plan.alreadyPresent.length > 1 ? 's' : ''}.`)
    } else {
      applyWire(plan)
      if (plan.backedUpTo !== null) log(`Moved the unreadable config aside to ${plan.backedUpTo}`)
      if (plan.repairedEncoding !== null) {
        log(`Rewrote the config as BOM-free UTF-8 (it was ${plan.repairedEncoding === 'bom' ? 'UTF-8 with a byte-order mark' : 'UTF-16'}, which ccr reads as "no panes configured")`)
      }
      if (plan.repairedEntries > 0) {
        log(`Rewrote ${plan.repairedEntries} bare-string pane entr${plan.repairedEntries === 1 ? 'y' : 'ies'} into the { "path": ... } shape ccr reads — they were being skipped`)
      }
      for (const added of plan.added) log(`Wired ${toJsonPath(added)} into ${configPath}`)
      for (const already of plan.alreadyPresent) log(`Already listed: ${toJsonPath(already)}`)
    }

    // The pane file itself, and the step no config can substitute for.
    const missing = panePaths.filter((p) => !existsSync(p))
    if (missing.length > 0) {
      log(`Note: ${missing.length === panePaths.length ? 'no pane file exists yet' : 'one pane file does not exist yet'} — treecontext writes them on the first drain of a session in this project. ccr shows "waiting for first blob" until then.`)
    }
    const hint = cycleHint()
    log(`To see it: ${hint.move} (${hint.host}). Views cycle economy → git → your panes.`)
    if (ccrInstanceDirs().length === 0) {
      log('No ccr instance directory found under ~/.ccr/instances — start the sidecar with `ccr` in your project first.')
    }
    return
  }


  if (args.command === 'stores') {
    await runStores(args)
    return
  }

  if (args.command === 'viz') {
    error('`viz` was removed with the tree era (deletion phase 2026-07-25)')
  }

  if (args.command === 'daemon') {
    error('`daemon` was removed with the tree era (deletion phase 2026-07-25); serve runs standalone per session')
  }

  if (args.command !== 'serve') {
    error(`Unknown command: ${args.command}`)
  }

  // Security: fall back to env var for HTTP token to avoid exposing
  // secrets via process.argv (visible in /proc/<pid>/cmdline).

  // Resolve store path
  const storeName = args.store ?? resolveAutoStore(args.projectDir)
  const storePath = resolveStorePath(storeName)
  const storeDir = join(storePath, '..')
  // Refuse-at-creation (ruling 2026-08-11): only an explicit --store can
  // mint an unaddressable name — autostore names are generated in-class.
  if (args.store !== null && refusesNewStoreName(args.store, existsSync(storeDir))) {
    error(
      `--store would create a new store named ${JSON.stringify(args.store)}, which the CLI `
      + 'could never address again (stores rm and doctor advice refuse it). Store names '
      + 'must match [A-Za-z0-9._-]+ and not be ".", "..", or start with "-". '
      + 'Existing stores are unaffected and still open.',
    )
  }
  mkdirSync(storeDir, { recursive: true, mode: 0o700 })

  log(`Store: ${storePath}`)
  log(`Namespace: ${args.namespace}`)
  log(`Transport: ${args.transport}`)
  log(`Mode: ${args.capture ? 'conversation-indexer' : 'standard'}`)
  log(`Policy: ${effectivePolicy(args.policy, args.readOnly)}`)


  // Open the store and serve it directly. The factory resolves the
  // store's recorded mode: lexical (or fresh) opens as a FlatStore;
  // a tree-era store refuses loudly unless --lexical explicitly forces
  // BM25 over its rows (the tree backend left in the deletion phase,
  // 2026-07-25 — recover via the pre-deletion-phase tag).
  {
    const { default: BetterSqlite3 } = await import('better-sqlite3')
    const { wrapBetterSqlite, ensureDbFileMode } = await import('../persistence/better-sqlite.js')
    const { startServer } = await import('./server.js')
    const { LeaseClient, tryClaim, NS_LEASE_TTL_SECS, DRAIN_LEASE_TTL_SECS, LEASE_RENEW_INTERVAL_MS } = await import(
      '../persistence/leases.js'
    )
    const { hostname } = await import('node:os')
    // One options object for the whole serve path: the wrap below and the
    // startServer call read the SAME seam the D1 ratchet enumerates.
    const serveOpts = serveOptionsFrom(args)
    const raw = new BetterSqlite3(storePath)
    const db = wrapBetterSqlite(raw, { secureDelete: serveOpts.secureDelete })
    ensureDbFileMode(storePath)
    log(`Lexical journal (FTS5 bm25, no embedder) — store: ${storePath}`)
    // Two writer roles, coordinated through the store's lease table (G4;
    // tests/server/design/store-as-arbiter.md §3 — the C2 lockfiles are
    // gone, one arbiter):
    //
    // TOOL WRITER — ns:<namespace>, one per (store, namespace). Since G2
    // correctness is constraint-enforced in the store, and since
    // amendment 8 (2026-08-20) this lease gates nothing a tool call
    // needs: it is the namespace's PRIMARY CLAIM — doctor visibility,
    // clean-exit release, the hook ladder's pid-rung corroboration, and
    // sweep singularity. Servers on different namespaces coexist; so
    // now do two servers on the same one, the second serving without
    // the claim. Lease semantics: try at startup; tool calls re-attempt
    // lazily (via lockHook — a re-acquire past the freshness window
    // heartbeats; within it, it skips the write entirely) so a
    // non-holder keeps the claim reachable and takes it over when the
    // holder's heartbeats stop.
    //
    // DRAIN OWNER — 'drain', one per store, serving every namespace (the
    // drain attributes each staged row to its stamped namespace, C1).
    // Efficiency, not correctness: G3's claims make a second drain safe,
    // just wasteful. Only contested by a server that would actually
    // drain (program-C review, finding 2). Decided once at startup.
    const { StoreLockedError } = await import('../errors/index.js')
    // Migrations run BEFORE lease acquisition: the lease table itself is
    // schema (021), and a fresh or behind store has no rows to arbitrate
    // with until the ladder has run. startServer's own migrate pass then
    // no-ops.
    const { runMigrations, ensureBaseSchema } = await import('../persistence/migrations.js')
    // A brand-new file gets the base schema BEFORE the ladder, exactly
    // as the library open (Persistence.openLexical) does — one shared
    // definition of "fresh" (version 0 AND empty sqlite_master, decided
    // under a transaction; pass-2 review 2026-08-15). Running the raw
    // ladder on a schema-less db minted a pre-migration-v0.bak of a 4KB
    // empty file that no verdict could ever be recorded against —
    // doctor then warned about it forever.
    ensureBaseSchema(db)
    runMigrations(db, { migrate: true })
    // Pre-G4 lockfiles are dead weight once the store is at the arbiter
    // schema (old binaries refuse it outright), and an orphan would only
    // mislead an operator following the old docs. Best-effort.
    try {
      const { readdirSync, rmSync: rmFile } = await import('node:fs')
      const { dirname: dirOf, join: joinPath } = await import('node:path')
      const storeDir = dirOf(storePath)
      for (const f of readdirSync(storeDir)) {
        if (f === '.treecontext.lock' || /^\.treecontext\.ns-.*\.lock$/.test(f)) {
          rmFile(joinPath(storeDir, f), { force: true })
        }
      }
    } catch {
      /* cleanup only */
    }
    const leases = new LeaseClient(db, { pid: process.pid, host: hostname(), label: `serve:${args.namespace}` })
    // Contention is not a refusal (amendment 8, 2026-08-20): a live
    // holder keeps the primary claim and this server serves alongside
    // it, so the tool call proceeds. The swallow itself lives in
    // tryClaim — one production spelling, shared with the corpus
    // bindings — which still lets a real DB failure surface as itself
    // (program-C review, finding 8).
    let holdsClaim = false
    const tryLock = (): void => {
      holdsClaim = tryClaim(leases, `ns:${args.namespace}`, NS_LEASE_TTL_SECS)
    }
    tryLock()
    if (!holdsClaim) {
      log(`Another treecontext server holds the primary claim on namespace '${args.namespace}' of this store — serving alongside it; the store arbitrates writes.`)
    }
    // The drain role is arbitrated PER TICK inside the ingestion loop
    // (G4 review, finding 1): a one-shot startup acquisition left a
    // crash-restarted server refused by its predecessor's stale lease
    // and captureless for its whole lifetime. Per-tick acquisition is
    // the heartbeat, self-heals within one TTL, and lets a standby
    // --capture server take over when the owner dies. A non-capture
    // server still never contests the role (program-C review, finding
    // 2): it constructs no loop.
    // Gate on the EFFECTIVE capture state, not the flag alone: a
    // --capture --read-only server constructs no ingestion loop, and
    // acquiring the drain here made it squat the lease for its whole
    // lifetime (the renew timer heartbeats every held role) while
    // staging grew unboundedly and a real capture server was refused
    // per tick (release-diff review 2026-08-15).
    if (captureEnabled(args.capture, effectivePolicy(args.policy, args.readOnly))) {
      try {
        leases.tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
        log('Capture drain: this server holds the drain lease.')
      } catch (err) {
        if (!(err instanceof StoreLockedError)) throw err
        log("Another treecontext server currently owns this store's capture drain — standing by; the drain lease is re-attempted every tick.")
      }
    }
    // The renewal timer is the heartbeat — an idle server never expires
    // while alive; a SIGKILLed one frees its roles within one TTL. On
    // clean exit the roles release synchronously (better-sqlite3 is
    // sync, so exit handlers CAN write) — delete-if-mine in the write
    // transaction, no unlink race.
    const renewTimer = setInterval(() => {
      try {
        leases.renewAll()
      } catch {
        /* renewal is best-effort; the TTL bounds the damage */
      }
    }, LEASE_RENEW_INTERVAL_MS)
    renewTimer.unref()
    const releaseLeases = (): void => {
      clearInterval(renewTimer)
      try {
        leases.releaseAll()
      } catch {
        /* store already closed — TTL expiry covers it */
      }
    }
    // Graceful shutdown releases via the server's own shutdown sequence
    // (before the db closes); the 'exit' hook is the last resort for
    // paths that bypass it — a no-op if the db is already closed.
    // Residual window, accepted: a SIGNAL between here and the server's
    // handler installation dies at default disposition (no 'exit'
    // hooks), stranding roles for one TTL — bounded at 90s for the
    // namespace, and the drain self-heals per tick regardless.
    process.once('exit', releaseLeases)
    await startServer({
      database: db,
      migrate: true,
      ...serveOpts,
      // Runtime-derived, not args-derived: capture requires owning the
      // drain, and info carries resolved paths.
      capture: args.capture,
      lockHook: tryLock,
      onShutdown: releaseLeases,
      // The maintenance heartbeat derives from this client inside
      // startServer (pass-2: one fact, one wiring).
      drainLease: { client: leases, ttlSecs: DRAIN_LEASE_TTL_SECS },
      info: { storeName, storePath, namespace: args.namespace, modelName: null },
      // The one place the tools may read or write a handoff file (D199):
      // the directory this store was resolved for, never the agent's word.
      projectDir: resolveProjectDir(args.projectDir),
    })
    return
  }


}

/**
 * True when this module is the process entrypoint rather than an import.
 *
 * Both sides must be compared through realpath. A global npm install puts a
 * *symlink* on PATH (~/.local/bin/treecontext -> .../lib/node_modules/
 * treecontext/dist/server/cli.js), so `argv[1]` is the symlink while
 * `import.meta.url` has already been realpath-resolved by the ESM loader.
 * Comparing with resolve() alone never matches, so main() never ran and every
 * subcommand printed nothing and exited 0 — which is what 0.0.9-beta shipped.
 * Windows escaped it because npm writes a .cmd shim naming the real file
 * instead of a symlink.
 *
 * Paths that cannot be realpath'd (deleted, permission-denied) fall back to
 * the plain resolved form, which is the pre-existing behaviour.
 */
export function isEntrypoint(entry: string | undefined, selfPath: string): boolean {
  if (!entry) return false
  try {
    // Plain comparison first: it settles the common case without touching the
    // filesystem, and it still answers correctly when realpath is unavailable
    // on one side but not the other (a permission-denied parent directory
    // would otherwise normalize only one path and produce a false negative —
    // the same silent no-op this function exists to prevent).
    const absEntry = resolvePath(entry)
    const absSelf = resolvePath(selfPath)
    if (absEntry === absSelf) return true

    const norm = (p: string): string => {
      try {
        return realpathSync.native(p)
      } catch {
        return p
      }
    }
    return norm(absSelf) === norm(absEntry)
  } catch {
    return false
  }
}

// Only run main() when executed directly (not when imported as a module).
// Without this guard, test suites that import helpers from cli.ts would
// trigger the full CLI startup path as a side effect.
const invokedAsScript = isEntrypoint(process.argv[1], fileURLToPath(import.meta.url))
if (invokedAsScript) {
  main().catch(async (err) => {
    // Record before printing. stderr is invisible to an MCP host — a server
    // that dies during startup surfaces to Claude Code only as "-32000:
    // Connection closed", so the log file is the sole channel that survives
    // to `treecontext doctor --dump-logs`.
    try {
      const { logFatal } = await import('../debug.js')
      logFatal(process.argv[2] ?? 'cli', err)
    } catch { /* never let logging mask the real error */ }
    // D5: sanitize paths in production fatal errors; surface StoreLockedError cleanly
    if (err && typeof err === 'object' && 'code' in err && err.code === 'STORE_LOCKED') {
      console.error(`[treecontext] ${err.message}`)
    } else if (process.env.NODE_ENV === 'development' || process.env.TREECONTEXT_LOG === 'debug') {
      console.error('[treecontext] Fatal:', err)
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      const { redactHome } = await import('../debug.js')
      console.error('[treecontext] Fatal:', redactHome(msg))
    }
    process.exit(1)
  })
}
