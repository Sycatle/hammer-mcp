"""What a compiled map actually references, and whether any of it will be missing.

The failure this exists to catch is the only one on the list a mapper never sees at home:
the purple checkerboard. It has the assets, so its map looks right on its own machine and
wrong on everyone else's. `run_pack` has always needed an explicit list of files, which
means the check for "did I forget one" was a human reading two lists side by side.

## Why the walk is recursive, and why that is the whole difficulty

Resolving one level -- material to texture -- produces a short, plausible, wrong list. A
`.vmt` can be a `patch` over another `.vmt`, water carries `$bottommaterial`, a broken
shader falls back through `$fallbackmaterial`, and a model names materials this map's
texture table never mentions. Each of those is a second hop, and a resolver that stops at
the first reports success while the map ships broken.

srctools does the two hard parts: `Material.apply_patches` follows `patch`/`include`
chains, and `Model.iter_textures` reads a `.mdl`'s own material list.

## What "missing" means here, precisely

Three answers, and the distinction matters more than the counts:

  packed   -- inside the map's own pakfile, lump 40. Ships with the map.
  game     -- found in the game's mounted content: its VPKs and loose files.
  missing  -- neither. This is the checkerboard.

An asset resolved as `game` ships only if the player owns and has mounted that game. A
Counter-Strike texture resolves fine on a machine with CS:S mounted and is a checkerboard
on one without, so the tool reports which filesystem answered rather than folding both
into "fine".
"""

from __future__ import annotations

from typing import Any

# Values that name another material. Each is a second hop, and each has cost someone a
# shipped map at some point.
MATERIAL_PARAMS = (
    "$bottommaterial",  # water: the view from underneath
    "$fallbackmaterial",  # what a card that cannot run this shader gets
    "$crackmaterial",
    "$underwateroverlay",
)

# Values that name a .vtf, relative to materials/ and without the extension.
TEXTURE_PARAMS = (
    "$basetexture",
    "$basetexture2",
    "$bumpmap",
    "$bumpmap2",
    "$normalmap",
    "$detail",
    "$detail2",
    "$envmapmask",
    "$blendmodulatetexture",
    "$selfillummask",
    "$phongexponenttexture",
    "$phongwarptexture",
    "$lightwarptexture",
    "$refracttinttexture",
    "$refractnormalmap",
    "$flowmap",
    "$tooltexture",
)

# `$envmap` usually names the engine's own cubemap rather than a file.
ENVMAP_KEYWORDS = {"env_cubemap", "cubemap"}


def is_engine_texture(value: str) -> bool:
    """Whether a texture value names a render target the engine creates, not a file.

    `_rt_Camera`, `_rt_FullFrameFB`, `_rt_WaterReflection`: allocated in memory at runtime,
    never shipped, so no install has `materials/_rt_camera.vtf` and none ever will (#114).
    Resolving them as files reported 30 of Counter-Strike: Source's own materials as broken
    -- nightvision, the flashbang, every camera monitor screen -- through 12 such names, a
    "missing texture" nobody can fix that teaches a builder to ignore the ones that matter.

    Shared by `_walk_material` here and `content._material_details`, like ENVMAP_KEYWORDS,
    so the two tools cannot disagree about what is a file.
    """
    return value.strip().lower().startswith("_rt_")

# A model needs its siblings or it draws as ERROR. `.phy` is genuinely optional -- a prop
# with no collision hull is a choice -- so its absence is reported without being an error.
MODEL_REQUIRED = (".mdl", ".vvd", ".dx90.vtx")
MODEL_OPTIONAL = (".phy", ".dx80.vtx", ".sw.vtx", ".ani")


def _norm(path: str) -> str:
    return path.replace("\\", "/").lower().lstrip("/")


def _engine_owned(key: str, map_name: str) -> bool:
    """Files the engine reads without any file ever naming them.

    Calling these "unreferenced" is how someone deletes 3983 `.vhv` files and wonders why
    every static prop went flat. They are vrad's own output -- per-prop vertex lighting and
    the built cubemaps -- and nothing in any material or model points at them.
    """
    if key.endswith(".vhv"):
        return True
    if map_name and key.startswith(f"materials/maps/{map_name}/"):
        # Cubemaps (`c<x>_<y>_<z>.vtf`) and the patched materials vbsp writes beside them.
        return True
    if map_name and key in {
        # Both are loaded from the map's own name and referenced by nothing. That is the
        # same mechanism that lets a misspelled .ain ship unnoticed -- so a correctly
        # named one must not then be reported as dead weight.
        f"maps/graphs/{map_name}.ain",
        f"maps/{map_name}.nav",
        f"maps/{map_name}_level_sounds.txt",
        f"maps/{map_name}_particles.txt",
    }:
        return True
    return False


