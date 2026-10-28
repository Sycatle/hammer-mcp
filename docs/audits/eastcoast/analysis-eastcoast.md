# `rp_eastcoast_v4c` — what the reading means

Derived from [`reading-eastcoast.md`](reading-eastcoast.md), which is authoritative on every
number. Anything wrong here can be corrected without touching what was measured — and **six
things already have been**: the lighting overflow, the edict count, the headline conclusion
itself, then the correction to that correction, which read the new measurement against the
wrong ceiling — and then, in the second pass, the edict count again (settled) and the claim
that two readers disagreed about one lump (they never read the same thing).

The question this was commissioned to answer: **is this map worth improving, and where.**

**The second pass answers it: yes, and the work starts at the entity list, not the geometry.**
The details are below; the shape of it is that the two things which looked like walls are not
walls, and that the map ships with four wiring defects and 21 MB of dead weight, all of which
are reachable without a decompile.

---

## ⚠️ The fact this analysis said governs every plan does not

**Corrected 15/08/2026, by measurement.** What follows first is what was written, then what
refuted it, because the wrong version is the useful half.

```
BRUSHES   8192 of 8192   MAX_MAP_BRUSHES
```

This was read as *on the hard ceiling, exactly* — and therefore as the fact governing every
decision: the map could not gain a single world brush, a decompile-and-rebuild would start at
100% of a limit, and nothing could be promised until somebody established whether the Hammer++
chain raised it.

