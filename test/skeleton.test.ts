/**
 * Creating a map, which nothing here could do until now.
 *
 * The gap was found by trying to use this toolkit for its stated purpose: an agent building
 * a map with these tools and nothing else got `ENOENT` from `write_vmf_solid` on the very
 * first call, enumerated all sixty-nine tools, found none that creates a `.vmf`, and had to
 * write a skeleton by hand -- breaking the one rule the exercise was built around.
 *
 * The suite had quietly paid the same cost: `test/build.test.ts` carries a hand-written
 * `SKELETON` constant for exactly this reason.
 *
 * The last test here is the one that matters. Two programs written on the same afternoon
 * agreeing proves less than it looks, so a map created by `write_vmf`, filled by
 * `write_vmf_solid` and by nothing else, is handed to vbsp -- and must seal.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/mcp/registry.js";
import { writeVmfSolidTool } from "../src/tools/build.js";
import { runCompile } from "../src/tools/compile.js";
import { readGameContentTool } from "../src/tools/content.js";
import { editVmf, writeVmf } from "../src/tools/vmfedit.js";
import { readVmfLeakTool } from "../src/tools/scene.js";
import { DEFAULT_SKYNAME, emptyVmf } from "../src/vmf/skeleton.js";
import { insertSolids } from "../src/vmf/build.js";
import { checkVmfSolids } from "../src/vmf/solid.js";
import { ctx as sharedCtx, has } from "./support/env.js";

const ctx = sharedCtx as unknown as ToolContext;
const scratch = mkdtempSync(join(tmpdir(), "hammer-skeleton-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Every map `write_vmf` creates has its sky looked up in the game, through the sidecar: a
 * fresh Python process that mounts the game's VPKs and walks `materials/skybox`. That is
 * well under a second, but not a duration anything here promises -- before #109 the walk
 * covered the whole game and took 8 s on a Counter-Strike: Source install, and Vitest's
 * default 5 s turned every test below that creates a map red. The bound exists to catch a
 * hang, the same reasoning as `VPK_SEARCH_TIMEOUT` in content.test.ts.
 */
const SKY_CHECK_TIMEOUT = 30_000;

interface Created {
  path: string;
  written: boolean;
  bytes: number;
  skyname: string;
  skybox: {
    checked: boolean;
    found: boolean | null;
    missingSides: string[];
    alternatives: string[];
    note: string;
  };
  note: string;
}

const create = async (name: string, over: Record<string, unknown> = {}): Promise<Created> =>
  (await writeVmf.handler(
    {
      path: join(scratch, name),
      skyname: DEFAULT_SKYNAME,
      gridSpacing: 64,
      dryRun: false,
      confirm: true,
      ...over,
    } as never,
    ctx,
  )) as unknown as Created;

describe("the empty map", () => {
  it("has the five blocks Hammer writes, and a worldspawn", () => {
    const text = emptyVmf();
    for (const block of ["versioninfo", "visgroups", "viewsettings", "world", "cameras"]) {
      expect(text).toMatch(new RegExp(`^${block}$`, "m"));
    }
    expect(text).toMatch(/"classname" "worldspawn"/);
    expect(text).toMatch(/"skyname" "sky_day01_01"/);
  });

  it("carries the sky and grid it was asked for", () => {
    const text = emptyVmf({ skyname: "sky_borealis01", gridSpacing: 16 });
    expect(text).toMatch(/"skyname" "sky_borealis01"/);
    expect(text).toMatch(/"nGridSpacing" "16"/);
  });

  /**
   * The point of the whole file: an empty map is only worth writing if the writer that
   * refused an absent one accepts this. `insertSolids` throws "this file has no `world`
   * block" on anything else, including a zero-byte file.
   */
  it("is accepted by the solid writer that refuses an absent file", () => {
    const r = insertSolids(emptyVmf(), [
      { shape: "box", mins: [-64, -64, 0], maxs: [64, 64, 64] },
    ]);
    expect(r.solidIds).toHaveLength(1);
    const report = checkVmfSolids("built", r.text);
    expect(report.validCount).toBe(report.solidCount);
  });
});

