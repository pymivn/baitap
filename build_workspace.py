"""Build workspace.json and tests.json for BaiTapPyMi browser IDE.

workspace.json: Contains exercise file contents for loading into the editor.
tests.json: Maps each exercise filename to its adapted unittest code from
            pyfml/tests, with imports rewritten for the browser's flat VFS.
"""

import ast
import glob
import json
import os
import re
import sys


# Modules/patterns that are incompatible with Pyodide's WASM sandbox.
# If a test method body references any of these, it will be marked as skipped.
INCOMPATIBLE_MARKERS = [
    "tempfile.mkstemp",
    "tempfile.mkstemp(",
    "os.walk(",
    "yaml.safe_load(",
    "pickle.load(",
    "configparser.ConfigParser",
    "os.path.exists(",
    'os.path.join(os.path.dirname(__file__)',
    "os.getcwd()",
    'open(fn',
    'open(__file__)',
    "hashlib.md5(",
    "os.__file__",
    "time.sleep(",
]


def build_workspace():
    """Scan exercises/ directory and generate workspace.json."""
    workspace = {}
    exercises = glob.glob("exercises/*.py")
    exercises.append("exercises/HUONGDAN.txt")

    for ex in exercises:
        if os.path.islink(ex):
            continue

        abs_ex = os.path.abspath(ex)
        abs_dir = os.path.abspath("exercises")
        if not abs_ex.startswith(abs_dir + os.sep):
            continue

        filename = os.path.basename(ex)
        with open(ex, "r", encoding="utf-8") as f:
            workspace[filename] = f.read()

    with open("workspace.json", "w", encoding="utf-8") as f:
        json.dump(workspace, f, indent=2)

    print(f"Generated workspace.json with {len(workspace)} files.")
    return workspace


def read_base_class():
    """Read the TestExercise base class from pyfml/tests/base.py and
    enhance _test_all with subTest for per-case granular reporting."""
    base_path = os.path.join("pyfml", "tests", "base.py")
    if not os.path.exists(base_path):
        print(f"Warning: {base_path} not found, tests.json will be empty.")
        return None

    with open(base_path, "r", encoding="utf-8") as f:
        source = f.read()

    # Remove the standalone 'import unittest' line since we'll add it ourselves
    source = re.sub(r"^import unittest\s*$", "", source, flags=re.MULTILINE)

    # Rewrite _test_all to use subTest for per-case reporting
    source = source.replace(
        """    def _test_all(self, func, cases):
        for input_, expect in cases:
            output = func(input_)
            msg = self.MESSAGE_FMT.format(input_, expect, output)
            self.assertEqual(output, expect, msg)""",
        """    def _test_all(self, func, cases):
        for input_, expect in cases:
            with self.subTest(input=input_, expected=expect):
                output = func(input_)
                msg = self.MESSAGE_FMT.format(input_, expect, output)
                self.assertEqual(output, expect, msg)"""
    )

    return source.strip()


def extract_test_methods(filepath):
    """Parse a test file and extract test class/method info using AST.

    Returns a list of dicts:
      [{"class_name": "TestExercise3", "method_name": "test_ex3_0",
        "is_skipped": False, "source_lines": (start, end)}]
    """
    with open(filepath, "r", encoding="utf-8") as f:
        source = f.read()

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError:
        print(f"Warning: SyntaxError parsing {filepath}, skipping.")
        return [], source

    methods = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            class_name = node.name
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name.startswith(
                    "test_"
                ):
                    # Check for @unittest.skip decorator
                    is_skipped = False
                    for decorator in item.decorator_list:
                        if isinstance(decorator, ast.Attribute):
                            if decorator.attr == "skip":
                                is_skipped = True
                        elif isinstance(decorator, ast.Name):
                            if decorator.id == "skip":
                                is_skipped = True

                    methods.append(
                        {
                            "class_name": class_name,
                            "method_name": item.name,
                            "is_skipped": is_skipped,
                            "lineno": item.lineno,
                            "end_lineno": getattr(item, "end_lineno", None),
                        }
                    )

    return methods, source


def method_name_to_exercise_file(method_name):
    """Convert a test method name to an exercise filename.

    e.g. 'test_ex3_0' -> 'ex3_0.py'
         'test_ex35_1' -> 'ex35_1.py'
         'test_ex69_1' -> 'ex69_1.py'
    """
    # Strip leading 'test_'
    ex_name = method_name[5:]  # remove 'test_'
    return f"{ex_name}.py"


