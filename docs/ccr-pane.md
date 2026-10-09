# Showing the treecontext pane in ccr

treecontext writes three small JSON pane files beside each store on every
capture drain — `sidecar.json` (is memory working right now?),
`sidecar-threads.json` (what is this session in the middle of?), and
`sidecar-trail.json` (what is the journal made of?). ccr draws any pane
file you list in its own config, and knows nothing about treecontext
otherwise: the file is the entire interface.

## Do this

In your project:

```bash
treecontext ccr wire
```

That names this project's pane in ccr's config — the right file for your
platform, merged into whatever is already there, written as BOM-free UTF-8
with forward slashes. It is idempotent, so running it twice is safe, and
it prints how to cycle to the pane on the terminal you are using.

Then **cycle to it**, because a wired pane is invisible until you switch
views:

| Where your sidecar runs | How you cycle |
| --- | --- |
| **tmux** (bare `ccr` on Linux/macOS) | press **F3** |
| **VS Code split terminal** (any OS) | click the sidecar pane, press **Space** (or F3) |
| **Windows Terminal** | **no key is bound** — run `ccr cycle-view` from another tab in the project |

If nothing shows up:

```bash
treecontext doctor
```

Doctor walks the whole join and names the broken link — whether ccr is
installed and new enough, which config file it will read, whether that
file parses, whether this project's pane is listed in a shape ccr accepts,
whether the pane file has been written yet, and how to cycle on this
terminal. Every row that can be fixed carries the command that fixes it.

```
[ok]   Sidecar pane: /home/you/.treecontext/stores/myproj/sidecar.json (written 4s ago)
[ok]   ccr renderer: ccr 0.4.0 (panes shipped in 0.3.0)
[ok]   ccr config: /home/you/.config/ccr/config.json: 4 pane entries
[ok]   ccr pane wiring: this project's panes are listed (3 of 4 configured pane(s))
[ok]   ccr pane viewing: tmux: press F3 in the sidecar pane
```

## What has to be true

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| **ccr** | 0.3.0 or newer — `ccr --version` | same | same |
| **A live sidecar** | `tmux` | `tmux` — `brew install tmux` | Windows Terminal (ccr splits it) or VS Code's integrated terminal |
| **treecontext** | installed, and this project has drained at least once | same | same |

Panes live **only in the sidecar** — the live sidebar from a bare `ccr`
launch. `ccr economy`, `ccr statusline` and `ccr resume` never draw them.

The pane file itself appears on the **first drain** of a session in that
project, so on a fresh project you can wire first and see
`waiting for first blob` until a session runs. That is the honest state,
not a fault.

### Options

```bash
treecontext ccr wire --pane all      # all three panes, as three cycle views
treecontext ccr wire --dry-run       # print the config it would write
treecontext ccr wire --force         # config isn't valid JSON: move it aside, write fresh
treecontext ccr wire --store <name>  # a store other than this directory's
```

`wire` never removes another tool's pane, never drops a setting it does
not understand, and refuses rather than discarding a config it cannot
parse. Two things it repairs in place, because ccr renders both as
silence: a **byte-order mark or UTF-16 encoding** (what PowerShell's
`Set-Content -Encoding utf8` and `>` produce), and **bare-string pane
entries**, which ccr skips without a word.

---

## Doing it by hand

You do not need this section unless you want to know exactly what `wire`
writes, or you are wiring a machine where treecontext is not installed.

**Where ccr's config lives:**

| Platform | ccr's config file |
| --- | --- |
| **Linux** | `$XDG_CONFIG_HOME/ccr/config.json`, defaulting to `~/.config/ccr/config.json` |
| **macOS** | `~/.config/ccr/config.json` — **not** `~/Library/Application Support` |
| **Windows** | `%USERPROFILE%\.config\ccr\config.json` — **not** `%APPDATA%` |