**Nobody had to.** Neither compiler available here enforces `MAX_MAP_BRUSHES` at all. Measured on
a purpose-built map — the table and its method are in
[`docs/compiling.md`](../../compiling.md#the-limits-this-repository-reports-are-not-the-limits-it-compiles-against):

| Limit | SDK 2013 | stock `vbsp.exe` | `vbspplusplus.exe` |
|---|---|---|---|
| `MAX_MAP_BRUSHES` | 8192 | not enforced — wrote 27 006 | not enforced — wrote 17 582 |
| `MAX_MAP_BRUSHSIDES` | 65 536 | not enforced — wrote 162 036 | enforced at **131 072** |

The 8192 in `read_map_report` is `source-sdk-2013/src/public/bspfile.h`'s, and neither binary
here is SDK 2013 — the stock one calls itself *Garry's Mod Edition*.

**So this map is not against a wall, and the question that was going to gate every other
decision does not exist.** What remains true is narrower and still worth knowing: it sits at
exactly the SDK-2013 value, which is a striking number to land on by chance and which this
audit cannot explain. The compiler that built it in 2018 may have enforced what today's does
not. That is a hypothesis, and nothing here tests it.

⚠️ **A second correction, 15/08/2026.** This section first said the ++ chain was the *stricter*
of the two and named `BRUSHSIDES` at 89% as the number to watch instead. Both halves were wrong.
++ enforces `MAX_MAP_BRUSHSIDES` at 131 072 — **twice** the SDK value — so it raises the limit
like everyone expects it to; it is simply the only one of the two that checks it. Against the
ceiling ++ actually defends, this map's 58 389 sides are **45%**, not 89%. There is no brush-side
headroom problem here either, and reading the reported percentage as a distance to a wall is what
produced two wrong conclusions in a row.

## The edict number is not what the verdict says it is — and the census says which number it is

`read_map_report` reports 3942 entities against `MAX_EDICTS` 2048 and calls it 192%, with the
message *"this is what the map costs empty; everything a gamemode spawns comes on top."*

The first pass sampled six `light_spot`, found none named, and concluded the real cost was
*"somewhere between about 1800 and 3942"*. **The second pass counted all 3942 instead of six**,
and the bound collapses onto its own floor:

| | Count | Reaches the runtime? |
|---|---|---|
| `light`, `light_spot`, `light_environment` — **unnamed** | **1113** | no: baked by vrad, then gone |
| `infodecal` | 991 | no: applied at load, then gone |
| everything else | **1838** | yes |

**1838 edicts empty, against a ceiling of 2048.** Not 3942, and not a range. The 36 named
`light_spot` are in the 1838, where they belong: a switchable light keeps its entity, and
naming is exactly what makes it switchable.

⚠️ **The 2104 subtracted rest on an inference, and it is the same one as before**: that Source
discards unnamed light entities and `infodecal` after load. What changed is not the confidence,
it is the population — the claim now covers every entity of those classes in the file rather
than six of 1068. Settling the inference itself still needs the engine: `read_entities` on a
running srcds, which `gmod-mcp` can do and no offline reader can.

**So the honest headline is worse than "192% of the ceiling" sounded, not better.** 1838 of
2048 leaves **210 slots** for everything DarkRP spawns — jobs, doors' ownership, spawned props,
weapons, money. That is not a margin, it is a rounding error, and it means the map is **not
usable as shipped**, for a reason no geometry limit was ever going to reveal.

### The 640 sprites are the whole answer

664 `env_sprite`, of which **24 are named and 640 are not**. They are glow sprites —
`glow06.spr` ×363, `glow.spr` ×245, `glow04.spr` ×41, and a handful more. Pure decoration,
each one a live server entity.

**Deleting the 640 unnamed ones takes the map from 1838 edicts to 1198, and the margin from
210 to 850.** It needs no recompile, no decompile and no source: it is an entity-lump patch,
which is the one thing `write_lump_patch` was built to do and the only edit that can remove an
entity *before* the map spawns it.

That is the single highest-value change available on this map, it is reachable today, and the
audit that produced the "192%" verdict could not see it because it was reading a total instead
of a population.

## The lighting overflow is not what I first thought

LIGHTING is 26.86 MB against a 16 MB ceiling — 168%, the second-worst number in the reading.

**My first reading was that it ships both LDR and HDR lightmaps**, from the arithmetic: 2 761 019
luxels at 4 bytes is 11.04 MB, and the lump is 2.4× that. `read_bsp_info` says
`hdrLighting: false`, reading the three lumps that settle it, and the two lumps whose names end
in `HDR` are the ones its own documentation warns are non-empty on LDR maps anyway.

The second pass settles that directly rather than by inference: **`LIGHTING_HDR`, lump 53, is
0 bytes**. LDR, from the lump.

So the 2.4× is **light styles**, and the census names them: of 1068 `light_spot`, **50 carry a
non-zero style** — 11 at style 1, 3 at style 6, and 36 spread across the custom styles 32–36.
A face lit by one of those stores one lightmap set per style, up to `MAXLIGHTMAPS = 4`. Fifty
lights out of 1149 are enough to inflate a lump 2.4× because it is the *faces they touch* that
pay, not the lights.

That also names the fix precisely, and it is not a sweep. The two sets line up exactly:
**all 36 named `light_spot` are styled, and every one of them sits in the custom range 32–36**
— the switchable ones, the light switches and the club spotlight. The other **14 styled lights
are unnamed and sit at styles 1 and 6**, Valve's animated presets: those flicker on their own
and nothing can switch them.

So the lighting lump is inflated by two different populations with two different answers.
Un-styling the 36 costs the map its only interactive lighting. Un-styling the 14 costs it
nothing but a flicker, and no entity has to be touched to find them.

That changes what a fix would be. Dropping HDR would have been free and is not available.
Reducing styles means deciding which flickering lights stop flickering, which is a design
question, not a compile flag.

The distribution says where the luxels are, and it is not where a reader might guess:

| Bucket | Faces | Luxels | Share of luxels |
|---|---|---|---|
| 1–256 | 23 345 (89%) | 927 706 | 34% |
| 257–4096 | 2 953 (11%) | 1 833 313 | **66%** |

**Eleven per cent of the lit faces carry two thirds of the lighting budget.** That is the shape
of a map where `set_lightmap_scale` has real headroom: coarsening the 426 faces in the top
bucket alone, where each doubling of scale divides the bill by four, is a measurable
intervention on a handful of surfaces rather than a sweep across 26 298.

## The map ships broken in four places, and all four are patchable

402 outputs, **7 aimed at a name that does not exist**. That ratio is unremarkable — most
shipped maps have a few. What matters is *which* seven, and reading the wiring around them
turns four dead names into four defects a player can meet.

**1 — the bar's windows never come back, and something churns forever.** Sixteen of the
seventeen shopfronts respawn their broken windows the same way: break one, its `OnBreak`
enables a 120-second `logic_timer`, the timer kills the group, re-spawns it from a
`point_template`, and disables itself. `bar_2_windows_timer` is the seventeenth, and every one
of its three outputs names **`res_4_windows`** instead. Two consequences, and the second is the
expensive one:

- the bar's windows, once broken, stay broken for the life of the map;
- the timer never disables itself — the `Disable` it fires lands on *res_4's* timer — so from
  the first broken bar window onward it fires **every 120 seconds until map change**, killing
  and re-spawning a different building's windows. Anyone standing at res_4 watches intact
  glass reset on a two-minute cycle, forever.

**2 — `store_4`'s windows have no respawn at all.** Its two `func_breakable_surf` enable
`store_4_windows_timer`, which does not exist, and no `store_4_windows_template` exists either.
Two of the seven dead outputs are this. It is the same shopfront system with one member simply
missing.

**3 — the map's tonemapping never applies.** `logic_auto` sets `SetBloomScale`,
`SetAutoExposureMin` and `SetAutoExposureMax` on `tonemap` at map spawn. There is no
`env_tonemap_controller` among the 57 classnames. Three of the seven dead outputs, and the
visible effect is that the author's exposure intent is absent — the map runs on whatever the
client's defaults are.

**4 — the bar's button does nothing.** `bar_button_logic` fires `bar_template,ForceSpawn` on
true and `bar_props,Kill` on false. `bar_template` is a `point_template` with **no `Template01`
key at all**, and `bar_props` does not exist. The button changes a sprite's colour and nothing
else.

**None of these needs a decompile.** All four live in the entity lump, which is the one part of
a compiled map that `write_lump_patch` rewrites in place — three retargeted outputs, one
missing timer to add, one `env_tonemap_controller` to create, one template to fill. That is the
cheapest real improvement this map has, and it is the argument for route A existing at all.

⚠️ **Two caveats, stated because neither was tested.** These are read from the entity lump, not
observed in a running game: what a `point_template` with `spawnflags 3` does on repeated
`ForceSpawn` is documented behaviour, not measured behaviour here. And a lump patch has not
been proven to load at all on the current Garry's Mod branch — that was gate B, **passed
15/08/2026**, in
[`docs/gates.md`](../../gates.md).

## Twenty-one megabytes of the twenty-seven are five files and a dead set

The PAKFILE is the largest lump in the map — 27.1 MB of a 79 MB file, larger than the lighting
everybody worries about. It is also the one place where a fix is arithmetic rather than
judgement.

| | Bytes | Share | What it is |
|---|---|---|---|
| 163 HDR cubemap textures | 12 474 064 | **44%** | unreadable: `LIGHTING_HDR` is 0 bytes |
| `mall_trees_branches01.vtf` | 5 592 672 | 20% | one 2048 × 2048 foliage sheet |
| `decals/basketmarking.vtf` | 5 592 640 | 20% | **a decal**, also 2048 × 2048 |
| everything else | ~4.4 MB | 16% | 1510 files |

**The HDR cubemap set cannot be read by this map.** `buildcubemaps` writes both sets whichever
mode it runs in, and lump 53 is empty, so the 12.5 MB is carried and never sampled. Dropping it
is a repack — `run_pack`, no compiler, no source — and it is the largest single byte saving
available anywhere in the file.

The 2048² decal is the other one. A basketball court marking at the resolution of a skybox is
disproportionate on its face; halving it to 1024² recovers 4.2 MB. The foliage sheet at the
same size is defensible, since an alpha-tested branch sheet is where resolution shows.

Taken together, **an addon that currently makes a joining player wait for 17 MB compressed
could ship at roughly three quarters of that without a single change a player would see.**

⚠️ Repacking a third-party Workshop addon is a redistribution decision before it is a technical
one. See the last section.

## Visibility: a big map cut into a lot of small pieces

```
11 337 leaves   3 653 clusters   1.55 MB visdata
median leaf volume 172 032   mean 42 306 662
```

The mean is 246× the median, which is the signature of a map with a few enormous outdoor leaves
and thousands of tiny indoor ones. 134 leaves are degenerate — zero volume.

Two absences are louder than any of those numbers:

- **`OCCLUSION` is 12 bytes.** Not one occluder in a 350-metre city.
- **38 `func_areaportal`** across 81 424 m². For comparison, round 6 measured that two
  areaportals in a 12 × 11 m tenement took `areas` from 2 to 3, and this map's `AREAS` lump is
  168 bytes.

Whether those absences cost anything is not readable from a `.bsp`, and this is where the audit
stops being able to answer. `read_visleaf_stats` counts the split; only the running engine says
what a player's `mat_wireframe` draws.

## What a compiled map cannot be asked

Stated because the next step is a decompile, and a decompiled `.vmf` will look like a source
file without being one.

**Compiling destroyed the structural / `func_detail` distinction, every hint brush, and every
visgroup.** They are not in the `.bsp` and no reader here will recover them. So:

- the 8192 brushes are *world* brushes — how many were `func_detail` in the original is
  indeterminable;
- a decompile brings everything back as **structural**, which is the opposite of the original
  and the single largest thing to fix. Round 6 measured what that costs on a map built here:
  thirty-seven brushes of trim, left structural, took a map from 74 leaves to 188 and divided
  the median leaf volume by ten;
- the 30 `info_hint` entities are *not* hint brushes — they are AI hint nodes, a different
  thing with a similar name.

**And the addon ships no `.nav`.** The 42 entries in the `.gma` are the `.bsp`, ten materials
and four models — nothing else. A nav mesh cannot be generated offline by anything, here or
elsewhere: only `nav_generate` in a running engine makes one. So the first time this map is
served, it has no navigation, and producing one is an in-engine step nobody can skip or script
around.

### The 8192 is at least not a torn write

The first pass could not explain landing on the SDK ceiling exactly and said so. The second
pass tests the one hypothesis that would have made the file *dangerous* rather than merely
curious — a compiler that stopped mid-write:

```
sum of numsides = 58 389   max(firstside + numsides) = 58 389   orphaned brushsides = 0
```

Every brushside is claimed by a brush and the chain ends exactly at the last one. **The lump is
internally consistent**, so whatever produced 8192 produced a coherent 8192.

That rules out a tear. It does **not** explain the coincidence, and nothing here does: a
compiler that clamped cleanly at its ceiling and one that happened to stop at 8192 leave the
same file behind. The hypothesis that the 2018 toolchain enforced what today's does not remains
untested, and testing it would need that toolchain.

## Where the work is, in order

The order changed at the second pass. Two items are struck because they are answered, and the
new first item is one the first pass could not see.

1. **Delete the 640 unnamed `env_sprite`, by lump patch.** 1838 edicts → 1198, and the margin
   against `MAX_EDICTS` goes from 210 to 850. Nothing else on this list changes a number by
   that much, and it needs no source, no compiler and no decompile. Gate B is passed, so the
   route is open.
2. **The four wiring defects**, same patch, same mechanism: `bar_2_windows_timer` retargeted,
   `store_4`'s timer and template supplied, an `env_tonemap_controller` named `tonemap` added,
   `bar_template` filled or its button unwired.
3. **Repack without the HDR cubemaps.** −12.5 MB on a 79 MB addon, no compiler involved, and
   the only cost is deciding whether a repacked third-party addon is something this project
   redistributes.
4. ~~**Settle the edict count in the engine.**~~ **Downgraded, 15/08/2026.** The census settled
   which number it is (1838); what remains open is the inference underneath — whether the
   engine really discards 1113 unnamed lights and 991 decals. Worth one `read_entities` on a
   loaded map, no longer worth blocking on.
5. **The 426 heaviest faces.** 11% of faces hold 66% of the lighting budget; `set_lightmap_scale`
   there is the cheapest measurable win in the file — but it needs a `.vmf`, so it sits behind
   the decompile with everything else geometric.
6. **The structural / detail split**, if and only if a decompile happens — the largest single
   lever Source has, and the one a decompile guarantees will be wrong.
7. **Occluders and areaportals**, last, and only after somebody has stood in the map with
   `mat_wireframe` on. Counting them is automatic; deciding where they go is not.

~~**Establish the brush ceiling.**~~ Answered 15/08/2026: neither compiler enforces
`MAX_MAP_BRUSHES`, and this map is at 45% of the `BRUSHSIDES` ceiling the ++ chain does
enforce. No brush limit constrains this work.

**The shape of that list is the answer to "can we work on this map".** Items 1 to 3 are
reachable today, cost hours, and are the ones that decide whether the map is *usable*. Items 5
to 7 are the ones that decide whether it is *good*, and every one of them is behind a decompile
that will hand back a `.vmf` with the structural/detail split inverted. Do the first three
first, and the decompile stops being a prerequisite for finding out whether this map is worth
it.

## What this audit found about the toolkit, not the map

- **`read_gma` cannot read what the Workshop actually stores**
  ([#96](https://github.com/ProjectSocietyStudio/hammer-mcp/issues/96)). The addon on disk is a
  raw LZMA stream, and every Workshop map is. The refusal is correct and the message is exact,
  but the commonest way anyone obtains a map needs a decompression step the toolkit does not
  have — six lines of Python stood between this repository and the file it was asked to audit.

- ⚠️ **`read_entity_report` parses entity lumps fine. It was never given one**
  ([#97](https://github.com/ProjectSocietyStudio/hammer-mcp/issues/97) — **requalified
  15/08/2026, and the first pass was wrong**). The issue's premise, *"two readers of one lump,
  one of which cannot parse it"*, is false: `read_entity_report` takes a **`.vmf`**
  (`src/tools/wiring.ts:24`), and it was handed a 79 MB `.bsp`. It read the whole binary in as
  text and the KeyValues lexer failed inside it. `read_map_organisation` — also a `.vmf` tool —
  fails at the identical offset for the identical reason, which is what gave it away.

  The entity lump is clean: 52 327 lines, not one with an odd quote count. What the first pass
  called a defect in a reader was a category error in the caller, restated confidently enough
  to survive into an issue and two documents.

  ✅ **Fixed 15/08/2026.** The real defect underneath was worse than the one reported: **a `.vmf`
  tool given a `.bsp` read the entire file into a string before failing.** On this map that is
  79 MB and a confusing error. On `rp_nycity_day` it is 1.13 GB, and the repository's own skill
  opens with the rule that a naive full read of that file kills the MCP transport. A path that
  does not end in `.vmf`, or a buffer that starts with `VBSP`, should be refused by name at the
  door.

- ✅ **Nothing in this repository validated the wiring of a compiled map**
  ([#103](https://github.com/ProjectSocietyStudio/hammer-mcp/issues/103), **fixed 15/08/2026**:
  `validate_io` and `read_entity_report` now take either format, and on this map the tool
  reproduces this audit's hand count exactly — 3942 entities, 402 outputs, 7 dead across the
  same four names). It was the gap this pass leaned on hardest. `validate_io` and `read_entity_report` are both `.vmf`-only
  (`src/tools/wiring.ts:86` and `:24`), while the BSP side has `read_bsp_entities`, which
  reports a histogram and samples. **Every one of the four defects in the section above was
  found with hand-written Python**, because no tool here will take a `.bsp` and tell you which
  outputs point at nothing.

  That is the exact case the `source-map` skill calls *"the production case"*: editing a map
  you have no source for. The entity lump is KeyValues text, the same grammar the `.vmf`
  machinery already parses, and `read_bsp_entities` already extracts it correctly. The gap is
  wiring one to the other.

- ✅ **`read_leak` concluded from a file that could not have been there**
  ([#104](https://github.com/ProjectSocietyStudio/hammer-mcp/issues/104), **fixed 15/08/2026**:
  the reply now carries `establishedBy`, and a bare `.bsp` reports `nothing` rather than a
  verdict). It returned
  `leaked: false` because no `.lin` sits beside the `.bsp` — but this `.bsp` came out of a
  `.gma`, which carries no `.lin` and never could. The reasoning is sound for a map compiled
  in place and unsound for every map obtained any other way, and the answer does not say which
  case it is in.

Two of these four are answered by the same observation: the toolkit is sharp on maps it built
and blunt on maps it was handed, and the audits directory exists precisely because those are
different.
