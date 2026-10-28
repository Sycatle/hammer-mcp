# Feasibility gates

Before writing a tool that depends on something, this repository first proves the something works.
Each gate below is dated, and one of them is still open and says so.

## Gate A

**The compilers under Wine — passed 02/08/2026.**

`vbsp.exe`, `vvis.exe` and `vrad.exe` (the "Garry's Mod Edition" build of 22/07/2026) load and run
under wine 9.0, `WINEPREFIX=~/.wine`, with the working directory forced onto the `bin` folder so
`tier0.dll` resolves.

A full compile of the probe map `test/fixtures/hmcp_probe.vmf` — a sealed room, an
`info_player_start`, a light, and an `info_target` used as a marker:

| Stage | Output | Exit |
|---|---|---|
| `vbsp -game <garrysmod> hmcp_probe.vmf` | `hmcp_probe.bsp`, no leak | 0 |
| `vvis -fast` | 4 portals, 16 visible clusters | 0 |
| `vrad -fast` | 32 triangles, lighting written | 0 |

Result: a 56,236-byte `.bsp`, VBSP version 20, `mapRevision` 1. It is committed as a fixture.

One warning, benign: `Skybox vtf files for skybox/sky_day01_01 weren't compiled with the same size
texture` — vbsp could not build the default cubemap. No effect on geometry.

**The path must be in absolute Windows form** (`Z:\...`). A relative path resolves against wine's
working directory and silently compiles the wrong file. `WINEDEBUG=-all` is not optional either:
without it, stderr is a wall of `fixme:` lines that buries the compiler's own output.

## Gate C

**The Hammer++ toolchain under Wine — passed 11/08/2026.**

`vbspplusplus.exe`, `vvisplusplus.exe`, `vradplusplus.exe` and `bspzipplusplus.exe` (June 2026
builds) run under the same wine 9.0 as the stock chain, with no extra DLL.

**What the gate corrected, and it is the important part: they do not live where they were expected
to.**

| | stock | Hammer++ |
|---|---|---|
| Directory | `GarrysMod/bin/` | `GarrysMod/bin/win64/` |
| Architecture | PE32 i386 | PE32+ x86-64 |
| The `.fgd` files | `bin/` | — (`toolsplusplus.fgd` ships separately) |

`bin/win64/` **also** holds its own 64-bit stock `vbsp.exe`/`vvis.exe`/`vrad.exe`, and requires the
**x86-64** beta branch of Garry's Mod (`BetaKey "x86-64"` in `appmanifest_4000.acf`). The
consequence for configuration: `gmodBin` used to mean both "where the compilers are" and "where the
`.fgd` files are". Those two roles separate here, and one path is no longer enough.

Two distinct archives, contrary to what the download page suggests:

- `hammerplusplus_gmod_build8871.zip` — the **editor only**, no compilers in it;
- `tools_plusplus.zip` (repository `ficool2/misc_tools`) — the four compilers,
  `studiomdlplusplus`, and `toolsplusplus.fgd`. Its `compatibility/` folder was **not** installed:
  it contains `tier0.dll`, `vstdlib.dll`, `filesystem_stdio.dll` and friends, which would overwrite
  the Steam install's own. Nothing needed them.

A full compile of `test/fixtures/hmcp_probe.vmf`, all three stages exiting 0:

| | PLANES | VERTEXES | TEXINFO | FACES | BRUSHES |
|---|---|---|---|---|---|
| stock | 40 | 35 | 3 | 16 | 6 |
| Hammer++ | 40 | 35 | 3 | 16 | 6 |

**Negative control** — without it the gate would only prove that a map which works, works. The
`info_player_start` moved to `0 0 2000`, outside the sealed volume: VBSP++ prints the same
`**** leaked ****`, the same `Entity info_player_start (0.00 0.00 2000.00) leaked!` line, and
writes a two-point `.lin` **in the same format, with the entity at the second point** — exactly the
convention `read_leak` was calibrated on.

All four raw outputs are committed under `test/fixtures/logs/` and replayed by
`test/compile.test.ts`: `parseCompileLog` stays silent on the three clean compiles and sees the
leak. That proves those two cases, **not** that every error the `++` builds can emit is covered —
their own messages have no sample yet.