def adapt_test_source(source, base_class_code):
    """Transform test file source code for browser Pyodide execution.

    - Replace 'from tests.base import TestExercise' -> inline base class
    - Replace 'import exercises.X as X' -> 'import X'
    - Remove 'if __name__' blocks
    - Remove standalone 'import unittest' (we prepend it)
    """
    # Remove 'from tests.base import TestExercise'
    adapted = re.sub(
        r"^from tests\.base import TestExercise\s*$",
        "",
        source,
        flags=re.MULTILINE,
    )

    # Transform 'import exercises.ex3_0 as ex3_0' -> 'import ex3_0'
    adapted = re.sub(
        r"^import exercises\.(\w+) as (\w+)\s*$",
        r"import \1 as \2",
        adapted,
        flags=re.MULTILINE,
    )

    # Remove standalone 'import unittest' (we'll prepend it)
    adapted = re.sub(r"^import unittest\s*$", "", adapted, flags=re.MULTILINE)

    # Remove 'if __name__ == "__main__":' block at the end
    adapted = re.sub(
        r'\nif __name__\s*==\s*["\']__main__["\']\s*:\s*\n\s*unittest\.main\(\)\s*$',
        "",
        adapted,
    )

    # Remove 'import sys' and sys.path hacks (from test_ex8.py)
    adapted = re.sub(
        r"^# hack path for importing.*$", "", adapted, flags=re.MULTILINE
    )
    adapted = re.sub(
        r"^sys\.path\.insert\(.*\).*# NOQA\s*$",
        "",
        adapted,
        flags=re.MULTILINE,
    )

    # Build final adapted source
    final = f"import unittest\n\n{base_class_code}\n\n{adapted}"

    # Clean up excessive blank lines
    final = re.sub(r"\n{4,}", "\n\n\n", final)

    return final


def check_method_compatibility(source, method_name, class_name):
    """Check if a specific test method uses browser-incompatible operations.

    We extract the method body text and check for incompatible patterns.
    """
    # Find the method body in the source
    # Use a regex pattern to find the method definition and its body
    pattern = rf"def {re.escape(method_name)}\(self\):"
    match = re.search(pattern, source)
    if not match:
        return True, None  # Can't find method, assume compatible

    # Get text from method start to the next 'def ' or class end
    start = match.start()
    rest = source[start:]

    # Find next method or class definition
    next_def = re.search(r"\n    def |\nclass |\Z", rest[1:])
    if next_def:
        method_body = rest[: next_def.start() + 1]
    else:
        method_body = rest

    # Check for incompatible patterns
    for marker in INCOMPATIBLE_MARKERS:
        if marker in method_body:
            return False, f"Uses incompatible operation: {marker}"

    return True, None


def build_test_registry(workspace_files):
    """Scan pyfml/tests/ and generate the test registry.

    Returns a dict mapping exercise filenames to test metadata.
    """
    base_class_code = read_base_class()
    if base_class_code is None:
        return {}

    test_files = sorted(glob.glob(os.path.join("pyfml", "tests", "test_ex*.py")))

    if not test_files:
        print("Warning: No test files found in pyfml/tests/")
        return {}

    registry = {}

    abs_tests_dir = os.path.abspath(os.path.join("pyfml", "tests"))

    for test_file in test_files:
        # Defense-in-depth: skip symlinks and validate path stays within tests/
        if os.path.islink(test_file):
            continue
        abs_test = os.path.abspath(test_file)
        if not abs_test.startswith(abs_tests_dir + os.sep):
            continue

        methods, raw_source = extract_test_methods(test_file)

        if not methods:
            continue

        # Adapt the full test source once per file
        adapted_source = adapt_test_source(raw_source, base_class_code)

        for method_info in methods:
            exercise_file = method_name_to_exercise_file(method_info["method_name"])

            # Skip if this exercise isn't in our workspace
            if exercise_file not in workspace_files:
                continue

            # Determine skip status
            skip = method_info["is_skipped"]
            skip_reason = "Skipped by @unittest.skip decorator" if skip else None

            # Check browser compatibility if not already skipped
            if not skip:
                compatible, reason = check_method_compatibility(
                    raw_source,
                    method_info["method_name"],
                    method_info["class_name"],
                )
                if not compatible:
                    skip = True
                    skip_reason = f"Browser incompatible: {reason}"

            registry[exercise_file] = {
                "testClass": method_info["class_name"],
                "testMethod": method_info["method_name"],
                "testCode": adapted_source,
                "sourceFile": os.path.basename(test_file),
                "skip": skip,
                "skipReason": skip_reason,
            }

    return registry


def main():
    # Phase 1: Build workspace.json
    workspace = build_workspace()

    # Phase 2: Build tests.json
    registry = build_test_registry(workspace)

    with open("tests.json", "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)

    # Report summary
    total = len(registry)
    skipped = sum(1 for v in registry.values() if v["skip"])
    runnable = total - skipped

    print(f"Generated tests.json with {total} test entries:")
    print(f"  ✅ Runnable: {runnable}")
    print(f"  ⏭️  Skipped:  {skipped}")

    if skipped > 0:
        print("\nSkipped tests:")
        for ex_file, entry in sorted(registry.items()):
            if entry["skip"]:
                print(f"  - {ex_file}: {entry['skipReason']}")


if __name__ == "__main__":
    main()
