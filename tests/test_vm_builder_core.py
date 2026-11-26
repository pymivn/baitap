"""Tests for pure VM builder core (APKINDEX resolution & pyfml reconstruction)."""

import ast
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

from scripts.vm_builder_core import (
    ApkPackage,
    build_pyfml_files,
    generate_post_receive_hook,
    normalize_apk_dep,
    parse_apkindex,
    parse_installed_apk_db,
    resolve_apk_closure,
)

SAMPLE_APKINDEX = """\
C:Q1abc=
P:musl
V:1.2.5-r0
A:aarch64
S:400000
T:the musl c library
p:so:libc.musl-aarch64.so.1=1

C:Q1def=
P:zlib
V:1.3.1-r0
A:aarch64
S:50000
T:A compression/decompression Library
D:so:libc.musl-aarch64.so.1
p:so:libz.so.1=1.3.1

C:Q1ghi=
P:libssl3
V:3.3.2-r0
A:aarch64
S:300000
T:SSL shared libraries
D:libcrypto3=3.3.2-r0 so:libc.musl-aarch64.so.1
p:so:libssl.so.3=3

C:Q1jkl=
P:libcrypto3
V:3.3.2-r0
A:aarch64
S:1200000
T:Crypto library
D:so:libc.musl-aarch64.so.1
p:so:libcrypto.so.3=3

C:Q1mno=
P:python3
V:3.12.9-r0
A:aarch64
S:14000000
T:High-level scripting language
D:so:libc.musl-aarch64.so.1 so:libz.so.1>=1.3 so:libssl.so.3 !python2
p:cmd:python3=3.12.9-r0

C:Q1pqr=
P:git
V:2.47.1-r0
A:aarch64
S:3500000
T:Distributed version control system
D:so:libc.musl-aarch64.so.1 so:libz.so.1 cmd:sh

C:Q1stu=
P:busybox
V:1.37.0-r0
A:aarch64
S:500000
T:Size optimized toolbox
p:cmd:sh=1.37.0-r0
"""


class TestApkIndexAndResolver(unittest.TestCase):
    def test_normalize_apk_dep(self) -> None:
        self.assertEqual(normalize_apk_dep("zlib>=1.3.1-r0"), "zlib")
        self.assertEqual(normalize_apk_dep("libcrypto3=3.3.2-r0"), "libcrypto3")
        self.assertEqual(normalize_apk_dep("so:libssl.so.3=3"), "so:libssl.so.3")
        self.assertEqual(normalize_apk_dep("foo~1.2"), "foo")
        self.assertIsNone(normalize_apk_dep("!python2"))
        self.assertIsNone(normalize_apk_dep("  "))

    def test_parse_apkindex(self) -> None:
        pkgs = parse_apkindex(SAMPLE_APKINDEX, repo="main")
        self.assertEqual(len(pkgs), 7)
        py = next(p for p in pkgs if p.name == "python3")
        self.assertEqual(py.version, "3.12.9-r0")
        self.assertEqual(py.repo, "main")
        self.assertEqual(py.apk_filename, "python3-3.12.9-r0.apk")
        self.assertIn("so:libssl.so.3", py.depends)
        self.assertIn("cmd:python3=3.12.9-r0", py.provides)

    def test_parse_installed_apk_db(self) -> None:
        installed_db = (
            "P:musl\nV:1.2.5-r0\np:so:libc.musl-aarch64.so.1=1\n\n"
            "P:busybox\nV:1.37.0-r0\np:cmd:sh=1.37.0-r0\n\n"
        )
        installed = parse_installed_apk_db(installed_db)
        self.assertIn("musl", installed)
        self.assertIn("so:libc.musl-aarch64.so.1", installed)
        self.assertIn("busybox", installed)
        self.assertIn("cmd:sh", installed)

    def test_resolve_apk_closure_with_preinstalled_and_virtual_provides(self) -> None:
        pkgs = parse_apkindex(SAMPLE_APKINDEX, repo="main")
        preinstalled = {"musl", "so:libc.musl-aarch64.so.1", "busybox", "cmd:sh"}
        resolved = resolve_apk_closure(
            pkgs, roots=["python3", "git"], preinstalled=preinstalled
        )
        filenames = [p.apk_filename for p in resolved]
        self.assertIn("python3-3.12.9-r0.apk", filenames)
        self.assertIn("git-2.47.1-r0.apk", filenames)
        self.assertIn("zlib-1.3.1-r0.apk", filenames)
        self.assertIn("libssl3-3.3.2-r0.apk", filenames)
        self.assertIn("libcrypto3-3.3.2-r0.apk", filenames)
        self.assertNotIn("musl-1.2.5-r0.apk", filenames)
        self.assertNotIn("busybox-1.37.0-r0.apk", filenames)

    def test_resolve_apk_closure_missing_package_raises(self) -> None:
        pkgs = parse_apkindex(SAMPLE_APKINDEX, repo="main")
        with self.assertRaises(ValueError):
            resolve_apk_closure(pkgs, roots=["nonexistent-pkg"])

    def test_resolve_apk_closure_is_deterministic(self) -> None:
        pkgs = parse_apkindex(SAMPLE_APKINDEX, repo="main")
        r1 = resolve_apk_closure(pkgs, roots=["git", "python3"])
        r2 = resolve_apk_closure(list(reversed(pkgs)), roots=["python3", "git"])
        self.assertEqual([p.apk_filename for p in r1], [p.apk_filename for p in r2])


