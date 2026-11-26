"""Imperative Shell: fetch unkernel, build distros/pymi-alpine.erofs, emit pyfml.json."""

import argparse
import gzip
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.vm_builder_core import (
    DEFAULT_BUILD_PLAN,
    ApkPackage,
    build_pyfml_files,
    generate_post_receive_hook,
    parse_apkindex,
    parse_installed_apk_db,
    resolve_apk_closure,
)

CACHE_DIR = REPO_ROOT / ".cache"
VENDOR_UNKERNEL_DIR = REPO_ROOT / "vendor" / "unkernel"
DISTROS_DIR = REPO_ROOT / "distros"
DEFAULT_ALPINE_MIRROR = "https://dl-cdn.alpinelinux.org/alpine"

UNKERNEL_EXTRACTS: dict[str, str] = {
    "package/dist/web.mjs": "web.mjs",
    "package/dist/node.mjs": "node.mjs",
    "package/dist/_chunks/core.mjs": "_chunks/core.mjs",
    "package/dist/_chunks/node.mjs": "_chunks/node.mjs",
    "package/dist/unkernel.wasm": "unkernel.wasm",
    "package/LICENSE": "LICENSE",
    "package/LICENSE-MIT": "LICENSE-MIT",
    "package/THIRD-PARTY.md": "THIRD-PARTY.md",
}

INSTALL_APKS_JS = r"""
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [nodeMjsPath, tmpErofsPath, outTarPath] = process.argv.slice(2);
const { createKernel, MemoryFs } = await import(pathToFileURL(nodeMjsPath).href);

const outFs = new MemoryFs();
const vm = await createKernel({
    distro: tmpErofsPath,
    mounts: { "/mnt/out": outFs },
});

try {
    const cmd = [
        "set -e",
        "apk add -q --repositories-file /dev/null --no-network --no-cache /kw-apks/*.apk",
        "ln -sf /usr/bin/python3 /usr/bin/python",
        "UPPER=/run/kw-lower/kw/tmp/upper",
        "tar -cf /mnt/out/upper.tar -C \"$UPPER\" --exclude='./kw-apks' --exclude='./mnt' --exclude='./run' .",
    ].join(" && ");

    const res = await vm.exec("/bin/sh", ["-c", cmd], { user: "root", timeout: 120000 });
    if (res.exitCode !== 0) {
        console.error("STDOUT:", res.stdout);
        console.error("STDERR:", res.stderr);
        process.exit(res.exitCode ?? 1);
    }
    const tarBytes = outFs.readFile("upper.tar");
    fs.mkdirSync(path.dirname(outTarPath), { recursive: true });
    fs.writeFileSync(outTarPath, tarBytes);
} finally {
    await vm.stop();
}
"""

SMOKE_TEST_JS = r"""
import { pathToFileURL } from "node:url";

const [nodeMjsPath, erofsPath] = process.argv.slice(2);
const { createKernel } = await import(pathToFileURL(nodeMjsPath).href);

const vm = await createKernel({ distro: erofsPath });
try {
    const checks = [
        { file: "python3", args: ["--version"], user: "user", expect: "Python 3." },
        { file: "python", args: ["--version"], user: "user", expect: "Python 3." },
        { file: "git", args: ["--version"], user: "user", expect: "git version" },
        { file: "bash", args: ["--version"], user: "user", expect: "GNU bash" },
        { file: "nano", args: ["--version"], user: "user", expect: "GNU nano" },
        { file: "whoami", args: [], user: "user", expect: "user" },
        { file: "sudo", args: ["id"], user: "user", expect: "uid=0(root)" },
    ];
    for (const chk of checks) {
        const res = await vm.exec(chk.file, chk.args, { user: chk.user, timeout: 30000 });
        const out = (res.stdout + res.stderr).trim();
        if (res.exitCode !== 0 || !out.includes(chk.expect)) {
            throw new Error(`Smoke check failed for ${chk.file} ${chk.args.join(" ")}: exit=${res.exitCode} out=${out}`);
        }
        console.log(`[smoke] ${chk.file} ${chk.args.join(" ")} -> ${out.split("\n")[0]}`);
    }
} finally {
    await vm.stop();
}
"""


