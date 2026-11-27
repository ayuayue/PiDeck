"""Build and verify a notarized NSGo macOS release using the Electron CI credentials."""

import argparse
import base64
import binascii
import os
import plistlib
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path


DEVELOPER_ID = (
    "anchor apple generic and "
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
)


def run(*args: str, stream: bool = False, timeout: int = 60) -> str:
    try:
        result = subprocess.run(
            args, check=True, text=True, timeout=timeout,
            stdout=None if stream else subprocess.PIPE,
            stderr=None if stream else subprocess.STDOUT,
        )
        return result.stdout or ""
    except subprocess.CalledProcessError as error:
        # Keychain and notary commands include passwords; never print their arguments or output.
        raise RuntimeError(f"{args[0]} {args[1]} failed (exit {error.returncode})") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{args[0]} {args[1]} timed out") from None


def signing_identity(output: str, team: str, name: str) -> str:
    identities = re.findall(r'^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"', output, re.MULTILINE)
    matches = {
        fingerprint.upper() for fingerprint, identity in identities
        if identity.startswith("Developer ID Application: ") and identity.endswith(f" ({team})")
        and (not name or name in identity or name.upper() == fingerprint.upper())
    }
    if len(matches) != 1:
        raise RuntimeError("expected exactly one valid Developer ID Application identity for the configured Team; check MAC_CSC_LINK / MAC_CSC_NAME")
    return matches.pop()


def verify(app: Path, dmg: Path, team: str) -> None:
    requirement = f'{DEVELOPER_ID} and certificate leaf[subject.OU] = "{team}"'
    run("codesign", "--verify", "--deep", "--strict", f"-R={requirement}", str(app))
    display = run("codesign", "-dv", "--verbose=4", str(app))
    with (app / "Contents" / "Info.plist").open("rb") as source:
        bundle_id = plistlib.load(source).get("CFBundleIdentifier")
    if not bundle_id or f"Identifier={bundle_id}" not in display.splitlines():
        raise RuntimeError("macOS signature identifier must match the app's CFBundleIdentifier")
    if f"TeamIdentifier={team}" not in display.splitlines() or not re.search(r"flags=.*\bruntime\b", display):
        raise RuntimeError("macOS release must use the configured Team and hardened runtime")
    run("xcrun", "stapler", "validate", str(app))
    run("spctl", "--assess", "--type", "execute", str(app))
    run("codesign", "--verify", "--strict", f"-R={requirement}", str(dmg))
    run("xcrun", "stapler", "validate", str(dmg))
    run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", str(dmg))


def release(target: str, version: str) -> None:
    required = ("MAC_CSC_LINK", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "NSGO_UPDATES_KEY")
    missing = [key for key in required if not os.environ.get(key, "").strip()]
    if missing:
        raise RuntimeError("macOS release requires repository Secrets: " + ", ".join(missing))
    team = os.environ["APPLE_TEAM_ID"].strip()
    pinned_team = os.environ.get("PIDECK_MAC_TEAM_ID", "").strip() or team
    if not re.fullmatch(r"[A-Z0-9]{10}", team) or pinned_team != team:
        raise RuntimeError("APPLE_TEAM_ID must be a 10-character Team ID matching MAC_TEAM_ID when configured")
    try:
        certificate = base64.b64decode("".join(os.environ["MAC_CSC_LINK"].split()), validate=True)
    except (ValueError, binascii.Error):
        raise RuntimeError("MAC_CSC_LINK must contain a base64-encoded .p12 certificate with its private key") from None

    previous_default = shlex.split(run("security", "default-keychain", "-d", "user"))
    previous_search = shlex.split(run("security", "list-keychains", "-d", "user"))
    if len(previous_default) != 1:
        raise RuntimeError("could not identify the runner's default keychain")
    with tempfile.TemporaryDirectory(prefix="pideck-macos-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
        cert = Path(temporary) / "signing.p12"
        cert.write_bytes(certificate)
        cert.chmod(0o600)
        keychain = str(Path(temporary) / "signing.keychain-db")
        password = secrets.token_hex(24)
        run("security", "create-keychain", "-p", password, keychain)
        try:
            run("security", "set-keychain-settings", "-lut", "21600", keychain)
            run("security", "unlock-keychain", "-p", password, keychain)
            run("security", "list-keychains", "-d", "user", "-s", keychain, *previous_search)
            # NSGo passes only --keychain-profile to notarytool, which uses the default keychain.
            run("security", "default-keychain", "-d", "user", "-s", keychain)
            run("security", "import", str(cert), "-k", keychain, "-P", os.environ.get("MAC_CSC_KEY_PASSWORD", ""), "-T", "/usr/bin/codesign")
            run("security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain)
            identity = signing_identity(
                run("security", "find-identity", "-v", "-p", "codesigning", keychain),
                team, os.environ.get("MAC_CSC_NAME", "").strip(),
            )
            run("xcrun", "notarytool", "store-credentials", "pideck-v2-release", "--keychain", keychain,
                "--apple-id", os.environ["APPLE_ID"], "--team-id", team,
                "--password", os.environ["APPLE_APP_SPECIFIC_PASSWORD"], timeout=180)
            run("go", "tool", "nsgo", "build", "-target", target, "-version", version,
                "-sign", identity, "-notarize", "pideck-v2-release", stream=True, timeout=1800)
            apps = list(Path("dist").glob(f"*-{version}-{target}/*.app"))
            dmgs = list(Path("dist/releases").glob(f"*-{version}-{target.replace('_', '-')}.dmg"))
            if len(apps) != 1 or len(dmgs) != 1:
                raise RuntimeError("expected exactly one macOS app and DMG for the requested target and version")
            verify(apps[0], dmgs[0], team)
        finally:
            failures = []
            for args in (
                ("security", "default-keychain", "-d", "user", "-s", previous_default[0]),
                ("security", "list-keychains", "-d", "user", "-s", *previous_search),
                ("security", "delete-keychain", keychain),
            ):
                try:
                    run(*args)
                except (RuntimeError, OSError) as error:
                    failures.append(type(error).__name__)
            if failures:
                raise RuntimeError("could not completely restore and remove the temporary signing keychain")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("macos_arm64", "macos_x64"), required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    try:
        release(args.target, args.version)
    except (RuntimeError, OSError) as error:
        message = error.strerror if isinstance(error, OSError) else str(error)
        print(f"::error::{message}", file=sys.stderr)
        sys.exit(1)
