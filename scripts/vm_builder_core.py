"""Pure VM builder core: APKINDEX resolution, pyfml repo reconstruction, CI hook."""

import ast
from dataclasses import dataclass
from enum import StrEnum
import re
from typing import Mapping


class ApkArch(StrEnum):
    """Target CPU architectures supported by unkernel Alpine images."""

    AARCH64 = "aarch64"


@dataclass(frozen=True)
class UnkernelRelease:
    """Pinned pithings/unkernel release metadata and SHA-256 digests."""

    tag: str
    tarball_name: str
    tarball_url: str
    tarball_sha256: str
    alpine_erofs_name: str
    alpine_erofs_url: str
    alpine_erofs_sha256: str


PINNED_UNKERNEL = UnkernelRelease(
    tag="v0.2.0-261126-fd204d3",
    tarball_name="unkernel.tgz",
    tarball_url=(
        "https://github.com/pithings/unkernel/releases/download/"
        "v0.2.0-261126-fd204d3/unkernel.tgz"
    ),
    tarball_sha256=(
        "0970d262dab8d584a162e0daec8e9a0a7dcd5212a81bf51f2c6323d5a4eabcf1"
    ),
    alpine_erofs_name="alpine.erofs",
    alpine_erofs_url=(
        "https://github.com/pithings/unkernel/releases/download/"
        "v0.2.0-261126-fd204d3/alpine.erofs"
    ),
    alpine_erofs_sha256=(
        "4253fdcaf3fe289f6a48eb565b5ca1eb43e147e6b9d9985ffbca865b3984a9a8"
    ),
)

DEFAULT_ALPINE_VERSION = "v3.24"

DEFAULT_VM_PACKAGES: tuple[str, ...] = (
    "python3",
    "git",
    "bash",
    "nano",
    "ca-certificates",
    "diffutils",
    "less",
    "ncurses",
)


@dataclass(frozen=True)
class ApkPackage:
    """Parsed package entry from an Alpine APKINDEX."""

    name: str
    version: str
    repo: str = ""
    depends: tuple[str, ...] = ()
    provides: tuple[str, ...] = ()
    arch: str = "aarch64"
    size: int = 0
    description: str = ""

    @property
    def apk_filename(self) -> str:
        """Return the canonical `.apk` archive filename."""
        return f"{self.name}-{self.version}.apk"

    @property
    def repo_relative_path(self) -> str:
        """Return the Alpine mirror relative path for downloading this package."""
        if self.repo:
            return f"{self.repo}/{self.arch}/{self.apk_filename}"
        return f"{self.arch}/{self.apk_filename}"


@dataclass(frozen=True)
class ErofsBuildPlan:
    """Declarative build configuration for `distros/pymi-alpine.erofs`."""

    release: UnkernelRelease
    alpine_version: str
    arch: ApkArch
    root_packages: tuple[str, ...]
    output_erofs: str


DEFAULT_BUILD_PLAN = ErofsBuildPlan(
    release=PINNED_UNKERNEL,
    alpine_version=DEFAULT_ALPINE_VERSION,
    arch=ApkArch.AARCH64,
    root_packages=DEFAULT_VM_PACKAGES,
    output_erofs="distros/pymi-alpine.erofs",
)

_DEP_CONSTRAINT_RE = re.compile(r"[<>=~]+")
_EXERCISE_NAME_RE = re.compile(r"^ex(\d+)_(\d+)$")

_TEST_BASE_PY = '''"""Base test case for PyMi exercises."""

import unittest


class TestExercise(unittest.TestCase):
    MESSAGE_FMT = "Đầu vào: {0!r} - Kết quả đúng là {1!r}, nhận được {2!r}"

    def _test_all(self, func, cases):
        for input_, expect in cases:
            with self.subTest(input=input_, expected=expect):
                output = func(input_)
                msg = self.MESSAGE_FMT.format(input_, expect, output)
                self.assertEqual(output, expect, msg)
'''

_SETUP_PY = '''"""Setup and unittest runner for PyMi exercises."""

import sys
import unittest


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] != "test":
        print("Usage: python3 setup.py test [--test-suite <module>]")
        return 2

    suite_name = None
    idx = 1
    while idx < len(args):
        arg = args[idx]
        if arg == "--test-suite" and idx + 1 < len(args):
            suite_name = args[idx + 1]
            idx += 2
        elif arg.startswith("--test-suite="):
            suite_name = arg.split("=", 1)[1]
            idx += 1
        else:
            idx += 1

    loader = unittest.TestLoader()
    if suite_name:
        suite = loader.loadTestsFromName(suite_name)
    else:
        suite = loader.discover("tests")

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
'''