## Gate B

**Does Garry's Mod honour `maps/<map>_l_0.lmp`? — passed 15/08/2026.**

**It does.** Measured on the live dev server, `gm_construct` under `sandbox`, tickrate 33, no
player connected. The protocol below is the one this section specified before it was run, and it
was followed except for step 5, which had to be replaced — see *"the control that did not
control"*.

### The map, before anything

`gm_construct.bsp` in the server tree: `mapRevision` **1765**, **1227** entities, and
**zero `info_target`**. That last number is what makes the probe conclusive: any `info_target` in
the running engine can only have come from the patch.

### The patch

```
write_lump_patch  bsp=srcds/garrysmod/maps/gm_construct.bsp
                  ops=[{op:"add", keyvalues:{classname:"info_target",
                                             targetname:"hmcp_probe", origin:"0 0 64"}}]
  -> server-config/maps/gm_construct_l_0.lmp   197 009 B
     entitiesBefore 1227   entitiesAfter 1228
```

Deployed by the sanctioned route, `./tools/sync-server-config.sh`, which copies
`server-config/` over `srcds/garrysmod/` — nothing of ours is ever written into the SteamCMD tree
by hand. `read_lump_patch` on the deployed file reads it back whole: `lumpID 0`, `lumpVersion 0`,
`lumpLength 196 989`, `mapRevision 1765`, 1228 entities, NUL-terminated.

### The result

Read from the running engine with `run_lua`, `gmod-mcp`:

| | `hmcp_probe` | `info_target` | entities |
|---|---|---|---|
| patch deployed | **1** | **1** | 283 |
| patch removed, same map, restarted | **0** | **0** | 275 |

```
class info_target   pos 0.000000 0.000000 64.000000   map gm_construct
```

The entity exists if and only if the file is there. **Garry's Mod reads these files today**, and
`write_lump_patch` can be relied on for what it claims: editing or deleting an entity a map spawns,
before it spawns.

### The control that did not control, and what it found instead

Step 5 as specified was *"`mapRevision + 1`, redeploy, restart → expect 0"*. It returned **1**.

The deployed bytes were checked afterwards rather than assumed: `mapRevision` **1766** at the head
of the file, written at 14:49:14, against a `.bsp` stamped **1765**, and the server booted at
14:51:01 — after. So the answer is not a stale one.

⚠️ **Garry's Mod does not check the `.lmp`'s `mapRevision`.** It applied a patch built against a
different revision of the map, in full, with nothing said on either side.

That reverses a claim this repository was making in three places, all now corrected: `codec.ts`
said *"the engine would ignore this patch without any message"*, and `read_lump_patch_status`
described the failure it catches as a "silent-ignore". The failure is a **silent-apply**, which is
the worse of the two — a patch left over from an older compile keeps editing the new map by names
and indices that may since have moved, and neither the engine nor the compiler will mention it.
`assertRevisionMatches` is therefore not a convenience that anticipates the engine: it is the only
check that exists anywhere.

Note that the guard had to be bypassed to run this control at all — the revision was changed by
writing four bytes at offset 16 of the finished `.lmp`, because `write_lump_patch` refuses to
produce a mismatched one.

The control that does discriminate is the one in the table above: **remove the file**. It proves
the mechanism rather than the revision field, which is what the gate was actually about.

### What was left behind

Nothing. Both the deployed `.lmp` and its source in `server-config/maps/` were removed after the
run; the two commands above rebuild them in seconds. The server was returned to
`rp_nycity_day` / `darkrp` / 33, the state it was found in.

## What a lump patch cannot do

Gate B is passed, and these three limits are structural rather than incidental — none of
them moves:

- **It cannot relight the map.** The LIGHTING lump is baked by vrad at compile time; adding a
  `light` entity through a patch changes nothing in game.
- **It cannot create brush entities.** A `func_*` needs a brush model (`*N`) that only vbsp emits.
- **It never reaches clients.** The `.lmp` lives server-side and is not referenced by the `.bsp`,
  so client-only entities added this way exist on the server and are invisible to every player.
