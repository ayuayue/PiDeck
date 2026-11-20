"""Select the application identity before packaging a stable or dev release."""

import argparse
import re
from pathlib import Path


def profile(text: str, version: str) -> str:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("release version must be semantic")
    if not re.search(r"-dev(?:\.|$)", version):
        return text
    replacements = {
        "name: PiDeck Lite\n": "name: PiDeck Lite Dev\n",
        "id: dev.nsgo.pidecklite\n": "id: dev.nsgo.pidecklite.dev\n",
        "[pideck-lite]": "[pideck-lite-dev]",
        "/releases/latest/download/": "/releases/download/dev/",
    }
    for before, after in replacements.items():
        if text.count(before) != 1:
            raise ValueError(f"expected one stable profile marker: {before!r}")
        text = text.replace(before, after, 1)
    return text


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--config", type=Path, default=Path("nsgo.yaml"))
    args = parser.parse_args()
    args.config.write_text(profile(args.config.read_text(encoding="utf-8"), args.version), encoding="utf-8", newline="\n")