_PEP8_PY = '''#!/usr/bin/env python3
"""Standalone lightweight PEP8 style checker for PyMi exercises."""

import io
import sys
import tokenize

MAX_LINE_LENGTH = 79


def check_file(filepath: str) -> list[str]:
    """Return formatted PEP8 violation lines for `filepath`."""
    with open(filepath, "r", encoding="utf-8") as fh:
        source = fh.read()

    if not source:
        return []

    violations: list[str] = []
    lines = source.splitlines(keepends=True)

    multiline_string_lines: set[int] = set()
    indent_errors: dict[int, tuple[int, str, str]] = {}
    comma_errors: list[tuple[int, int, str, str]] = []

    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except tokenize.TokenError:
        tokens = []

    for idx, tok in enumerate(tokens):
        if tok.type == tokenize.STRING:
            for lineno in range(tok.start[0], tok.end[0] + 1):
                multiline_string_lines.add(lineno)
        elif tok.type == tokenize.INDENT:
            indent_text = tok.string
            lineno = tok.start[0]
            if "\\t" in indent_text and " " in indent_text:
                indent_errors[lineno] = (1, "E101", "indentation contains mixed spaces and tabs")
            elif "\\t" in indent_text:
                indent_errors[lineno] = (1, "W191", "indentation contains tabs")
            elif len(indent_text) % 4 != 0:
                indent_errors[lineno] = (1, "E111", "indentation is not a multiple of four")
        elif tok.type == tokenize.OP and tok.string == ",":
            if idx + 1 < len(tokens):
                nxt = tokens[idx + 1]
                if (
                    nxt.start[0] == tok.end[0]
                    and nxt.start[1] == tok.end[1]
                    and nxt.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT)
                    and nxt.string not in (")", "]", "}", ":")
                ):
                    comma_errors.append(
                        (tok.start[0], tok.start[1] + 1, "E231", "missing whitespace after ','")
                    )

    for idx, raw_line in enumerate(lines, start=1):
        line_no_nl = raw_line.rstrip("\\r\\n")
        has_noqa = "# NOQA" in line_no_nl or "# noqa" in line_no_nl

        if not line_no_nl and idx not in multiline_string_lines:
            continue

        if line_no_nl and not line_no_nl.strip() and idx not in multiline_string_lines:
            violations.append(f"{filepath}:{idx}:1: W293 blank line contains whitespace")
        elif line_no_nl != line_no_nl.rstrip(" \\t") and idx not in multiline_string_lines:
            col = len(line_no_nl.rstrip(" \\t")) + 1
            violations.append(f"{filepath}:{idx}:{col}: W291 trailing whitespace")

        if idx in indent_errors:
            col, code, msg = indent_errors[idx]
            violations.append(f"{filepath}:{idx}:{col}: {code} {msg}")
        elif idx not in multiline_string_lines:
            leading = line_no_nl[: len(line_no_nl) - len(line_no_nl.lstrip(" \\t"))]
            if "\\t" in leading and " " in leading:
                violations.append(
                    f"{filepath}:{idx}:1: E101 indentation contains mixed spaces and tabs"
                )
            elif "\\t" in leading:
                violations.append(
                    f"{filepath}:{idx}:1: W191 indentation contains tabs"
                )

        if len(line_no_nl) > MAX_LINE_LENGTH and not has_noqa:
            violations.append(
                f"{filepath}:{idx}:{MAX_LINE_LENGTH + 1}: E501 "
                f"line too long ({len(line_no_nl)} > {MAX_LINE_LENGTH} characters)"
            )

    for lineno, col, code, msg in comma_errors:
        line_text = lines[lineno - 1].rstrip("\\r\\n")
        if "# NOQA" not in line_text and "# noqa" not in line_text:
            violations.append(f"{filepath}:{lineno}:{col}: {code} {msg}")

    if not source.endswith("\\n"):
        last_line = len(lines)
        last_col = len(lines[-1]) + 1
        violations.append(f"{filepath}:{last_line}:{last_col}: W292 no newline at end of file")

    return violations


def main(argv: list[str]) -> int:
    if not argv:
        print("Usage: pep8.py <file.py> [...]", file=sys.stderr)
        return 2

    all_violations: list[str] = []
    for path in argv:
        all_violations.extend(check_file(path))

    for item in all_violations:
        print(item)

    return 1 if all_violations else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
'''