describe("write_vmf", () => {
  it("creates a file that was not there", async () => {
    const r = await create("fresh.vmf");
    expect(r.written).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, "utf8")).toBe(emptyVmf());
    expect(r.bytes).toBeGreaterThan(0);
  }, SKY_CHECK_TIMEOUT);

  it("refuses to overwrite, because the alternative is deleting a map", async () => {
    const path = join(scratch, "occupied.vmf");
    writeFileSync(path, "hours of work\n");
    await expect(create("occupied.vmf")).rejects.toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe("hours of work\n");
  });

  it("writes nothing on a dry run", async () => {
    const r = await create("dry.vmf", { dryRun: true });
    expect(r.written).toBe(false);
    expect(existsSync(join(scratch, "dry.vmf"))).toBe(false);
  }, SKY_CHECK_TIMEOUT);

  it("says the sky was not checked, rather than implying it was", async () => {
    // No game configured is a normal case -- a map for a game this machine does not have
    // is still a map -- and `found: null` is the honest answer for it. Absent and unknown
    // are different, and a boolean cannot hold both.
    const r = await create("nogame.vmf", { game: undefined });
    expect(typeof r.skybox.checked).toBe("boolean");
    if (!r.skybox.checked) {
      expect(r.skybox.found).toBeNull();
      expect(r.skybox.note).toMatch(/not checked/);
    }
    // Either way the note reaches the caller, which is the whole point of #62.
    expect(r.note).toContain(r.skybox.note);
  }, SKY_CHECK_TIMEOUT);

  describe("checking the sky against the game", () => {
    const ready = has.sidecar && has.gameContent;

    it.skipIf(!ready)("confirms the default is a sky the game really has", async () => {
      const r = await create("default-sky.vmf");
      expect(r.skybox.checked).toBe(true);
      expect(r.skybox.found).toBe(true);
      expect(r.skybox.missingSides).toEqual([]);
      // What the check does NOT prove, said out loud: the two vbsp "default cubemap"
      // lines are about the .vtf headers, which nothing here reads.
      expect(r.skybox.note).toMatch(/default cubemap/);
    }, SKY_CHECK_TIMEOUT);

    it.skipIf(!ready)("names skies the game has when the one asked for is absent", async () => {
      const r = await create("made-up-sky.vmf", { skyname: "sky_not_a_real_sky_at_all" });
      expect(r.skybox.checked).toBe(true);
      expect(r.skybox.found).toBe(false);
      expect(r.skybox.missingSides).toHaveLength(6);
      expect(r.skybox.alternatives.length).toBeGreaterThan(0);
      expect(r.skybox.alternatives).not.toContain("sky_not_a_real_sky_at_all");

      // The alternatives have to be real, or this is worse than saying nothing -- and
      // "real" is checked against the game through a different tool, not against the
      // list this one just built. Note the first one found here is `painted`, which is a
      // complete sky whose name does not begin with "sky": a name-shaped assertion would
      // have passed for the wrong reason.
      const first = r.skybox.alternatives[0]!;
      const found = (await readGameContentTool.handler(
        { pattern: `skybox/${first}*`, kind: "material", limit: 100 } as never,
        ctx,
      )) as unknown as { results: Array<{ path: string }> };
      const sides = new Set(
        found.results
          .map((row) => /skybox\/(.+?)(rt|lf|bk|ft|up|dn)\.vmt$/i.exec(row.path))
          .filter((m): m is RegExpExecArray => m !== null && m[1] === first)
          .map((m) => m[2]!),
      );
      expect([...sides].sort()).toEqual(["bk", "dn", "ft", "lf", "rt", "up"]);
      // And the file is still written: this reports, it does not refuse.
      expect(r.written).toBe(true);
    }, SKY_CHECK_TIMEOUT);
  });
});

/**
 * The compiler oracle, and the exercise that produced this tool, in one test: nothing
 * below touches a file except through a tool call.
 */
describe("a map created and built through tools alone", () => {
  const SHELL = [
    { shape: "box" as const, mins: [-288, -288, -32], maxs: [288, 288, 0] },
    { shape: "box" as const, mins: [-288, -288, 256], maxs: [288, 288, 288] },
    { shape: "box" as const, mins: [-288, -288, 0], maxs: [-256, 288, 256] },
    { shape: "box" as const, mins: [256, -288, 0], maxs: [288, 288, 256] },
    { shape: "box" as const, mins: [-256, -288, 0], maxs: [256, -256, 256] },
    { shape: "box" as const, mins: [-256, 256, 0], maxs: [256, 288, 256] },
  ];

  const build = async (name: string, shell: typeof SHELL): Promise<string> => {
    const { path } = await create(name);
    for (const solid of shell) {
      await writeVmfSolidTool.handler(
        {
          path,
          solids: [solid],
          material: "DEV/DEV_MEASUREGENERIC01",
          lightmapScale: 16,
          dryRun: false,
          backup: false,
          confirm: true,
        } as never,
        ctx,
      );
    }
    await editVmf.handler(
      {
        path,
        ops: [
          { op: "add", keyvalues: { classname: "info_player_start", origin: "0 0 16" } },
          {
            op: "add",
            keyvalues: { classname: "light", origin: "0 0 128", _light: "255 255 255 200" },
          },
        ],
        dryRun: false,
        backup: false,
        confirm: true,
      } as never,
      ctx,
    );
    return path;
  };

  it("reads as sealed without a compiler", async () => {
    const path = await build("sealed.vmf", SHELL);
    const r = (await readVmfLeakTool.handler(
      { path, step: 16, maxCells: 4_000_000 } as never,
      ctx,
    )) as unknown as { sealed: boolean };
    expect(r.sealed).toBe(true);
  }, SKY_CHECK_TIMEOUT);

  it("reads as leaking the moment a wall is left out, so the test above means something", async () => {
    const path = await build("holed.vmf", SHELL.slice(0, 5));
    const r = (await readVmfLeakTool.handler(
      { path, step: 16, maxCells: 4_000_000 } as never,
      ctx,
    )) as unknown as { sealed: boolean };
    expect(r.sealed).toBe(false);
  }, SKY_CHECK_TIMEOUT);

  it.skipIf(!has.toolchain)(
    "seals for vbsp too, which was not written here",
    async () => {
      const path = await build("compiled.vmf", SHELL);
      const r = (await runCompile.handler(
        {
          vmf: path,
          fast: true,
          hdr: false,
          stages: ["vbsp"],
          toolchain: "stock",
          cull: false,
          timeoutMinutes: 10,
          confirm: true,
        } as never,
        ctx,
      )) as { ok: boolean; leaked: boolean; bspExists: boolean };

      expect(r.leaked).toBe(false);
      expect(r.bspExists).toBe(true);
      expect(r.ok).toBe(true);
    },
    300_000,
  );
});
