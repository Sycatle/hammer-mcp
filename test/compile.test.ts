import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readGeometry } from "../src/bsp/geometry.js";
import { locateLeak, readPointfile } from "../src/compile/leak.js";
import { parseCompileLog } from "../src/compile/log.js";
import {
  chooseToolchain,
  compilerExe,
  runCompiler,
  ToolchainError,
  toolchainDir,
  toWindowsPath,
  windowsInvocation,
} from "../src/compile/wine.js";
import type { MapEntity } from "../src/entity/model.js";
import type { ToolContext } from "../src/mcp/registry.js";
import { readLeak, runCompile } from "../src/tools/compile.js";
import { FIXTURES, config, ctx as sharedCtx, has, paths } from "./support/env.js";

const ctx = sharedCtx as unknown as ToolContext;
const canCompile = has.toolchain;
const scratch = mkdtempSync(join(tmpdir(), "hammer-compile-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Windows path conversion", () => {
  it("maps the root onto Z:", () => {
    expect(toWindowsPath("/home/x/map.vmf")).toBe("Z:\\home\\x\\map.vmf");
  });

  it("refuses a relative path", () => {
    // The failure this prevents is silent: wine resolves a relative path against its
    // own working directory, and vbsp then compiles a different file successfully.
    expect(() => toWindowsPath("maps/foo.vmf")).toThrow(ToolchainError);
  });

  it("leaves a drive path on its drive, normalising only the separators", () => {
    // On Windows the path already is a Windows path. Prefixing Z: would hand vbsp
    // "Z:C:\...", which names no file at all.
    expect(toWindowsPath("C:/Steam/cstrike/maps/foo.vmf")).toBe("C:\\Steam\\cstrike\\maps\\foo.vmf");
    expect(toWindowsPath("D:\\maps\\foo.vmf")).toBe("D:\\maps\\foo.vmf");
  });
});

describe("how a Windows binary is executed", () => {
  const realPlatform = process.platform;
  const onPlatform = (platform: string): void => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };
  afterEach(() => onPlatform(realPlatform));

  const binary = "C:\\game\\bin\\vbsp.exe";
  const withBackend = (backend: string) => ({ ...config, backend }) as typeof config;

  it("runs the binary itself under the native backend on Windows", () => {
    onPlatform("win32");
    const [cmd, args, env] = windowsInvocation(withBackend("native"), binary, ["-game", "x"]);
    expect(cmd).toBe(binary);
    expect(args).toEqual(["-game", "x"]);
    expect(env.WINEDEBUG).toBe(process.env.WINEDEBUG);
  });

  it("refuses the native backend anywhere but Windows", () => {
    onPlatform("linux");
    expect(() => windowsInvocation(withBackend("native"), binary, [])).toThrow(/needs Windows/);
  });

  it("keeps wine's prefix and silences its fixme lines under the wine backend", () => {
    const [cmd, args, env] = windowsInvocation(withBackend("wine"), binary, ["-game", "x"]);
    expect(cmd).toBe("wine");
    expect(args).toEqual([binary, "-game", "x"]);
    expect(env.WINEDEBUG).toBe("-all");
    expect(env.WINEPREFIX).toBe(config.winePrefix);
  });

  it("still refuses proton, which nothing here has run", () => {
    expect(() => windowsInvocation(withBackend("proton"), binary, [])).toThrow(ToolchainError);
  });
});

