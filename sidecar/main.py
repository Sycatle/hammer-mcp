#!/usr/bin/env python3
"""Sidecar for the Source file formats srctools already knows how to read.

One subprocess per call: a verb in argv[1], a JSON request on stdin, a JSON reply on
stdout, diagnostics on stderr. No daemon and no lock -- that is the point. hammer-mcp is
stateless, and the incident that produced gmod-mcp's daemon.lock is exactly what a
long-lived helper here would invite.

The boundary follows call frequency, not file format: what is hot and already proven
stays in TypeScript (BSP by offset, KeyValues with offsets preserved, the .lmp codec);
what is cold and expensive to rewrite lives here.

Every reply is a JSON object. Failures come back as {"error": {...}} with exit code 1,
never as a traceback on stdout: the caller parses this, and a half-JSON stream would
look like a protocol fault rather than a bad path.
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable

VERBS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}


def verb(name: str) -> Callable[[Callable[[dict[str, Any]], dict[str, Any]]], Any]:
    def register(fn: Callable[[dict[str, Any]], dict[str, Any]]) -> Any:
        VERBS[name] = fn
        return fn

    return register


@verb("health")
def _health(_req: dict[str, Any]) -> dict[str, Any]:
    """Reports what this sidecar can actually do. Must never raise: hammer-mcp's own
    health tool calls it to describe a broken install rather than fail with it."""
    out: dict[str, Any] = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
    }
    try:
        from importlib.metadata import version

        import srctools  # noqa: F401 -- imported to prove it loads, not for its names

        out["srctools"] = version("srctools")
        out["ok"] = True
    except Exception as exc:  # noqa: BLE001 -- reporting, not handling
        out["srctools"] = None
        out["ok"] = False
        out["reason"] = f"{type(exc).__name__}: {exc}"
    return out


@verb("pakfile")
def _pakfile(req: dict[str, Any]) -> dict[str, Any]:
    """Lists what a compiled map carries in lump 40, the embedded pakfile.

    It is a plain ZIP, so this is the audit of what actually ships with the map: custom
    materials and models a player will see, and the cubemap VTFs (`c-*.vtf`), whose
    presence is machine-checkable proof that buildcubemaps was run -- more reliable than
    trusting the compile settings.
    """
    from srctools.bsp import BSP

    path = req["path"]
    limit = int(req.get("limit", 200))

    bsp = BSP(path)
    entries: list[dict[str, Any]] = []
    by_ext: dict[str, int] = {}
    total_bytes = 0
    cubemaps = 0

    for info in bsp.pakfile.infolist():
        name = info.filename
        total_bytes += info.file_size
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        by_ext[ext] = by_ext.get(ext, 0) + 1
        base = name.rsplit("/", 1)[-1]
        if base.startswith("c") and base.endswith(".vtf") and "-" in base:
            cubemaps += 1
        entries.append(
            {"name": name, "bytes": info.file_size, "compressed": info.compress_size}
        )

    entries.sort(key=lambda e: -e["bytes"])
    return {
        "path": path,
        "fileCount": len(entries),
        "totalBytes": total_bytes,
        "byExtension": dict(sorted(by_ext.items(), key=lambda kv: -kv[1])),
        "cubemapTextures": cubemaps,
        "returned": min(len(entries), limit),
        "largest": entries[:limit],
    }


@verb("pakfile_extract")
def _pakfile_extract(req: dict[str, Any]) -> dict[str, Any]:
    """Pulls files out of lump 40, the map's embedded pakfile.

    `read_pakfile` says what is in there; nothing could get it out, so anything packed
    inside a map -- a cubemap, a soundscript, a custom material -- was readable only by
    unpacking the map by hand. That is the gap this closes.

    Two refusals, both about writing somewhere the caller did not ask for:

    * an entry whose name escapes the destination (`../`, an absolute path, a drive
      letter) is refused rather than sanitised. A pakfile is content that came from
      somewhere else, and quietly rewriting a path to something safe would extract a file
      the caller cannot then find by name.
    * an existing file is never overwritten. `overwrite` says otherwise explicitly.
    """
    import fnmatch
    import os

    from srctools.bsp import BSP

    path = req["path"]
    into = req["into"]
    pattern = req.get("pattern")
    limit = int(req.get("limit", 200))
    overwrite = bool(req.get("overwrite", False))

    bsp = BSP(path)
    root = os.path.realpath(into)
    os.makedirs(root, exist_ok=True)

    written: list[dict[str, Any]] = []
    refused: list[dict[str, str]] = []
    skipped = 0
    matched = 0

    for info in bsp.pakfile.infolist():
        name = info.filename
        if pattern and not fnmatch.fnmatch(name.lower(), pattern.lower()):
            continue
        matched += 1
        if len(written) >= limit:
            skipped += 1
            continue

        target = os.path.realpath(os.path.join(root, name))
        if target != root and not target.startswith(root + os.sep):
            refused.append({"name": name, "why": "escapes the destination directory"})
            continue
        if os.path.exists(target) and not overwrite:
            refused.append({"name": name, "why": "already exists; pass overwrite to replace"})
            continue

        os.makedirs(os.path.dirname(target), exist_ok=True)
        data = bsp.pakfile.read(name)
        with open(target, "wb") as fh:
            fh.write(data)
        written.append({"name": name, "path": target, "bytes": len(data)})

    return {
        "path": path,
        "into": root,
        "matched": matched,
        "written": written,
        "refused": refused,
        "skippedOverLimit": skipped,
    }


def _fgd_names(req: dict[str, Any]) -> tuple[str, ...]:
    """Which FGDs to check against, relative to `binDir` or absolute.

    A list rather than one name since Hammer++ ships its own. The caller decides -- it is
    the side that knows which files exist -- and the reply names what was loaded, so the
    schema can never widen without it being visible.
    """
    names = req.get("fgd") or ("garrysmod.fgd",)
    return (names,) if isinstance(names, str) else tuple(names)


def _load_vmf(path: str, req: dict[str, Any] | None = None) -> tuple[Any, dict[str, Any]]:
    """Parses a .vmf, optionally flattening its func_instances first.

    Off by default: expanding changes every count and every targetname in the reply, and
    that must be something the caller asked for rather than something that happens to a
    map one day because an option gained a default.
    """
    from srctools import Keyvalues, VMF

    with open(path, encoding="utf8", errors="replace") as f:
        vmf = VMF.parse(Keyvalues.parse(f))

    if not (req or {}).get("collapseInstances"):
        return vmf, {"collapsed": 0, "requested": False}

    from instances import collapse_instances

    info = collapse_instances(
        vmf,
        path,
        (req or {}).get("gameDir"),
        instance_path=(req or {}).get("instancePath"),
    )
    info["requested"] = True
    return vmf, info


@verb("map_dependencies")
def _map_dependencies(req: dict[str, Any]) -> dict[str, Any]:
    """Every asset a compiled map references, and where each one will come from."""
    from dependencies import map_dependencies

    return map_dependencies(req)


@verb("search_content")
def _search_content(req: dict[str, Any]) -> dict[str, Any]:
    """Materials and models the game actually has, by name."""
    from content import search_content

    return search_content(req)


@verb("model_info")
def _model_info(req: dict[str, Any]) -> dict[str, Any]:
    """Bounds, skins and materials of one .mdl -- what Hammer's model browser shows."""
    from content import model_info

    return model_info(req)


