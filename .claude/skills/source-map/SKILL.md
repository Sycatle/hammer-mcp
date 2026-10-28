---
name: source-map
description: Working a Source / Garry's Mod map — measure, audit, edit a VMF, compile, pack, ship. Use whenever the subject is a map, .vmf, .bsp, Hammer, vbsp/vvis/vrad, a leak, lightmaps, cubemaps, nav mesh, asset packing, or rp_nycity_day itself.
---

# Working a Source map

The tooling lives in **`hammer-mcp`** (offline: files, compilers) and **`gmod-mcp`** (online: the
running engine). This skill says **what to do and in what order**; the thresholds, the limits and
the schemas live in the tools, where they are verified, not here.

It covers the **tooling**. The craft — brushwork, VIS, lighting, displacements, performance, level
design — lives in the `source-mapping` skill, which does not copy this one.

`hammer-mcp` has been public since 11/08/2026: its measurement log is in
[`docs/`](https://github.com/ProjectSocietyStudio/hammer-mcp/tree/main/docs), where what is proven
is kept separate from what is not.

## The rule that comes first

**A `.bsp` is never read by hand.** The production map is 1.13 GB, 1004 MB of it pakfile. A
`readFileSync` on it kills the MCP transport, and the agent sees a hang rather than an error. Every
reader in `hammer-mcp` goes by offsets — they read 1.5 MB where the file is 1130. Never work around
the tool.

## Survey the ground first

| Question | The tool |
|---|---|
| What is broken in my chain? | `health` — active game profile, Wine binaries, FGD, Python sidecar |
| Which game am I working on? | `read_source_games` — what is installed, read from Steam and `gameinfo.txt` |
| How big is this map? | `read_map_extents` |
| Can it still grow? | `read_map_geometry` |
| What does it ship with? | `read_pakfile` |
| What is inside it? | `read_bsp_entities`, `read_prop_survey` |
| **Is my server the build I think it is?** | `health` again — `tools.count` against the number [`docs/hammer-parity.md`](https://github.com/ProjectSocietyStudio/hammer-mcp/blob/main/docs/hammer-parity.md) states, and `tools.build.stale` |

⚠️ **A stale build is silent.** `.mcp.json` points at `dist/`, which is gitignored, so a checkout
that has not been built serves the tool list of whatever was built last — no error, no warning,
just fewer tools, and a missing tool is indistinguishable from one that was never written. That
cost twelve tools and forty minutes on 13/08/2026. `pnpm build` **and reconnect the client**: a
client holds the tool list it was handed when it connected.

On `rp_nycity_day`, the answer to "can it grow" is **no**: `TEXINFO` at 96%, `VERTEXES` at 95%, and
`MODELS` **past its ceiling** (1218 against 1024). That last point does not mean the map is broken —
it loads every day — but that its compilers raise that ceiling. Any proposal that adds geometry has
to start there.

**The game is no longer assumed.** Tools that depend on it take a `game` argument and **report in
their output which profile answered**, plus whether that came from the call or the configuration.
An unknown id is refused, naming the ones that exist, never resolved to the default. Only Garry's
Mod has actually been run; the other profiles are plausible and unverified, and `health` says where
each value came from.

## Editing a map you have no source for

That is the production case. There is no `.vmf` for `rp_nycity_day`.

**A lump patch** (`write_lump_patch`) rewrites a compiled `.bsp`'s entity list without recompiling.
It can **edit or delete an entity the map itself spawns**, before it spawns — which no Lua script
can do. It cannot: relight the map (the LIGHTING lump is baked), create geometry, or reach clients
(the `.lmp` lives server-side).

**To simply add an entity, prefer a GLua manifest** read at `InitPostEntity`: format-agnostic,
survives a recompile, hot-reloads.

✅ **Gate B is passed — 15/08/2026.** Garry's Mod reads `maps/<map>_l_0.lmp` on the current
branch: an `info_target` added by patch to `gm_construct` appeared in the running engine, and
disappeared when the file was removed. The protocol and its numbers are in `docs/gates.md`, in
this repository.

⚠️ **What it also measured, and it is the sharp half: the engine does NOT check the patch's
`mapRevision`.** A patch stamped against an older compile of a map is applied to the new one in
full, silently, editing entities by names and indices that may have moved. `write_lump_patch`
refuses to build a mismatched patch and `read_lump_patch_status` reports drift — those two are
the only check that exists anywhere, so run the second one after any recompile.

## Building a map from nothing

Detail in [references/building.md](references/building.md), which is written from two real
builds of the same brief rather than from the tool list. The shape of it:

**`write_vmf` creates the file** — nothing else can, and `write_vmf_solid` refuses a file with
no `world` block, so an absent or empty one is not a starting point.

Then: shell → `read_vmf_leak` → openings → spawn and markers → `read_vmf_rooms` →
`check_vmf_rules` → furniture → **fittings** → **look** → compile. The cheap steps are seconds
rather than minutes, which is the whole reason to work offline; run them after every
structural change.

**Done is three greens and a look**: `read_vmf_leak` sealed, `check_vmf_rules` with
`overall: "pass"`, `run_compile` clean — then `read_leak` on the `.bsp`, which answers the
seal question a second time by a different method — and `render_vmf_tour`, described in
writing before you conclude.

⚠️ **The fourth one is not a nicety.** Three builders reached the first three greens on the
same brief. The third map was sealed, satisfied all seven of its rules and compiled clean,
and in game had a door painted flat on a wall, counters that were single boxes, and no
skirting anywhere. `render_vmf_view` existed throughout and was called **once in 145 tool
calls**. A count of greens cannot see proportion or absence; you can.

**Build to Source's scale, which is not the real world's.** Heights are four thirds of real —
measured on three unrelated Valve models — while the player is one to one. Door leaf 48 × 108,
shop counter 56 tall, casework 24 deep. `write_vmf_fitting` carries all of it: give it the
envelope you would have given a box and it supplies the articulation.

Read `overall`, never `errorCount`: zero errors is also what a run returns when a rule matched
nothing, and when there is no rules file at all. Both come back `skipped`.

⚠️ **The room pass splits space at one cell size and it is not the default, and the response is
not monotone.** When a rule about doorways matches nothing, vary `step` — try 32 — before
touching geometry. `check_vmf_rules` reports the `segmentation` it used and says so.
[`building.md`](references/building.md) has the measured table and the rest of the traps.

## Asking what a place is, without compiling it

These answer questions Hammer never asked, and all of them work on an **uncompiled** `.vmf`:

| Question | The tool |
|---|---|
| Does it seal? | `read_vmf_leak` — with the path out, in seconds, no compiler |
| What rooms are there, and what joins them? | `read_vmf_rooms` — and `merges`, which says *why* the count is what it is |
| Is this place wide enough to stand and pass in? | `measure_vmf_clearance` — a swept hull, not a ray |
| Can a person stand in front of that door? | `measure_vmf_approach` |
| Can this see that? | `read_vmf_visibility`, `read_vmf_sightlines` |
| What is in the way, and how far? | `read_vmf_trace`, `read_vmf_nearest_surface` |
| Which faces are floor, wall, ceiling — and touchable? | `read_vmf_surfaces` |
| **What does it look like?** | `render_vmf_tour` for the whole place in one call, `render_vmf_view` from one camera, `render_vmf_plan` as a dimensioned floor plan |
| Does it meet its own brief? | `check_vmf_rules` against `<map>.rules.json` |

A brief is checkable: `<map>.rules.json` beside the `.vmf` states widths, headroom, floor areas
and sight lines, and `check_vmf_rules` judges them. It **reports and never refuses** — a mapper
may want a narrow alley, and turning a design choice into a write error is how a tool stops
being usable.

## Writing or changing a VMF

1. `read_fgd_class` before inventing a keyvalue — the game's FGD is the schema Hammer enforces, and
   it answers "does this class accept this key".
2. `read_vmf_lint` **before every compile**. It catches in a second what a compile takes forty
   minutes to refuse, and what otherwise only shows up in game.
3. `edit_vmf` splices the original text: entities, keyvalues, outputs. **Everything untouched stays
   byte for byte identical**, so a one-entity change gives a one-entity diff. It is guarded
   (`confirm: true`) and writes a `.bak` by default.

   Never reserialise a VMF. What a reserialisation costs has been measured, and it is not what you
   would think: our formatter copies values verbatim, so `5416.0312` survives it. What does not
   survive is what the grammar does not model — **`//` comments, blank lines, indentation that is
   not one tab per level**. Third-party editors and hand-edited maps have all of these, and the
   loss is silent. (The Python sidecar reads values back as numbers: never write a VMF through it.)

4. `write_vmf_solid` creates brush geometry, and `read_vmf_solids` is the oracle that makes it
   safe: it recovers the volume **from the planes**, running the opposite way, so a sign error
   cannot hide in both directions at once.

**In Garry's Mod, the FGD is not the whole truth**: Lua registers its own entities. An
`unknown-classname` on a `ttt_*` or `r*` class is probably a false positive — the lint already
knows the repository's Lua entities and the Hammer++ compiler classes, but not those of an addon
that is not installed. It says which schemas it judged against (`fgdsLoaded`).

**A map with `func_instance` is read expanded or not at all.** Folded, an instance is one entity
where there is a whole building: counts are massively understated, and any output crossing an
instance boundary looks like a dead reference. `read_vmf` and `read_vmf_lint` take
`collapseInstances: true` — set it as soon as a `func_instance` shows up in the histogram.

## Compiling

Detail in [references/compiling.md](references/compiling.md). The essentials:

- `read_vmf_lint` first, always.
- `run_compile` with `fast: true` to iterate; `fast: false` only to ship.
- `toolchain: "stock"` by default. `"plusplus"` when vvis takes hours or a map hits a ceiling — and
  then recompile with `stock` to compare before concluding anything.
- **Copy the `.vmf` out of any read-only tree before compiling**: the compiler writes the `.bsp`
  beside its source, and the write guard refuses those trees.
- A **leak invalidates everything after it**. `run_compile` stops at the offending stage on its own.
- `read_leak` turns "leaked!" into a named entity. The compilers give no position at all.

## Optimising, lighting, shipping

Three areas where counting is automatable and **placement is not**:

- [references/optimisation.md](references/optimisation.md) — visleaves, `func_detail`, hints,
  areaportals, props.
- [references/lighting.md](references/lighting.md) — lightmaps, HDR, cubemaps, static props.
- [references/shipping.md](references/shipping.md) — packing, nav mesh, the check before shipping.

## What no tool here can do

To be said rather than worked around:

- **Name a street, a plot, a district.** A `.bsp` carries no such notion. `read_sightlines` measures
  lines of sight between walkable points, not "the longest avenue"; a spec that needs "plot" must
  first define the convention that bounds one.
- **See props and brush entities.** The tracer only knows the world tree: a closed door reads as
  open.
- **Generate a nav mesh.** Only `nav_generate` in the engine does it. No offline generator exists,
  here or anywhere.
- **Judge.** Which wall is structural, where a hint goes, whether a map looks good. Counting
  areaportals is automatic; deciding where to put them is not.

  This one has a sharper edge than it used to. No *tool* judges — but `render_vmf_tour` puts
  the picture in front of somebody who can, and three sessions' worth of evidence says that
  not looking is the expensive failure, not looking and being unsure. The line is between
  "no tool decides whether this is good" and "nobody looked", and only the first is a limit.

And two things that used to be on this list and are not any more, because the entry expired
rather than the reasoning:

- **Look at a map.** `render_vmf_view` draws an uncompiled `.vmf` from any camera,
  `render_vmf_tour` walks the whole place and returns it as one contact sheet, and
  `render_vmf_plan` draws a dimensioned floor plan — all without the game and without a
  compile. What none of them is, and will not be, is a viewport you drag things in.
- **Know whether a map seals without compiling it.** `read_vmf_leak` floods the geometry and
  returns the path out. It can miss a leak through a wall thinner than its cell; it does not
  invent one, because a cell counts as free only when its whole interior is.

## The server is shared

`srcds` and the `gmod-mcp` daemon are shared between sessions. **Never restart either
unilaterally** — two daemons destroy the transport silently. Any in-game check (gate B,
`buildcubemaps`, `nav_generate`, cross-checking a count) is asked for, not decided.
