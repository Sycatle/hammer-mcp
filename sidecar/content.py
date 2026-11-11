"""Searching the game's own content: which materials and models exist, and what they are.

A mapper picks a texture from Hammer's browser and a prop from its model viewer. An agent
had neither, so it named materials from memory -- and vbsp resolves a name literally, which
makes a wrong one a purple checkerboard nobody sees until a player loads the map. `set_face_
material` can now change a wall's material; this is how you find out what to change it to.

The mounting is the same one `dependencies.py` uses, deliberately: `Game(dir).get_filesystem()`
chains the VPKs and the loose tree in the order the engine reads them. Reusing it means the
answer here and the answer there cannot disagree about what is installed.

Two things this does not do, and says so rather than implying otherwise:

**It does not judge whether a texture looks right.** It reports the shader, the flags and the
size; "is this the brick for a 1970s Bronx tenement" is not a measurement.

**It does not read every VMT to answer a search.** A Garry's Mod install holds tens of
thousands, and parsing them all to answer "brick" would cost seconds per call. The search is
over names; `details` reads the VMTs of what the search returned, which is a handful.
"""

from __future__ import annotations

import fnmatch
import re
from typing import Any

# A search that returns everything is not a search, and serialising 40 000 names through
# the transport would cost more than the caller could use.
DEFAULT_LIMIT = 100
# Animation labels returned per model. A prop has one; a character can have hundreds, and
# a caller asking about a prop should not pay for those.
SEQUENCE_LIMIT = 64
MAX_LIMIT = 1000


def _mount(game_dir: str | None) -> tuple[Any, str | None]:
    if not game_dir:
        return None, "no gameDir given, so nothing was searched"
    try:
        from srctools.game import Game

        return Game(game_dir).get_filesystem(), None
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


def _walk(fsys: Any) -> list[str]:
    """Every file the mounted chain can see, as engine-relative paths."""
    out: list[str] = []
    for f in fsys:
        try:
            out.append(f.path.replace("\\", "/"))
        except Exception:  # noqa: BLE001,S112
            continue
    return out


def _searchable(rel: str, prefix: str) -> str:
    """The name a mapper thinks in: `brick/brickwall001a`, no prefix and no extension.

    Matching against the full engine path instead is what a first version did, and it made
    every anchored glob fail silently: `brick/brickwall*` cannot match
    `materials/brick/brickwall001a.vmt`, because fnmatch anchors at both ends and the path
    starts with the prefix. It returned nothing, which is indistinguishable from a game
    that does not have the texture.
    """
    stem = rel[len(prefix) :] if rel.lower().startswith(prefix) else rel
    return stem.rsplit(".", 1)[0].lower()


def _matcher(pattern: str) -> Any:
    """A glob when it looks like one, a substring otherwise.

    `brick*` and `metal/*floor*` are what a mapper types; `brick` on its own means "anything
    with brick in it", not "a file called exactly brick". Guessing wrong in either direction
    returns nothing and looks like the content is missing.

    A glob is tried anchored and then floating, so `brick/brickwall*` matches from the start
    of the name while `*wall00?a` still matches in the middle of it.
    """
    p = pattern.lower().strip("/")
    if any(c in p for c in "*?["):
        return lambda name: fnmatch.fnmatch(name, p) or fnmatch.fnmatch(name, f"*{p}")
    return lambda name: p in name


def _vmf_name(rel: str) -> str:
    """`materials/brick/wall.vmt` as a .vmf stores it: `BRICK/WALL`.

    The form `set_face_material` wants. Returning the path instead would make the caller
    strip the prefix and the suffix itself, which is exactly the step that gets skipped.
    """
    stem = rel[len("materials/") :] if rel.lower().startswith("materials/") else rel
    return re.sub(r"\.vmt$", "", stem, flags=re.IGNORECASE).upper()


def _present(fsys: Any, path: str) -> bool:
    """Whether the mounted chain has this file. `in` is not part of the filesystem API."""
    try:
        fsys[path]
    except (KeyError, FileNotFoundError):
        return False
    except Exception:  # noqa: BLE001
        return False
    return True