@verb("vmf_displacements")
def _vmf_displacements(req: dict[str, Any]) -> dict[str, Any]:
    """Displacements as srctools reads them -- the oracle for our own reader."""
    from displacements import vmf_displacements

    return vmf_displacements(req)


@verb("fgd_class")
def _fgd_class(req: dict[str, Any]) -> dict[str, Any]:
    """Describes one class as the game's own FGD declares it, or lists the classes."""
    from fgd_support import describe_class, load_fgds

    fgd, tolerated = load_fgds(req["binDir"], _fgd_names(req))
    name = req.get("classname")

    if not name:
        prefix = (req.get("prefix") or "").lower()
        names = sorted(c for c in fgd.entities if c.lower().startswith(prefix))
        return {
            "classCount": len(fgd.entities),
            "toleratedHelpers": tolerated,
            "classnames": names[: int(req.get("limit", 200))],
            "returned": min(len(names), int(req.get("limit", 200))),
            "matched": len(names),
        }

    entity = fgd.entities.get(name)
    if entity is None:
        # Substring matching misses the mistake people actually make: a single wrong
        # letter. "prop_dynamik" contains no class as a substring and is contained by
        # none, yet it is one edit from prop_dynamic.
        import difflib

        near = difflib.get_close_matches(name, list(fgd.entities), n=8, cutoff=0.6)
        near += [c for c in sorted(fgd.entities) if name.lower() in c.lower() and c not in near]
        near = near[:10]
        raise KeyError(
            f"no class {name!r} in this FGD"
            + (f"; did you mean {', '.join(near)}?" if near else "")
        )
    return {
        "classCount": len(fgd.entities),
        "toleratedHelpers": tolerated,
        **describe_class(entity),
    }