def sha256_file(path: pathlib.Path) -> str:
    """Compute hex SHA-256 digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


def download_verified(
    url: str, dest: pathlib.Path, expected_sha256: str = ""
) -> pathlib.Path:
    """Download `url` to `dest` atomically, verifying SHA-256 if cached or downloaded."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if not expected_sha256 or sha256_file(dest) == expected_sha256:
            return dest
        dest.unlink()

    print(f"[fetch] {url} -> {dest.relative_to(REPO_ROOT)}")
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    req = urllib.request.Request(url, headers={"User-Agent": "BaiTapPyMi-VM-Builder/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        shutil.copyfileobj(resp, out)

    actual = sha256_file(tmp)
    if expected_sha256 and actual != expected_sha256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(
            f"SHA-256 mismatch for {dest.name}: expected {expected_sha256}, got {actual}"
        )
    tmp.replace(dest)
    return dest


class NixToolRunner:
    """Runs erofs-utils and nodejs_24 via native PATH, nix, or nix-portable."""

    def __init__(self) -> None:
        self._nix_prefix: list[str] | None = None
        self._env: dict[str, str] = os.environ.copy()

    def _detect_nix_prefix(self) -> list[str]:
        if self._nix_prefix is not None:
            return self._nix_prefix

        if shutil.which("mkfs.erofs") and shutil.which("fsck.erofs"):
            node_path = shutil.which("node")
            if node_path:
                ver = subprocess.check_output([node_path, "--version"], text=True).strip()
                major = int(ver.lstrip("v").split(".")[0])
                if major >= 24:
                    self._nix_prefix = []
                    return self._nix_prefix

        nix_bin = shutil.which("nix")
        if nix_bin:
            probe_cmd = [
                nix_bin,
                "--extra-experimental-features",
                "nix-command flakes",
                "shell",
                "nixpkgs#erofs-utils",
                "-c",
                "true",
            ]
            probe = subprocess.run(probe_cmd, capture_output=True, text=True, check=False)
            if probe.returncode != 0:
                self._env["NP_RUNTIME"] = "proot"
            self._nix_prefix = [
                nix_bin,
                "--extra-experimental-features",
                "nix-command flakes",
                "shell",
                "nixpkgs#erofs-utils",
                "nixpkgs#nodejs_24",
                "-c",
            ]
            return self._nix_prefix

        np_bin = shutil.which("nix-portable")
        if not np_bin:
            raise RuntimeError(
                "Neither erofs-utils+nodejs_24, nix, nor nix-portable found in PATH."
            )

        probe = subprocess.run(
            [np_bin, "nix", "--version"],
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.returncode != 0:
            self._env["NP_RUNTIME"] = "proot"

        self._nix_prefix = [
            np_bin,
            "nix",
            "--extra-experimental-features",
            "nix-command flakes",
            "shell",
            "nixpkgs#erofs-utils",
            "nixpkgs#nodejs_24",
            "-c",
        ]
        return self._nix_prefix

    def run(self, cmd: list[str], *, cwd: pathlib.Path | None = None) -> None:
        prefix = self._detect_nix_prefix()
        full_cmd = [*prefix, *cmd]
        subprocess.run(
            full_cmd,
            cwd=cwd or REPO_ROOT,
            env=self._env,
            check=True,
        )


def extract_unkernel_vendor(tarball_path: pathlib.Path) -> None:
    """Extract required browser/node unkernel files into `vendor/unkernel/`."""
    VENDOR_UNKERNEL_DIR.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tarball_path, "r:gz") as tf:
        members = {m.name: m for m in tf.getmembers()}
        for src_name, dest_rel in UNKERNEL_EXTRACTS.items():
            member = members.get(src_name)
            if member is None or not member.isfile():
                raise RuntimeError(f"Missing {src_name} inside {tarball_path.name}")
            dest_path = VENDOR_UNKERNEL_DIR / dest_rel
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            src_file = tf.extractfile(member)
            if src_file is None:
                raise RuntimeError(f"Failed to read {src_name} from {tarball_path.name}")
            with src_file, open(dest_path, "wb") as out:
                shutil.copyfileobj(src_file, out)
    print(f"[vendor] Extracted {len(UNKERNEL_EXTRACTS)} unkernel files to vendor/unkernel/")


def build_pyfml_json() -> pathlib.Path:
    """Generate `pyfml.json` from `workspace.json`, `tests.json`, and `guide.rst`."""
    workspace = json.loads((REPO_ROOT / "workspace.json").read_text(encoding="utf-8"))
    tests_reg = json.loads((REPO_ROOT / "tests.json").read_text(encoding="utf-8"))
    guide_rst = (REPO_ROOT / "guide.rst").read_text(encoding="utf-8")

    files = build_pyfml_files(workspace, tests_reg, guide_rst)
    hook = generate_post_receive_hook()

    payload = {
        "version": 1,
        "files": files,
        "postReceiveHook": hook,
    }
    out_path = REPO_ROOT / "pyfml.json"
    out_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"[pyfml] Generated pyfml.json ({len(files)} files, {out_path.stat().st_size} bytes)")
    return out_path


def _fetch_apkindex(mirror: str, alpine_ver: str, repo: str, arch: str) -> list[ApkPackage]:
    dest = CACHE_DIR / "apks" / alpine_ver / f"{repo}-{arch}-APKINDEX.tar.gz"
    url = f"{mirror}/{alpine_ver}/{repo}/{arch}/APKINDEX.tar.gz"
    download_verified(url, dest)
    with tarfile.open(dest, "r:gz") as tf:
        member = tf.getmember("APKINDEX")
        fh = tf.extractfile(member)
        if fh is None:
            raise RuntimeError(f"APKINDEX missing inside {dest}")
        text = fh.read().decode("utf-8")
    return parse_apkindex(text, repo=repo)


def _normalize_arcname(name: str) -> str:
    clean = name.lstrip("./")
    while "//" in clean:
        clean = clean.replace("//", "/")
    return clean.rstrip("/")


def _base_mode_for_path(rel_path: str, st_mode: int, is_dir: bool) -> int:
    overrides = {
        "usr/bin/doas": 0o4755,
        "etc/doas.d/kw-user.conf": 0o400,
        "tmp": 0o1777,
        "var/tmp": 0o1777,
        "root": 0o700,
        "etc/shadow": 0o640,
    }
    if rel_path in overrides:
        return overrides[rel_path]
    if is_dir:
        return 0o755
    return 0o755 if (st_mode & 0o111) else 0o644


def _merge_base_and_upper_to_tar(
    base_dir: pathlib.Path,
    upper_tar_path: pathlib.Path,
    out_tar_path: pathlib.Path,
) -> None:
    """Merge extracted base rootfs and guest overlay upper tar into one deterministic tar."""
    upper_entries: dict[str, tuple[tarfile.TarInfo, bytes | None]] = {}
    deleted_paths: set[str] = set()

    with tarfile.open(upper_tar_path, "r:*") as utf:
        for member in utf.getmembers():
            norm = _normalize_arcname(member.name)
            if not norm or norm == ".":
                continue
            base_name = os.path.basename(norm)
            parent = os.path.dirname(norm)
            if base_name.startswith(".wh."):
                target = base_name[4:]
                if target != ".wh..opq":
                    deleted = f"{parent}/{target}" if parent else target
                    deleted_paths.add(deleted)
                continue
            data: bytes | None = None
            if member.isfile():
                extracted = utf.extractfile(member)
                data = extracted.read() if extracted is not None else b""
            copy_info = tarfile.TarInfo(name=norm)
            copy_info.type = member.type
            copy_info.mode = member.mode
            copy_info.uid = member.uid
            copy_info.gid = member.gid
            copy_info.uname = member.uname or ("user" if member.uid == 1000 else "root")
            copy_info.gname = member.gname or ("user" if member.gid == 1000 else "root")
            copy_info.mtime = 0
            copy_info.size = len(data) if data is not None else 0
            copy_info.linkname = _normalize_arcname(member.linkname) if member.islnk() else member.linkname
            upper_entries[norm] = (copy_info, data)

    merged: dict[str, tuple[tarfile.TarInfo, bytes | None]] = {}

    for root_str, dirs, files in os.walk(base_dir, followlinks=False):
        root_path = pathlib.Path(root_str)
        dirs.sort()
        files.sort()
        for entry_name in [*dirs, *files]:
            full_path = root_path / entry_name
            rel = full_path.relative_to(base_dir).as_posix()
            if rel in deleted_paths or rel in upper_entries:
                continue
            st = os.lstat(full_path)
            info = tarfile.TarInfo(name=rel)
            is_user_home = rel == "home/user" or rel.startswith("home/user/")
            info.uid = 1000 if is_user_home else 0
            info.gid = 1000 if is_user_home else 0
            info.uname = "user" if is_user_home else "root"
            info.gname = "user" if is_user_home else "root"
            info.mtime = 0

            if os.path.islink(full_path):
                info.type = tarfile.SYMTYPE
                info.mode = 0o777
                info.linkname = os.readlink(full_path)
                merged[rel] = (info, None)
            elif os.path.isdir(full_path):
                info.type = tarfile.DIRTYPE
                info.mode = _base_mode_for_path(rel, st.st_mode, is_dir=True)
                merged[rel] = (info, None)
            elif os.path.isfile(full_path):
                info.type = tarfile.REGTYPE
                info.mode = _base_mode_for_path(rel, st.st_mode, is_dir=False)
                raw = full_path.read_bytes()
                info.size = len(raw)
                merged[rel] = (info, raw)

    merged.update(upper_entries)

    with tarfile.open(out_tar_path, "w") as out_tf:
        for key in sorted(merged.keys()):
            info, data = merged[key]
            if data is not None:
                out_tf.addfile(info, io.BytesIO(data))
            else:
                out_tf.addfile(info)


def build_erofs_image(runner: NixToolRunner, mirror: str) -> pathlib.Path:
    """Build `distros/pymi-alpine.erofs` using unkernel + erofs-utils."""
    plan = DEFAULT_BUILD_PLAN
    DISTROS_DIR.mkdir(parents=True, exist_ok=True)
    output_erofs = REPO_ROOT / plan.output_erofs

    base_erofs = download_verified(
        plan.release.alpine_erofs_url,
        CACHE_DIR / "unkernel" / plan.release.alpine_erofs_name,
        plan.release.alpine_erofs_sha256,
    )

    work_dir = CACHE_DIR / "work"
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    base_root = work_dir / "base-root"
    runner.run(["fsck.erofs", f"--extract={base_root}", "--no-preserve", str(base_erofs)])

    installed_db = (base_root / "lib" / "apk" / "db" / "installed").read_text(encoding="utf-8")
    preinstalled = parse_installed_apk_db(installed_db)

    main_pkgs = _fetch_apkindex(mirror, plan.alpine_version, "main", plan.arch)
    comm_pkgs = _fetch_apkindex(mirror, plan.alpine_version, "community", plan.arch)
    resolved = resolve_apk_closure(
        main_pkgs + comm_pkgs,
        list(plan.root_packages),
        preinstalled=preinstalled,
    )
    print(f"[apk] Resolved {len(resolved)} packages: {', '.join(p.name for p in resolved)}")

    stage_root = work_dir / "stage-root"
    shutil.copytree(base_root, stage_root, symlinks=True)
    kw_apks_dir = stage_root / "kw-apks"
    kw_apks_dir.mkdir(parents=True, exist_ok=True)

    apk_cache_dir = CACHE_DIR / "apks" / plan.alpine_version
    for pkg in resolved:
        cached_apk = download_verified(
            f"{mirror}/{plan.alpine_version}/{pkg.repo_relative_path}",
            apk_cache_dir / pkg.apk_filename,
        )
        shutil.copy2(cached_apk, kw_apks_dir / pkg.apk_filename)

    tmp_erofs = work_dir / "tmp-alpine.erofs"
    runner.run(["mkfs.erofs", "-L", "kwroot", str(tmp_erofs), str(stage_root)])

    install_mjs = work_dir / "install_apks.mjs"
    install_mjs.write_text(INSTALL_APKS_JS, encoding="utf-8")
    upper_tar = work_dir / "upper.tar"

    print("[unkernel] Booting Alpine VM to run apk add --no-network ...")
    runner.run(
        [
            "node",
            str(install_mjs),
            str(VENDOR_UNKERNEL_DIR / "node.mjs"),
            str(tmp_erofs),
            str(upper_tar),
        ]
    )

    merged_tar = work_dir / "merged.tar"
    _merge_base_and_upper_to_tar(base_root, upper_tar, merged_tar)

    tmp_out_erofs = output_erofs.with_suffix(".erofs.tmp")
    runner.run(
        [
            "mkfs.erofs",
            "--tar=f",
            "-zzstd,level=9",
            "-C131072",
            "-Efragments",
            "-L",
            "kwroot",
            str(tmp_out_erofs),
            str(merged_tar),
        ]
    )
    tmp_out_erofs.replace(output_erofs)
    print(
        f"[erofs] Built {output_erofs.relative_to(REPO_ROOT)} "
        f"({output_erofs.stat().st_size / (1024 * 1024):.2f} MiB)"
    )

    smoke_mjs = work_dir / "smoke_test.mjs"
    smoke_mjs.write_text(SMOKE_TEST_JS, encoding="utf-8")
    print("[smoke] Verifying distros/pymi-alpine.erofs inside Node 24 unkernel ...")
    runner.run(
        [
            "node",
            str(smoke_mjs),
            str(VENDOR_UNKERNEL_DIR / "node.mjs"),
            str(output_erofs),
        ]
    )
    return output_erofs


def main() -> int:
    parser = argparse.ArgumentParser(description="Build BaiTapPyMi browser Linux VM assets.")
    parser.add_argument(
        "--pyfml-only",
        action="store_true",
        help="Only regenerate pyfml.json without building EROFS or fetching unkernel.",
    )
    parser.add_argument(
        "--skip-erofs-if-exists",
        action="store_true",
        help="Skip building distros/pymi-alpine.erofs if it already exists.",
    )
    parser.add_argument(
        "--alpine-mirror",
        default=DEFAULT_ALPINE_MIRROR,
        help="Alpine Linux APK mirror base URL.",
    )
    args = parser.parse_args()

    build_pyfml_json()
    if args.pyfml_only:
        return 0

    release = DEFAULT_BUILD_PLAN.release
    unkernel_tgz = download_verified(
        release.tarball_url,
        CACHE_DIR / "unkernel" / release.tarball_name,
        release.tarball_sha256,
    )
    extract_unkernel_vendor(unkernel_tgz)

    output_erofs = REPO_ROOT / DEFAULT_BUILD_PLAN.output_erofs
    if args.skip_erofs_if_exists and output_erofs.exists():
        print(f"[erofs] Skipping build; {output_erofs.relative_to(REPO_ROOT)} already exists.")
        return 0

    runner = NixToolRunner()
    build_erofs_image(runner, args.alpine_mirror)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
