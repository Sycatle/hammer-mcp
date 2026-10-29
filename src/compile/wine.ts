import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { run } from "@projectsociety/mcp-core";
import type { RunResult } from "@projectsociety/mcp-core";
import type { Config } from "../config.js";
import type { ResolvedGame } from "../games/profile.js";

export class ToolchainError extends Error {}

/**
 * Converts a Linux path to the Windows form the compilers need.
 *
 * Wine maps `Z:` to `/`, so `/home/x` becomes `Z:\home\x`. This is not cosmetic: a
 * relative path is resolved against wine's own working directory, and vbsp then compiles
 * a different file than the one asked for, silently and successfully.
 *
 * A path that is already a Windows drive path (the `native` backend, on Windows) only has
 * its separators normalised: prefixing it with `Z:` would produce `Z:C:\...`.
 */
export function toWindowsPath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) return path.replace(/\//g, "\\");
  if (!isAbsolute(path)) {
    throw new ToolchainError(
      `${path}: the Source compilers need an absolute path, because a relative one ` +
        `resolves against wine's working directory and quietly compiles the wrong file`,
    );
  }
  return `Z:${path.replace(/\//g, "\\")}`;
}

export interface CompilerRun extends RunResult {
  command: string;
  args: string[];
  durationMs: number;
}

/**
 * Which set of compilers to drive.
 *
 * `stock` is what ships with the GMod client. `plusplus` is ficool2's rebuild of the same
 * SDK 2013 tools -- same inputs, same outputs, faster and with extra flags -- and it is the
 * default this repository compiles with.
 *
 * They still coexist rather than replace each other, and that matters more now than it did
 * when stock was the default: comparing a `plusplus` result against the `stock` one on the
 * same source is the only oracle available for judging whether the faster chain changed
 * anything it should not have. Which is why every result says which chain actually ran.
 */
export type Toolchain = "stock" | "plusplus";

/** The compile stages, and the pack step, that both toolchains provide. */
export type CompileStage = "vbsp" | "vvis" | "vrad" | "bspzip";

/**
 * Where a toolchain's binaries live. Measured at gate C, 11/08/2026, and not guessable:
 * the ++ builds are x86-64 and sit in `bin/win64/`, while the stock ones are i386 and sit
 * in `bin/`. `bin/win64/` also holds its own 64-bit stock compilers, and requires the
 * x86-64 beta branch of GMod.
 *
 * `gmodBin` therefore cannot mean both "the compilers" and "the .fgd files" any more: the
 * .fgd files stay in `bin/`.
 */
export function toolchainDir(config: Config, chain: Toolchain, game?: ResolvedGame): string {
  const bin = game?.binDir ?? config.gmodBin;
  if (chain === "stock") return bin;
  return game?.plusPlusBinDir ?? config.gmodBinPlusPlus ?? join(bin, "win64");
}

/** `vbsp.exe` or `vbspplusplus.exe`. One place knows the naming convention. */
export function compilerExe(stage: CompileStage, chain: Toolchain): string {
  return chain === "stock" ? `${stage}.exe` : `${stage}plusplus.exe`;
}

export interface ChosenToolchain {
  /** The chain that will actually run. */
  chain: Toolchain;
  /** The chain that was asked for, which is not always the one that runs. */
  requested: Toolchain;
  /** Binaries the requested chain is missing, named. Empty when nothing is missing. */
  missing: string[];
  /** Said out loud whenever `chain !== requested`, and null otherwise. */
  note: string | null;
}

/**
 * Which chain runs, given which one was asked for and what is installed.
 *
 * The `++` chain is the default because it is the better compiler -- vvis measured 50% to
 * 2700% faster by its author, and the culling flags exist only there. But a default that
 * cannot run on a machine without it would make this server useless on exactly the machines
 * that need it most, CI included. So an absent `++` chain **falls back to stock and says
 * so**, in the result and in a note, rather than either failing or quietly substituting.
 *
 * Silence was the option deliberately rejected: without `toolchainRequested` beside
 * `toolchain`, nobody could tell which compilers produced a given `.bsp`, and the comparison
 * between the two chains -- the only oracle for "did the fast one change something" -- would
 * stop being possible without anyone noticing.
 */
