# hammer-mcp

[![CI](https://github.com/ProjectSocietyStudio/hammer-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ProjectSocietyStudio/hammer-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP server for Source-engine map work. It reads `.vmf` and `.bsp` files, lints a map against
the game's own FGD, edits a `.vmf` without reformatting it, patches a compiled map's entities
without recompiling, drives the compilers under Wine or natively on Windows — **Hammer++ by default**, stock on demand or
as a fallback — and measures a map
against the limits of the format.

**It never talks to a running engine.** It reads and writes files and runs compilers, and nothing
else. That is what lets it hold no lock and sit beside a live server without disturbing it.

```
> read_map_geometry rp_nycity_day.bsp

  a 1.13 GB map — header and lump directory only, 1 ms

  MODELS       1218 /  1024   119%  ████████████▏  over
  TEXINFO     11841 / 12288    96%  █████████▋
  VERTEXES    62270 / 65536    95%  █████████▌
  BRUSHES      6913 /  8192    84%  ████████▍

  4 lumps at or past 80% of their ceiling.

  MODELS is past it outright — and this map loads every day. That is
  not a broken map: it is evidence that the compilers which built it
  raise that ceiling. The tool reports it in those terms, rather than
  an error it cannot substantiate.
```

Measured on 11/08/2026. The tool returns JSON; the bars are this README's rendering of it. Every
number above is in that JSON, and [docs/measuring.md](docs/measuring.md) says what corroborates
each one.

## What it does

```mermaid
flowchart LR
  VMF[".vmf"] --> LINT["read_vmf_lint<br/>against the game's FGD"]
  LINT --> EDIT["edit_vmf<br/>splice, never reserialise"]
  EDIT --> VMF
  LINT --> C["vbsp · vvis · vrad<br/>under Wine"]
  C --> BSP[".bsp"]
  BSP --> M["measure · pack · patch entities"]
  M -. never .-x ENG["a running engine"]
  style ENG stroke-dasharray: 4 4
```

| | |
|---|---|
| **Measure** | how full each lump is, world extents, prop inventory, packed assets, sightlines |
| **Judge** | the same measurements against a budget profile, as a verdict per criterion — so a caller knows when it is done, not just where it stands |
| **Read and lint** | entities, outputs and brush counts of a `.vmf`; every finding checked against the FGD the game itself declares |
| **Edit** | entities, keyvalues and outputs of a `.vmf`, by splicing byte ranges — untouched bytes stay untouched |
| **Build** | brushes from a shape description, wound and textured the way vbsp expects, refused unless they close |
| **Optimise** | `func_detail`, hint brushes including diagonal ones, per-face lightmap scale — the decisions a compiled map no longer contains |
| **Compile** | vbsp/vvis/vrad under Wine (natively on Windows), findings per stage, and a leak turned into a named entity |
| **Ship** | resolve every asset a map references and find what will be missing, pack them into a `.bsp` — by hand or derived from the map — check a nav mesh still matches |
| **Open** | a Workshop `.gma`: read its index, pull one map out of a gigabyte without unpacking the rest |
| **Patch without recompiling** | rewrite a compiled map's entity list through a `.lmp` |

## Knowing when you are done

Every reader above answers *how much*. None of them answers *is that enough* — so anything
driving this toolchain can measure a map forever without learning that it is finished.
`read_map_report` closes that: it runs the readers and judges them against a **budget
profile**.

```
> read_map_report rp_nycity_day.bsp --profile source-stock

  FAIL   19 pass · 3 warn · 3 fail · 1 skipped

  fail   MODELS            119%   past MAX_MAP_MODELS
  fail   LIGHTING          264%   42.29 MiB of a 16 MiB ceiling
  fail   edicts            174%   3555 entities against MAX_EDICTS (2048)
  skip   luxel-density      --    nothing calibrates a threshold for this
```

Measured on 11/08/2026. The `LIGHTING` line is the one that was not already known: this map
carries **42.29 MiB of lightmap data against `MAX_MAP_LIGHTING`'s 16 MiB**, and it holds no
HDR at all (lumps 53, 54 and 58 are empty), so that is LDR alone. It is a second stock
ceiling exceeded, in a lump entirely independent of the first — which corroborates the
`MODELS` reading rather than repeating it.

Two things this design refuses to do:

- **It never restates a limit.** Ceilings live once, in `src/bsp/geometry.ts` and in
  `LIMITS`, read from Valve's headers with a date. A profile carries *thresholds* — policy —
  and every one of them states its own provenance, including "we chose it".
- **It never invents a threshold to fill a row.** `luxel-density` is measurable and
  uncalibrated, so it reports `skipped` and says so. A confident verdict about nothing is
  worse than an admitted gap, and the same goes for the overall verdict: a run that judged
  nothing comes back `skipped`, never `pass`.

## Building brushes, and why that was refused until now

`edit_vmf` used to say it outright: creating a brush means choosing planes and texture axes,
and a tool that does that without an oracle produces maps that compile and are wrong. The
argument was right. What changed is that the oracles exist now, so the conclusion expired
rather than the reasoning.

`write_vmf_solid` takes a shape — `box`, `wedge` for a ramp, `cylinder` for an n-sided
prism, or `convex` for a hull given face by face — and two things it gets right by
construction rather than by care:

- **Winding.** Every face is wound against the solid's own centroid, so a normal that points
  inward is turned around before it is written. A new shape cannot introduce a winding bug.
- **Texture axes.** Not invented: vbsp's own base-axis table. **All six** of its branches are
  reproduced exactly by `gen_probe.py`, which was written by hand and has been through a real
  compile and a real boot. So a ramp does not reach a seventh entry — there is no seventh. What
  it exercises is the *selection*: picking the closest base for a normal that matches none of
  them exactly. That step is Valve's algorithm rather than an extrapolation, and it is the part
  still owed a compile.

Nothing is written until the result has been read back by `read_vmf_solids` and passed. The
writer goes volume → planes and the checker goes planes → volume, so neither hides the
other's sign error, and a solid that does not close is refused rather than reported.

And because two programs written on the same afternoon agreeing proves less than it looks:
**a six-brush room built entirely by this tool is compiled by vbsp for real, and seals.**
Remove one wall and it leaks. Without that second half, a writer that emitted nothing at all
would pass the first test just as happily.

## The checkerboard, before a player finds it

A missing asset is the only failure on this page a mapper never sees at home — they have the
files. `read_map_dependencies` resolves every asset a compiled map references and says where
each will come from: **packed** inside the map, found in the **game**'s own content, or
**missing**.

The walk is recursive because a one-level walk gives a short, plausible, wrong answer. It
follows VMT `patch` and `include` chains, `$bottommaterial` and `$fallbackmaterial`, a
model's own material list, the skybox's six sides, and the detail sprite config.

On the production map — 11/08/2026:

```
  10 520 assets resolved   (10 493 packed · 27 from the game)
       5 faults

  nodegraph-name-mismatch   maps/graphs/rp_nyc1ty_day.ain
  texture ×4                referenced by model materials, present nowhere
```

That first line is a real defect in a map that has shipped and runs daily: the packed
nodegraph is `rp_nyc1ty_day.ain`, with a digit `1` where an `i` belongs. The engine loads
`maps/graphs/<mapname>.ain`, will never find it, and the NPCs navigate without it. Nothing
warns about this at compile time, because nothing checks that a packed file's name matches
the map it was packed into.

⚠️ **"Unreferenced" is not "safe to delete", and the tool refuses to blur the two.** The same
map packs 4261 files the *engine* references and no file names:

- 3983 `.vhv` — vrad's per-prop vertex lighting. Delete these and every static prop in the
  map goes flat.
- the built cubemaps under `materials/maps/<mapname>/`.
- everything the engine finds by **naming convention** rather than by reference: the
  skybox's six sides derived from `skyname`, the detail sprite material and its `.vbsp`
  config, `maps/<mapname>.nav`, `maps/graphs/<mapname>.ain`, the level sounds list.

That last group is the same mechanism that let the misspelled `.ain` ship: a file the engine
locates by deriving its name is invisible to a dependency walk *and* to the compiler. Getting
it right in both directions matters — miss it and the tool reports a dozen essential files as
dead weight.

Counted separately again: the 251 files under `sound/`, `scripts/` and `particles/`, which
this walk does not follow. A soundscape is named by a string defined in a manifest, and
`info_particle_system` names an *effect*, not a file.

What is left — 254 on that map — is the only number that means anything, and it is **still
not a delete list.**

And **where in the game it was found matters as much as whether**. An asset inside a VPK is
base content: every player who owns that game has it. An asset sitting **loose** in the
content tree usually is not — it resolves at home because it is on that disk, and it is a
checkerboard for everyone else.

`run_pack` with `auto: true` packs exactly those, deriving the list from the map and
returning it so what was packed is visible rather than inferred. It never packs VPK content.

⚠️ Loose is a **candidate**, not a certainty, and that is measured rather than assumed:
Garry's Mod ships `detail.vbsp` loose in its own root. No rule separates a mapper's work from
a game's loose files — they live under the same install. The asymmetry is what makes erring
toward inclusion right: packing a stock file wastes kilobytes, missing a custom one ships a
broken map. `exclude` drops the ones you recognise.

## Opening a Workshop archive

A `.gma` is how the Workshop ships everything, maps included, so until now a Workshop map had
to be unpacked by hand before anything here could look at it — which meant the corpus a mapper
learns from was out of reach.

The format concatenates every file after an index with no padding, so one pass over the index
gives random access to the whole archive. `run_gma_extract` pulls `maps/rp_pinescity_v2b.bsp`
out of a 245 MB addon without reading the materials beside it.

Read across every archive on this machine, 11/08/2026: **56 archives, no failures** — the
largest 1143 MB, the busiest 6521 entries, seven of them carrying a map. Header and index
only.

## Where the lighting budget goes

`lightmapscale` is **units per luxel**, so it reads backwards: smaller is finer and more
expensive, and the cost is an *area*. The probe room, compiled at four scales — 11/08/2026:

| scale | luxels | `LIGHTING` |
|---|---|---|
| 8 | 17 424 | 69 760 B |
| 16 (Hammer's default) | 4 624 | 18 560 B |
| 32 | 1 296 | 5 248 B |
| 64 | 400 | 1 664 B |

Each doubling divides the bill by roughly four. That arithmetic is why the production map
audited here carries **264% of `MAX_MAP_LIGHTING`** — nobody arrives there by choosing a fine
lightmap once, but by never coarsening the surfaces that did not need one. A warehouse floor
at 16 and the same floor at 32 are indistinguishable to a player and differ fourfold on disk.

`set_lightmap_scale` selects by solid, material, which way a face points, minimum area, or a
combination, and **projects the luxel count before writing**. It refuses to touch every face
in the map unless told `all: true` — rescaling a whole map is legitimate and is never what
someone meant by accident.

⚠️ It also warns about the cost that does not look like one. A brush face may carry at most
**32 luxels along either texture axis** (`MAX_BRUSH_LIGHTMAP_DIM_WITHOUT_BORDER`, read from
`bspfile.h`). vbsp does not refuse more — it **splits the face** until each piece fits. So
lowering the scale on a large surface multiplies faces as well as luxels, and `FACES` has a
ceiling of its own. (The similarly-named `MAX_LIGHTMAP_DIM_WITHOUT_BORDER` in that header
aliases the *displacement* value of 125; reading the obvious name gives four times the real
limit for a brush face.)

## `func_detail`, measured

The largest single lever on a Source map's performance, and a `.bsp` cannot tell you it was
ever pulled: vbsp folds `func_detail` into the world as detail brushes, so nothing in a
shipped map records which brushes were structural. `set_solid_class` moves them, either way.

A structural brush splits the BSP tree and spawns visleaves around itself. A pillar standing
in a room, compiled three ways — 11/08/2026, stock compilers:

| | leaves | clusters | VISIBILITY |
|---|---|---|---|
| empty room | 29 | 4 | 44 B |
| pillar, structural | 33 | 7 | 74 B |
| pillar, `func_detail` | 29 | 4 | 44 B |

The detail pillar returns the tree to the empty room's numbers **exactly**. It is still there,
still solid, still drawn — vvis simply no longer knows about it.

Read that narrowly, because it is the easiest result on this page to over-read. It says the
pillar left the visibility tree. It does **not** say the pillar became free: it still draws,
still counts in `FACES`, and still costs its lightmap. On a real map that second bill is
usually the one that decides, and `read_map_report` is what puts a number on it.

⚠️ **And the trap, which is why the tool warns instead of congratulating you: a `func_detail`
brush does not seal the map.** Move a wall into one and the next compile leaks. No static check
here can rule that out — sealing is a property of the whole hull, not of one brush — so the
tool returns what to compile next rather than implying the move was safe. The test suite
proves both halves: detailing an interior pillar is clean, detailing a wall of the same room
leaks.

It refuses two things outright. A brush inside a `hidden` block — Hammer's storage for a
visgroup-hidden brush — because moving it out would unhide it as a side effect of an edit that
said nothing about visibility. And an entity whose classname is not the one asked for, rather
than putting brushes somewhere the caller did not name.

## Hints, and what a compiled map has already forgotten

`func_detail`, hints, per-face lightmap scale: the decisions that most affect how a map
performs exist **only in the `.vmf`**. vvis consumes hints and they are gone from the `.bsp`,
vbsp folds detail into the world. So a tool that can audit a compiled map in detail is still
unable to act on anything it finds there — the acting has to happen on the source.

`write_hint_brush` places a slab carrying `TOOLS/TOOLSHINT` on the plane vvis should cut
along and `TOOLS/TOOLSSKIP` everywhere else, and `rotateZ` turns it, which is how a cut is
made diagonal.

Compiled three ways on the probe room, 11/08/2026, stock compilers:

| | leaves | clusters | VISIBILITY |
|---|---|---|---|
| no hint | 29 | 4 | 44 B |
| hint, axial | 33 | 8 | 84 B |
| hint, 45° | 35 | 10 | 124 B |

The diagonal is not the axial cut turned round: in the same room it subdivides further. That
is the lever behind an audit finding on three shipped city maps, whose BSP trees choose
diagonal split planes at roughly **80×** the rate of a same-genre control by another author —
an author building a city whose streets do not run along the axes reaches for exactly this.

Finer is not automatically better: those clusters cost VIS data and compile time, and one
small room is one sample. What the table settles is that the lever works and that the two
cuts are not equivalent. The tool says so itself — it returns the measurement to take next,
because **a hint that changes no leaf count did nothing and still costs a plane in the tree.**

## Reading brushes backwards

A VMF stores a brush as planes. `read_vmf_solids` intersects those half-spaces back into a
volume, and checks what comes out: closed, convex, inside the world, on a grid, with texture
axes that actually lie across their own faces.

The direction is the point. Anything that *writes* a brush goes volume → planes; this goes
planes → volume. A sign error or an inverted winding cannot survive both, so the two check
each other instead of sharing a bug — which is what "no tool without an oracle" has to mean
before this repository can write geometry at all.

The subtle case, and the reason the closure test is not a corner count: reverse one side's
winding on a box and its half-space faces outward, so the solid becomes an infinite prism.
The four corners at the closed end survive and satisfy every half-space, so counting corners
returns four and looks healthy. What gives it away is that those four are coplanar and the
volume is zero. Removing the volume half of that test turns exactly one test red, which is
how it was checked rather than reasoned about.

### On grids

Every solid also reports the coarsest grid all its corners land on, and the report carries
the distribution. That turns a piece of workshop lore — *build everything on one grid, 8 is
a good one* — into something a map can be asked about.

Measured 11/08/2026 on `ttt_traps.vmf`, the only Hammer-written map shipped with the game:

| Grid | Solids | |
|---|---|---|
| 16 | 3 | 4% |
| 8 | 24 | 32% |
| 4 | 1 | 1% |
| 2 | 18 | 24% |
| 1 | 29 | 39% |

75 solids, none off-grid, no errors. So a map that shipped and plays is **not** built to one
uniform grid. Read that carefully, though: this metric is the *coarsest* grid every corner
fits, so a single odd coordinate anywhere on a brush drops the whole brush to 1. It measures
how uniform the geometry ended up, not what grid someone worked at.

## The craft, alongside the tool

`.claude/skills/` carries two skills, and they live here rather than in the workshop that uses
this server, because this is where map work belongs:

| Skill | What it holds |
|---|---|
| [`source-map`](.claude/skills/source-map/SKILL.md) | **driving the tooling** — which tool answers which question, in what order, and what each one cannot tell you. [`building.md`](.claude/skills/source-map/references/building.md) is the order to build a map in, written from two real builds rather than from the tool list |
| [`source-mapping`](.claude/skills/source-mapping/SKILL.md) | **the craft** — brushwork and grid, visibility, lighting, displacements, entities, performance, scale and composition, materials, atmosphere, and the myths |

They reference each other and neither copies the other. Every rule in `source-mapping` carries
**how to check it**, and marks itself:

| Mark | Meaning |
|---|---|
| `[moteur]` | read in Valve's own source, with the file and the date |
| `[consensus]` | widely agreed among mappers, not verified here |
| `[contesté]` | mappers disagree, and the disagreement is stated |
| `[mesuré]` | measured in this workshop, with the sample size |

[`tooling-coverage.md`](.claude/skills/source-mapping/references/tooling-coverage.md) is
the honest half: it maps each family of rules to the tool that verifies it, and names the ones
**nothing** verifies. That column is not a gap in the tooling — it is the nature of the work, and
an agent that dresses a judgement up as a metric produces a wrong number and false confidence.

The `[mesuré]` markers come from an audit of shipped city maps whose raw files stay in a private
repository. What is here is what survived a contradiction pass, together with what did not —
[`measured-corpus.md`](.claude/skills/source-mapping/references/measured-corpus.md) keeps both, and
the refutations are the more useful half.

## Hammer, command by command

[`docs/hammer-parity.md`](docs/hammer-parity.md) has a row for every command in the editor,
naming the tool that covers it or the reason it never will be covered. Two rows say "not
covered" rather than "not applicable" — displacement subdivision, and copying one face's
alignment onto another — and those two are the whole of the gap.

A test reads that document and fails if it names a tool this server does not have, if it
omits one it does, or if the count it states has moved.

## Proven, and not proven

The distinction matters more here than the feature list. Every claim below is backed by a dated
measurement in [`docs/`](docs/), or it says it is not.

| Area | State |
|---|---|
| BSP reading | **proven** — cross-checked against three independent witnesses |
| Measurement | **proven** — same |
| VMF reading and lint | **proven** — every rule verified by a fault injected on purpose |
| VMF writing (`edit_vmf`) | **proven** — comments, blank lines and indentation survive |
| Brush creation (`write_vmf_solid`) | **proven** — a room built entirely by it compiles sealed, and leaks when one wall is removed |
| Compiling, both toolchains | **proven** — a leak caused, then located, on stock and Hammer++ |
| Python sidecar (srctools) | **proven** |
| Game discovery | **proven for Garry's Mod only** — the readers are generic Source, but one game has been run here |
| Moving and deleting brushes | **proven** — a room turned 45 degrees compiles sealed, and leaks when one of its walls is deleted |
| Reading the game's content | **proven** — searches and model bounds checked against Garry's Mod's own install |
| Vertex editing | **proven** — a slab tilted into a wedge stays a valid brush; every move that would break a face is refused |
| Writing displacements | **proven** — srctools reads back the grid, the relief and the blend this wrote |
| Entity wiring | **proven** — a wire to a name nothing has, and an input a class does not have, are both found against the real FGD |
| Reading displacements | **proven** — srctools reads the same power, grid, start and extremes from the same file |
| Hollowing | **proven** — the walls sum exactly to the outer volume less the room, and the hollowed probe still seals |
| Clipping | **proven** — a room whose every wall was cut diagonally compiles sealed; the two halves sum to the original volume |
| Texture alignment | **proven** — aligning to world reproduces, on all 36 faces, the six axis pairs `gen_probe.py` states by hand |
| Tracing an uncompiled `.vmf` | **proven** — 5000 rays agree with the compiled map's own tracer to under half a unit, and the broadphase agrees with brute force bit for bit |
| Rendering a `.vmf` | **proven** — the id buffer agrees with a traced ray at 2000 pixels, and the PNG inflates back to the framebuffer byte for byte |
| Finding a leak without compiling | **proven** — a hole cut in a sealed fixture is found, and the path out ends at it; the probe map, which compiles clean and boots, reads as sealed |
| Rooms and doorways | **partly proven** — a fixture stating its own dimensions returns three rooms and two doorways of exactly 96 units, a 40-unit counter top is reported as unreachable rather than as a room, and every merge is reported with the comparison that decided it. The method is a heuristic and says so; it is also **sensitive to cell scan order**, reproduced in `test/watershed.test.ts` and open as [#48](https://github.com/ProjectSocietyStudio/hammer-mcp/issues/48) |
| The floor plan | **proven** — the drawn area equals the sections' own area from the page geometry alone, every room label falls inside its room, and no two labels overlap |
| Measuring a place | **proven** — a corridor built 256 wide measures 256, a doorway built 96 measures 96, and one built 100 measures 100 where the voxel estimate would still say 96 |
| Per-map rules | **proven** — a corridor built 256 passes a 192 bar and fails a 320 one with both numbers; a rule that cannot fail is refused at load; and a write goes through on a map that violates every rule it has |
| The write guard | **proven** — each of the five VMF writers is called for real on a map inside `srcds/` and must refuse |
| Entity-lump patching | codec **proven**; **its effect in game is not** — see [gate B](docs/gates.md#gate-b) |
| `read_vprof` | **not written**: no real sample to calibrate it against |

## Install

```bash
git clone https://github.com/ProjectSocietyStudio/hammer-mcp
cd hammer-mcp && pnpm install && pnpm build
./sidecar/setup.sh          # Python venv + srctools, for the VMF/FGD/pakfile tools
node dist/index.js install  # declares the server in <repoRoot>/.mcp.json
```

**Nothing throws when a prerequisite is missing** — run `health` and it says exactly what is
absent and what that costs you.

⚠️ **After pulling, rebuild *and* reconnect.** `.mcp.json` points at `dist/`, which is
gitignored, so a checkout that has not been built serves the tool list of whatever was built
last — silently, with no error and no warning. Reconnecting matters just as much: a client
holds the tool list it was handed when it connected. `health` reports both halves under
`tools`: how many tools this server is serving, and whether its build is older than the
source. On 13/08/2026 this cost twelve tools and forty minutes —
[the finding](docs/dogfood/2026-08-13-bodega/findings.md#1--the-server-was-serving-a-build-twelve-tools-old-and-nothing-said-so).

| | Needed for | If missing |
|---|---|---|
| Node ≥ 20 | everything | nothing starts |
| Python 3 + [`srctools`](https://github.com/TeamSpen210/srctools) | VMF, FGD, pakfile | those tools only |
| Wine (measured on 9.0), except on Windows | `run_compile`, `run_pack` | those two only |
| A Source game with its compilers | same | same |

⚠️ **The compilers ship with the game *client*, never with a dedicated server.** `srcds/bin/` has
none of them.

## Which game

`read_source_games` finds what is installed by reading Steam's own files and each game's
`gameinfo.txt` — appid, install directory, mod directory, and **the FGD the game declares**. So
Counter-Strike: Source lints against `cstrike.fgd` without anyone typing that name.

Only Garry's Mod has actually been run here. Every profile records where each of its values came
from and whether a file was read; `health` reports it. See
[docs/formats.md#game-profiles](docs/formats.md#game-profiles).

## Tools

`read_*` observes, `run_*` executes, `verb_noun` mutates. Tools that write or execute are
**guarded**: they need `confirm: true`, or their name in `toolAllowlist`.

A guarded tool asks permission twice, and the two gates belong to different people.
`confirm: true` is **ours** — the server refuses without it, and an agent satisfies it by
itself, which is what makes a destructive call deliberate rather than incidental. Twenty-five
of them also carry `anthropic/requiresUserInteraction`, which is the **client's** gate: it
asks for a human, and no argument an agent can pass will satisfy it.

**`toolAllowlist` lifts both.** An operator who writes a tool down as pre-approved has
answered the question the prompt asks, in a config file, on purpose; leaving the human gate
up would contradict that rather than read it strictly. Nothing else changes — `guarded` still
holds, and a tool not on the list keeps both gates, which stays the default.

| Tool | Realm | Guarded | What it does |
|---|---|---|---|
| `health` | `local` | | State of the toolchain: game profile, binaries, FGDs, Wine, sidecar — and how many tools this build serves, and whether it is older than the source |
| `read_source_games` | `local` | | Source games installed here, read from Steam and from `gameinfo.txt` |
| `read_bsp_info` | `map` | | Header of a `.bsp`: ident, version, mapRevision, all 64 lumps, and whether vrad produced HDR |
| `read_bsp_entities` | `map` | | Entities of lump 0, filtered and paginated, with a classname histogram |
| `read_map_extents` | `map` | | Real world extents (lump 14), in Hammer units and in metres |
| `read_map_geometry` | `map` | | How full each lump is, and how much room is left before vbsp's ceiling |
| `read_prop_survey` | `map` | | Prop inventory, and which `prop_dynamic` are dynamic for nothing |
| `read_pakfile` | `map` | | Contents of the embedded pakfile (lump 40), and the compile evidence it carries |
| `read_sightlines` | `map` | | Longest clear lines of sight, traced against the world tree |
| `read_brush_volumes` | `map` | | Footprint and volume of each brush entity, by class |
| `read_materials` | `map` | | Material table of a compiled map, and how many `TEXINFO` reference each one |
| `read_lightmap_budget` | `map` | | Where a compiled map's lightmap resolution went: total luxels, distribution, costliest faces |
| `read_visleaf_stats` | `map` | | Quality of a compiled map's visibility split: leaf/cluster counts, leaf volume distribution |
| `read_map_report` | `map` | | Judges a map against a budget profile: a verdict per criterion, not another number |
| `read_fgd_class` | `map` | | A class's schema per the game's FGD: keyvalues, inputs, outputs |
| `read_vmf` | `map` | | Entities, outputs and counts of a `.vmf`. `collapseInstances` expands `func_instance` |
| `read_game_content` | `map` | | Hammer's texture and model browsers: what the game actually has, by name |
| `read_model_info` | `map` | | A prop's hull, skins, sequences and materials, before you place it |
| `read_vmf_solids` | `map` | | Rebuilds every brush from its planes: is it closed, convex, in the world, on a grid |
| `read_displacements` | `map` | | The terrain grids of a `.vmf`, their vertices in world space, and their seams |
| `write_displacement` | `map` | ● | Creates terrain grids on selected faces — 5×5, 9×9 or 17×17 |
| `sew_displacements` | `map` | ● | Pulls displacements back together along the edges they share |
| `sculpt_displacement` | `map` | ● | Flatten, raise, slope or noise — with a seed, so it can be made twice |
| `paint_displacement` | `map` | ● | The blend channel: uniform, by height, or by slope |
| `write_portal` | `map` | ● | Areaportals and occluders — the runtime half of visibility |
| `set_map_properties` | `map` | ● | worldspawn: the sky, the detail sprites, the fog |
| `write_vmf_solid` | `map` | ● | Creates brushes — box, wedge, prism, cone, arch, sphere, torus, stairs, or a hull face by face. One material, or one per role: top, bottom, sides |
| `transform_solids` | `map` | ● | Moves, turns, scales or mirrors brushes already in the file, texture lock included |
| `delete_solids` | `map` | ● | Removes brushes. The counterpart write_vmf_solid never had |
| `read_map_organisation` | `map` | | Visgroups, groups and the cordon, with what belongs to each |
| `set_visgroup` | `map` | ● | Names a selection so later calls can say the name instead of a box |
| `group_solids` | `map` | ● | Hammer groups: several brushes that click as one |
| `set_cordon` | `map` | ● | The cordon box, and whether it is on — the one setting that changes what compiles |
| `hollow_solids` | `map` | ● | Turns a block into the walls of a room, mitred — Hammer's version overlaps |
| `clip_solids` | `map` | ● | Cuts brushes with a plane — front, back, or both. Hammer's most-used tool |
| `move_vertices` | `map` | ● | Moves a brush's corners — Hammer's VM tool, with its refusals |
| `set_face_material` | `map` | ● | Sets the material on selected faces. Nothing could change one before |
| `align_faces` | `map` | ● | Realigns a texture: to the world, to the face's own plane, or fitted to it |
| `set_smoothing_groups` | `map` | ● | Hammer's 1-to-32 groups, written as the bitmask the file stores |
| `write_hint_brush` | `map` | ● | Places a hint brush, straight or diagonal, to shape where vvis splits the map |
| `set_solid_class` | `map` | ● | Moves brushes between the world and a brush entity — `func_detail` and back |
| `set_lightmap_scale` | `map` | ● | Sets `lightmapscale` on selected faces, and projects the luxel bill before writing |
| `read_entity_report` | `map` | | Hammer's Entity Report: every entity and its keyvalues, filterable |
| `validate_io` | `map` | | Every output checked against the FGD — the wire that fires into nothing |
| `read_vmf_lint` | `map` | | What will break at compile time or in game, before compiling |
| `read_vmf_trace` | `map` | | Traces a ray or a swept player hull through an **uncompiled** `.vmf`: what is in the way, how far, which face |
| `read_vmf_visibility` | `map` | | Whether named pairs of points can see each other, and the brush that blocks the ones that cannot |
| `read_vmf_nearest_surface` | `map` | | Exact distance from a point to the nearest surface, and which face it belongs to |
| `render_vmf_view` | `map` | | Renders an **uncompiled** `.vmf` from a camera and returns the picture: form and occlusion, no textures |
| `read_vmf_leak` | `map` | | Whether a `.vmf` seals, **without compiling it**, with the path out |
| `read_vmf_rooms` | `map` | | The rooms of a `.vmf`, the doorways between them and how they connect — every merge it made with the reason, **the doorway that merge stopped reporting**, and the standable places no walk reaches. Each doorway carries both its cell-count estimate and its **measured** width, from a swept player hull at the same col |
| `read_vmf_surfaces` | `map` | | Faces sorted into floor, wall, ceiling — and which of them a person could touch |
| `render_vmf_plan` | `map` | | A **dimensioned floor plan**: rooms, areas, doorway widths as measured rather than counted, grid, scale bar, north |
| `measure_vmf_clearance` | `map` | | Free width and headroom at a point, measured with a **swept player hull**, not a ray. Says when no body fits there rather than reporting the hull's own width |
| `measure_vmf_approach` | `map` | | How much clear room a person has in front of each entity — the door that opens into a wall |
| `read_vmf_sightlines` | `map` | | Longest clear sight lines in an **uncompiled** `.vmf`, sampled where a person can stand |
| `check_vmf_rules` | `map` | | Checks a map against **its own** `<map>.rules.json`. Reports; never refuses. A run where a rule matched nothing is `skipped`, never `pass`, and it says what segmentation the verdict rests on. A width or clearance violation carries `evidence`: the direction swept, the yaw it came from, what stopped it — and `measured: null` rather than a bare zero when no body fits where it would have measured |
| `write_vmf` | `map` | ● | Creates an empty `.vmf` — Hammer's File > New. Refuses to overwrite. Checks the `skyname` it writes against the game's own content, and names complete skies the game has when that one is absent |
| `edit_vmf` | `map` | ● | Edits a `.vmf` by splicing: entities, keyvalues, outputs. Nothing else moves |
| `run_pakfile_extract` | `map` | ● | Gets files **out** of a compiled map's pakfile — the counterpart `read_pakfile` never had. Refuses an entry that would escape the destination, never overwrites unless told |
| `run_cubemap2hdr` | `local` | ● | Turns an LDR cubemap into the HDR one Source loads in HDR mode. Refuses anything but DXT1 up front, naming the format the file actually is || `run_vtf_convert` | `local` | ● | Turns a `.tga`/`.png`/`.bmp` into a `.vtf`, and reports the format that actually came out rather than the one asked for. Drives VTFCmd from ficool2's VTFEdit++ |
| `run_tga2skybox` | `local` | ● | Builds a cubemap `.vtf` from six TGA faces, LDR **and** HDR — the half of cubemap work that does not need the engine running. Drives ficool2's `tga2skybox` |
| `run_bsp_rename` | `local` | ● | Renames a compiled `.bsp` **and the content packed inside it** — the nodegraph, cubemap patches, soundscripts. Drives ficool2's `bsp_rename`, a separate download; `health` says whether it is there |
| `run_compile` | `local` | ● | vbsp, vvis and vrad under Wine, or natively on Windows, findings per stage. Drives the **Hammer++ chain by default**, with its culling flags; falls back to the stock compilers when Hammer++ is absent and says which one ran |
| `read_compile_log` | `map` | | Turns compiler output into findings, each with what the message actually means |
| `read_leak` | `map` | | Turns `**** leaked ****` into a position and a named entity |
| `read_map_dependencies` | `map` | | Every asset a map references, and whether each will be there: packed, from the game, or missing |
| `read_gma` | `map` | | Header and index of a Workshop archive: what is in it, and where |
| `run_gma_extract` | `map` | ● | Pulls matching files out of a `.gma` by offset, without unpacking the rest |
| `run_pack` | `local` | ● | Packs files into a `.bsp` via bspzip. `auto` derives the list from the map itself |
| `read_nav` | `map` | | Says whether a nav mesh still matches its map |
| `read_lump_patch` | `map` | | Decodes a `.lmp` and its entities |
| `write_lump_patch` | `map` | ● | Builds an entity patch from add/update/remove operations |
| `read_lump_patch_status` | `map` | | Compares built patches to what is deployed, and to map revisions |

The `map` realm is offline file work; `local` runs a binary on the host.

## How this repository works

Three rules, stated in full in [CONTRIBUTING.md](CONTRIBUTING.md):

1. **A passing test proves nothing until it has been shown it can fail.** Every test here was
   sabotaged and watched go red before it was accepted. One of them failed that check and had to
   be rewritten — [docs/architecture.md](docs/architecture.md#splicing) says which, and why.
2. **No number nobody read.** Every figure in this repository comes from a file that was read or a
   measurement that was taken, with its date. Values that cannot be verified are marked unverified
   or left out — never presented as fact.
3. **The commit carries its documentation.** A README describing a tool that does not exist is a
   bug, not a delay.

There is a corollary for tools: **no tool without an oracle.** Several gaps in this repository are
documented rather than filled, because no independent way to check the answer could be built.

## The log

The dated record of what was tried, measured, and got wrong:

- [docs/gates.md](docs/gates.md) — the feasibility gates: do the compilers run under Wine, does
  the engine honour a lump patch, does the Hammer++ chain behave like the stock one
- [docs/measuring.md](docs/measuring.md) — what a 1.13 GB production map says about itself, and
  the three ways of sampling sightlines that all returned confident, wrong numbers
- [docs/compiling.md](docs/compiling.md) — Wine, Hammer++, what `cull` actually saves, and the
  compiler messages that name the wrong thing
- [docs/formats.md](docs/formats.md) — the `.lmp` format as measured, the sidecar, the FGD, game
  profiles
- [docs/architecture.md](docs/architecture.md) — why the write path is a splice, the write
  discipline, and shared plumbing
- [docs/audits/fishke/](docs/audits/fishke/) — three production maps read end to end with this
  server: the raw readings, the analyses, and the adversarial pass that refuted two of their own
  conclusions

## Configuration

`<repoRoot>/.hammer-mcp/config.json`, every field optional. See
[`config.example.json`](config.example.json).

| Field | Default |
|---|---|
| `game` | `gmod` — the profile used when a call does not name one |
| `gameProfiles` | `{}` — per-profile overrides: `binDir`, `gameDir`, `plusPlusBinDir`, `fgd`, `branch` |
| `backend` | `native` on Windows, which runs the `.exe` files directly; `wine` everywhere else |
| `winePrefix` | `~/.wine` |
| `sidecarPython` | `<stateDir>/sidecar-venv/bin/python` |
| `externalToolsDir` | `<stateDir>/tools` — standalone tools this server drives, such as ficool2's `bsp_rename.exe`. They belong to no game install, so nothing can discover them; `health` lists which are present |
| `toolAllowlist` | `[]` |

**Normally there is nothing to configure**: paths come from discovery. `gameProfiles` is for what
discovery cannot see — a game installed outside Steam, compilers shipped in a separate app, an
engine branch we do not classify.

`gmodBin`, `gmodGameDir` and `gmodBinPlusPlus` are the older spelling of
`gameProfiles.gmod.{binDir,gameDir,plusPlusBinDir}`. They still work. Setting both to different
values is **refused at load** rather than silently resolved: the losing half would leave no trace
in any output.

## Development

```bash
pnpm build       # tsc -> dist/
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit, tests included
```

Most of this suite is not unit tests: it drives the real compilers under Wine, the real Python
sidecar and real maps. None of that ships with the repository, so `pnpm test` on a bare machine
**skips** what it cannot run — and says so:

```
[hammer-mcp] Tests needing these are SKIPPED, not passing:
  - the Python sidecar venv (run sidecar/setup.sh)
  - a large production .bsp
```

That is deliberate: a silently skipped test and a passing test look too much alike. `HAMMER_MCP_REPO`
points the suite at the tree holding your game content when it is not the parent of the checkout.

**No Valve content is committed here.** The only binary fixtures are `test/fixtures/hmcp_probe.{vmf,bsp}`,
generated by `test/fixtures/gen_probe.py` and compiled from it.

## Related

- [`@projectsociety/mcp-core`](https://www.npmjs.com/package/@projectsociety/mcp-core) — the shared MCP
  plumbing: tool registry, guarded calls, audit log, config loading
- [`gmod-mcp`](https://github.com/ProjectSocietyStudio/gmod-mcp) — the other side: a server that
  does drive a running Garry's Mod engine

## License

MIT. See [LICENSE](LICENSE).
