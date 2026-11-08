import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig as coreLoadConfig } from "@projectsociety/mcp-core";
import { z } from "zod";
import { GameProfileOverride } from "./games/profile.js";
import type { ResolvedGame } from "./games/profile.js";
import { gameFor } from "./games/resolve.js";

const STEAM_GMOD = join(
  homedir(),
  ".steam",
  "steam",
  "steamapps",
  "common",
  "GarrysMod",
);

/**
 * Configuration, loaded from `<repoRoot>/.hammer-mcp/config.json` when present,
 * otherwise defaults. Every field in the file is optional and gets filled in.
 *
 * The Source toolchain lives OUTSIDE the repo, in the Steam library, so its paths are
 * machine-specific by nature. Nothing here may be assumed to exist: every tool that
 * depends on `gmodBin` degrades to a reported reason rather than throwing.
 */
export const ConfigFile = z.object({
  /** Root of the GMod repo (contains tools/, addons/, srcds/). */
  repoRoot: z.string().optional(),
  /**
   * Directory holding hammer.exe, vbsp/vvis/vrad.exe and the .fgd files. These ship
   * with the GMod *client*, not with the dedicated server -- `srcds/bin/` has none of
   * them.
   */
  gmodBin: z.string().optional(),
  /**
   * Directory holding the Hammer++ compilers, when they are installed. Defaults to
   * `<gmodBin>/win64`, which is where they must go: they are x86-64 where the stock ones
   * are i386, and they require the x86-64 beta branch of GMod. The .fgd files stay in
   * `gmodBin`. Nothing needs this set unless the install is unusual.
   */
  gmodBinPlusPlus: z.string().optional(),
  /**
   * Directory holding the standalone tools this server can drive, beyond the compilers.
   *
   * These are separate downloads that belong to nobody's game install -- ficool2's
   * `bsp_rename.exe` is the first -- so they cannot be discovered the way `gmodBin` is.
   *
   * Defaults to `<stateDir>/tools`, i.e. `.hammer-mcp/tools`. Not `<repoRoot>/tools`,
   * which was the first choice and is wrong here: `repoRoot` is the *parent* repository
   * this server is embedded in, whose `tools/` is full of that project's own scripts.
   * Dropping third-party Windows binaries in there would be writing into somebody else's
   * source tree. `.hammer-mcp/` is already this server's own and already ignored by git.
   */
  externalToolsDir: z.string().optional(),
  /**
   * Which game profile tools work against when a call does not name one. `gmod` unless
   * set; `read_source_games` lists what this machine actually has.
   */
  game: z.string().default("gmod"),
  /**
   * Per-profile overrides, keyed by profile id. Anything discovery gets wrong or cannot
   * see goes here -- a game installed outside Steam, compilers in a separate app, an
   * engine branch we do not classify.
   *
   * `gmodBin`, `gmodGameDir` and `gmodBinPlusPlus` above are the older spelling of
   * `gameProfiles.gmod.{binDir,gameDir,plusPlusBinDir}`. They still work. Setting both to
   * different values is refused at load rather than silently resolved.
   */
  gameProfiles: z.record(GameProfileOverride).default({}),
  /** The `-game` directory the compilers resolve content against. */
  gmodGameDir: z.string().optional(),
  /**
   * How the Windows compilers are executed. Decided by measurement, not preference:
   * plain wine was verified to run vbsp/vvis/vrad here on 02/08/2026 (see README).
   * On Windows the default is `native`, which runs the .exe files directly.
   */
  backend: z
    .enum(["wine", "proton", "native"])
    .default(process.platform === "win32" ? "native" : "wine"),
  /** WINEPREFIX for the `wine` backend. */
  winePrefix: z.string().default(join(homedir(), ".wine")),
  /** Proton entry script, for the `proton` backend. */
  protonPath: z.string().optional(),
  /**
   * Interpreter for the Python sidecar. Defaults to the venv `sidecar/setup.sh` builds
   * under the state directory. Set it only to point at an interpreter you manage.
   */
  sidecarPython: z.string().optional(),
  /** Tools allowed without confirmation. Empty means the default policy. */
  toolAllowlist: z.array(z.string()).default([]),
  /** Plugin ESM modules to load, relative to the repo root. Each exports `tools`. */
  plugins: z.array(z.string()).default([]),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

export interface Config extends ConfigFile {
  repoRoot: string;
  /** Runtime state directory: `<repoRoot>/.hammer-mcp`. */
  stateDir: string;
  /**
   * What the config file actually said, before any profile filled anything in.
   *
   * `gmodBin` and `gmodGameDir` below are computed: absent from the file, they come from
   * whatever discovery found for the active profile. Profile resolution must therefore
   * read *this* rather than the computed values, or it would resolve itself in a circle.
   */
  explicit: {
    gmodBin?: string;
    gmodGameDir?: string;
    gmodBinPlusPlus?: string;
  };
  /** Compilers and .fgd files of the active profile. Always a string, never asserted to exist. */
  gmodBin: string;
  /** The `-game` argument for the active profile. */
  gmodGameDir: string;
}

/** Defines a property computed on first read and remembered afterwards. */
function lazy<T>(target: object, key: string, compute: () => T): void {
  let done = false;
  let value: T;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get(): T {
      if (!done) {
        value = compute();
        done = true;
      }
      return value;
    },
  });
}

/**
 * Loads the effective configuration. The root is resolved in this order:
 * 1. `HAMMER_MCP_REPO` (env)  2. the file's `repoRoot` field  3. walking up from cwd.
 *
 * `gmodBin` and `gmodGameDir` are resolved **lazily**: reading them scans the Steam
 * libraries, and loading a configuration must stay a file read. The last fallback is the
 * historical hard-coded Steam path, so a machine where discovery finds nothing behaves
 * exactly as it did before profiles existed.
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  const config = coreLoadConfig(
    { envVar: "HAMMER_MCP_REPO", stateDirName: ".hammer-mcp", schema: ConfigFile },
    cwd,
  ) as Config;

  config.explicit = {
    ...(config.gmodBin !== undefined ? { gmodBin: config.gmodBin } : {}),
    ...(config.gmodGameDir !== undefined ? { gmodGameDir: config.gmodGameDir } : {}),
    ...(config.gmodBinPlusPlus !== undefined ? { gmodBinPlusPlus: config.gmodBinPlusPlus } : {}),
  };

  const active = (): ResolvedGame | null => {
    try {
      return gameFor(config).game;
    } catch {
      // An unknown default profile is reported by the tools that use it, not by throwing
      // out of the config loader -- health has to stay callable to say what is wrong.
      return null;
    }
  };

  if (config.externalToolsDir === undefined) {
    config.externalToolsDir = join(config.stateDir, "tools");
  }

  lazy(config, "gmodBin", () => config.explicit.gmodBin ?? active()?.binDir ?? join(STEAM_GMOD, "bin"));
  lazy(
    config,
    "gmodGameDir",
    () => config.explicit.gmodGameDir ?? active()?.gameDir ?? join(STEAM_GMOD, "garrysmod"),
  );
  // The profile already derives this from an explicitly configured gmodBin -- see
  // applyOverride in games/resolve.ts. Deliberately not duplicated here: two paths to the
  // same answer means a test can only ever prove one of them.
  lazy(
    config,
    "gmodBinPlusPlus",
    () => config.explicit.gmodBinPlusPlus ?? active()?.plusPlusBinDir ?? undefined,
  );

  return config;
}

export { findRepoRoot } from "@projectsociety/mcp-core";