ccr resolves that the same way on every platform (`$XDG_CONFIG_HOME` if
set, else the home directory's `.config`), and `CCR_CONFIG` overrides it
everywhere. It is never `~/.ccr` — that is state ccr rewrites — and never
a file inside your repository.

The shape:

```json
{ "panes": [ { "path": "/home/you/.treecontext/stores/myproj/sidecar.json" } ] }
```

Four rules decide whether ccr accepts it, and breaking any one of them
costs you the pane with nothing on screen to say so:

1. **Forward slashes in the path, even on Windows.** `"C:\Users\…"` is
   invalid JSON — `\U` is an illegal escape.
2. **Objects, not bare strings.** Anything else in the array is skipped.
3. **An absolute path.** `~/` is expanded; `~\` is **not**; a relative
   path resolves against the config file's own directory.
4. **Valid JSON, in UTF-8 with no BOM.** No trailing commas, no comments.

Order is cycle order, and two entries naming one file are two panes. ccr
re-reads the config every tick, so no restart is needed.

On Windows, write it with `[System.IO.File]::WriteAllText` — PowerShell
5.1's `>` writes UTF-16 and `Set-Content -Encoding utf8` writes a BOM, and
ccr's `JSON.parse` rejects both:

```powershell
$cfg = "$env:USERPROFILE\.config\ccr\config.json"
New-Item -ItemType Directory -Force -Path (Split-Path $cfg) | Out-Null
$json = '{ "panes": [ { "path": "C:/Users/you/.treecontext/stores/myproj/sidecar.json" } ] }'
[System.IO.File]::WriteAllText($cfg, $json)
```

## Cycling, in detail

Views are numbered **0** economy, **1** git, **2 and up** your configured
panes in config order; the `3/5` in a pane's top-right corner is its
position in that cycle. `ccr sidecar --view 2` opens straight on the first
configured pane, and `ccr cycle-view` advances a running one from any
shell (add `-i <name>` when several ccr instances are up).

Windows Terminal gets no hotkey from the launcher on purpose: binding one
would mean editing your own `settings.json`, and ccr is read-only about
your configuration. That is a ruling in ccr's pane contract, not a gap.

**If you want a key inside the pane on Windows Terminal anyway.** ccr keeps
exactly one live sidecar per instance and the newer one wins, so start your
own with keys enabled in a second tab and let the auto-split pane stand
down (it prints "another sidecar attached — this pane stood down"):

```powershell
ccr sidecar -i <instance> --keys
# or, by state dir:  --state-dir "$env:USERPROFILE\.ccr\instances\1"
```

`ccr economy`, run in the project, heads its output with the instance name
it resolved. In that pane, **Space** is the key that always works. **F3**
works too on **Node 22.17+ or 24.2+**: those switched `setRawMode` to
Windows' VT input mode, where the terminal's own sequence for F3 (`ESC O
R`) reaches the program — one of the three ccr listens for. On older Node,
libuv translates F3 itself into `ESC [ [ C`, which ccr does not match, and
only Space registers.

A wired, drained pane looks like this:

```
journal · treecontext  treecontext   3/5
  drain · 2026-08-21 20:12Z · blob written 4s ago

  ● capture   44 events / 10m  ▁▁▁▅▇▅▅▄▅█   hook → staging
  ● drain     clear   1,883 rows staged, all drained
  ● requeued  none   staged events that failed a drain and are
  ● gaps      none   holes the journal admitted in itself
  ● curated   153 notes   newest 3h before this drain, 46 entr
  ● threads   32 open   108 threads closed out
  ● journal   12,207 entries   38 MB stored
```

## The other two panes

All three files sit in the same directory. Add one entry each if you want
them all in the cycle:

| File | Pane | Answers |
| --- | --- | --- |
| `sidecar.json` | `journal` | Is capture working right now? |
| `sidecar-threads.json` | `threads` | What is this session in the middle of — open resume pointers, and the ones recently superseded |
| `sidecar-trail.json` | `trail` | What is the captured trail made of — exit-type mix, intent mix, preview-vs-full fidelity |

## When nothing shows up

ccr renders **any** config problem as "no panes configured", silently, by
its own survive-a-typo ruling — so a wiring mistake looks identical to
nothing happening. Work down this list; the first four account for nearly
every report.

0. **Run `treecontext doctor` first.** It checks every link below except
   the one only you can see — whether you cycled — and prints the fix for
   whatever it finds. The rest of this list is what it is checking, for
   when you want to check by hand.
1. **You never cycled.** The economy panel is view 0 and it is what you see
   on launch. Press F3, or the equivalent for your host.
2. **No sidecar is running.** Panes exist only in the live sidebar. On
   macOS that means tmux is installed and `ccr` launched it; on Windows,
   that Windows Terminal split or the VS Code pane is actually up.
3. **The config didn't parse.** Check it — the answer is either a pane
   count or the reason:

   ```bash
   node -e 'const f=process.argv[1];const s=require("fs").readFileSync(f,"utf8");if(s.charCodeAt(0)===0xFEFF)throw new Error("UTF-8 BOM at byte 0 — ccr cannot parse this");console.log("ok:",(JSON.parse(s).panes||[]).length,"pane(s)")' ~/.config/ccr/config.json
   ```

   ```powershell
   node -e "const f=process.argv[1];const s=require('fs').readFileSync(f,'utf8');if(s.charCodeAt(0)===0xFEFF)throw new Error('UTF-8 BOM at byte 0 - ccr cannot parse this');console.log('ok:',(JSON.parse(s).panes||[]).length,'pane(s)')" "$env:USERPROFILE\.config\ccr\config.json"
   ```

4. **Wrong file.** The table under "Doing it by hand" is the whole story — plus `CCR_CONFIG`,
   which wins if it is set in the environment ccr runs in. Editing
   `~/.ccr/…` or a repo-local file changes nothing.
5. **ccr is older than 0.3.0.** `ccr --version`. No pane cycle exists
   below that.
6. **Nothing has drained in that project yet.** The pane file appears on
   the first drain; until then ccr says `waiting for first blob`. Confirm
   with `treecontext doctor` (the row loses its "written on the first
   drain" suffix once the file exists).
7. **Panes are switched off.** They are on by default; `--no-sidecar` on
   the server, or in `~/.treecontext/config.toml`:

   ```toml
   [server]
   sidecar = false
   ```

A **correctly configured** pane never disappears silently. Instead you get
a named state, quoting the path ccr used:

| On screen | What it means |
| --- | --- |
| `waiting for first blob` | Nothing at that path yet — treecontext hasn't drained here, or the path is wrong |
| `cannot read blob (permission \| symlink \| directory)` | The path resolves to something ccr will not read |
| `blob unreadable` | The file is not valid JSON, or fails the pane contract |
| rows reporting `broken` | treecontext's own drain failed and the pane says so rather than showing stale health |

```
pane   4/5

  waiting for first blob
  /home/you/.treecontext/stores/myproj/sidecar.json
```

## One config, many projects

ccr's pane config is **global**; a treecontext store is **per project**. The
pane you wire shows that project's journal in every ccr instance, whatever
directory the tab is in — it does not follow the tab. Add one entry per
project you want in the cycle (each is its own view), and read the pane
title: every pane names its store, `journal · myproj`.

## What the pane will and won't tell you

Every number is frozen at the drain that wrote it — the pane's age chrome
("blob written 3m ago", drawn by ccr from the file's mtime) is what tells
you how current it is. A failed drain rewrites the pane as a `broken`
confession rather than leaving stale health on screen. The producer side of
this contract is pinned in `tests/server/pane-contract.test.ts` against
ccr's canonical golden blob, on Linux, macOS, and Windows.
