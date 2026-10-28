import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { readEntityLump } from "../bsp/entities.js";
import { LUMP_ENTITIES, readHeader } from "../bsp/header.js";
import { applyEntityOps } from "../entity/edit.js";
import type { EntityOp } from "../entity/edit.js";
import { histogram } from "../entity/model.js";
import { parseEntityText } from "../bsp/entities.js";
import { assertWritable } from "../fs/guard.js";
import { decodeLmp, encodeLmp, readLmp } from "../lmp/codec.js";
import { defineTool } from "../mcp/registry.js";
import { CONFIRM, resolveInput } from "./paths.js";

const MATCH = z
  .object({
    index: z.number().int().min(0).optional(),
    classname: z.string().optional(),
    targetname: z.string().optional(),
  })
  .describe("Selects entities in the BSP's own list. At least one field is required.");

const OP = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    keyvalues: z
      .record(z.string())
      .describe("Full keyvalue set for the new entity; must include classname."),
  }),
  z.object({
    op: z.literal("update"),
    match: MATCH,
    set: z.record(z.string()).optional(),
    unset: z.array(z.string()).optional(),
  }),
  z.object({ op: z.literal("remove"), match: MATCH }),
]);

/** `maps/rp_x.bsp` -> `rp_x`. */
function mapName(bspPath: string): string {
  return basename(bspPath).replace(/\.bsp$/i, "");
}

/** Where a patch for this map belongs: tracked in git, deployed by sync-server-config.sh. */
function defaultOut(bspPath: string, repoRoot: string): string {
  return join(repoRoot, "server-config", "maps", `${mapName(bspPath)}_l_0.lmp`);
}

export const readLumpPatch = defineTool({
  name: "read_lump_patch",
  description:
    "Decodes a Source lump patch (.lmp): its header and, for lump 0, the entities it " +
    "carries. A .lmp overrides one lump of a .bsp at load time without recompiling.",
  realm: "map",
  inputSchema: {
    path: z.string().describe("Path to the .lmp file."),
    limit: z.number().int().min(1).max(2000).default(50),
  },
  handler: (args, ctx) => {
    const path = resolveInput(args.path, ctx.config);
    const file = readLmp(path);
    const isEntities = file.header.lumpID === LUMP_ENTITIES;
    const entities = isEntities ? parseEntityText(file.payload.toString("utf8")) : [];
    return {
      path,
      header: file.header,
      nulTerminated: file.nulTerminated,
      payloadBytes: file.payload.length,
      ...(isEntities
        ? {
            total: entities.length,
            histogram: Object.fromEntries(histogram(entities)),
            entities: entities.slice(0, args.limit).map((e) => ({
              index: e.index,
              classname: e.classname,
              targetname: e.targetname ?? null,
              origin: e.origin ?? null,
              keyvalues: Object.fromEntries(e.keyvalues),
            })),
          }
        : { note: `lumpID ${file.header.lumpID} is not the entity lump; payload not parsed.` }),
    };
  },
});