@verb("vmf_read")
def _vmf_read(req: dict[str, Any]) -> dict[str, Any]:
    """Entities, brushes and counts of a .vmf, without judging any of it."""
    from vmf_lint import count_vmf

    vmf, instances = _load_vmf(req["path"], req)
    limit = int(req.get("limit", 200))
    wanted = req.get("classname")

    entities = []
    for ent in vmf.entities:
        classname = ent["classname", ""]
        if wanted and classname != wanted:
            continue
        entities.append(
            {
                "id": int(ent.id),
                "classname": classname,
                "targetname": ent["targetname", ""] or None,
                "origin": [float(v) for v in ent.get_origin()] if ent.is_brush() is False else None,
                "solidCount": len(list(ent.solids)),
                "keyvalues": {k: str(v) for k, v in ent.items()},
                "outputs": [
                    {
                        "output": o.output,
                        "target": o.target,
                        "input": o.input,
                        "params": o.params,
                        "delay": o.delay,
                        "times": o.times,
                    }
                    for o in ent.outputs
                ],
            }
        )

    histogram: dict[str, int] = {}
    for ent in vmf.entities:
        c = ent["classname", ""]
        histogram[c] = histogram.get(c, 0) + 1

    return {
        "path": req["path"],
        "counts": count_vmf(vmf),
        "instances": instances,
        "histogram": dict(sorted(histogram.items(), key=lambda kv: -kv[1])),
        "matched": len(entities),
        "returned": min(len(entities), limit),
        "entities": entities[:limit],
    }


@verb("vmf_lint")
def _vmf_lint(req: dict[str, Any]) -> dict[str, Any]:
    """Checks a .vmf against the FGD and against what the compilers accept."""
    from fgd_support import load_fgds
    from vmf_lint import count_vmf, lint_vmf, model_bounds

    names = _fgd_names(req)
    fgd, tolerated = load_fgds(req["binDir"], names)
    vmf, instances = _load_vmf(req["path"], req)
    lua_classes = frozenset(req.get("luaClasses") or ())
    findings = lint_vmf(vmf, fgd, lua_classes)
    # Not a finding: the raw halves of one. Whether a prop sinks into the floor is a
    # question about the floor, and the tracer that answers it is in TypeScript.
    props = model_bounds(vmf, req.get("gameDir"))

    by_rule: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    for f in findings:
        by_rule[f["rule"]] = by_rule.get(f["rule"], 0) + 1
        by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1

    limit = int(req.get("limit", 200))
    return {
        "path": req["path"],
        "counts": count_vmf(vmf),
        "props": props,
        "instances": instances,
        "toleratedHelpers": tolerated,
        "fgdsLoaded": list(names),
        "luaClassesKnown": len(lua_classes),
        "total": len(findings),
        "bySeverity": by_severity,
        "byRule": dict(sorted(by_rule.items(), key=lambda kv: -kv[1])),
        "returned": min(len(findings), limit),
        "findings": findings[:limit],
    }


def main() -> int:
    if len(sys.argv) < 2:
        json.dump({"error": {"kind": "usage", "message": "missing verb"}}, sys.stdout)
        return 1

    name = sys.argv[1]
    fn = VERBS.get(name)
    if fn is None:
        json.dump(
            {
                "error": {
                    "kind": "unknown_verb",
                    "message": f"unknown verb {name!r}",
                    "known": sorted(VERBS),
                }
            },
            sys.stdout,
        )
        return 1

    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        json.dump(
            {"error": {"kind": "bad_request", "message": f"stdin is not JSON: {exc}"}},
            sys.stdout,
        )
        return 1

    try:
        json.dump(fn(req), sys.stdout)
    except Exception as exc:  # noqa: BLE001 -- the boundary turns anything into JSON
        traceback.print_exc(file=sys.stderr)
        json.dump(
            {"error": {"kind": type(exc).__name__, "message": str(exc)}},
            sys.stdout,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