def _source(fsys: Any, rel: str) -> str:
    """`vpk` when the copy the engine would load is inside an archive, `loose` when on disk.

    A match is not evidence a player has it (#112). On a Counter-Strike: Source install a
    quarter of the VMTs a search could return sat in `cstrike/download` -- sent by servers
    once visited -- and most of them resolve, so `resolves` cannot tell them from stock.
    `loose` covers that, `custom/` and a mapper's own files alike: srctools drops the
    gameinfo labels that would separate them, and all three need packing to reach a player.

    The same test `read_map_dependencies` applies, imported, so the two cannot disagree. A
    lookup per returned row, at most `limit`, and no VMT parsed: cheap enough to be default.
    """
    from dependencies import is_archive

    try:
        found = fsys[rel]
    except Exception:  # noqa: BLE001
        # The walk just listed it, so this is not expected. Unknown provenance reads as an
        # archive, exactly as is_archive itself treats it.
        return "vpk"
    return "vpk" if is_archive(fsys, found) else "loose"


def _material_details(fsys: Any, rel: str) -> dict[str, Any]:
    """Shader, base texture, surface properties -- and whether the thing will actually draw.

    That last part is #77, and it is why this function is not just a VMT reader. A `.vmt`
    present in the game says nothing about the `.vtf` it points at. `NATURE/BLENDGRASSDIRT01`
    ships with Garry's Mod; its `forest_grass_01`, `forest_dirt_02` and `blendtexture01` do
    not, and a garden built on it is the purple checkerboard this whole tool exists to
    prevent -- reported as present.

    The resolution is `dependencies.py`'s, imported rather than restated: the two must not be
    able to disagree about what is installed, which is the same reason both mount through
    `Game(dir).get_filesystem()`.
    """
    out: dict[str, Any] = {"shader": None, "basetexture": None, "surfaceprop": None,
                           "translucent": False, "toolTexture": False,
                           "resolves": True, "missingTextures": [], "error": None}
    try:
        from srctools.vmt import Material

        from dependencies import ENVMAP_KEYWORDS, TEXTURE_PARAMS, _under_materials

        with fsys[rel].open_str() as fh:
            mat = Material.parse(fh, rel)
        mat = mat.apply_patches(fsys)
        out["shader"] = mat.shader
        for key in ("$basetexture", "$bumpmap", "$surfaceprop", "$translucent", "$alphatest"):
            val = mat.get(key)
            if val is None:
                continue
            if key == "$basetexture":
                out["basetexture"] = str(val)
            elif key == "$surfaceprop":
                out["surfaceprop"] = str(val)
            elif key in ("$translucent", "$alphatest") and str(val).strip() not in ("0", ""):
                out["translucent"] = True

        # Every texture the material names, not just the base one: a blend draws its second
        # texture wherever alpha is 255, so a missing `$basetexture2` is half a terrain.
        missing: list[str] = []
        seen: set[str] = set()
        for key, value in mat.items():
            low = key.lower()
            if not isinstance(value, str) or not value.strip():
                continue
            if low in TEXTURE_PARAMS or (
                low == "$envmap" and value.lower() not in ENVMAP_KEYWORDS
            ):
                tex = _under_materials(value.strip(), ".vtf")
                if tex in seen:
                    continue
                seen.add(tex)
                if not _present(fsys, tex):
                    missing.append(tex)
        out["missingTextures"] = sorted(missing)
        out["resolves"] = not missing
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        # A VMT this parser cannot read is not evidence that its textures are absent. Saying
        # `resolves: false` there would turn "I could not tell" into "it is broken".
        out["resolves"] = None
    out["toolTexture"] = rel.lower().startswith("materials/tools/")
    return out


def search_content(req: dict[str, Any]) -> dict[str, Any]:
    """Finds materials and models in the game, by name."""
    game_dir = req.get("gameDir")
    pattern = str(req.get("pattern", "")).strip()
    kind = req.get("kind", "material")
    limit = min(int(req.get("limit", DEFAULT_LIMIT)), MAX_LIMIT)
    want_details = bool(req.get("details", False))

    if not pattern:
        # Not a top-level `error`: callSidecar reads any truthy top-level `error` as the
        # fault envelope and looks for `error.message`, so a string there reaches the caller
        # as "unknown error" and this diagnostic is lost. The verb reports the problem in
        # its own result instead.
        return {
            "gameDir": game_dir,
            "mounted": False,
            "mountError": None,
            "pattern": pattern,
            "kind": kind,
            "total": 0,
            "results": [],
            "refused": "a search needs a pattern; an empty one would return the whole game",
        }

    fsys, mount_error = _mount(game_dir)
    if fsys is None:
        return {
            "gameDir": game_dir,
            "mounted": False,
            "mountError": mount_error,
            "pattern": pattern,
            "kind": kind,
            "total": 0,
            "results": [],
            "note": "nothing was searched, so an empty result here says nothing about the game",
        }

    prefix, suffix = (
        ("materials/", ".vmt") if kind == "material" else ("models/", ".mdl")
    )
    match = _matcher(pattern)
    hits: list[str] = []
    for path in _walk(fsys):
        low = path.lower()
        if not low.startswith(prefix) or not low.endswith(suffix):
            continue
        if match(_searchable(low, prefix)):
            hits.append(path)

    hits.sort()
    total = len(hits)
    shown = hits[:limit]

    results: list[dict[str, Any]] = []
    for rel in shown:
        row: dict[str, Any] = {"path": rel, "source": _source(fsys, rel)}
        if kind == "material":
            row["name"] = _vmf_name(rel)
            if want_details:
                row.update(_material_details(fsys, rel))
        results.append(row)

    return {
        "gameDir": game_dir,
        "mounted": True,
        "mountError": None,
        "pattern": pattern,
        "kind": kind,
        "total": total,
        "shown": len(results),
        "truncated": total > len(results),
        "results": results,
        "note": (
            "names only unless details was asked for: a Garry's Mod install holds tens of "
            "thousands of VMTs and parsing them all to answer one search would cost seconds"
        ),
    }


