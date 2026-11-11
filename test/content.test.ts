import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/mcp/registry.js";
import { callSidecar } from "../src/sidecar/client.js";
import { readGameContentTool, readModelInfoTool } from "../src/tools/content.js";
import { readSourceGames as readSourceGamesTool } from "../src/tools/games.js";
import { GAME, ctx as sharedCtx, has } from "./support/env.js";

const ctx = sharedCtx as unknown as ToolContext;
const ready = has.sidecar && has.gameContent;

/**
 * These search the game's own VPKs through the Python sidecar, and one of them does it
 * three times. Vitest's default 5 s does not describe that work: on an idle machine the
 * file takes 16 s across fourteen tests, and under any load at all -- a `pnpm build` in the
 * same shell was enough -- the three-search case crossed the line at 5013 ms and went red.
 *
 * A flake nobody wrote down becomes a mystery, and a suite that fails for a reason unrelated
 * to the change under test is worse than a slow one. So the bound is stated, and it is
 * generous on purpose: it exists to catch a hang, not to police a duration nothing here
 * promises.
 */
const VPK_SEARCH_TIMEOUT = 30_000;

interface SearchReply {
  mounted: boolean;
  total: number;
  shown?: number;
  truncated?: boolean;
  results: Array<{
    path: string;
    name?: string;
    shader?: string | null;
    toolTexture?: boolean;
    resolves?: boolean;
    missingTextures?: string[];
  }>;
  error?: string;
}

interface ModelReply {
  found: boolean;
  mins?: number[] | null;
  maxs?: number[] | null;
  size?: number[] | null;
  skinCount?: number;
  sequences?: string[];
  materials?: string[];
  model: string;
}

const search = (args: Record<string, unknown>): Promise<SearchReply> =>
  readGameContentTool.handler(
    { kind: "material", limit: 100, ...args } as never,
    ctx,
  ) as unknown as Promise<SearchReply>;

