#!/usr/bin/env bash
# Creates the sidecar's virtualenv and installs its pinned dependencies.
#
# The venv lives in the repo's state directory (<repoRoot>/.hammer-mcp/sidecar-venv),
# not in this folder: it is machine-specific build output, and the state directory is
# already ignored by git and already where this server keeps its runtime files.
#
# Safe to re-run: it recreates nothing that already matches.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${HAMMER_MCP_REPO:-$(cd "$here/../.." && pwd)}"
venv="$repo_root/.hammer-mcp/sidecar-venv"

# Windows (Git Bash / MSYS) venvs put the interpreter in Scripts/, and `python3` there is
# often the Microsoft Store stub rather than a real interpreter. PYTHON overrides either.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    venv_python="$venv/Scripts/python.exe"
    base_python="${PYTHON:-python}"
    ;;
  *)
    venv_python="$venv/bin/python"
    base_python="${PYTHON:-python3}"
    ;;
esac

if [[ ! -x "$venv_python" ]]; then
  echo "creating venv: $venv"
  "$base_python" -m venv "$venv"
fi

"$venv_python" -m pip install --quiet --upgrade pip
"$venv_python" -m pip install --quiet -r "$here/requirements.txt"

echo -n "sidecar ready: "
"$venv_python" "$here/main.py" health </dev/null
echo
