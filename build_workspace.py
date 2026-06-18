import glob
import json
import os


def main():
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


if __name__ == "__main__":
    main()