def model_info(req: dict[str, Any]) -> dict[str, Any]:
    """Bounds, skins, sequences and materials of one .mdl.

    What Hammer's model browser shows, and what an agent needs before placing a prop: a
    prop_static positioned from its origin without knowing its size lands half inside the
    floor, and nothing downstream reports that.
    """
    game_dir = req.get("gameDir")
    rel = str(req.get("model", "")).replace("\\", "/").strip()
    if not rel:
        return {"model": "", "mounted": False, "found": False, "refused": "no model given"}
    if not rel.lower().startswith("models/"):
        rel = f"models/{rel}"
    if not rel.lower().endswith(".mdl"):
        rel = f"{rel}.mdl"

    fsys, mount_error = _mount(game_dir)
    if fsys is None:
        return {"model": rel, "mounted": False, "mountError": mount_error, "found": False}

    try:
        from srctools.mdl import Model

        mdl = Model(fsys, fsys[rel])
    except (KeyError, FileNotFoundError):
        return {
            "model": rel,
            "mounted": True,
            "mountError": None,
            "found": False,
            "note": "not in this game's content. Check the name, or the addon that ships it",
        }
    except Exception as exc:  # noqa: BLE001
        # `readError` rather than `error`, for the same reason as above: a malformed model
        # would otherwise reach the caller as "sidecar model_info: unknown error" with the
        # diagnostic thrown away.
        return {
            "model": rel,
            "mounted": True,
            "mountError": None,
            "found": False,
            "readError": f"{type(exc).__name__}: {exc}",
        }

    def _vec(v: Any) -> list[float] | None:
        try:
            return [round(float(v.x), 3), round(float(v.y), 3), round(float(v.z), 3)]
        except Exception:  # noqa: BLE001
            return None

    textures = []
    try:
        textures = sorted({t.replace("\\", "/") for t in mdl.iter_textures()})
    except Exception:  # noqa: BLE001
        textures = []

    skins: list[int] = []
    try:
        skins = list(range(len(mdl.skins)))
    except Exception:  # noqa: BLE001
        skins = []

    # Labels only. srctools' Sequence reprs its bounding box and its event list, which
    # runs to a few hundred characters each and answers a question nobody asked.
    # Counted before slicing. Reporting the length of the truncated list told a caller a
    # model with 300 animations has exactly 64, with nothing to say the rest exist.
    sequences: list[str] = []
    sequence_total = 0
    try:
        labels = [str(getattr(s, "label", s)) for s in getattr(mdl, "sequences", [])]
        sequence_total = len(labels)
        sequences = labels[:SEQUENCE_LIMIT]
    except Exception:  # noqa: BLE001
        sequences = []

    mins = _vec(getattr(mdl, "hull_min", None))
    maxs = _vec(getattr(mdl, "hull_max", None))
    size = (
        [round(maxs[i] - mins[i], 3) for i in range(3)]
        if mins is not None and maxs is not None
        else None
    )

    return {
        "model": rel,
        "mounted": True,
        "mountError": None,
        "found": True,
        "mins": mins,
        "maxs": maxs,
        "size": size,
        "skinCount": len(skins),
        "sequenceCount": sequence_total,
        "sequences": sequences,
        "sequencesTruncated": sequence_total > len(sequences),
        "materials": textures,
        "note": (
            "bounds are the model's own hull, around its origin. A prop placed at a floor's "
            "height sinks by however far its origin sits above its lowest point"
        ),
    }