describe("read_game_content", () => {
  it("refuses an empty pattern rather than returning the whole game", async () => {
    // Refused in TypeScript, before the sidecar is reached, so this holds on a bare
    // machine -- which is the machine CI runs on and where every other test here skips.
    await expect(search({ pattern: "   " })).rejects.toThrow(/needs a pattern/);
  });

  it.skipIf(!ready)("finds a material every Source game has", async () => {
    const r = await search({ pattern: "brickwall001a" });
    expect(r.mounted).toBe(true);
    expect(r.total).toBeGreaterThan(0);
    expect(r.results.map((x) => x.path)).toContain("materials/brick/brickwall001a.vmt");
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("returns the name in the form a .vmf stores, not the path", async () => {
    // The whole point of the tool: what comes out here goes straight into
    // set_face_material, with no prefix to strip and no case to fix.
    const r = await search({ pattern: "brickwall001a" });
    const hit = r.results.find((x) => x.path === "materials/brick/brickwall001a.vmt")!;
    expect(hit.name).toBe("BRICK/BRICKWALL001A");
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("treats a bare word as a substring and a starred one as a glob", async () => {
    // The glob must actually find something. Asserting only that it finds fewer than the
    // substring passes when it finds nothing at all, and `.every()` on an empty array is
    // vacuously true -- which is how a sabotage run that removed globbing stayed green.
    const substring = await search({ pattern: "brick" });
    const glob = await search({ pattern: "brick/brickwall*" });
    expect(glob.total).toBeGreaterThan(0);
    expect(substring.total).toBeGreaterThan(glob.total);
    expect(glob.results.every((x) => x.path.includes("brick/brickwall"))).toBe(true);

    // A wildcard in the middle is the case a substring match cannot express at all:
    // `brickwall00?a` finds 001a and 003a, and no path contains that literal text.
    const middle = await search({ pattern: "brickwall00?a" });
    expect(middle.total).toBeGreaterThan(1);
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("says how many it found, not only how many it returned", async () => {
    // A truncated list that reports its own length as the total is how a caller concludes
    // the game has four bricks.
    const r = await search({ pattern: "brick", limit: 2 });
    expect(r.results).toHaveLength(2);
    expect(r.shown).toBe(2);
    expect(r.total).toBeGreaterThan(2);
    expect(r.truncated).toBe(true);
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("reads the shader only when asked, and marks tool textures", async () => {
    const plain = await search({ pattern: "brickwall001a" });
    expect(plain.results[0]!.shader).toBeUndefined();

    const detailed = await search({ pattern: "brickwall001a", details: true });
    expect(detailed.results[0]!.shader).toBe("LightmappedGeneric");
    expect(detailed.results[0]!.toolTexture).toBe(false);

    const tool = await search({ pattern: "tools/toolsnodraw", details: true });
    expect(tool.results[0]!.toolTexture).toBe(true);
  }, VPK_SEARCH_TIMEOUT);

  // #77. Found building hmcp_backyard: this tool listed NATURE/BLENDGRASSDIRT01 as present,
  // it went onto the garden's displacements, and read_map_dependencies then reported three
  // missing .vtf behind it. The .vmt ships with the game and its textures do not -- which is
  // the purple checkerboard this tool exists to prevent, reported as fine.
  describe("a material whose textures are absent (#77)", () => {
    /**
     * The behaviour, on a game made for the test. Which real material is broken is a fact
     * about one game's content -- `nature/blendgrassdirt01` is Garry's Mod's, and
     * Counter-Strike: Source does not ship it at all -- so pinning only that made #77's
     * check fail on every other game and skip on every machine without one (#109). A
     * gameinfo, two VMTs and one VTF need neither, only the sidecar.
     */
    describe("in a game built for the test", () => {
      const scratch = mkdtempSync(join(tmpdir(), "hammer-unresolved-"));
      afterAll(() => rmSync(scratch, { recursive: true, force: true }));

      const game = join(scratch, "fakegame");
      mkdirSync(join(game, "materials", "hmcp"), { recursive: true });
      writeFileSync(
        join(game, "gameinfo.txt"),
        `"GameInfo"\n{\n\tgame\t"Fake"\n\tFileSystem\n\t{\n\t\tSteamAppId\t4000\n` +
          `\t\tSearchPaths\n\t\t{\n\t\t\tgame+mod\t|gameinfo_path|.\n\t\t}\n\t}\n}\n`,
      );
      // A blend whose second texture is absent: #77's shape exactly, a garden that is half
      // checkerboard. Its first texture exists, so "missing" has to name the right one.
      writeFileSync(
        join(game, "materials", "hmcp", "blend_broken.vmt"),
        `WorldVertexTransition\n{\n\t"$basetexture" "hmcp/present"\n` +
          `\t"$basetexture2" "hmcp/absent"\n}\n`,
      );
      writeFileSync(
        join(game, "materials", "hmcp", "whole.vmt"),
        `LightmappedGeneric\n{\n\t"$basetexture" "hmcp/present"\n}\n`,
      );
      writeFileSync(join(game, "materials", "hmcp", "present.vtf"), "not a real vtf");

      const find = (args: Record<string, unknown>): Promise<SearchReply> =>
        callSidecar<SearchReply>(
          "search_content",
          { gameDir: game, kind: "material", limit: 100, ...args },
          ctx.config,
          VPK_SEARCH_TIMEOUT,
        );

      it.skipIf(!has.sidecar)("reports it as unresolvable, and names what is missing", async () => {
        const r = await find({ pattern: "hmcp/blend_broken", details: true });
        expect(r.mounted).toBe(true);
        const row = r.results.find((x) => x.path === "materials/hmcp/blend_broken.vmt");
        expect(row).toBeDefined();
        expect(row!.resolves).toBe(false);
        expect(row!.missingTextures).toEqual(["materials/hmcp/absent.vtf"]);
      }, VPK_SEARCH_TIMEOUT);

      it.skipIf(!has.sidecar)("reports a material that does draw as resolvable", async () => {
        const r = await find({ pattern: "hmcp/whole", details: true });
        expect(r.results).toHaveLength(1);
        expect(r.results[0]!.resolves).toBe(true);
        expect(r.results[0]!.missingTextures).toEqual([]);
      }, VPK_SEARCH_TIMEOUT);

      it.skipIf(!has.sidecar)("says nothing about resolution when details were not asked for", async () => {
        // The default listing opens no VMT at all: a GMod install holds tens of thousands.
        const r = await find({ pattern: "hmcp/blend_broken" });
        expect(r.results).toHaveLength(1);
        expect(r.results[0]!.resolves).toBeUndefined();
      }, VPK_SEARCH_TIMEOUT);
    });

    /**
     * The same check against a game's real content, where someone has measured a broken
     * material in it. Both entries are from the game's own VPKs, so they hold on any
     * install of that game rather than on one machine's loose files. A game with no entry
     * skips: an absent measurement is not a failure.
     */
    describe("in the game's own content", () => {
      const BROKEN: Record<string, { material: string; missing: string }> = {
        // Found building hmcp_backyard (#77). Its .vmt ships with Garry's Mod; its textures do not.
        gmod: {
          material: "nature/blendgrassdirt01",
          missing: "materials/nature/forest_grass_01.vtf",
        },
        // Measured 11/11/2026 against Counter-Strike: Source's cstrike_pak.vpk: one of three
        // stock blends in it whose textures the game does not have.
        css: {
          material: "cs_havana/blendrockmoss002a",
          missing: "materials/nature/rockwall012a.vtf",
        },
      };
      const known = BROKEN[GAME];

      it.skipIf(!ready || !known)("reports it as unresolvable, and names what is missing", async () => {
        const r = await search({ pattern: known!.material, details: true });
        const row = r.results.find((x) => x.path === `materials/${known!.material}.vmt`);
        expect(row).toBeDefined();
        expect(row!.resolves).toBe(false);
        expect(row!.missingTextures).toContain(known!.missing);
      }, VPK_SEARCH_TIMEOUT);

      it.skipIf(!ready)("reports a material that does draw as resolvable", async () => {
        const r = await search({ pattern: "brick/brickwall001a", details: true });
        expect(r.results[0]!.resolves).toBe(true);
        expect(r.results[0]!.missingTextures).toEqual([]);
      }, VPK_SEARCH_TIMEOUT);
    });
  });

  it.skipIf(!ready)("finds models as well as materials", async () => {
    const r = await search({ pattern: "props_c17/oildrum001", kind: "model" });
    expect(r.results.map((x) => x.path)).toContain("models/props_c17/oildrum001.mdl");
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("returns nothing, and says nothing is there, for a name that is not", async () => {
    const r = await search({ pattern: "no_such_material_anywhere_12345" });
    expect(r.mounted).toBe(true);
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
  }, VPK_SEARCH_TIMEOUT);
});

describe("a game profile that is not installed", () => {
  it("searches nothing rather than searching Garry's Mod under another game's name", async () => {
    // Falling back to the configured GMod directory returned GMod's own assets under a
    // reply that named the other game: a confident answer about content the map will not
    // have. read_source_games is what says which profiles resolve to a real directory.
    const games = (await readSourceGamesTool.handler({} as never, ctx)) as unknown as {
      games: Array<{ id: string; gameDir: string | null }>;
    };
    const missing = games.games.find((g) => g.gameDir === null);
    if (!missing) return;

    const r = await search({ pattern: "brick", game: missing.id });
    expect(r.mounted).toBe(false);
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
  });
});

describe("read_model_info", () => {
  const info = (model: string): Promise<ModelReply> =>
    readModelInfoTool.handler({ model } as never, ctx) as unknown as Promise<ModelReply>;

  it.skipIf(!ready)("measures a prop's own hull", async () => {
    // Measured 11/08/2026 against Garry's Mod's copy of Half-Life 2's content. The numbers
    // are the reason the tool exists: the origin sits at the centre of the drum, so placing
    // it at a floor's own z buries half of it, and nothing downstream reports that.
    const r = await info("props_c17/oildrum001");
    expect(r.found).toBe(true);
    expect(r.size![0]).toBeCloseTo(29, 1);
    expect(r.size![1]).toBeCloseTo(29, 1);
    expect(r.size![2]).toBeCloseTo(45.562, 2);
    expect(r.mins![2]).toBeLessThan(0);
    expect(r.maxs![2]).toBeGreaterThan(0);
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("adds the prefix and the suffix a caller left off", async () => {
    const bare = await info("props_c17/oildrum001");
    const full = await info("models/props_c17/oildrum001.mdl");
    expect(bare.model).toBe("models/props_c17/oildrum001.mdl");
    expect(bare.size).toEqual(full.size);
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("lists the skins and materials a mapper chooses between", async () => {
    const r = await info("props_c17/oildrum001");
    expect(r.skinCount).toBe(6);
    expect(r.materials!.length).toBeGreaterThan(0);
    expect(r.materials![0]).toMatch(/^materials\/models\//);
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("names its sequences rather than dumping their internals", async () => {
    // srctools reprs a Sequence with its bounding box and its event list, a few hundred
    // characters each, answering a question nobody asked.
    const r = await info("props_c17/oildrum001");
    expect(r.sequences).toEqual(["idle"]);
  }, VPK_SEARCH_TIMEOUT);

  it.skipIf(!ready)("says a model is absent instead of failing", async () => {
    const r = await info("models/nope/nope.mdl");
    expect(r.found).toBe(false);
    expect(r.size ?? null).toBeNull();
  }, VPK_SEARCH_TIMEOUT);
});