describe("compile log rules", () => {
  it("recognises a leak and marks the log unclean", () => {
    const r = parseCompileLog("Processing areas...\n**** leaked ****\nEntity light (0 0 0) leaked!");
    expect(r.leaked).toBe(true);
    expect(r.clean).toBe(false);
    expect(r.findings[0]!.message).toMatch(/not sealed/);
  });

  it("stays clean and quiet on ordinary output", () => {
    // The baseline: a parser that flagged everything would look the same as one that works.
    const r = parseCompileLog("Loading map\nProcessing areas...\nDone (2)\n4 threads");
    expect(r.findings).toHaveLength(0);
    expect(r.clean).toBe(true);
  });

  it("explains what the compiler's own message hides", () => {
    const r = parseCompileLog("Displacement found on a(n) func_detail entity!");
    expect(r.findings[0]!.rule).toBe("displacement-on-entity");
    // vbsp prints brush id 0 every time, so the message has to say where the real one is.
    expect(r.findings[0]!.message).toMatch(/always 0/);
  });

  it("does not call the skybox cubemap notice a missing material", () => {
    // First-match-wins is what makes this work: the line matches the generic
    // "Can't load" rule too, whose advice -- pack the asset -- is wrong here, because
    // nothing is missing. vbsp simply could not build a placeholder.
    const r = parseCompileLog(
      "Can't load skybox file skybox/sky_day01_01 to build the default cubemap!",
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.rule).toBe("cubemap-size-mismatch");
    expect(r.findings[0]!.severity).toBe("info");
  });

  it("still reports a genuinely missing material", () => {
    const r = parseCompileLog("Material foo/bar not found.");
    expect(r.findings[0]!.rule).toBe("material-missing");
  });
});

describe("pointfile correlation", () => {
  const entity = (index: number, classname: string, origin: [number, number, number]): MapEntity =>
    ({
      index,
      classname,
      origin,
      keyvalues: [],
      connections: [],
      solidCount: 0,
      start: 0,
      end: 0,
    }) as MapEntity;

  it("names the entity sitting on an endpoint, whichever end it is", () => {
    // Measured, not assumed: vbsp put the entity on the SECOND point of a two-point
    // pointfile. Correlating only the first named a light 232 units away and missed
    // the actual cause.
    const path = join(scratch, "two.lin");
    writeFileSync(path, "-144 -144 304\n0 0 2000\n");
    const report = locateLeak(path, readPointfile(path), [
      entity(0, "light", [0, 0, 192]),
      entity(1, "info_player_start", [0, 0, 2000]),
    ]);
    expect(report.leakingEntity?.classname).toBe("info_player_start");
    expect(report.leakingEntity?.atEnd).toBe(true);
    expect(report.leakingEntity?.distanceUnits).toBe(0);
    expect(report.nearestToStart[0]!.classname).toBe("light");
  });

  it("reports no culprit when no entity is on either end", () => {
    // The negative control: without it, a correlation that always named its closest
    // entity would look exactly like one that identifies the cause.
    const path = join(scratch, "far.lin");
    writeFileSync(path, "0 0 0\n1000 1000 1000\n");
    const report = locateLeak(path, readPointfile(path), [
      entity(0, "light", [5000, 5000, 5000]),
    ]);
    expect(report.leakingEntity).toBeNull();
  });

  it("says a missing pointfile probably means no leak", () => {
    expect(() => readPointfile(join(scratch, "absent.lin"))).toThrow(/did not leak/);
  });

  /**
   * The reader above is right to throw -- it was handed a path and the file is not there.
   * The *tool* is a different question, and it used to pass that throw straight on, so
   * confirming a map was sealed came back as `read_leak failed: … does not exist`. An
   * agent that treats tool errors as failures reads *this map is sealed* as *this step
   * broke*, which is what happened while building hmcp_bodega.
   */
  describe("read_leak on a map that did not leak", () => {
    it("answers, rather than failing, when a .bsp is there and no pointfile is", async () => {
      const map = join(scratch, "clean.vmf");
      writeFileSync(map, "");
      writeFileSync(join(scratch, "clean.bsp"), "");

      const r = (await readLeak.handler({ path: map, limit: 5 }, ctx)) as {
        leaked: boolean;
        compiled: boolean;
        establishedBy: string;
        evidence: string[];
        note: string;
      };
      expect(r.leaked).toBe(false);
      expect(r.compiled).toBe(true);
      // The negative sister of the #104 case below: here the .vmf beside the .bsp shows a
      // compile happened in this directory, so the missing pointfile does mean something.
      expect(r.establishedBy).toBe("compile-artefacts");
      expect(r.evidence).toContain(map);
      // No hedge: a .bsp beside no pointfile is evidence, not a guess.
      expect(r.note).not.toMatch(/usually|probably/i);
    });

    /**
     * #104. This tool returned `leaked: false` on `rp_eastcoast_v4c.bsp`, reasoning that
     * vbsp writes a `.lin` when it leaks and none was there. That `.bsp` came out of a
     * Workshop `.gma`, which contains 42 entries and no pointfile and could not have
     * contained one -- so the absence it reasoned from carried no information at all.
     *
     * The fix is not a better guess, it is saying which case the answer is in.
     */
    it("does not claim a bare .bsp did not leak: nothing here compiled it", async () => {
      const only = join(scratch, "downloaded.bsp");
      writeFileSync(only, "");

      const r = (await readLeak.handler({ path: only, limit: 5 }, ctx)) as {
        leaked: boolean;
        compiled: boolean;
        establishedBy: string;
        evidence: string[];
        note: string;
      };
      expect(r.compiled).toBe(true);
      expect(r.establishedBy).toBe("nothing");
      expect(r.evidence).toEqual([only]);
      expect(r.note).toMatch(/never travels with its/);
      expect(r.note).toMatch(/read_vmf_leak/);
    });

    it("says nothing has compiled the map, rather than that it did not leak", async () => {
      const map = join(scratch, "never-built.vmf");
      writeFileSync(map, "");

      const r = (await readLeak.handler({ path: map, limit: 5 }, ctx)) as {
        leaked: boolean;
        compiled: boolean;
        note: string;
      };
      expect(r.compiled).toBe(false);
      expect(r.note).toMatch(/nothing here has compiled/i);
    });
  });
});

