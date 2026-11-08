import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { BUILTIN_PROFILES, resolveProfiles } from "../src/games/profile.js";
import { GameConfigConflict, UnknownGameError, allGames, gameFor } from "../src/games/resolve.js";
import { runCompile } from "../src/tools/compile.js";
import { readVmfLint } from "../src/tools/vmf.js";
import { FIXTURES, cssCompilable, ctx, has } from "./support/env.js";

const scratch = mkdtempSync(join(tmpdir(), "hammer-profile-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A repo root carrying nothing but the config file under test.
 *
 * `HAMMER_MCP_REPO` is cleared for the call: it outranks the argument by design, so with
 * it set every test below silently loaded some other tree's configuration and asserted
 * against it. That is exactly how these tests failed on a bare machine while passing here.
 */
function rootWith(name: string, config: Record<string, unknown>): Config {
  const root = join(scratch, name);
  mkdirSync(join(root, ".hammer-mcp"), { recursive: true });
  writeFileSync(join(root, ".hammer-mcp", "config.json"), JSON.stringify(config));

  const saved = process.env["HAMMER_MCP_REPO"];
  delete process.env["HAMMER_MCP_REPO"];
  try {
    return loadConfig(root);
  } finally {
    if (saved !== undefined) process.env["HAMMER_MCP_REPO"] = saved;
  }
}

describe("the built-in table says only what it can back", () => {
  it("gives every profile the four facts discovery cannot produce", () => {
    for (const b of BUILTIN_PROFILES) {
      expect(b.steamAppId).toBeGreaterThan(0);
      expect(b.installDir.length).toBeGreaterThan(0);
      expect(b.modDir.length).toBeGreaterThan(0);
    }
  });

  it("hard-codes no FGD name and no lump ceiling anywhere", () => {
    // The point of the whole design. `GameData` is in every gameinfo.txt, so writing a
    // per-game FGD name here would be an assertion nobody verified -- and a wrong FGD
    // makes a lint accuse correct maps without ever saying it guessed.
    const text = JSON.stringify(BUILTIN_PROFILES);
    expect(text).not.toMatch(/\.fgd/);
    expect(text).not.toMatch(/MAX_MAP/);
  });

  it("claims a Hammer++ directory for the one game where it was measured", () => {
    // Gate C measured bin/win64 for GMod. Repeating it for games nobody ran would be a
    // guess about a directory layout, dressed as configuration.
    const withPlus = BUILTIN_PROFILES.filter((b) => b.plusPlusSubdir !== undefined);
    expect(withPlus.map((b) => b.id)).toEqual(["gmod"]);
  });

  it("marks a game it has never seen as unusable for compiling", () => {
    const games = resolveProfiles({}, []);
    for (const id of Object.keys(games)) {
      expect(games[id]!.unusableForCompile).not.toBeNull();
      expect(games[id]!.fgd).toEqual([]);
    }
  });
});

describe("provenance separates what was read from what was assumed", () => {
  it.skipIf(!has.toolchain)("takes the FGD and the instance path from gameinfo.txt", () => {
    const { game } = gameFor(loadConfig(process.cwd()));
    expect(game.fgd.length).toBeGreaterThan(0);
    expect(game.provenance["fgd"]).toEqual({ source: "gameinfo.txt:GameData", verified: true });
    // InstancePath was guessed at in sidecar/instances.py; the game states it.
    expect(game.provenance["instancePath"]?.verified).toBe(true);
  });

  it("never marks a built-in guess as verified", () => {
    const games = resolveProfiles({}, []);
    for (const g of Object.values(games)) {
      for (const [key, p] of Object.entries(g.provenance)) {
        if (p.source === "builtin table") {
          expect(p.verified, `${g.id}.${key} claims a built-in guess is verified`).toBe(false);
        }
      }
    }
  });
});

describe("the legacy config fields keep working", () => {
  it("routes gmodBin to the gmod profile", () => {
    const config = rootWith("legacy", { gmodBin: "/tmp/x/bin", gmodGameDir: "/tmp/x/game" });
    expect(config.gmodBin).toBe("/tmp/x/bin");
    expect(gameFor(config).game.binDir).toBe("/tmp/x/bin");
    expect(gameFor(config).game.gameDir).toBe("/tmp/x/game");
  });

  it("accepts the new spelling too", () => {
    const config = rootWith("modern", {
      gameProfiles: { gmod: { binDir: "/tmp/y/bin" } },
    });
    expect(gameFor(config).game.binDir).toBe("/tmp/y/bin");
    expect(config.gmodBin).toBe("/tmp/y/bin");
  });

  it("refuses two spellings that disagree rather than picking one", () => {
    // A server that quietly resolves a contradiction is worse than one that refuses: the
    // half of the config that lost leaves no trace anywhere in the output.
    const config = rootWith("conflict", {
      gmodBin: "/tmp/a/bin",
      gameProfiles: { gmod: { binDir: "/tmp/b/bin" } },
    });
    expect(() => allGames(config)).toThrow(GameConfigConflict);
    expect(() => allGames(config)).toThrow(/gmodBin/);
    expect(() => allGames(config)).toThrow(/gameProfiles\.gmod\.binDir/);
  });

  it("does not mistake two spellings that agree for a conflict", () => {
    const config = rootWith("agree", {
      gmodBin: "/tmp/same/bin",
      gameProfiles: { gmod: { binDir: "/tmp/same/bin" } },
    });
    expect(gameFor(config).game.binDir).toBe("/tmp/same/bin");
  });
});

describe("choosing a profile", () => {
  it("reports whether the caller chose it or the config did", () => {
    const config = rootWith("from", {});
    expect(gameFor(config).from).toBe("config");
    expect(gameFor(config, "tf2").from).toBe("argument");
  });

  it("refuses an unknown id instead of falling back", () => {
    // The failure this prevents: asking for Team Fortress 2, getting a Garry's Mod answer,
    // and having nothing in the output that says so.
    const config = rootWith("unknown", {});
    expect(() => gameFor(config, "quake")).toThrow(UnknownGameError);
    expect(() => gameFor(config, "quake")).toThrow(/gmod/);
    expect(() => gameFor(config, "quake")).toThrow(/read_source_games/);
  });

  it("honours a configured default other than gmod", () => {
    const config = rootWith("default-tf2", { game: "tf2" });
    expect(gameFor(config).game.id).toBe("tf2");
  });
});

describe("the tools say which game they answered about", () => {
  const ready = has.sidecar && has.fgd;

  it.skipIf(!ready)("carries the profile into read_vmf_lint's output", async () => {
    const r = (await readVmfLint.handler(
      { path: join(FIXTURES, "hmcp_probe.vmf"), limit: 5, collapseInstances: false },
      ctx as never,
    )) as { game: { id: string; from: string }; fgdsLoaded: string[] };

    expect(r.game.id).toBe("gmod");
    expect(r.game.from).toBe("config");
    // The FGD is no longer a constant in TypeScript: this name was read out of
    // gameinfo.txt's GameData line.
    expect(r.fgdsLoaded[0]).toBe("garrysmod.fgd");
  }, 60_000);

  it.skipIf(!ready)("refuses a game it does not know, from inside a tool", async () => {
    await expect(
      readVmfLint.handler(
        { path: join(FIXTURES, "hmcp_probe.vmf"), limit: 5, collapseInstances: false, game: "quake" },
        ctx as never,
      ),
    ).rejects.toThrow(UnknownGameError);
  }, 60_000);

  it.skipIf(cssCompilable)("refuses to compile against a game whose toolchain it cannot find", async () => {
    // css is declared in the built-in table and, on most machines, installed nowhere. The
    // failure this prevents is a compile that starts, runs wine, and dies on a missing DLL.
    // Where css *is* installed there is nothing to refuse, and running anyway would compile
    // the probe fixture in place -- hence the skip.
    await expect(
      runCompile.handler(
        {
          vmf: join(FIXTURES, "hmcp_probe.vmf"),
          fast: true,
          hdr: false,
          stages: ["vbsp"],
          toolchain: "stock",
          cull: false,
          game: "css",
          timeoutMinutes: 1,
          confirm: true,
        },
        ctx as never,
      ),
    ).rejects.toThrow(/cannot compile against css/);
  });
});

describe("a game that is not installed", () => {
  it("degrades to a named reason rather than to a wrong path", () => {
    const games = resolveProfiles({}, []);
    const css = games["css"]!;
    expect(css.binDir).toBeNull();
    expect(css.gameDir).toBeNull();
    // Never the other game's bin/: several Source games ship their tools in a separate
    // app, and borrowing GMod's would compile CS:S content with the wrong toolchain.
    expect(css.unusableForCompile).toMatch(/not found/i);
  });
});
