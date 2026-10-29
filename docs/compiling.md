# Compiling, and what the compilers do not say

Three settings are load-bearing, all measured rather than guessed: the working directory must be
`bin/` or `tier0.dll` fails to resolve; `WINEDEBUG=-all` is mandatory or stderr is a wall of
`fixme:` lines; and **the path must be in absolute Windows form** (`Z:\...`).

That last one is the nastiest. A relative path resolves against wine's working directory, and vbsp
then compiles **a different file, without error**. So `toWindowsPath` refuses a relative path
rather than converting it.

On Windows none of that applies, because there is no wine: the `native` backend, the default
there, runs the `.exe` directly with the same working directory, and `toWindowsPath` leaves a
path that already carries a drive letter on that drive. Measured on 24/10/2026 on Windows 11 with
Counter-Strike: Source's stock 64-bit compilers (`bin/x64/`, vbsp built Nov 7 2025): vbsp, vvis
and vrad all ran, and a sealed 63-brush map compiled clean.

`run_compile` **stops at the first stage that fails.** Running vvis after a leak spends an hour
computing a visibility set that means nothing.

## Choosing a toolchain

`run_compile` and `run_pack` take `toolchain`, and **the default is `plusplus`** — ficool2's
Hammer++ rebuild of the SDK 2013 compilers. It is the better compiler: much faster vvis, and the
culling flags exist nowhere else. `cull` is on by default with it, for the same reason.

This reverses an earlier decision, and the argument that decision rested on is still true, so it is
worth saying what changed. The argument was: the only way to know whether the `++` chain altered
something it should not have is to recompile the same source with the stock chain and compare, and
a default nobody chose would remove that comparison invisibly. What serves that argument is **every
result naming the chain that actually ran** (`toolchain`, `toolchainRequested`, `cull`), not making
the slower chain the one everybody gets by accident.

| Situation | Chain |
|---|---|
| Iterating, shipping, everyday work | the default — `plusplus` |
| Doubt about a result the `++` chain returned | `toolchain: "stock"`, recompile, compare |
| A compile that must not prune anything | `cull: false` |
| No Hammer++ on the machine | nothing to do — it falls back and says so |

The `++` binaries stay optional. `health` says whether they are there; absent, `run_compile` and
`run_pack` **fall back to the stock chain** and report it in `toolchainNote` with the binaries that
were missing. The fallback is never silent: a `.bsp` whose compiler cannot be identified afterwards
is exactly what the old default existed to prevent.

`cull` on the stock chain is still **refused** rather than ignored — but only when a caller asks
for it explicitly. Leaving it out on a stock compile means "no culling", because that is the only
thing stock can do.

## What the Hammer++ chain buys, and what it does not

One flag is exposed — `cull` — because one is all that could be measured here.

**`cull`** turns on `-cullverts -cullplanes -cullbrushes -cullbrushsides`: vbsp normally only
discards what nothing references once a ceiling is reached. Measured on `ttt_traps.vmf`,
11/08/2026:

| | without | with | change |
|---|---|---|---|
| `PLANES` | 400 | 318 | **−20.5%** |
| `VERTEXES` | 725 | 632 | **−12.8%** |
| `FACES` | 441 | 441 | 0 |
| `TEXINFO` | 101 | 101 | 0 |
| bytes | 218,912 | 195,936 | **−10.5%** |

Faces and texinfos unchanged: that is what distinguishes a prune from a broken map. `BRUSHES` and
`BRUSHSIDES` did not move either — this map has nothing unused on that side, which is not evidence
that those two flags do nothing.

`cull` on the stock chain is **refused**, not ignored: vbsp swallows unknown options silently, and
a compile that reports success having culled nothing is worse than an error.

**The `++` compilers' own FGD joins the lint.** `toolsplusplus.fgd` declares five classes
`garrysmod.fgd` does not know: `func_detail_illusionary`, `func_detail_blocker`, `func_nobevel`,
`light_directional`, `light_projected`. Without it, a map using them collects one
`unknown-classname` per occurrence.

It is loaded **only if the file is there**, and `read_vmf_lint` returns `fgdsLoaded`: a schema that
widens silently is a lint that silently stops catching things. `hammerplusplus_fgd.fgd`, shipped
with the editor, is deliberately left out — it mostly redeclares existing classes to attach display
helpers, so merging it would change the accepted keyvalues of entities the game already defines.

**Two flags the received wisdom advertises, which do not hold up here:**

- **`-allowdynamicpropsasstatic` converts nothing.** It lifts vbsp's refusal on a `prop_static`
  whose model is not flagged static; the conversion itself is still a VMF edit. Not exposed:
  `ttt_traps.vmf` has **no** props at all, and the one map with 59 of them has no source. No
  constructible oracle, no tool — the same rule that keeps `read_vprof` unwritten.
