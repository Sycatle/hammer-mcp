/**
 * Whether a skyname names a sky the configured game actually ships.
 *
 * `write_vmf` picks `sky_day01_01` by default -- Source's own -- and on the install this
 * repository is developed against, vbsp answers every compile with two `*** Error:` lines
 * about it: the vtf files "weren't compiled with the same size texture and/or same flags",
 * so it cannot build a default cubemap. Harmless, graded `info` by `read_compile_log`, fixed
 * by `buildcubemaps` in game -- and three separate builders have now spent a moment reading
 * those two lines before concluding they did not matter (issue #62).
 *
 * The tool that *chose* the value is the one that could have checked it. This is that check.
 *
 * ## What it proves, and what it does not
 *
 * It proves the six sides exist, by mounting the same VPK-and-loose chain the engine reads
 * through. It does **not** prove they will build a cubemap: that is a statement about the
 * `.vtf` headers -- dimensions and flags across the six faces -- which nothing in this server
 * reads today. So a sky can pass here and still produce those two lines, and the note says so
 * rather than implying a guarantee it has not earned.
 */
import { callSidecar } from "../sidecar/client.js";
import type { Config } from "../config.js";

/** The six faces Source derives from a skyname, in the order the engine names them. */
export const SKY_SIDES = ["rt", "lf", "bk", "ft", "up", "dn"] as const;

const SKY_FACE = /^materials\/skybox\/(.+?)(rt|lf|bk|ft|up|dn)(_hdr)?\.vmt$/i;

export interface SkyboxCheck {
  /** False when there was no game to look in, or the sidecar could not mount it. */
  checked: boolean;
  /** Null when `checked` is false: absent is not the same answer as unknown. */
  found: boolean | null;
  /** The sides that are missing, when some are. */
  missingSides: string[];
  /** A few complete skies the game does have, for a caller that has to pick another. */
  alternatives: string[];
  note: string;
}

const unchecked = (why: string): SkyboxCheck => ({
  checked: false,
  found: null,
  missingSides: [],
  alternatives: [],
  note: why,
});

/**
 * Looks the sky up in the game's own content.
 *
 * One search, not six: `search_content` walks the mounted filesystem per call and caches
 * nothing, so a call per face would cost six walks to answer one question.
 *
 * And the walk is told where the skies are. Left to walk all of `materials/`, it cost 8 s on
 * a Counter-Strike: Source install with a well-used `download/` folder -- longer than the
 * whole budget of the tests that create a map (#109). `materials/skybox` alone is 0.03 s.
 * The pattern stays `skybox/*` so the rows are the same ones a caller of read_game_content
 * would see; only the folder outside it is no longer read.
 */
export async function checkSkybox(
  skyname: string,
  gameDir: string | null,
  config: Config,
): Promise<SkyboxCheck> {
  if (!skyname.trim()) return unchecked("no skyname to check");
  if (!gameDir) {
    return unchecked(
      "no game profile is configured, so the sky was not checked: read_game_content and " +
        "this share one mount, and neither invents a directory to look in.",
    );
  }

  let result: Record<string, unknown>;
  try {
    result = (await callSidecar(
      "search_content",
      { gameDir, pattern: "skybox/*", kind: "material", folder: "materials/skybox", limit: 1000 },
      config,
      120_000,
    )) as Record<string, unknown>;
  } catch (err) {
    // Never fatal. A map is still a map without a verified sky, and failing the write
    // because the Python sidecar is absent would make this tool useless on a machine that
    // has no game installed at all.
    return unchecked(
      `the sky was not checked: ${err instanceof Error ? err.message : String(err)}. ` +
        `That is about this machine, not about the map.`,
    );
  }

  if (result.mounted !== true) {
    return unchecked(
      `the sky was not checked: the game's content could not be mounted` +
        (typeof result.mountError === "string" ? ` (${result.mountError})` : ``) +
        `. Nothing was searched, so an empty answer would have said nothing about the game.`,
    );
  }

  const sides = new Map<string, Set<string>>();
  for (const row of (result.results as Array<{ path?: string }> | undefined) ?? []) {
    const m = SKY_FACE.exec((row.path ?? "").toLowerCase());
    if (!m) continue;
    // The HDR set is a second copy of the same sky, not a sky of its own.
    if (m[3]) continue;
    const name = m[1]!;
    (sides.get(name) ?? sides.set(name, new Set()).get(name)!).add(m[2]!);
  }

  const complete = [...sides.entries()]
    .filter(([, s]) => SKY_SIDES.every((side) => s.has(side)))
    .map(([name]) => name)
    .sort();

  const have = sides.get(skyname.toLowerCase()) ?? new Set<string>();
  const missingSides = SKY_SIDES.filter((side) => !have.has(side));
  const found = missingSides.length === 0;

  const truncated = result.truncated === true;
  const caveat =
    ` Present is not the same as usable: whether the six faces share a size and flags -- ` +
    `which is what vbsp needs to build a default cubemap -- lives in the .vtf headers, ` +
    `which nothing here reads. A sky can pass this check and still draw the two 'default ` +
    `cubemap' lines that read_compile_log grades as info.`;

  return {
    checked: true,
    found,
    missingSides: [...missingSides],
    alternatives: found ? [] : complete.slice(0, 3),
    note: found
      ? `The game has all six sides of skybox/${skyname}.` + caveat
      : `The game has no skybox/${skyname}${have.size > 0 ? `${SKY_SIDES.filter((s) => have.has(s)).join(", ")}` : ``}: ` +
        `${missingSides.length} of its six sides are missing (${missingSides.join(", ")}). ` +
        `vbsp resolves a skyname literally, so this compiles and renders as whatever sky ` +
        `the engine loaded last.` +
        (complete.length > 0
          ? ` Complete skies this game does have: ${complete.slice(0, 3).join(", ")}` +
            (complete.length > 3 ? ` (${complete.length} in all -- read_game_content lists them).` : `.`)
          : ` This game ships no complete sky at all, which is itself worth knowing.`) +
        (truncated ? ` The search was truncated, so that list is partial.` : ``),
  };
}