_README_MD = """# PyMi Exercises (`pyfml`)

Repository bài tập Python tại PyMi.vn.

## Cấu trúc thư mục

- `exercises/` — Các file bài tập (`ex3_0.py`, `ex35_1.py`, `ex4_1.py`, ...).
- `tests/` — Bộ test `unittest` cho từng chương (`test_ex3.py`, ...).
- `vendor/pep8.py` — Công cụ kiểm tra chuẩn code PEP8.
- `setup.py` — Runner chạy test (`python3 setup.py test --test-suite tests.test_ex3`).
- `guide.rst` — Tài liệu hướng dẫn làm bài và nộp bài bằng Git.
"""


def normalize_apk_dep(dep: str) -> str | None:
    """Strip version operators from an APK dependency token; return None for conflicts."""
    cleaned = dep.strip()
    if not cleaned or cleaned.startswith("!"):
        return None
    base = _DEP_CONSTRAINT_RE.split(cleaned, maxsplit=1)[0].strip()
    return base or None


def parse_apkindex(text: str, repo: str = "") -> list[ApkPackage]:
    """Parse an Alpine `APKINDEX` text document into `ApkPackage` records."""
    packages: list[ApkPackage] = []
    for stanza in text.strip().split("\n\n"):
        if not stanza.strip():
            continue
        fields: dict[str, str] = {}
        for line in stanza.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            fields[key] = value

        name = fields.get("P", "").strip()
        version = fields.get("V", "").strip()
        if not name or not version:
            continue

        depends = tuple(fields.get("D", "").split())
        provides = tuple(fields.get("p", "").split())
        arch = fields.get("A", "aarch64").strip() or "aarch64"
        size_raw = fields.get("S", "0").strip()
        size = int(size_raw) if size_raw.isdigit() else 0
        description = fields.get("T", "").strip()

        packages.append(
            ApkPackage(
                name=name,
                version=version,
                repo=repo,
                depends=depends,
                provides=provides,
                arch=arch,
                size=size,
                description=description,
            )
        )
    return packages


def parse_installed_apk_db(text: str) -> set[str]:
    """Extract all installed package names and virtual provides from `/lib/apk/db/installed`."""
    installed: set[str] = set()
    for pkg in parse_apkindex(text):
        installed.add(pkg.name)
        for prov in pkg.provides:
            base = normalize_apk_dep(prov)
            if base is not None:
                installed.add(base)
    return installed


def resolve_apk_closure(
    packages: list[ApkPackage],
    roots: list[str],
    preinstalled: set[str] | None = None,
) -> list[ApkPackage]:
    """Resolve transitive APK dependencies in deterministic topological order."""
    installed = preinstalled or set()
    by_name: dict[str, ApkPackage] = {}
    by_provide: dict[str, list[ApkPackage]] = {}

    for pkg in sorted(packages, key=lambda p: (p.repo != "main", p.name, p.version)):
        by_name.setdefault(pkg.name, pkg)
        for prov in pkg.provides:
            base = normalize_apk_dep(prov)
            if base is not None:
                by_provide.setdefault(base, []).append(pkg)

    ordered: list[ApkPackage] = []
    selected: dict[str, ApkPackage] = {}
    visiting: set[str] = set()

    def _lookup(token: str) -> ApkPackage:
        if token in by_name:
            return by_name[token]
        candidates = by_provide.get(token, [])
        if not candidates:
            raise ValueError(f"Unresolvable APK dependency: {token}")
        for cand in candidates:
            if cand.name in selected:
                return cand
        return candidates[0]

    def _visit(token: str) -> None:
        base = normalize_apk_dep(token)
        if base is None or base in installed:
            return
        pkg = _lookup(base)
        if pkg.name in installed or pkg.name in selected or pkg.name in visiting:
            return
        visiting.add(pkg.name)
        for dep in pkg.depends:
            _visit(dep)
        visiting.remove(pkg.name)
        selected[pkg.name] = pkg
        ordered.append(pkg)

    for root in sorted(roots):
        _visit(root)

    return ordered


def _exercise_sort_key(module_name: str) -> tuple[int, int, str]:
    match = _EXERCISE_NAME_RE.match(module_name)
    if match:
        return (int(match.group(1)), int(match.group(2)), module_name)
    return (999999, 999999, module_name)


def _extract_class_block(test_code: str, test_class: str) -> str:
    marker = f"class {test_class}(TestExercise):"
    idx = test_code.find(marker)
    if idx == -1:
        raise ValueError(f"Could not find {marker} in testCode")
    return test_code[idx:].rstrip()


def _find_referenced_exercises(
    class_code: str, workspace_modules: set[str]
) -> list[str]:
    tree = ast.parse(class_code)
    found = {
        node.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and node.id in workspace_modules
    }
    return sorted(found, key=_exercise_sort_key)