describe("the Hammer++ compilers say the same things", () => {
  // Captured from vbspplusplus/vvisplusplus/vradplusplus on 11/08/2026, gate C. The rules
  // in log.ts were written against the stock compilers of 2013; nothing guaranteed the
  // ++ builds phrase their failures the same way, and a parser that silently found
  // nothing in a ++ log would look exactly like a clean compile.
  const log = (name: string): string =>
    readFileSync(join(FIXTURES, "logs", `plusplus-${name}.txt`), "utf8");

  it.each(["vbsp", "vvis", "vrad"])("stays quiet on a clean %s run", (stage) => {
    const r = parseCompileLog(log(stage));
    expect(r.clean).toBe(true);
    expect(r.leaked).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("still recognises a leak, banner and entity line alike", () => {
    // The half that gives the three above their meaning: silence on a clean log only
    // counts once the same parser has been shown to speak up on a broken one.
    const r = parseCompileLog(log("leak"));
    expect(r.leaked).toBe(true);
    expect(r.clean).toBe(false);
    expect(r.byRule["leak"]).toBe(2);
  });
});

/** One vbsp pass over `vmf`, on whichever toolchain. */
async function compile(
  vmf: string,
  toolchain: "stock" | "plusplus" = "stock",
  stages: Array<"vbsp" | "vvis" | "vrad"> = ["vbsp"],
  cull = false,
): Promise<{
  ok: boolean;
  leaked: boolean;
  bspExists: boolean;
  pointfile: string | null;
  toolchain: string;
  stages: Array<{ stage: string; stdoutTail: string }>;
}> {
  return (await runCompile.handler(
    { vmf, fast: true, hdr: false, stages, toolchain, cull, timeoutMinutes: 10, confirm: true },
    ctx,
  )) as never;
}

describe("compiling for real, under wine", () => {
  const sealed = join(scratch, "sealed.vmf");
  const leaky = join(scratch, "leaky.vmf");

  if (canCompile) {
    copyFileSync(join(FIXTURES, "hmcp_probe.vmf"), sealed);
    // The most common real cause of a leak, and it touches no geometry: an entity
    // placed outside the sealed hull.
    writeFileSync(
      leaky,
      readFileSync(sealed, "utf8").replace(
        /("classname" "info_player_start"[\s\S]{0,200}?"origin" ")[^"]*(")/,
        "$10 0 2000$2",
      ),
    );
  }

  it.skipIf(!canCompile)("compiles the sealed probe without error", async () => {
    const r = await compile(sealed);
    expect(r.leaked).toBe(false);
    expect(r.bspExists).toBe(true);
    expect(r.pointfile).toBeNull();
    expect(r.ok).toBe(true);
  }, 300_000);

  it.skipIf(!canCompile)("detects the leak and locates its cause", async () => {
    const compiled = await compile(leaky);
    expect(compiled.leaked).toBe(true);
    expect(compiled.ok).toBe(false);
    expect(compiled.pointfile).not.toBeNull();

    const located = (await readLeak.handler({ path: leaky, limit: 3 }, ctx)) as {
      leakingEntity: { classname: string; distanceUnits: number } | null;
    };
    expect(located.leakingEntity?.classname).toBe("info_player_start");
    expect(located.leakingEntity?.distanceUnits).toBeLessThan(16);
  }, 300_000);
});

describe("choosing the Hammer++ toolchain", () => {
  const plusDir = toolchainDir(config, "plusplus");
  const hasPlus = has.plusplus;

  it("resolves the binaries of each chain to its own directory", () => {
    // The correction gate C forced: the ++ compilers are not siblings of the stock ones.
    expect(compilerExe("vbsp", "stock")).toBe("vbsp.exe");
    expect(compilerExe("vbsp", "plusplus")).toBe("vbspplusplus.exe");
    expect(toolchainDir(config, "stock")).toBe(config.gmodBin);
    expect(plusDir).toBe(join(config.gmodBin, "win64"));
  });

  it.skipIf(!hasPlus)("really runs the ++ binary, not the stock one", async () => {
    // Without this, the test below would pass unchanged if the toolchain argument were
    // ignored entirely: a stock compile of a map that compiles looks exactly like a ++
    // one. Only the binary's own banner tells them apart, and it is the first line, so
    // run_compile's stdoutTail (the last 40) cannot carry it.
    const run = await runCompiler(config, compilerExe("vbsp", "plusplus"), [], 60_000, "plusplus");
    expect(run.stdout.split("\n")[0]).toContain("vbspplusplus.exe");
  }, 120_000);

  it.skipIf(!hasPlus)("compiles the sealed probe the same way the stock chain does", async () => {
    const vmf = join(scratch, "sealed-plusplus.vmf");
    copyFileSync(join(FIXTURES, "hmcp_probe.vmf"), vmf);
    const r = await compile(vmf, "plusplus");
    expect(r.toolchain).toBe("plusplus");
    expect(r.leaked).toBe(false);
    expect(r.bspExists).toBe(true);
    expect(r.ok).toBe(true);
  }, 300_000);

  const TTT = paths.tttSource;

  it.skipIf(!hasPlus || !has.tttSource)("culls what it says it culls", async () => {
    // The probe map is six brushes and would show nothing. ttt_traps is the only real
    // Hammer-written source here -- and it lives under srcds/, where the repo hooks
    // refuse writes, while the compilers write the .bsp beside their source. Hence the
    // copy: this is the trap anyone hits the first time they compile a repo map.
    const plain = join(scratch, "cull-off.vmf");
    const culled = join(scratch, "cull-on.vmf");
    copyFileSync(TTT, plain);
    copyFileSync(TTT, culled);

    expect((await compile(plain, "plusplus")).ok).toBe(true);
    expect((await compile(culled, "plusplus", ["vbsp"], true)).ok).toBe(true);

    const countOf = (bsp: string, lump: string): number =>
      readGeometry(bsp).lumps.find((l) => l.name === lump)!.count!;
    const off = plain.replace(/\.vmf$/, ".bsp");
    const on = culled.replace(/\.vmf$/, ".bsp");

    // Measured 11/08/2026: 400 -> 318 planes, 725 -> 632 vertices. Asserted as a real
    // reduction rather than as those exact numbers, which would break on any compiler
    // update without anything actually being wrong.
    expect(countOf(on, "PLANES")).toBeLessThan(countOf(off, "PLANES"));
    expect(countOf(on, "VERTEXES")).toBeLessThan(countOf(off, "VERTEXES"));
    // And the point of culling: it removes what nothing referenced, so the map itself
    // is untouched. A "reduction" that also dropped faces would be a broken map.
    expect(countOf(on, "FACES")).toBe(countOf(off, "FACES"));
    expect(countOf(on, "TEXINFO")).toBe(countOf(off, "TEXINFO"));
  }, 600_000);

  it("picks the ++ chain when it is there, and says so", () => {
    // The default this repository compiles with. `chooseToolchain` is what run_compile
    // asks, so testing it here tests the decision rather than a copy of it.
    const chosen = chooseToolchain(config, "plusplus", ["vbsp", "vvis", "vrad"]);
    expect(chosen.requested).toBe("plusplus");
    if (hasPlus) {
      expect(chosen.chain).toBe("plusplus");
      expect(chosen.missing).toEqual([]);
      expect(chosen.note).toBeNull();
    }
  });

  it("falls back to stock when the ++ chain is absent, and names what is missing", () => {
    // A default that cannot run without Hammer++ would take CI and every fresh clone
    // with it. Falling back is right; falling back in silence is not -- without the
    // note and `toolchainRequested`, nobody could tell which compilers made a .bsp.
    const absent = { ...config, gmodBinPlusPlus: join(scratch, "no-such-toolchain") };
    const chosen = chooseToolchain(absent, "plusplus", ["vbsp", "vvis"]);
    expect(chosen.chain).toBe("stock");
    expect(chosen.requested).toBe("plusplus");
    expect(chosen.missing).toEqual(["vbspplusplus.exe", "vvisplusplus.exe"]);
    expect(chosen.note).toMatch(/not installed/);
    expect(chosen.note).toMatch(/tools_plusplus\.zip/);
  });

  it("does not dress a stock request up as a fallback", () => {
    // Asking for stock is a real request -- it is what a comparison between the two
    // chains needs -- so it never carries a note about anything being missing.
    const chosen = chooseToolchain(config, "stock", ["vbsp"]);
    expect(chosen.chain).toBe("stock");
    expect(chosen.note).toBeNull();
  });

  it.skipIf(!hasPlus)("compiles on the ++ chain, with culling, when asked for neither", async () => {
    // The switch itself: a call with no `toolchain` and no `cull` at all. Parsed through
    // the tool's own input schema rather than handed to the handler directly, because the
    // default lives in the schema -- which is also where the server applies it.
    const vmf = join(scratch, "default-chain.vmf");
    copyFileSync(join(FIXTURES, "hmcp_probe.vmf"), vmf);
    const args = z
      .object(runCompile.inputSchema!)
      .parse({ vmf, stages: ["vbsp"], timeoutMinutes: 10, confirm: true });
    expect(args.toolchain).toBe("plusplus");
    expect(args.cull).toBeUndefined();

    const r = (await runCompile.handler(args as never, ctx)) as unknown as {
      toolchain: string;
      toolchainRequested: string;
      cull: boolean;
      ok: boolean;
    };
    expect(r.toolchainRequested).toBe("plusplus");
    expect(r.toolchain).toBe("plusplus");
    expect(r.cull).toBe(true);
    expect(r.ok).toBe(true);
  }, 300_000);

  it("refuses cull on the stock chain instead of dropping it", async () => {
    // vbsp accepts unknown flags in silence. Ignoring cull here would produce a compile
    // that reports success and culled nothing, which is worse than an error.
    await expect(compile(join(scratch, "irrelevant.vmf"), "stock", ["vbsp"], true)).rejects.toThrow(
      /Hammer\+\+ flag/,
    );
  });

  it("names the missing chain rather than blaming the GMod install", async () => {
    // The negative control, and the reason the message is not the generic one: without
    // the chain named, "vbspplusplus.exe not found" reads as a broken GMod install --
    // and the stock compilers sitting right there are perfectly fine.
    const absent = { ...config, gmodBinPlusPlus: join(scratch, "no-such-toolchain") };
    await expect(
      runCompiler(absent, compilerExe("vbsp", "plusplus"), [], 5_000, "plusplus"),
    ).rejects.toThrow(/"plusplus" toolchain is not installed/);
  });
});