- **`bspzip -threads` does not apply to `run_pack`.** BSPZIP++'s multithreading is on `-repack`, a
  different operation; `run_pack` does `-addlist`. `toolchain: "plusplus"` still gives it the `++`
  binary. `-repack -compress` was never tried: nothing says Garry's Mod reads an LZMA-compressed
  lump.

## The limits this repository reports are not the limits it compiles against

Measured 15/08/2026 on maps generated for the purpose: a sealed shell plus a solid block of
adjacent 32-unit cells. Adjacency matters — neighbours share their corners, so `N³` brushes cost
only `(N+1)³` unique vertices, which is the only way to exceed `MAX_MAP_BRUSHES` without tripping
`MAX_MAP_VERTS` first. Free-standing boxes cannot do it: 8192 × 8 is exactly 65536, so those two
ceilings arrive together, and the first probe proved it by failing on verts at 9006 boxes.

| probe | brushes · brushsides | stock `vbsp.exe` | `vbspplusplus.exe` |
|---|---|---|---|
| cubes | 9 267 · 55 602 | **compiles** | **compiles** |
| cubes | 27 006 · 162 036 | **compiles** | **refuses**, `Brush 152917: MAX_MAP_BRUSHSIDES` |
| wedges | 17 582 · 87 916 | **compiles** | **compiles** |

Neither binary is the one `LUMP_SPECS` quotes. The stock chain calls itself `Valve Software -
vbsp.exe (Jul 22 2026) - Garry's Mod Edition (64-bit)`, the other `ficool2 - vbspplusplus.exe
(Jun 23 2026)`, and the ceilings in `read_map_report` are
`source-sdk-2013/src/public/bspfile.h`'s. What each one actually enforces:

| Limit | SDK 2013 | stock | ++ |
|---|---|---|---|
| `MAX_MAP_BRUSHES` | 8192 | not enforced — wrote **27 006** | not enforced — wrote **17 582** |
| `MAX_MAP_BRUSHSIDES` | 65 536 | not enforced — wrote **162 036** | **enforced at 131 072** |
| `MAX_MAP_VERTS` | 65 536 | **enforced at 65 536** | not reached by these probes |

**`MAX_MAP_BRUSHES` is enforced by neither**, and the wedge probe is what settles it for ++. A
wedge has five sides rather than six, so 17 582 of them fit in 87 916 sides — past 8192 brushes
and past 16 384, with room to spare under the side limit. ++ compiled it and said so:
`Emitted 17582 brushes and 123068 brushsides`. Whatever stops a map on either chain, it is not
the brush count.

**Where ++ enforces, it enforces a doubled ceiling.** `Brush 152917` is the id of the **21 846th**
solid in that file; the 21 845 before it carry six sides each, which is 131 070, and the next six
would pass 131 072. That is 2 × 65 536 exactly. ++ is not more limited than stock — it is the only
one of the two that **checks** this limit at all, and the value it checks against is twice the
SDK's.

⚠️ **So a map ++ refuses and stock accepts is not a map ++ is being fussy about.** The stock chain
wrote a `BRUSHSIDES` lump at 247% of its stated size without a word; nothing here shows the engine
reads such a lump correctly, and the compiler that stopped is the one that made a claim it can
stand behind. Silence is not permission.

**And `read_map_report`'s `fail` on a lump is a statement about SDK 2013, not about the map.**
Each such verdict already carries the caveat verbatim — *"either the compilers that built this
raise it, or vbsp would have refused. Do not read it as 'this map is broken' without checking
which toolchain produced it"* — and this is the measurement behind that sentence.

