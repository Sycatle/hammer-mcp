"""Loading the game's own FGD, which is the schema every VMF is checked against.

The FGD is what Hammer itself enforces: which keyvalues a class accepts, which inputs it
answers to, which outputs it can fire. Checking a VMF against it catches, before a
40-minute compile, the class of mistake that otherwise only shows up as an entity that
silently does nothing in game.

`garrysmod.fgd` from the GMod install is used rather than srctools' bundled multi-game
database. The bundle is broader and wronger for us: its `prop_dynamic` unions 111
keyvalues across every Source game, where GMod's own says 39. It also has no
`sent_ball`, and a lint that does not know a class exists reports it as unknown.
"""

from __future__ import annotations

import collections
from typing import Any

_CACHE: dict[str, Any] = {}


def _make_helpers_lenient() -> collections.Counter[str]:
    """Stops one malformed display helper from costing us the whole FGD.

    `garrysmod.fgd` line 187 declares `sphere(ball_size, 255, 255, 255, diameter)` with
    five arguments where srctools accepts 0, 1 or 4, and the parse aborts. Helpers are
    Hammer's rendering hints -- a sphere gizmo, a colour swatch -- and say nothing about
    whether a keyvalue is valid, so a bad one is worth tolerating rather than failing on.

    Falls back through shorter argument lists, then to a no-op helper. What was tolerated
    is counted and reported, so this stays visible instead of becoming silent damage.
    """
    from srctools.fgd import HELPER_IMPL, HelperTypes

    tolerated: collections.Counter[str] = collections.Counter()
    noop = HELPER_IMPL[HelperTypes.HALF_GRID_SNAP]()

    for impl in list(HELPER_IMPL.values()):
        original = impl.parse

        def make(original: Any = original) -> Any:
            def parse(cls: Any, args: Any, *rest: Any) -> Any:
                try:
                    return original.__func__(cls, args, *rest)
                except (ValueError, IndexError, TypeError):
                    pass
                for n in range(len(args) - 1, -1, -1):
                    try:
                        result = original.__func__(cls, args[:n], *rest)
                    except (ValueError, IndexError, TypeError):
                        continue
                    tolerated[cls.__name__] += 1
                    return result
                tolerated[f"{cls.__name__} (dropped)"] += 1
                return noop

            return classmethod(parse)

        impl.parse = make()

    return tolerated


def load_fgds(
    bin_dir: str, names: list[str] | tuple[str, ...] = ("garrysmod.fgd",)
) -> tuple[Any, dict[str, int]]:
    """Parses the FGDs into one schema, once per process, and caches the result.

    More than one because the game's FGD is not the only source of truth about what a
    class is. The Hammer++ compilers add their own entities -- `func_detail_illusionary`,
    `func_nobevel`, `light_projected` -- and a lint that does not know them calls a map
    using them wrong. Merging is what srctools does naturally: parsing several files into
    the same FGD object unions their classes, and `apply_bases` runs once at the end so
    inheritance resolves across all of them.

    `names` are paths relative to `bin_dir`, so `win64/toolsplusplus.fgd` reaches the ++
    FGD without anything having to be moved next to the game's own.

    An absolute name is opened from its own directory instead. Counter-Strike: Source keeps
    its FGDs in `bin/` while its 64-bit compilers are in `bin/x64/`, and RawFileSystem
    refuses any path that leaves its root. Rooting at the file's directory also keeps its
    `@include "base.fgd"` resolving next to it.
    """
    import os

    names = tuple(names)
    key = f"{bin_dir}::{'|'.join(names)}"
    if key in _CACHE:
        return _CACHE[key]

    from srctools.fgd import FGD
    from srctools.filesys import RawFileSystem

    tolerated = _make_helpers_lenient()
    fs = RawFileSystem(bin_dir)
    fgd = FGD()
    for name in names:
        if os.path.isabs(name):
            own = RawFileSystem(os.path.dirname(name))
            fgd.parse_file(own, own[os.path.basename(name)], eval_bases=True)
        else:
            fgd.parse_file(fs, fs[name], eval_bases=True)
    fgd.apply_bases()

    result = (fgd, dict(tolerated))
    _CACHE[key] = result
    return result


def describe_class(entity: Any) -> dict[str, Any]:
    """Flattens one FGD class into plain JSON."""
    # srctools keys these dicts in lowercase but keeps the declared spelling on the
    # object. Hammer's I/O is case-insensitive, so both work -- but an agent writing an
    # output into a VMF should see "SetAnimation", the way the FGD and every tutorial
    # spell it, not "setanimation".
    keyvalues = []
    for name in sorted(entity.kv):
        kv = entity.kv[name]
        entry: dict[str, Any] = {
            "name": getattr(kv, "name", None) or name,
            "type": str(getattr(kv, "type", "")).rsplit(".", 1)[-1],
            "display": getattr(kv, "disp_name", None),
            "default": getattr(kv, "default", None) or None,
        }
        choices = getattr(kv, "val_list", None)
        if choices:
            entry["choices"] = [list(map(str, c[:2])) for c in choices][:64]
        keyvalues.append(entry)

    return {
        "classname": entity.classname,
        "type": str(entity.type).rsplit(".", 1)[-1],
        "description": (entity.desc or "").strip()[:2000] or None,
        "keyvalues": keyvalues,
        "inputs": sorted(
            getattr(entity.inp[k], "name", None) or k for k in entity.inp
        ),
        "outputs": sorted(
            getattr(entity.out[k], "name", None) or k for k in entity.out
        ),
    }