def _under_materials(name: str, ext: str) -> str:
    """A material or texture path, rooted at `materials/` exactly once.

    The two sources disagree and both are right: a map's texture table names materials
    relative to `materials/`, while `Model.iter_textures` already includes it. Prepending
    unconditionally produced 1281 lookups for `materials/materials/...`, every one of them
    reported as a missing asset.
    """
    rel = _norm(name)
    if not rel.startswith("materials/"):
        rel = "materials/" + rel
    if not rel.endswith(ext):
        rel += ext
    return rel


class Resolver:
    """Reads an asset from the map's pakfile first, then the game's mounted content."""

    def __init__(self, pakfile: Any, game_fs: Any, chain: Any = None) -> None:
        self.pakfile = pakfile
        self.game_fs = game_fs
        # The filesystem handed to `apply_patches`, which must see the pakfile: a patch
        # material in a map routinely includes another material packed beside it, and a
        # chain holding only the game's content cannot resolve one. Measured on the
        # production map, where it turned 1225 resolvable materials into "unparsed".
        self.chain = chain if chain is not None else game_fs
        # Case-insensitive index: a VMT written `Materials/Brick/X.vmt` and packed as
        # `materials/brick/x.vmt` is the same file, and Windows never noticed.
        self.packed: dict[str, str] = {}
        if pakfile is not None:
            for name in pakfile.namelist():
                self.packed[_norm(name)] = name

    def where(self, rel: str) -> str | None:
        """`packed`, `game-vpk`, `game-loose`, or None.

        A file inside a VPK is base game content: every player who owns the game has it,
        and packing it wastes space. A file sitting **loose** in the content tree usually
        is not -- it resolves at home because it is on that disk, and it is a checkerboard
        for everyone else. That is the commonest way a map ships broken.

        "Usually", and the exception is measured rather than assumed: Garry's Mod ships
        `detail.vbsp` loose in its own root, so a loose file is a *candidate* for packing,
        not a certainty. No rule separates the two cleanly -- a mapper's own materials sit
        under the same install as the game's. The asymmetry is what makes that acceptable:
        packing a stock file wastes a few kilobytes, while missing a custom one ships a
        broken map, so the candidate list errs toward including.
        """
        key = _norm(rel)
        if key in self.packed:
            return "packed"
        if self.game_fs is not None:
            try:
                found = self.game_fs[key]
            except (KeyError, FileNotFoundError):
                return None
            return "game-vpk" if self._is_archive(found) else "game-loose"
        return None

    def _is_archive(self, found: Any) -> bool:
        try:
            from srctools.filesys import RawFileSystem

            owner = self.game_fs.get_system(found)
            return not isinstance(owner, RawFileSystem)
        except Exception:  # noqa: BLE001
            # Unknown provenance is reported as an archive: the cost of guessing wrong
            # that way is a file left unpacked that was already there, while the other
            # way is a packing list full of Valve's own content.
            return True

    def disk_path(self, rel: str) -> str | None:
        """Where a loose file actually is, so a packing list can name it."""
        if self.game_fs is None:
            return None
        try:
            from srctools.filesys import RawFileSystem

            found = self.game_fs[_norm(rel)]
            owner = self.game_fs.get_system(found)
            if isinstance(owner, RawFileSystem):
                import os

                return os.path.join(str(owner.path), _norm(rel))
        except Exception:  # noqa: BLE001
            return None
        return None

    def read(self, rel: str) -> bytes | None:
        key = _norm(rel)
        real = self.packed.get(key)
        if real is not None:
            return self.pakfile.read(real)
        if self.game_fs is not None:
            try:
                return self.game_fs[key].open_bin().read()
            except (KeyError, FileNotFoundError):
                return None
        return None


