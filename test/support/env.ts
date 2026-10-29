/**
 * What the machine running the tests actually has.
 *
 * Most of this suite is not a unit test: it drives the real Source toolchain under wine,
 * the real Python sidecar, and real maps. None of that ships with the repo, so nearly
 * every file guarded itself with its own `existsSync` against its own hand-built path.
 * Six of them also computed the repo root as `test/fixtures/../../..` -- three levels up,
 * which lands OUTSIDE this repository and only resolves to anything meaningful when the
 * checkout happens to sit inside the private workspace it was written in.
 *
 * One place decides all of it now, and `HAMMER_MCP_REPO` overrides the guess, so a
 * contributor with a different layout points the suite at their tree instead of editing
 * six files.
 *
 * The other half of the job is being loud. A skipped test and a passing test look the
 * same in a green summary, and a contributor who runs `pnpm test` on a bare machine
 * deserves to know that the compiler tests never ran rather than to conclude the
 * toolchain works. `announceMissing()` says what is absent, once per process.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";
import { allGames } from "../../src/games/resolve.js";
import { pythonPath } from "../../src/sidecar/client.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * The tree the server anchors its state and its game content to.
 *
 * `HAMMER_MCP_REPO` wins. Otherwise the historical guess is kept verbatim: three levels
 * up from `test/fixtures`. Inside the workspace this file was written in, that is the
 * root holding `srcds/`; anywhere else it is some unrelated directory, and every
 * predicate below simply reports false -- which is the honest answer, not a failure.
 */
export function repoRoot(): string {
  return process.env.HAMMER_MCP_REPO ?? join(FIXTURES, "..", "..", "..");
}

export const REPO = repoRoot();
export const config: Config = loadConfig(REPO);

/** A minimal ToolContext. The audit log is a sink: no test asserts on it. */
export const ctx = {
  config,
  audit: { record: () => undefined },
} as unknown as { config: Config; audit: { record: () => void } };

const GAME_CONTENT = {
  /** The production map: 1.13 GB, never committed, the only oracle at real scale. */
  prodMap: join(REPO, "srcds/garrysmod/addons/rp_nycity_day/maps/rp_nycity_day.bsp"),
  /** The only large Hammer-written VMF around, shipped inside the TTT gamemode. */
  tttSource: join(REPO, "srcds/garrysmod/gamemodes/terrortown/mapexamples/ttt_traps.vmf"),
  /** A stock Valve entity-lump patch, the reference the codec was calibrated on. */
  stockLmp: join(REPO, "srcds/garrysmod/maps/c1a1_l_0.lmp"),
  mapsDir: join(REPO, "srcds/garrysmod/maps"),
} as const;

export const paths = GAME_CONTENT;

