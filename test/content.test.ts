import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/mcp/registry.js";
import { callSidecar } from "../src/sidecar/client.js";
import { readGameContentTool, readModelInfoTool } from "../src/tools/content.js";
import { readSourceGames as readSourceGamesTool } from "../src/tools/games.js";
import { ctx as sharedCtx, has } from "./support/env.js";

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
    it.skipIf(!ready)("reports it as unresolvable, and names what is missing", async () => {
      const r = await search({ pattern: "nature/blendgrassdirt01", details: true });
      const row = r.results.find((x) => x.path === "materials/nature/blendgrassdirt01.vmt");
      expect(row).toBeDefined();
      expect(row!.resolves).toBe(false);
      expect(row!.missingTextures).toContain("materials/nature/forest_grass_01.vtf");
    }, VPK_SEARCH_TIMEOUT);

    it.skipIf(!ready)("reports a material that does draw as resolvable", async () => {
      const r = await search({ pattern: "brick/brickwall001a", details: true });
      expect(r.results[0]!.resolves).toBe(true);
      expect(r.results[0]!.missingTextures).toEqual([]);
    }, VPK_SEARCH_TIMEOUT);

    it.skipIf(!ready)("says nothing about resolution when details were not asked for", async () => {
      // The default listing opens no VMT at all: a GMod install holds tens of thousands.
      const r = await search({ pattern: "nature/blendgrassdirt01" });
      expect(r.results[0]!.resolves).toBeUndefined();
    }, VPK_SEARCH_TIMEOUT);
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

  /**
   * #114. `_rt_Camera` and its kind are render targets the engine makes at runtime, never
   * files; reading them as missing called thirty of Counter-Strike: Source's own materials
   * broken. Tested on a game built for the test, with a control: a texture that truly is
   * absent, in the same material, must still be named.
   */
  describe("a render target (#114)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "hammer-rt-content-"));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    const game = join(scratch, "rtgame");
    mkdirSync(join(game, "materials", "hmcp"), { recursive: true });
    writeFileSync(
      join(game, "gameinfo.txt"),
      `"GameInfo"\n{\n\tgame\t"Fake"\n\tFileSystem\n\t{\n\t\tSteamAppId\t4000\n` +
        `\t\tSearchPaths\n\t\t{\n\t\t\tgame+mod\t|gameinfo_path|.\n\t\t}\n\t}\n}\n`,
    );
    writeFileSync(
      join(game, "materials", "hmcp", "monitor.vmt"),
      `UnlitGeneric\n{\n\t"$basetexture" "_rt_Camera"\n}\n`,
    );
    writeFileSync(
      join(game, "materials", "hmcp", "monitor_broken.vmt"),
      `UnlitGeneric\n{\n\t"$basetexture" "_rt_Camera"\n\t"$detail" "hmcp/absent_detail"\n}\n`,
    );

    const find = (pattern: string): Promise<SearchReply> =>
      callSidecar<SearchReply>(
        "search_content",
        { gameDir: game, kind: "material", limit: 100, pattern, details: true },
        ctx.config,
        VPK_SEARCH_TIMEOUT,
      );

    it.skipIf(!has.sidecar)("resolves, because the engine makes it", async () => {
      const r = await find("hmcp/monitor");
      const row = r.results.find((x) => x.path === "materials/hmcp/monitor.vmt");
      expect(row?.resolves).toBe(true);
      expect(row?.missingTextures).toEqual([]);
    }, VPK_SEARCH_TIMEOUT);

    it.skipIf(!has.sidecar)("does not hide a texture that is really absent beside it", async () => {
      const r = await find("hmcp/monitor_broken");
      expect(r.results[0]!.resolves).toBe(false);
      expect(r.results[0]!.missingTextures).toEqual(["materials/hmcp/absent_detail.vtf"]);
    }, VPK_SEARCH_TIMEOUT);

    it.skipIf(!ready)("leaves a stock material that draws one resolvable", async () => {
      // effects/nightvision draws _rt_FullFrameFB. Measured on Counter-Strike: Source, where
      // it read as broken before #114; a game that does not ship it has nothing to assert.
      const r = await search({ pattern: "effects/nightvision", details: true });
      const row = r.results.find((x) => x.path === "materials/effects/nightvision.vmt");
      if (!row) return;
      expect(row.resolves).toBe(true);
    }, VPK_SEARCH_TIMEOUT);
  });
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