⚠️ **What this does not license is reading a percentage against the wrong ceiling**
([#101](https://github.com/ProjectSocietyStudio/hammer-mcp/issues/101)). A map at 89%
of `BRUSHSIDES` as this repository reports it is at **45%** of what ++ enforces, and at no known
fraction of anything on stock. The percentages are useful as a relative signal and are not a
distance to a wall.

Two things the measurement found on its way:

- The stock chain's `Too many unique verts, max = 65536` stops vbsp with exit code 1, and
  `run_compile` reported that stage as `clean: true` with no finding at all
  ([#99](https://github.com/ProjectSocietyStudio/hammer-mcp/issues/99)). The ++ chain's
  `MAX_MAP_BRUSHSIDES` on the same probe produced exactly the right finding — the gap is that the
  vertex limit announces itself in prose rather than by name.
- **++ prints `Emitted N brushes and M brushsides`; stock prints neither.** That line is the
  cheapest ground truth there is on a map with no `.vmf`, and it is worth reading when a count is
  in question. Note that the emitted side count exceeds the authored one — 87 916 authored became
  123 068 emitted on the wedge probe, because vbsp adds bevel planes for collision. **A map can
  therefore pass the load-time check and fail on what it emits**, and the authored count is a
  lower bound rather than the number the limit is compared against.

⚠️ **Whether the engine copes with a lump past its stated ceiling is a separate question and is
not measured here.** GMod ships both the compiler and the engine, so a lump its vbsp writes is
presumably one its engine reads; that is an inference, not a measurement.

## Only world brushes seal

A leaked map is one where something inside can see the void. The consequences compound: the PVS
cannot be computed, the map loads fullbright, and vvis and vrad stop meaning anything — which is
why `run_compile` stops at the stage that leaked instead of spending an hour on the next one.

**`func_detail` does not seal. Nor do displacements, nor brush entities.** A room sealed with
`func_detail` leaks, and the reason is the whole point of the optimisation: vbsp removes detail
brushes from the BSP tree, so as far as visibility is concerned they are not there. Everything that
makes `func_detail` worth using is the same thing that makes it unable to hold the void out.

This rule was written down in an earlier French-only note and did not survive the move into these
docs — restored 11/08/2026 after a second session shipped a tool that flips brushes to
`func_detail` and had to prove the trap beside the benefit.

No static check can rule it out. Sealing is a property of the whole hull, not of any one brush, so
the only honest answer after such an edit is to compile. Measured on the probe map, which is a
sealed box: **all six of its brushes are load-bearing, the floor included** — the void is directly
underneath it. A bare closed room has no brush that is safe to detail.

## The pointfile said the opposite of what I believed

`read_leak` reads the `.lin` vbsp writes beside the map. I had assumed its first point was the
offending entity — that is what Quake lore says. **Wrong, measured 11/08/2026**: on the probe map
with its `info_player_start` moved outside, the pointfile has two points and the entity is on the
**second**. Correlating only the start named a `light` 232 units away and missed the cause
entirely.

So both ends are correlated, and the tool only names a culprit when an entity stands within 16
units of one of them. On the broken map: `info_player_start`, **at 0 units**. The negative control
exists too — with no entity near either end, the tool names nobody, where a naive correlation would
always name its nearest neighbour.

## What a compiler message deserves as a translation

The compilers speak to whoever wrote them in 2004, and several of their messages **name the wrong
thing**. Each rule therefore carries the correction rather than repeating the line:

| Message | What the rule adds |
|---|---|
| `**** leaked ****` | no position at all — hence the pointer to `read_leak` and the pointfile |
| `Displacement found on a(n) X entity` | the brush id it prints is **always 0**; `read_vmf_lint` gives the real one |
| `Bad surface extents` | names a face by an index you cannot find in Hammer |
| `Can't load skybox file … default cubemap` | **nothing is missing** — vbsp could not build a default cubemap |

That last one cost a correction: it was also triggering the generic "missing material" rule, whose
advice — pack the asset — was wrong. Rule matching became **first match wins**, specific before
generic.

It also cost three builders a moment each, which is why `write_vmf` now checks the sky it writes
against the game's own content and says what it found. Note what that check settles and what it
does not: it proves the **six sides exist**, mounting the same VPK chain the engine reads. Whether
they share a size and flags — which is what vbsp actually needs to build the default cubemap —
lives in the `.vtf` headers, and nothing in this server reads those. A sky can pass the check and
still draw these two lines, so the tool says so rather than implying a guarantee it has not earned.

## run_pack does not believe its own exit code

`bspzip` exits 0 whether or not it added anything. So `run_pack` counts the pakfile contents before
and after, and only returns `ok: true` when the file count grew by **exactly** what was asked for.
Verified: 1 → 2 files, 34,876 → 36,876 bytes.

## The nav mesh, or the failure that says nothing

Recompiling a map always invalidates its nav mesh. The engine compares the BSP size recorded in the
`.nav` against the map it is loading, and **says nothing** when they differ: in game that looks
like Nextbots refusing to move, with a silent console.

`read_nav` reads that header. Verified against ground truth, to the byte, on both shipped maps:

| Map | Recorded size | Actual `.bsp` size | Verdict |
|---|---|---|---|
| `gm_construct` | 36,735,656 | 36,735,656 | fresh |
| `gm_flatgrass` | 47,430,424 | 47,430,424 | fresh |

The negative control comes with it: the same mesh placed beside a map of a different size is
declared **stale**. Without it, a checker that always answered "fresh" would be indistinguishable
on every healthy map.

**What is proven and what is not**: magic, version, recorded size and the "analysed" flag are read
per the documented format and cross-checked on two files. The area count, however, is **indicative
at best** — `gm_construct` reports 2271 in 7.2 MB, or 3189 bytes each, where `gm_flatgrass` reports
853 at 325 bytes. The gap may well be real, since hiding spots and encounter paths grow faster than
the area count, but nothing here demonstrates it, and the field is documented as such rather than
presented as a measurement.

**Generating a nav mesh is out of reach**: only `nav_generate` in the engine does it, and no
offline generator exists — not here, and not publicly anywhere.