def _walk_material(
    name: str,
    resolver: Resolver,
    seen: set[str],
    found: dict[str, str],
    missing: list[dict[str, str]],
    depth: int = 0,
) -> None:
    """Resolves one material, then everything it points at."""
    from srctools.vmt import Material

    rel = _under_materials(name, ".vmt")
    if rel in seen or depth > 16:
        return
    seen.add(rel)

    where = resolver.where(rel)
    if where is None:
        missing.append({"path": rel, "kind": "material", "referencedBy": name})
        return
    found[rel] = where

    raw = resolver.read(rel)
    if raw is None:
        return
    try:
        # `keepends=True` is not cosmetic. The tokenizer ends an unquoted value at a line
        # break, and most hand-written VMTs quote nothing: strip the newlines and
        # `$surfaceprop wood` runs into the next key, the braces desync, and the file
        # reports as unparseable. Every VMT in the production map with CRLF endings and an
        # unquoted value failed this way.
        mat = Material.parse(raw.decode("utf-8", "replace").splitlines(True), rel)
        if resolver.chain is not None:
            # Follows `patch` and `include`. Without this a patch material reports as a
            # leaf and everything it inherits goes unlisted -- a short, plausible answer.
            mat = mat.apply_patches(resolver.chain)
    except Exception:
        # A VMT this parser cannot read is reported as found, because it is: the file
        # exists. Guessing at its dependencies would be worse than admitting the stop.
        missing.append({"path": rel, "kind": "unparsed-material", "referencedBy": name})
        return

    for key, value in mat.items():
        low = key.lower()
        if not isinstance(value, str) or not value.strip():
            continue
        if low in MATERIAL_PARAMS:
            _walk_material(value.strip(), resolver, seen, found, missing, depth + 1)
        elif low in TEXTURE_PARAMS or (low == "$envmap" and value.lower() not in ENVMAP_KEYWORDS):
            if is_engine_texture(value):
                continue
            tex = _under_materials(value.strip(), ".vtf")
            if tex in seen:
                continue
            seen.add(tex)
            spot = resolver.where(tex)
            if spot is None:
                missing.append({"path": tex, "kind": "texture", "referencedBy": rel})
            else:
                found[tex] = spot


def _walk_model(
    name: str,
    resolver: Resolver,
    seen: set[str],
    found: dict[str, str],
    missing: list[dict[str, str]],
    optional_absent: list[str],
) -> None:
    from srctools.mdl import Model

    base = _norm(name)
    if base.endswith(".mdl"):
        base = base[:-4]
    if base in seen:
        return
    seen.add(base)

    for ext in MODEL_REQUIRED:
        rel = base + ext
        spot = resolver.where(rel)
        if spot is None:
            missing.append({"path": rel, "kind": "model", "referencedBy": name})
        else:
            found[rel] = spot
    for ext in MODEL_OPTIONAL:
        rel = base + ext
        spot = resolver.where(rel)
        if spot is not None:
            found[rel] = spot
        elif ext == ".phy":
            optional_absent.append(rel)

    # A model names its own materials, and those are routinely absent from the map's
    # texture table -- which is exactly how a prop ends up checkerboarded on a map whose
    # own materials are all present.
    mdl = base + ".mdl"
    if resolver.where(mdl) is None:
        return
    try:
        # Model wants srctools' own File handle, not bytes -- it reads the .vvd and the
        # .vtx through the same filesystem, so handing it a buffer cuts it off from the
        # siblings it needs.
        model = Model(resolver.chain, resolver.chain[_norm(mdl)])
        for tex in model.iter_textures():
            _walk_material(tex, resolver, seen, found, missing, 1)
    except Exception:
        # Not fatal, and not silent: the caller is told the model's own materials could
        # not be read, so "no missing textures" is not mistaken for "checked".
        missing.append({"path": mdl, "kind": "unread-model-materials", "referencedBy": name})


