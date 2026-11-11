#!/usr/bin/env python3
"""Generate split_game/ -- the smallest game whose content comes from both a VPK and disk.

For #112: `read_game_content` labels each match `vpk` or `loose`, and testing that against a
real install would pin one machine's download/ folder. This game has, by construction:

- materials/hmcp/packed.vmt   inside pak_dir.vpk         -> vpk
- materials/hmcp/ondisk.vmt   a plain file beside it     -> loose
- models/hmcp/ondisk.mdl      a plain file (never parsed) -> loose

The gameinfo mounts the VPK first, as Valve's do. Run with the sidecar's venv, which has
srctools: `python test/fixtures/gen_split_game.py`. The output is committed, so the tests
need only the sidecar, not this script.
"""
from pathlib import Path

from srctools.vpk import VPK, OpenModes

ROOT = Path(__file__).resolve().parent / "split_game"

GAMEINFO = """"GameInfo"
{
\tgame\t"hmcp split game"
\tFileSystem
\t{
\t\tSteamAppId\t4000
\t\tSearchPaths
\t\t{
\t\t\tgame+mod\t|gameinfo_path|pak.vpk
\t\t\tgame+mod\t|gameinfo_path|.
\t\t}
\t}
}
"""


def main() -> None:
    (ROOT / "materials" / "hmcp").mkdir(parents=True, exist_ok=True)
    (ROOT / "models" / "hmcp").mkdir(parents=True, exist_ok=True)
    (ROOT / "gameinfo.txt").write_text(GAMEINFO, newline="\n")

    vpk = VPK(ROOT / "pak_dir.vpk", mode=OpenModes.WRITE)
    vpk.add_file(
        "materials/hmcp/packed.vmt",
        b'LightmappedGeneric\n{\n\t"$basetexture" "hmcp/packed"\n}\n',
    )
    vpk.write_dirfile()

    (ROOT / "materials" / "hmcp" / "ondisk.vmt").write_text(
        'LightmappedGeneric\n{\n\t"$basetexture" "hmcp/ondisk"\n}\n', newline="\n"
    )
    # Never parsed: a search lists model names, and only read_model_info opens one.
    (ROOT / "models" / "hmcp" / "ondisk.mdl").write_bytes(b"not a real mdl")


if __name__ == "__main__":
    main()