export const writeLumpPatch = defineTool({
  name: "write_lump_patch",
  description:
    "Builds an entity lump patch (.lmp) for a .bsp by applying add/update/remove operations " +
    "to the map's own entity list, without recompiling. The mapRevision is copied from the " +
    "target .bsp -- a mismatch makes the engine ignore the patch in complete silence. " +
    "Writes to server-config/maps/ by default; deploy with ./tools/sync-server-config.sh. " +
    "Cannot create brush entities (they need a brush model only vbsp can emit), and lighting " +
    "entities have no effect because vrad bakes lighting at compile time.",
  realm: "map",
  guarded: true,
  /**
   * Asks the client to confirm with a human even under a permissive mode.
   *
   * `guarded` already refuses the call without `confirm:true`, but that gate is ours and
   * an agent satisfies it by itself. This writes a file that changes what the production
   * map spawns, so it deserves the client's own confirmation on top.
   *
   * Client-specific and unverified from here: an unrecognised key is ignored in silence,
   * which is precisely why `guarded` remains the real defence rather than this.
   */
  meta: { "anthropic/requiresUserInteraction": true },
  inputSchema: {
    bsp: z.string().describe("Target .bsp. Its mapRevision and entity list are the base."),
    ops: z.array(OP).min(1),
    out: z
      .string()
      .optional()
      .describe("Output path. Default: server-config/maps/<map>_l_0.lmp"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Compute and report the result without writing."),
    confirm: CONFIRM,
  },
  handler: (args, ctx) => {
    const bspPath = resolveInput(args.bsp, ctx.config);
    const lump = readEntityLump(bspPath);
    const result = applyEntityOps(lump.text, lump.entities, args.ops as EntityOp[]);

    const encoded = encodeLmp(result.text, {
      lumpID: LUMP_ENTITIES,
      mapRevision: lump.header.mapRevision,
      nulTerminate: true,
    });

    const outPath = args.out
      ? resolveInput(args.out, ctx.config)
      : defaultOut(bspPath, ctx.config.repoRoot);
    const checked = assertWritable(outPath, ctx.config);

    if (!args.dryRun) {
      mkdirSync(dirname(checked), { recursive: true });
      writeFileSync(checked, encoded);
      ctx.audit.record({
        kind: "file_write",
        data: { path: checked, bytes: encoded.length, bsp: bspPath },
      });
    }

    return {
      bsp: bspPath,
      mapRevision: lump.header.mapRevision,
      out: checked,
      written: !args.dryRun,
      bytes: encoded.length,
      entitiesBefore: result.entitiesBefore,
      entitiesAfter: result.entitiesAfter,
      outcomes: result.outcomes,
      warnings: result.warnings,
      deploy: "./tools/sync-server-config.sh",
    };
  },
});

export const readLumpPatchStatus = defineTool({
  name: "read_lump_patch_status",
  description:
    "For each patch in server-config/maps/, reports whether it is deployed under srcds and " +
    "whether its mapRevision still matches the .bsp it targets. That check is the only one " +
    "there is: gate B measured Garry's Mod applying a patch whose revision disagrees with " +
    "the map, in full and without a word, so a patch left over from an older compile keeps " +
    "editing the new one by names and indices that may have moved.",
  realm: "map",
  inputSchema: {
    bspSearchPaths: z
      .array(z.string())
      .default(["srcds/garrysmod/maps", "srcds/garrysmod/addons/*/maps"])
      .describe("Where to look for the target .bsp, relative to the repo root."),
  },
  handler: (args, ctx) => {
    const { repoRoot } = ctx.config;
    const sourceDir = join(repoRoot, "server-config", "maps");
    if (!existsSync(sourceDir)) {
      return { sourceDir, patches: [], note: "no server-config/maps/ directory yet" };
    }

    const files = readdirSync(sourceDir).filter((f) => f.endsWith(".lmp"));

    const patches = files.map((file) => {
      const source = join(sourceDir, file);
      const deployed = join(repoRoot, "srcds", "garrysmod", "maps", file);
      const map = file.replace(/_l_\d+\.lmp$/i, "");

      let header;
      let error: string | undefined;
      try {
        header = decodeLmp(readFileSync(source)).header;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const bsp = findBsp(repoRoot, map, args.bspSearchPaths);
      let bspRevision: number | undefined;
      if (bsp) {
        try {
          bspRevision = readHeader(bsp).mapRevision;
        } catch {
          /* reported as bsp: null below */
        }
      }

      return {
        file,
        map,
        source,
        deployed: existsSync(deployed),
        bsp: bsp ?? null,
        patchRevision: header?.mapRevision ?? null,
        bspRevision: bspRevision ?? null,
        revisionMatches:
          header && bspRevision !== undefined ? header.mapRevision === bspRevision : null,
        ...(error ? { error } : {}),
      };
    });

    return { sourceDir, patches };
  },
});

/** Looks for `<map>.bsp` under each search path, expanding a single `*` segment. */
function findBsp(repoRoot: string, map: string, searchPaths: readonly string[]): string | undefined {
  for (const raw of searchPaths) {
    const parts = raw.split("*");
    if (parts.length === 1) {
      const candidate = join(repoRoot, raw, `${map}.bsp`);
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const base = join(repoRoot, parts[0]!);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const candidate = join(base, entry, parts[1]!.replace(/^\/+/, ""), `${map}.bsp`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export const lmpTools = [readLumpPatch, writeLumpPatch, readLumpPatchStatus];