def map_dependencies(req: dict[str, Any]) -> dict[str, Any]:
    from srctools.bsp import BSP

    path = req["path"]
    game_dir = req.get("gameDir")
    limit = int(req.get("limit", 300))

    bsp = BSP(path)

    game_fs = None
    game_error = None
    if game_dir:
        try:
            from srctools.game import Game

            game_fs = Game(game_dir).get_filesystem()
        except Exception as exc:  # noqa: BLE001
            game_error = f"{type(exc).__name__}: {exc}"

    # The chain srctools itself reads through: the map's own pakfile first, then the game.
    chain = None
    try:
        from srctools.filesys import FileSystemChain, ZipFileSystem

        chain = FileSystemChain(ZipFileSystem(path, bsp.pakfile))
        if game_fs is not None:
            chain.add_sys(game_fs)
    except Exception as exc:  # noqa: BLE001
        game_error = game_error or f"pakfile not mounted: {type(exc).__name__}: {exc}"
        chain = game_fs

    resolver = Resolver(bsp.pakfile, game_fs, chain)
    map_name = _norm(path).rsplit("/", 1)[-1][:-4] if path.lower().endswith(".bsp") else ""

    materials = [t for t in bsp.textures if t and not t.lower().startswith("tools/")]
    models: list[str] = []
    for ent in bsp.ents.entities:
        mdl = ent.get("model", "")
        if mdl.lower().startswith("models/"):
            models.append(mdl)

    # prop_static lives in the GAME_LUMP and is invisible to every other reader here. A
    # city map's props are most of its assets, so leaving them out would make a clean
    # report meaningless. Read through srctools rather than reimplemented: the GAME_LUMP
    # reader proper is someone else's work in this repository.
    static_props: list[str] = []
    static_prop_error = None
    try:
        static_props = [str(m) for m in bsp.static_prop_models()]
    except Exception as exc:  # noqa: BLE001
        static_prop_error = f"{type(exc).__name__}: {exc}"

    seen: set[str] = set()
    found: dict[str, str] = {}
    missing: list[dict[str, str]] = []
    optional_absent: list[str] = []

    # worldspawn names three things no texture table mentions, and a missing skybox is one
    # of the loudest failures a map can ship with.
    spawn = bsp.ents.spawn
    detail_material = spawn.get("detailmaterial", "")
    if detail_material:
        _walk_material(detail_material, resolver, seen, found, missing)
    detail_vbsp = _norm(spawn.get("detailvbsp", ""))
    if detail_vbsp:
        spot = resolver.where(detail_vbsp)
        if spot is None:
            missing.append({"path": detail_vbsp, "kind": "detail-config", "referencedBy": "worldspawn"})
        else:
            found[detail_vbsp] = spot
            seen.add(detail_vbsp)
    sky = _norm(spawn.get("skyname", ""))
    if sky:
        for side in ("rt", "lf", "bk", "ft", "up", "dn"):
            _walk_material(f"skybox/{sky}{side}", resolver, seen, found, missing)
            # The HDR set is optional -- an LDR-only map legitimately ships without it, so
            # a probe that reported these as missing would fire on most maps. Recorded when
            # present so they are not counted as dead weight instead.
            hdr = _under_materials(f"skybox/{sky}{side}_hdr", ".vmt")
            if hdr not in seen:
                spot_hdr = resolver.where(hdr)
                if spot_hdr is not None:
                    seen.add(hdr)
                    _walk_material(f"skybox/{sky}{side}_hdr", resolver, seen, found, missing)

    # The nodegraph is named after the map, and nothing checks that when it is packed.
    for packed_name in list(resolver.packed):
        if packed_name.endswith(".ain") and map_name:
            expected = f"maps/graphs/{map_name}.ain"
            if packed_name != expected:
                missing.append(
                    {
                        "path": packed_name,
                        "kind": "nodegraph-name-mismatch",
                        "referencedBy": f"the engine loads {expected}",
                    }
                )

    for mat in materials:
        _walk_material(mat, resolver, seen, found, missing)
    for mdl in list(dict.fromkeys(models + static_props)):
        _walk_model(mdl, resolver, seen, found, missing, optional_absent)

    referenced = set(found) | {m["path"] for m in missing}
    engine_owned: list[str] = []
    not_walked: list[str] = []
    unreferenced: list[str] = []
    for key in sorted(resolver.packed):
        if key in referenced:
            continue
        if _engine_owned(key, map_name):
            engine_owned.append(key)
        elif key.startswith(("sound/", "scripts/", "particles/", "resource/", "scenes/")):
            not_walked.append(key)
        else:
            unreferenced.append(key)

    by_source: dict[str, int] = {}
    for spot in found.values():
        by_source[spot] = by_source.get(spot, 0) + 1

    loose = sorted(k for k, v in found.items() if v == "game-loose")
    return {
        "path": path,
        "looseCount": len(loose),
        "loose": [
            {"path": k, "diskPath": resolver.disk_path(k)} for k in loose[:limit]
        ],
        "materialCount": len(materials),
        "modelCount": len(set(models)),
        "staticPropModelCount": len(static_props),
        "staticPropError": static_prop_error,
        "gameDir": game_dir,
        "gameMounted": game_fs is not None,
        "gameError": game_error,
        "resolved": len(found),
        "bySource": by_source,
        "missing": missing[:limit],
        "missingCount": len(missing),
        "missingTruncated": len(missing) > limit,
        "packedUnreferenced": unreferenced[:limit],
        "packedUnreferencedCount": len(unreferenced),
        "engineOwnedCount": len(engine_owned),
        "notWalkedCount": len(not_walked),
        "notWalked": not_walked[:limit],
        "optionalAbsent": optional_absent[:limit],
    }
