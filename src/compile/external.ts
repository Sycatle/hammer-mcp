/**
 * Driving a standalone Windows tool that is not part of a game install.
 *
 * The compilers come with the game and are found by discovery. These do not: they are
 * separate downloads from ficool2's tools page, they belong to no Steam library, and a
 * machine that has never heard of them is the normal case. So the whole file is built
 * around one rule -- **an absent tool is a reported state, never a crash** -- and around
 * a second one that the compilers never needed.
 *
 * ## Console tools here are interactive, and that is not an obstacle
 *
 * `bsp_rename.exe` prints `Enter the bsp name:` and waits. Written for a person dragging a
 * file onto it, which is exactly the shape an agent cannot use -- unless the answers are
 * fed on stdin, which is what `stdin` below is for. Measured 14/08/2026: three lines (the
 * path, the new name, and a newline for its "press any key") drive it to completion under
 * wine with no terminal at all.
 *
 * The `Press any key to continue...` at the end is why every call needs a timeout it can
 * survive: a tool waiting on a key it will never get looks identical to a slow one.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "@projectsociety/mcp-core";
import type { Config } from "../config.js";
import { ToolchainError, windowsInvocation } from "./wine.js";

export interface ExternalRun {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The binary that ran, so a result can be attributed to a version of a tool. */
  binary: string;
}

/** Where a named external tool is expected to be. One place knows the layout. */
export function externalToolPath(config: Config, exe: string): string {
  return join(config.externalToolsDir ?? join(config.stateDir, "tools"), exe);
}

/** Whether it is there. Callers report this rather than failing a whole run over it. */
export function externalToolPresent(config: Config, exe: string): boolean {
  return existsSync(externalToolPath(config, exe));
}

/**
 * Runs one external Windows tool under wine.
 *
 * Same two load-bearing settings as the compilers, for the same measured reasons: the
 * working directory is the tool's own, and `WINEDEBUG=-all` keeps wine's `fixme:` lines
 * out of the tool's output.
 */
export async function runExternalTool(
  config: Config,
  exe: string,
  args: readonly string[],
  options: { timeoutMs?: number; stdin?: string; where?: string } = {},
): Promise<ExternalRun> {
  const binary = externalToolPath(config, exe);
  if (!existsSync(binary)) {
    throw new ToolchainError(
      `${binary} not found. ${exe} is a standalone tool, not part of a game install: ` +
        `download it from ficool2's tools page (https://ficool2.github.io/` +
        `HammerPlusPlus-Website/tools.html) and put it in ${config.externalToolsDir}, or ` +
        `set externalToolsDir to where you keep it. health lists which of these are present.`,
    );
  }
  const started = Date.now();
  const [cmd, cmdArgs, env] = windowsInvocation(config, binary, args);
  const result = await run(cmd, cmdArgs, {
    cwd: options.where ?? config.externalToolsDir!,
    timeoutMs: options.timeoutMs ?? 300_000,
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
    env,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    timedOut: result.timedOut ?? false,
    durationMs: Date.now() - started,
    binary,
  };
}
