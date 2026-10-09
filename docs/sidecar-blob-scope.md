# Sidecar blob — scope and build record (2026-08-04)

> **Built.** `src/server/sidecar-blob.ts` (the producer), `FlatStore.vitals()`
> (the facts it stands on), the drain hook in `src/server/ingestion.ts`, the
> wiring in `src/server/server.ts`, and `features/journal-sidecar.feature`
> — eleven scenarios, all bound, suite 959 passed. Rulings 1 and 3 were taken
> as proposed and are recorded below; ruling 2 shipped as a `doctor` line.
> Two panes ship: `journal` and `threads`. `trail` and `stores` did not.

treecontext becomes a **pane-blob producer** for the ccr sidecar, under
`ccr/docs/PANE-CONTRACT.md` v1. gherkin-trace is the existing producer; this
adds a second. No ccr change is required and none is proposed: the entire
interface is a JSON file tc writes beside its own store, plus one line the user
adds to `~/.config/ccr/config.json`.

```
~/.treecontext/stores/<store>/          ccr sidecar
  treecontext.db                        ┌──────────────────────────┐
  sidecar.json         ────────────────►│ read · verify · draw     │
  sidecar-threads.json ────────────────►│ (whole-pane cycle views) │
   (written by the drain tick)          └──────────────────────────┘
```

## What the wrapper had, and what of it survives

The original `treecontext-mcp/wrapper/sidecar/` shipped six renderers over three
signals. Most of it does not come back, and the reasons are worth stating so
they are not re-litigated.

| wrapper | fate | why |
| --- | --- | --- |
| `tree-art` | **dead** | `max_depth` is 0. There is no tree to draw. Independently, the contract's permanent fence forbids producer-shipped whole-pane layouts, so it could not return in its old form even if the data existed. |
| `activity` | **cut** | ccr's own live feed already tails the transcript for tool/skill events, and does it better — from the transcript, not from `staging`. |
| `economy`, `pressureLines`, `sessionLine`, git | **cut** | That is ccr's view 1. Duplicating it in a tc pane would put two answers to the same question in one cycle. |
| `ekg`, `heartbeat`, `sparklines` | **collapsed** | These were three *animations of the same three signals*, selected by a style file. Under the contract the producer writes values and ccr redraws them: there is no animation channel and no producer-side render. The cycle is now over **subjects**, not styles — which is a strict gain: six styles of one dataset becomes N panes of different data. |
| `L3` snapshot lifecycle | **folded away** | Snapshots have shrunk to session-start rehydration. Not a row family of its own. |
| `L2` capture liveness | **survives — the core** | Still the single most valuable thing a tc pane can answer: *is this session actually being captured?* |
| `L1` manual-insert cadence | **survives** | The one actionable nudge. tc's own instructions say "write at natural breaks"; nothing else measures whether that is happening. |
| `execSync('sqlite3 …')` per 1s tick | **gone by construction** | The old sidecar shelled into the store from the draw loop, per renderer. The contract replaces that with the producer computing at its own moment and dropping a file. This is the durable half of the seam. |

New, with no wrapper ancestor: **resume-pointer threads**, supersession
hygiene, capture gaps, and the exit-type mix of the captured trail.

## Where the producer lives

**Inside the server process, on the `IngestionLoop` drain tick** (5 s default),
plus once at server start.

- The contract names "a drain" as an example of a natural moment. This is that.
- The server already holds the store open; the blob costs a handful of indexed
  `COUNT`s, no new process and no new lock.
- Node `content` is not plaintext — it is `Buffer([flag, …payload])`, zstd
  under flag `0x01` (`persistence/content-codec.ts`). Any producer outside tc
  has to reimplement the codec to read a thread's first line. The server just
  reads the store. (Confirmed the hard way while prototyping.)
- **Guarded by `drainOwner`** (`server/cli.ts:830`). A second server on the
  same store has `capture: false` and therefore no natural moment; it must
  write **no blob at all**. Without this guard a non-owner would overwrite a
  live panel with numbers from a drain it never ran.

Rejected:

- **The hooks.** `post-tool-use` is a per-invocation process on the latency
  path of every tool call. Aggregate queries do not belong there.
- **A `treecontext sidecar` CLI.** The blob would be exactly as fresh as the
  last time someone remembered to run it, and ccr never triggers producers.

Paths, owner-only (`~/.treecontext/stores/` is already `0700`):

- `~/.treecontext/stores/<store>/sidecar.json` — the journal pane
- `~/.treecontext/stores/<store>/sidecar-threads.json` — the threads pane

Basis: `{ "label": "drain", "at": "<YYYY-MM-DD HH:MM>" }`.

## The panes

Four were prototyped against the live store and rendered through ccr's real
verifier and renderer. Two are proposed for v1.

**`journal` — v1.** Is memory working right now? Row floor: `capture`, `drain`,
`requeued`, `gaps`, `curated`, `threads`, `journal` — every family present in
every state, `dark` when tc cannot tell.

**`threads` — v1.** What am I in the middle of? One row per open resume
pointer, then the recently superseded ones dim. This is the pane no other tool
can draw, and it is the one that makes the session-start protocol visible
between sessions rather than only at cold start.