def build_pyfml_files(
    workspace: Mapping[str, str],
    tests_registry: Mapping[str, Mapping[str, object]],
    guide_rst: str,
) -> dict[str, str]:
    """Reconstruct the full multi-file `pyfml` repository from browser JSON artifacts."""
    files: dict[str, str] = {}
    files["exercises/__init__.py"] = ""
    for filename, content in sorted(workspace.items()):
        files[f"exercises/{filename}"] = content

    files["tests/__init__.py"] = ""
    files["tests/base.py"] = _TEST_BASE_PY

    workspace_modules = {
        name[:-3] for name in workspace if name.endswith(".py")
    }

    by_source_file: dict[str, list[Mapping[str, object]]] = {}
    for entry in tests_registry.values():
        src = str(entry["sourceFile"])
        by_source_file.setdefault(src, []).append(entry)

    for source_file, entries in sorted(by_source_file.items()):
        sample = entries[0]
        test_class = str(sample["testClass"])
        raw_code = str(sample["testCode"])
        class_block = _extract_class_block(raw_code, test_class)
        referenced = _find_referenced_exercises(class_block, workspace_modules)

        import_lines = "\n".join(
            f"import exercises.{mod} as {mod}" for mod in referenced
        )
        sections = [
            "import unittest",
            "from tests.base import TestExercise",
        ]
        if import_lines:
            sections.append(import_lines)
        sections.append(class_block)
        sections.append('if __name__ == "__main__":\n    unittest.main()')

        reconstructed = "\n\n\n".join(sections[:2])
        if import_lines:
            reconstructed = (
                "import unittest\n\nfrom tests.base import TestExercise\n\n"
                + import_lines
                + "\n\n\n"
                + class_block
                + '\n\n\nif __name__ == "__main__":\n    unittest.main()\n'
            )
        else:
            reconstructed = (
                "import unittest\n\nfrom tests.base import TestExercise\n\n\n"
                + class_block
                + '\n\n\nif __name__ == "__main__":\n    unittest.main()\n'
            )

        # Validate syntax at build time so malformed tests fail fast.
        ast.parse(reconstructed, filename=f"tests/{source_file}")
        files[f"tests/{source_file}"] = reconstructed

    files["setup.py"] = _SETUP_PY
    files["vendor/pep8.py"] = _PEP8_PY
    files["guide.rst"] = guide_rst
    files["README.md"] = _README_MD
    return files


def generate_post_receive_hook() -> str:
    """Return the bash `post-receive` hook script for `/srv/git/pyfml.git`."""
    return """#!/bin/bash
set -u

ZERO_REV="0000000000000000000000000000000000000000"

while read -r oldrev newrev refname; do
  branch="${refname#refs/heads/}"
  echo ""
  echo "To create a merge request for ${branch}, visit:"
  echo "  https://thegit.pymi.vn/pyfml/pyfml/merge_requests/new?merge_request%5Bsource_branch%5D=${branch}"
  echo ""

  if [ "${newrev}" = "${ZERO_REV}" ]; then
    continue
  fi

  if [ "${oldrev}" = "${ZERO_REV}" ]; then
    changed_files=$(git diff-tree --no-commit-id --name-only -r "${newrev}" -- 'exercises/*.py')
  else
    changed_files=$(git diff --name-only "${oldrev}" "${newrev}" -- 'exercises/*.py')
  fi

  if [ -z "${changed_files}" ]; then
    echo "[BaiTapPyMi Local CI] PASSED (no exercise .py changes)"
    continue
  fi

  tmpdir=$(mktemp -d)
  pep8_script="${tmpdir}/pep8.py"
  if ! git show "${newrev}:vendor/pep8.py" > "${pep8_script}" 2>/dev/null; then
    rm -rf "${tmpdir}"
    continue
  fi

  ci_failed=0
  for file_path in ${changed_files}; do
    mkdir -p "${tmpdir}/$(dirname "${file_path}")"
    if git show "${newrev}:${file_path}" > "${tmpdir}/${file_path}" 2>/dev/null; then
      output=$(python3 "${pep8_script}" "${tmpdir}/${file_path}" 2>&1)
      if [ $? -ne 0 ]; then
        ci_failed=1
        echo "[BaiTapPyMi Local CI] PEP8 warning in ${file_path}:"
        echo "${output}" | sed "s|${tmpdir}/||g"
      fi
    fi
  done

  if [ "${ci_failed}" -eq 0 ]; then
    echo "[BaiTapPyMi Local CI] PASSED"
  else
    echo "[BaiTapPyMi Local CI] PEP8 check reported warnings (see above)."
  fi

  rm -rf "${tmpdir}"
done
"""