class TestBuildPyfmlFiles(unittest.TestCase):
    def test_reconstructs_full_repo_from_real_workspace_and_tests(self) -> None:
        root = pathlib.Path(__file__).resolve().parent.parent
        workspace = json.loads((root / "workspace.json").read_text(encoding="utf-8"))
        tests_reg = json.loads((root / "tests.json").read_text(encoding="utf-8"))
        guide_rst = (root / "guide.rst").read_text(encoding="utf-8")

        files = build_pyfml_files(workspace, tests_reg, guide_rst)

        self.assertIn("exercises/__init__.py", files)
        self.assertIn("exercises/ex3_0.py", files)
        self.assertIn("exercises/HUONGDAN.txt", files)
        self.assertIn("tests/__init__.py", files)
        self.assertIn("tests/base.py", files)
        self.assertIn("setup.py", files)
        self.assertIn("vendor/pep8.py", files)
        self.assertIn("guide.rst", files)
        self.assertIn("README.md", files)

        expected_test_files = [
            "tests/test_ex3.py",
            "tests/test_ex35.py",
            "tests/test_ex4.py",
            "tests/test_ex5.py",
            "tests/test_ex6.py",
        ]
        for tf in expected_test_files:
            self.assertIn(tf, files)
            ast.parse(files[tf], filename=tf)
            self.assertIn("from tests.base import TestExercise", files[tf])
            self.assertNotIn("class TestExercise(", files[tf])

        # Verify all ex3_0..ex3_10 are imported in tests/test_ex3.py
        for i in range(11):
            self.assertIn(f"import exercises.ex3_{i} as ex3_{i}", files["tests/test_ex3.py"])

        # Write reconstructed tree to a temp dir and verify unittest discovery + setup.py + pep8.py
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            for rel, content in files.items():
                dest = tmp_path / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(content, encoding="utf-8")

            # Verify test module imports cleanly via unittest
            proc = subprocess.run(
                [sys.executable, "-c", "import tests.test_ex3, tests.test_ex35, tests.test_ex4, tests.test_ex5, tests.test_ex6"],
                cwd=tmp_path,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)

            # Verify setup.py test --test-suite works (ex6_0/ex6_10 skipped, rest raise NotImplementedError)
            setup_proc = subprocess.run(
                [sys.executable, "setup.py", "test", "--test-suite", "tests.test_ex3.TestExercise3.test_ex3_0"],
                cwd=tmp_path,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertIn("test_ex3_0", setup_proc.stderr + setup_proc.stdout)

            # Verify vendor/pep8.py exits 0 with no output on clean file and 1 on violation
            clean_file = tmp_path / "clean.py"
            clean_file.write_text("def foo(x):\n    return x + 1\n", encoding="utf-8")
            clean_proc = subprocess.run(
                [sys.executable, "vendor/pep8.py", "clean.py"],
                cwd=tmp_path,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(clean_proc.returncode, 0, clean_proc.stdout + clean_proc.stderr)
            self.assertEqual(clean_proc.stdout, "")

            bad_file = tmp_path / "bad.py"
            bad_file.write_text("x = '" + ("a" * 80) + "'\n", encoding="utf-8")
            bad_proc = subprocess.run(
                [sys.executable, "vendor/pep8.py", "bad.py"],
                cwd=tmp_path,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(bad_proc.returncode, 1)
            self.assertIn("E501", bad_proc.stdout)


class TestPostReceiveHook(unittest.TestCase):
    def test_generate_post_receive_hook(self) -> None:
        hook = generate_post_receive_hook()
        self.assertTrue(hook.startswith("#!/bin/bash"))
        self.assertIn(
            "https://thegit.pymi.vn/pyfml/pyfml/merge_requests/new?merge_request%5Bsource_branch%5D=",
            hook,
        )
        self.assertIn("pep8.py", hook)
        self.assertIn("[BaiTapPyMi Local CI]", hook)


if __name__ == "__main__":
    unittest.main()