**`trail` — v1.1, optional.** Is the captured trail worth reading? Exit-type
mix (success / soft-fail / error), user-turn intent mix, preview-vs-full-tail
fidelity, embedding backend as an honest `dark`.

**`stores` — recommend cutting.** A cross-store inventory in a per-store blob
has no honest author: whichever server happens to be running would be
describing directories it does not own, on data it did not compute. This wants
to be a `treecontext stores` CLI table, not a pane.

## Rulings — how they were taken

1. **Windows over a moving clock. TAKEN AS PROPOSED.** Every window is
   measured from the basis moment, which is an *argument* to
   `FlatStore.vitals(atSec)` and to the producer — neither reads the clock.
   Two scenarios pin it: identical panes for the same journal and moment,
   and a different pane for a different moment (which is what proves any of
   it is anchored to the basis at all rather than to nothing).

2. **Store-name discoverability. SHIPPED AS A DOCTOR LINE.** `treecontext
   doctor` now reports `Sidecar pane: <path>` for the store bound to the
   current directory, and says "(written on the first drain)" when no pane
   exists yet. Reported, never checked — an absent pane is the honest state
   before a drain, not a fault.

3. **Default on. TAKEN.** Panes are written unless `--no-sidecar` or
   `sidecar = false` in config. They live inside treecontext's own `0700`
   store directory and cost two small files per drain. Reversing this is a
   one-line default change.

The one thing ruling 1 does *not* settle is whether ccr's contract should
say this out loud. Its wording ("values are functions of the producer's
data, never of the current wall clock") is aimed at a value that drifts
while the file does not, which this design avoids — but a producer whose
data *is* a time series has to reason it out from scratch, as this one did.
A sentence in the contract's field rules would save the next producer the
derivation. That is ccr's call, not treecontext's.

## Frictions found in contract v1

Neither is a blocker; both shaped the prototypes.

- **The label column caps at 20 characters** (`ccr/src/render/pane.js:145`).
  A list-shaped view cannot put its subject in the label. The threads pane
  works around it by putting the age in `label` and the topic in `value`,
  which reads acceptably but inverts the natural order.
- **At a 48-column sidebar, `detail` is mostly clipped.** Design rule for
  tc's rows: `detail` is a bonus, never load-bearing. A row must be readable
  from marker + label + value alone.

## Producer obligations tc must meet

Straight from the contract, all six, plus the two tc-specific ones:

1. Atomic write-aside + rename, temp file in the same directory.
2. The store dir is tc's own and already 0700. Never write into `~/.ccr`.
3. **Confess.** A drain that *fails* rewrites the blob with `status:"broken"`
   and a message. A drain that is *refused* (not the owner, store locked)
   leaves the blob untouched — and a non-owner never writes a first one.
4. State the basis (`drain`, and its moment).
5. Store artifacts first, blob last.
6. `stripControl` at the source. Thread topics and content first-lines are
   **agent-authored text**, and node content is influenced by whatever passed
   through the transcript. ccr strips again; stripping twice is the point.
   Truncate topics at the source too.

## What was built

| Where | What |
| --- | --- |
| `src/core/types.ts` | `JournalVitals`, `OpenThread` |
| `src/flat-store.ts` | `vitals(atSec)` — the facts, tree-scoped, clock-free |
| `src/server/sidecar-blob.ts` | the producer: compute, confess, atomic write |
| `src/server/ingestion.ts` | `onBatch` — every drain tick, empty or thrown |
| `src/server/server.ts` | wiring, inside capture setup (see below) |
| `src/server/cli.ts`, `config.ts` | `--no-sidecar`, `server.sidecar` |
| `src/server/installer.ts` | `doctor` reports the pane path |
| `features/journal-sidecar.feature` | 11 scenarios, all bound |

**The refusal is structural, not a check.** The producer is wired inside
`initCapture`, which a server that lost the store lock never reaches
(`capture: args.capture && drainOwner`). There is deliberately no
`if (drainOwner)` in the producer: a second guard would imply the guarantee
lives there, and the next reader would maintain the wrong one.

**No new indexes, on evidence.** The vitals queries were measured against a
711-node / 27 MB store before being written: the metadata scans cost the
same 0.3 ms as the *indexed* resume-pointer lookup, because content lives in
overflow pages and a b-tree walk never touches it. The measurement is in the
`vitals()` docstring so the next person adds an index for a reason rather
than a hunch.

## What the bindings are worth

Green bindings prove nothing until they can go red, so four were checked by
breaking the code on purpose:

| Mutation | Result |
| --- | --- |
| atomic rename → plain overwrite | torn-read scenario fails |
| `inert()` → identity | escape-bytes scenario fails |
| skip rewriting unchanged panes | pane-age scenario fails |
| broken pane ships its rows | confession scenario fails |

The fourth passed at first — because the mutation script targeted the wrong
indentation and never applied. Worth recording: a mutation that silently
fails to land reads exactly like a binding that holds.

Prototype producer and render harness (throwaway, live data, rendered
through ccr's real verifier): `scratchpad/produce.cjs`, `render.cjs`.