export const has = {
  /** The stock compilers. They ship with the GMod client, never with srcds. */
  toolchain: existsSync(join(config.gmodBin, "vbsp.exe")),
  /** ficool2's rebuild, installed separately. Absent is the normal case. */
  plusplus: existsSync(join(config.gmodBinPlusPlus ?? join(config.gmodBin, "win64"), "vbspplusplus.exe")),
  /** The srctools venv built by sidecar/setup.sh. */
  sidecar: existsSync(pythonPath(config)),
  /** The .fgd files, which live beside the compilers. */
  fgd: existsSync(join(config.gmodBin, "garrysmod.fgd")),
  plusFgd: existsSync(join(config.gmodBin, "win64", "toolsplusplus.fgd")),
  prodMap: existsSync(GAME_CONTENT.prodMap),
  tttSource: existsSync(GAME_CONTENT.tttSource),
  stockLmp: existsSync(GAME_CONTENT.stockLmp),
  navPair:
    existsSync(join(GAME_CONTENT.mapsDir, "gm_construct.nav")) &&
    existsSync(join(GAME_CONTENT.mapsDir, "gm_construct.bsp")),
  /**
   * Lua entity trees to scan. Only a GMod content tree has these, and the assertion they
   * back is about counts, so an absent tree has to skip rather than assert zero.
   */
  luaEntities: existsSync(join(REPO, "srcds/garrysmod/addons")) || existsSync(join(REPO, "addons")),
  /**
   * The game's own materials and models, mounted through its VPKs.
   *
   * `gameinfo.txt` is what srctools reads to build the filesystem chain, so its presence
   * is the honest predicate: a directory that exists but has no gameinfo mounts nothing,
   * and the tests would report the content missing rather than the mount failing.
   */
  gameContent: existsSync(join(config.gmodGameDir, "gameinfo.txt")),
  /**
   * ficool2's bsp_rename, a standalone download that belongs to no game install.
   *
   * Absent is the normal case, here as on any fresh clone: it is not ours to
   * redistribute, so it cannot be committed and cannot be discovered either.
   */
  bspRename: existsSync(
    join(config.externalToolsDir ?? join(config.stateDir, "tools"), "bsp_rename.exe"),
  ),
  /** ficool2's tga2skybox, same story as bsp_rename: a separate download. */
  tga2skybox: existsSync(
    join(config.externalToolsDir ?? join(config.stateDir, "tools"), "tga2skybox.exe"),
  ),
  /** ficool2's cubemap2hdr. Its input has to come out of a map, so it also needs navPair. */
  cubemap2hdr: existsSync(
    join(config.externalToolsDir ?? join(config.stateDir, "tools"), "cubemap2hdr.exe"),
  ),
  /** VTFCmd, the command-line half of VTFEdit++. Needs DevIL.dll beside it. */
  vtfcmd: existsSync(join(config.externalToolsDir ?? join(config.stateDir, "tools"), "VTFCmd.exe")),
} as const;

/**
 * Whether Counter-Strike: Source resolves to a toolchain it can compile with here.
 *
 * Not in `has`: the tests that read it need CS:S to be *absent*, so false is the normal
 * case and must not be announced as something missing. When it is true, a test that
 * expects a compile against css to be refused would instead run a real one -- and the
 * one that does compiles test/fixtures/hmcp_probe.vmf in place, overwriting the probe
 * .bsp that the BSP readers' tests assert against.
 */
export const cssCompilable = allGames(config)["css"]?.unusableForCompile === null;

const LABELS: Record<keyof typeof has, string> = {
  toolchain: `the stock Source compilers (${config.gmodBin})`,
  plusplus: "the Hammer++ compilers (optional)",
  sidecar: "the Python sidecar venv (run sidecar/setup.sh)",
  fgd: "the game's .fgd files",
  plusFgd: "the Hammer++ .fgd (optional)",
  prodMap: "a large production .bsp",
  tttSource: "a large Hammer-written .vmf",
  stockLmp: "a stock Valve .lmp",
  navPair: "a .nav / .bsp pair",
  luaEntities: "a GMod Lua entity tree",
  gameContent: `the game's own content (${config.gmodGameDir})`,
  bspRename: `ficool2's bsp_rename.exe in ${config.externalToolsDir} (optional)`,
  tga2skybox: `ficool2's tga2skybox.exe in ${config.externalToolsDir} (optional)`,
  cubemap2hdr: `ficool2's cubemap2hdr.exe in ${config.externalToolsDir} (optional)`,
  vtfcmd: `VTFCmd.exe and DevIL.dll in ${config.externalToolsDir} (optional)`,
};

let announced = false;

/**
 * Prints, once, everything the machine does not have. Called from the setup file so it
 * runs whatever subset of the suite is invoked.
 */
export function announceMissing(): void {
  if (announced) return;
  announced = true;
  const missing = (Object.keys(has) as Array<keyof typeof has>).filter((k) => !has[k]);
  if (missing.length === 0) return;
  console.warn(
    `\n[hammer-mcp] Tests needing these are SKIPPED, not passing:\n` +
      missing.map((k) => `  - ${LABELS[k]}`).join("\n") +
      `\n  Repo root: ${REPO}${process.env.HAMMER_MCP_REPO ? " (HAMMER_MCP_REPO)" : ""}\n`,
  );
}