export function chooseToolchain(
  config: Config,
  requested: Toolchain,
  stages: readonly CompileStage[],
  game?: ResolvedGame,
): ChosenToolchain {
  const dir = toolchainDir(config, requested, game);
  const missing = stages
    .map((s) => compilerExe(s, requested))
    .filter((exe) => !existsSync(join(dir, exe)));

  if (missing.length === 0) return { chain: requested, requested, missing: [], note: null };
  if (requested === "stock") {
    // Nothing to fall back to, and the error runCompiler raises names the directory.
    return { chain: "stock", requested, missing, note: null };
  }

  return {
    chain: "stock",
    requested,
    missing,
    note:
      `The Hammer++ chain is the default and is not installed here (${missing.join(", ")} ` +
      `missing from ${dir}), so this ran on the stock compilers. That is a slower vvis and ` +
      `no culling flags, not a different map. The four binaries come from ` +
      `tools_plusplus.zip (ficool2/misc_tools) and need the x86-64 beta branch of the game; ` +
      `health reports which of them are present.`,
  };
}

/**
 * Runs one Source compiler under wine.
 *
 * Two settings are load-bearing, both measured rather than guessed (README, gate A):
 * the working directory must be the `bin` folder or `tier0.dll` fails to resolve, and
 * `WINEDEBUG=-all` must be set or stderr is a wall of `fixme:` lines that buries the
 * compiler's own output.
 */
export async function runCompiler(
  config: Config,
  exe: string,
  args: readonly string[],
  timeoutMs: number,
  chain: Toolchain = "stock",
  game?: ResolvedGame,
): Promise<CompilerRun> {
  const dir = toolchainDir(config, chain, game);
  const binary = join(dir, exe);
  if (!existsSync(binary)) {
    throw new ToolchainError(
      chain === "stock"
        ? `${binary} not found. These ship with the GMod client, not with srcds; ` +
          `check gmodBin with the health tool`
        : // Naming the chain matters: without it this reads like a broken GMod install,
          // when in fact the stock compilers are fine and only Hammer++ is absent.
          //
          // Reaching this at all means a caller drove runCompiler directly: run_compile
          // and run_pack ask chooseToolchain first, which falls back to stock and says so.
          `${binary} not found: the "plusplus" toolchain is not installed. The four ` +
          `Hammer++ compilers come from tools_plusplus.zip and go in ${dir}; the stock ` +
          `chain is unaffected, and run_compile falls back to it. See health`,
    );
  }
  const started = Date.now();
  const [cmd, cmdArgs, env] = windowsInvocation(config, binary, args);
  const result = await run(cmd, cmdArgs, { cwd: dir, timeoutMs, env });

  return {
    ...result,
    command: exe,
    args: [...args],
    durationMs: Date.now() - started,
  };
}

/**
 * The command line that executes a Windows binary under the configured backend.
 *
 * `native` runs the .exe directly and only means something on Windows. `wine` keeps the
 * two settings measured as load-bearing: `WINEPREFIX`, and `WINEDEBUG=-all` so wine's
 * `fixme:` lines do not bury the tool's own output.
 */
export function windowsInvocation(
  config: Config,
  binary: string,
  args: readonly string[],
): [string, string[], NodeJS.ProcessEnv] {
  if (config.backend === "native") {
    if (process.platform !== "win32") {
      throw new ToolchainError(
        `backend "native" runs the Windows binaries directly and needs Windows; ` +
          `this is ${process.platform}`,
      );
    }
    return [binary, [...args], process.env];
  }
  if (config.backend !== "wine") {
    throw new ToolchainError(
      `backend "${config.backend}" is not implemented; only wine and native are proven here`,
    );
  }
  return [
    "wine",
    [binary, ...args],
    { ...process.env, WINEPREFIX: config.winePrefix, WINEDEBUG: "-all" },
  ];
}
