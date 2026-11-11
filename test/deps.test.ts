import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolContext } from "../src/mcp/registry.js";
import { readMapDependenciesTool } from "../src/tools/deps.js";
import { callSidecar } from "../src/sidecar/client.js";
import { config, ctx as sharedCtx, FIXTURES, GAME, has, paths } from "./support/env.js";

const PROBE = join(FIXTURES, "hmcp_probe.bsp");
const ctx = sharedCtx as unknown as ToolContext;
const shape = z.object(readMapDependenciesTool.outputSchema!);

const run = async (path: string, limit = 3000) =>
  shape.parse(await readMapDependenciesTool.handler({ path, limit }, ctx));

describe.skipIf(!has.sidecar)("read_map_dependencies", () => {
  it("resolves the probe, and finds nothing missing", async () => {
    const out = await run(PROBE);
    expect(out.materialCount).toBeGreaterThan(0);
    expect(out.missing).toEqual([]);
    expect(out.resolved).toBeGreaterThan(0);
  }, 120_000);

  it("says whether the game's content was mounted, rather than assuming it", async () => {
    const out = await run(PROBE);
    expect(typeof out.gameMounted).toBe("boolean");
    // A run with no game content mounted would report every base texture as missing, so
    // the caller has to be able to tell that case apart from a genuinely broken map.
    if (!out.gameMounted) expect(out.gameError).not.toBeNull();
  }, 120_000);

  it("carries the caveat that `game` is not the same answer as `packed`", async () => {
    const out = await run(PROBE);
    expect(out.caveat).toMatch(/mounted/);
    expect(out.caveat).toMatch(/Nothing here is a delete list/);
  }, 120_000);

  it.skipIf(!has.prodMap)(
    "on the production map: resolves ten thousand assets and finds the five real faults",
    async () => {
      const out = await run(paths.prodMap);

      // Measured 11/08/2026. The counts are this map's, not assertions about the tool --
      // what is asserted is the shape: a large map resolves overwhelmingly from its own
      // pakfile, and what is left missing is a handful, not a wall.
      expect(out.gameMounted).toBe(true);
      expect(out.resolved).toBeGreaterThan(10000);
      expect(out.bySource.packed).toBeGreaterThan(out.bySource.game ?? 0);
      expect(out.staticPropModelCount).toBeGreaterThan(800);
      expect(out.missingCount).toBeLessThan(20);

      // The nodegraph this map ships is named rp_nyc1ty_day.ain -- a digit 1 where an i
      // belongs. The engine loads maps/graphs/<mapname>.ain and will never find it.
      const graph = out.missing.find((m: { kind: string }) => m.kind === "nodegraph-name-mismatch");
      expect(graph).toBeDefined();
      expect(graph!.path).toMatch(/\.ain$/);

      // Four textures referenced by model materials and present nowhere: those props draw
      // as a checkerboard for every player, and the map has shipped like that.
      expect(out.missing.filter((m: { kind: string }) => m.kind === "texture").length).toBeGreaterThan(0);
    },
    600_000,
  );

  it.skipIf(!has.prodMap)(
    "does not call vrad's own output unreferenced",
    async () => {
      // The failure this guards: 3983 .vhv files and 273 built cubemaps are named by no
      // material and no model, so a naive walk reports them as dead weight. Deleting them
      // flattens the lighting on every static prop in the map.
      const out = await run(paths.prodMap);
      expect(out.engineOwnedCount).toBeGreaterThan(4000);
      expect(out.packedUnreferenced.some((p: string) => p.endsWith(".vhv"))).toBe(false);
      expect(out.notWalkedCount).toBeGreaterThan(0);
      expect(out.notWalked.every((p: string) => /^(sound|scripts|particles|resource|scenes)\//.test(p))).toBe(
        true,
      );

      // Everything the engine finds by naming convention rather than by reference: the
      // skybox's six sides, the detail sprite config, the level sounds list. Each one is
      // a file no material and no model names, and each would otherwise read as dead
      // weight -- the same mechanism that let the misspelled .ain ship unnoticed.
      const left = out.packedUnreferenced;
      expect(left.some((p: string) => p.startsWith("materials/skybox/"))).toBe(false);
      expect(left.some((p: string) => p.endsWith(".vbsp"))).toBe(false);
      expect(left.some((p: string) => p.endsWith("_level_sounds.txt"))).toBe(false);
    },
    600_000,
  );
});

/**
 * The distinction `run_pack auto` is built on.
 *
 * A dependency found inside a VPK is base game content: every player who owns the game has
 * it. One found as a **loose file** in the content tree is almost always the mapper's own
 * work in progress -- it resolves at home because it is on that disk, and it is a
 * checkerboard for everyone else. The two are indistinguishable until you ask which
 * filesystem answered, and getting it wrong either wastes megabytes or ships a broken map.
 *
 * Tested by pointing the same map at two different game trees: one real, one a temporary
 * tree holding a loose copy of the material the probe uses.
 */
describe.skipIf(!has.sidecar)("loose files versus VPK content", () => {
  const scratch = mkdtempSync(join(tmpdir(), "hammer-loose-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function fakeGame(): string {
    const root = join(scratch, "fakegame");
    mkdirSync(join(root, "materials", "dev"), { recursive: true });
    writeFileSync(
      join(root, "gameinfo.txt"),
      `"GameInfo"\n{\n\tgame\t"Fake"\n\tFileSystem\n\t{\n\t\tSteamAppId\t4000\n` +
        `\t\tSearchPaths\n\t\t{\n\t\t\tgame+mod\t|gameinfo_path|.\n\t\t}\n\t}\n}\n`,
    );
    // The material the probe's every face uses, placed loose rather than in a VPK.
    writeFileSync(
      join(root, "materials", "dev", "dev_measuregeneric01.vmt"),
      `LightmappedGeneric\n{\n\t"$basetexture" "dev/dev_measuregeneric01"\n}\n`,
    );
    writeFileSync(join(root, "materials", "dev", "dev_measuregeneric01.vtf"), "not a real vtf");
    return root;
  }

  const call = (gameDir: string) =>
    callSidecar<{
      bySource: Record<string, number>;
      loose: Array<{ path: string; diskPath: string | null }>;
      looseCount: number;
    }>("map_dependencies", { path: PROBE, gameDir, limit: 50 }, ctx.config, 300_000);

  it("calls a loose file loose, and says where on disk it is", async () => {
    const r = await call(fakeGame());
    expect(r.looseCount).toBeGreaterThan(0);
    expect(r.bySource["game-loose"]).toBeGreaterThan(0);
    expect(r.bySource["game-vpk"] ?? 0).toBe(0);

    const vmt = r.loose.find((f) => f.path.endsWith("dev_measuregeneric01.vmt"));
    expect(vmt).toBeDefined();
    // The disk path is what run_pack auto hands to bspzip, so it has to be real.
    expect(vmt!.diskPath).not.toBeNull();
    expect(existsSync(vmt!.diskPath!)).toBe(true);
  }, 300_000);

  it("calls the same material VPK content when it comes from the real game", async () => {
    const r = await call(config.gmodGameDir);
    expect(r.bySource["game-vpk"] ?? 0).toBeGreaterThan(0);
    // Whatever a game keeps loose, each one named has to be a real file: the disk path is
    // what run_pack auto hands to bspzip. Holds for every game, unlike the list itself.
    for (const f of r.loose) {
      expect(f.diskPath, f.path).not.toBeNull();
      expect(existsSync(f.diskPath!), f.diskPath!).toBe(true);
    }
  }, 300_000);

  /**
   * Which of the probe's files a game keeps loose, measured per game, because the answer is
   * the game's and not the code's (#109).
   *
   * Garry's Mod ships detail.vbsp loose in its own root. That is the measured reason a loose
   * file is a candidate for packing rather than proof of a custom asset, and it is pinned
   * here so the claim in the docs has something holding it up.
   *
   * Counter-Strike: Source has a loose `cstrike/detail.vbsp` too -- and a copy inside
   * cstrike_pak.vpk, which its gameinfo mounts first, so the VPK answers and nothing is
   * loose. Same file, other answer: what decides it is search-path order, not the file.
   */
  const LOOSE: Record<string, string[]> = {
    gmod: ["detail.vbsp"],
    css: [],
  };

  it.skipIf(!has.gameContent || !LOOSE[GAME])(
    "keeps loose exactly the files this game is measured to keep loose",
    async () => {
      const r = await call(config.gmodGameDir);
      expect(r.loose.map((f) => f.path)).toEqual(LOOSE[GAME]);
    },
    300_000,
  );
});
