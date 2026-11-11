import { z } from "zod";
import { gameBlock, gameFor } from "../games/resolve.js";
import { defineTool } from "../mcp/registry.js";
import { callSidecar } from "../sidecar/client.js";
import { GAME, GAME_BLOCK } from "./paths.js";

export const readGameContentTool = defineTool({
  name: "read_game_content",
  description:
    "Searches the game's installed content for materials and models, by name. This is " +
    "Hammer's texture browser and model browser, which an agent otherwise does not have: " +
    "without it a material is named from memory, and vbsp resolves a name literally, so a " +
    "wrong one is a purple checkerboard nobody sees until a player loads the map. Returns " +
    "material names in the form a .vmf stores -- uppercase, no materials/ prefix, no .vmt " +
    "suffix -- which is exactly what set_face_material takes. A pattern with * or ? is a " +
    "glob; anything else is a substring. Mounts the same VPK-and-loose chain the engine " +
    "reads through, so this and read_map_dependencies cannot disagree about what exists. " +
    "A .vmt being present is NOT the same as the material drawing: NATURE/BLENDGRASSDIRT01 " +
    "ships with Garry's Mod and the three .vtf it points at do not, which is the same purple " +
    "checkerboard by another route. Pass details to resolve every texture a material names " +
    "and get `resolves` with what is missing. Every result also carries `source`: `vpk` is " +
    "inside an archive the game ships, so every player has it; `loose` is a plain file on " +
    "this disk -- a mapper's own, a custom/ install, or one a server sent into download/ -- " +
    "and reaches a player only if the map packs it (run_pack auto does). Needs the Python " +
    "sidecar; see health.",
  realm: "map",
  inputSchema: {
    pattern: z
      .string()
      .describe("Name to look for. 'brick' matches anything containing it; 'brick*' is a glob."),
    kind: z
      .enum(["material", "model"])
      .default("material")
      .describe("Materials (.vmt) or models (.mdl)."),
    details: z
      .boolean()
      .optional()
      .describe(
        "Read the .vmt of each result for its shader, its surface property, and whether " +
          "every texture it names actually exists in this install. Off by default: a " +
          "Garry's Mod install holds tens of thousands, and parsing them all to answer one " +
          "search would cost seconds.",
      ),
    limit: z.number().int().min(1).max(1000).default(100),
    game: GAME,
  },
  outputSchema: {
    game: GAME_BLOCK,
    gameDir: z.string().nullable(),
    mounted: z.boolean(),
    mountError: z.string().nullable(),
    pattern: z.string(),
    kind: z.string(),
    /** Every match, not only those returned. */
    total: z.number(),
    shown: z.number().optional(),
    truncated: z.boolean().optional(),
    results: z.array(
      z.object({
        path: z.string(),
        /**
         * Where the copy the engine would load lives (#112). `vpk`: a game archive, on
         * every player's machine. `loose`: a file on this disk, which is not -- the same
         * split read_map_dependencies reports as game-vpk / game-loose.
         */
        source: z.enum(["vpk", "loose"]),
        /** Materials only: the name as a .vmf writes it. */
        name: z.string().optional(),
        shader: z.string().nullable().optional(),
        basetexture: z.string().nullable().optional(),
        surfaceprop: z.string().nullable().optional(),
        translucent: z.boolean().optional(),
        toolTexture: z.boolean().optional(),
        /**
         * Whether every .vtf this material names is installed. `details` only.
         *
         * `null` means the .vmt could not be parsed, which is not evidence either way --
         * see `error` beside it.
         */
        resolves: z.boolean().nullable().optional(),
        /** The .vtf this material names and the install does not have. `details` only. */
        missingTextures: z.array(z.string()).optional(),
        error: z.string().nullable().optional(),
      }),
    ),
    note: z.string().optional(),
    /** Set when the verb declined the request. Not `error`, which is the fault envelope. */
    refused: z.string().optional(),
  },
  handler: async (args, ctx) => {
    // Refused here rather than in the sidecar so it holds on a machine with no venv: an
    // empty pattern would walk the whole game and serialise tens of thousands of names.
    if (args.pattern.trim().length === 0) {
      throw new Error("a search needs a pattern; an empty one would return the whole game");
    }
    const { game, from } = gameFor(ctx.config, args.game);
    const result = (await callSidecar(
      "search_content",
      {
        // The selected profile's directory, and nothing else. Falling back to Garry's Mod
        // when the asked-for game is not installed returned GMod's assets under a reply
        // that named the other game -- a confident answer about content the map will not
        // have. A null directory makes the sidecar report that nothing was mounted, which
        // is the honest one.
        gameDir: game.gameDir,
        pattern: args.pattern,
        kind: args.kind,
        limit: args.limit,
        ...(args.details !== undefined ? { details: args.details } : {}),
      },
      ctx.config,
      120_000,
    )) as Record<string, unknown>;
    return { ...result, game: gameBlock(game, from) };
  },
});

export const readModelInfoTool = defineTool({
  name: "read_model_info",
  description:
    "Bounds, skins, sequences and materials of one .mdl -- what Hammer's model viewer " +
    "shows before you place a prop. The bounds are the reason this exists: a model's " +
    "origin is wherever the artist put it, so a prop placed at floor height sinks by " +
    "however far its origin sits above its lowest point, and nothing downstream reports " +
    "that. A barrel measured here is 52 units tall with its origin at the centre, which " +
    "means 26 units underground if it is placed on the floor's own z. Needs the Python " +
    "sidecar; see health.",
  realm: "map",
  inputSchema: {
    model: z
      .string()
      .describe("Model path. The models/ prefix and the .mdl suffix are added if missing."),
    game: GAME,
  },
  outputSchema: {
    game: GAME_BLOCK,
    model: z.string(),
    mounted: z.boolean(),
    mountError: z.string().nullable().optional(),
    found: z.boolean(),
    /** Corner of the model's own hull, relative to its origin. */
    mins: z.array(z.number()).nullable().optional(),
    maxs: z.array(z.number()).nullable().optional(),
    size: z.array(z.number()).nullable().optional(),
    skinCount: z.number().optional(),
    /** Every sequence the model has, even when only the first 64 labels are returned. */
    sequenceCount: z.number().optional(),
    sequences: z.array(z.string()).optional(),
    materials: z.array(z.string()).optional(),
    sequencesTruncated: z.boolean().optional(),
    note: z.string().optional(),
    /** A model that exists and could not be read. Not `error`: that is the fault envelope. */
    readError: z.string().optional(),
    refused: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const { game, from } = gameFor(ctx.config, args.game);
    const result = (await callSidecar(
      "model_info",
      // Same rule as read_game_content: the profile's own directory, or nothing.
      { gameDir: game.gameDir, model: args.model },
      ctx.config,
      120_000,
    )) as Record<string, unknown>;
    return { ...result, game: gameBlock(game, from) };
  },
});

export const contentTools = [readGameContentTool, readModelInfoTool];
