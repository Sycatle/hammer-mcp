import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@projectsociety/mcp-core";
import type { Config } from "../config.js";

/** A sidecar call that came back with an error, or could not be made at all. */
export class SidecarError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

/**
 * `sidecar/main.py`, next to the package rather than inside `dist/`.
 *
 * `dist/sidecar/client.js` sits two levels below the package root, which is where the
 * `sidecar/` directory lives. Under `tsx` the same arithmetic holds from `src/`.
 */
function scriptPath(): string {
  return fileURLToPath(new URL("../../sidecar/main.py", import.meta.url));
}

/** The interpreter of the venv `sidecar/setup.sh` builds, unless configured otherwise. */
export function pythonPath(config: Config): string {
  // A Windows venv keeps its interpreter in Scripts\python.exe, not bin/python.
  const venvPython =
    process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
  return config.sidecarPython ?? join(config.stateDir, "sidecar-venv", venvPython);
}

interface SidecarFault {
  error?: { kind?: string; message?: string };
}

/**
 * Runs one sidecar verb: a fresh subprocess, JSON in, JSON out.
 *
 * One process per call is the design, not a shortcut. A resident helper would need a
 * lock and a lifecycle, which is exactly what keeps hammer-mcp stateless and out of the
 * failure mode that produced gmod-mcp's `daemon.lock`. The processes are short and cold
 * by construction: anything hot stayed in TypeScript.
 */
export async function callSidecar<T>(
  verb: string,
  request: unknown,
  config: Config,
  timeoutMs = 120_000,
): Promise<T> {
  const python = pythonPath(config);
  if (!existsSync(python)) {
    throw new SidecarError(
      `Python sidecar not installed: ${python} does not exist. ` +
        `Run ./sidecar/setup.sh in hammer-mcp to create it.`,
      "not_installed",
    );
  }

  const result = await run(python, [scriptPath(), verb], {
    timeoutMs,
    input: JSON.stringify(request ?? {}),
    env: { ...process.env, PYTHONWARNINGS: "ignore" },
  });

  if (result.timedOut) {
    throw new SidecarError(`sidecar ${verb} timed out after ${timeoutMs} ms`, "timeout");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // stdout is the contract. Anything else means the interpreter died before the
    // sidecar could frame its own failure -- report stderr, which will say why.
    throw new SidecarError(
      `sidecar ${verb} produced no JSON (exit ${result.code}): ` +
        `${result.stderr.trim().slice(-500) || "no stderr"}`,
      "no_json",
    );
  }

  const fault = parsed as SidecarFault;
  if (fault && typeof fault === "object" && fault.error) {
    throw new SidecarError(
      `sidecar ${verb}: ${fault.error.message ?? "unknown error"}`,
      fault.error.kind ?? "error",
    );
  }
  return parsed as T;
}

export interface SidecarStatus {
  installed: boolean;
  python: string;
  /** Absent when the sidecar could not run at all. */
  pythonVersion?: string;
  srctools?: string | null;
  ok?: boolean;
  reason?: string;
}

/**
 * Describes the sidecar without ever throwing.
 *
 * `health` exists to report a broken toolchain, so it must not fail with it: a server
 * that cannot start because its optional helper is missing has turned a warning into an
 * outage.
 */
export async function probeSidecar(config: Config): Promise<SidecarStatus> {
  const python = pythonPath(config);
  try {
    const out = await callSidecar<{
      python: string;
      srctools: string | null;
      ok: boolean;
      reason?: string;
    }>("health", {}, config, 30_000);
    return {
      installed: true,
      python,
      pythonVersion: out.python,
      srctools: out.srctools,
      ok: out.ok,
      ...(out.reason ? { reason: out.reason } : {}),
    };
  } catch (err) {
    return {
      installed: false,
      python,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
