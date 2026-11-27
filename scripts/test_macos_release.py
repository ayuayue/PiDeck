import base64
import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import macos_release


TEAM = "ABCDE12345"
FINGERPRINT = "A" * 40
IDENTITY = f'  1) {FINGERPRINT} "Developer ID Application: PiDeck ({TEAM})"\n     1 valid identities found\n'
ENV = {
    "MAC_CSC_LINK": base64.b64encode(b"test-p12").decode(),
    "MAC_CSC_KEY_PASSWORD": "test-certificate-password",
    "APPLE_ID": "build@example.invalid",
    "APPLE_APP_SPECIFIC_PASSWORD": "test-notary-password",
    "APPLE_TEAM_ID": TEAM,
    "NSGO_UPDATES_KEY": "test-update-key",
}
DISPLAY = f"Identifier=dev.nsgo.pideckv2\nTeamIdentifier={TEAM}\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=1\n"


class MacOSReleaseTests(unittest.TestCase):
    def test_identity_requires_valid_developer_id_and_matching_team(self):
        self.assertEqual(macos_release.signing_identity(IDENTITY, TEAM, ""), FINGERPRINT)
        self.assertEqual(macos_release.signing_identity(IDENTITY, TEAM, "PiDeck"), FINGERPRINT)
        self.assertEqual(macos_release.signing_identity(IDENTITY, TEAM, FINGERPRINT.lower()), FINGERPRINT)
        for output in (
            IDENTITY.replace(TEAM, "OTHER12345"),
            IDENTITY.replace("Developer ID Application:", "Apple Development:"),
            "0 valid identities found",
        ):
            with self.subTest(output=output), self.assertRaisesRegex(RuntimeError, "exactly one valid"):
                macos_release.signing_identity(output, TEAM, "")

    def test_ambiguous_identity_requires_a_name_or_fingerprint(self):
        second = f'  2) {"B" * 40} "Developer ID Application: Another ({TEAM})"\n'
        with self.assertRaisesRegex(RuntimeError, "exactly one valid"):
            macos_release.signing_identity(IDENTITY + second, TEAM, "")
        self.assertEqual(macos_release.signing_identity(IDENTITY + second, TEAM, "PiDeck"), FINGERPRINT)

    def test_missing_credentials_stop_before_keychain_or_build(self):
        for key in ENV:
            if key == "MAC_CSC_KEY_PASSWORD":  # A p12 may have an empty password.
                continue
            env = ENV.copy()
            env.pop(key)
            with self.subTest(key=key), patch.dict(os.environ, env, clear=True), patch.object(macos_release, "run") as run:
                with self.assertRaisesRegex(RuntimeError, key):
                    macos_release.release("macos_arm64", "2.0.1")
                run.assert_not_called()

    def test_invalid_team_and_certificate_stop_before_keychain_or_build(self):
        for extra, message in (
            ({"APPLE_TEAM_ID": "invalid"}, "Team ID"),
            ({"PIDECK_MAC_TEAM_ID": "OTHER12345"}, "Team ID"),
            ({"MAC_CSC_LINK": "https://example.invalid/certificate.p12"}, "base64-encoded"),
        ):
            with self.subTest(extra=extra), patch.dict(os.environ, {**ENV, **extra}, clear=True), patch.object(macos_release, "run") as run:
                with self.assertRaisesRegex(RuntimeError, message):
                    macos_release.release("macos_x64", "2.0.1")
                run.assert_not_called()

    def test_command_errors_do_not_expose_credentials_or_tool_output(self):
        args = ("security", "import", "certificate.p12", "-P", ENV["MAC_CSC_KEY_PASSWORD"])
        for error, message in (
            (subprocess.CalledProcessError(1, args, output=ENV["MAC_CSC_KEY_PASSWORD"]), "exit 1"),
            (subprocess.TimeoutExpired(args, 60, output=ENV["MAC_CSC_KEY_PASSWORD"]), "timed out"),
        ):
            with self.subTest(error=type(error).__name__), patch.object(subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, message) as raised:
                    macos_release.run(*args)
                self.assertNotIn(ENV["MAC_CSC_KEY_PASSWORD"], str(raised.exception))
                self.assertNotIn("certificate.p12", str(raised.exception))

    def release_case(self, target="macos_arm64", version="2.0.1", failure="", missing_dmg=False):
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous = Path.cwd()
            app = root / "dist" / f"PiDeck V2-{version}-{target}" / "PiDeck V2.app"
            dmg = root / "dist" / "releases" / f"pideck-v2-{version}-{target.replace('_', '-')}.dmg"

            def command(*args, **kwargs):
                calls.append(args)
                if args[:2] == ("security", "default-keychain") and "-s" not in args:
                    return '"/Library/Keychains/login keychain-db"\n'
                if args[:2] == ("security", "list-keychains") and "-s" not in args:
                    return '"/Library/Keychains/login keychain-db"\n"/Library/Keychains/other.keychain-db"\n'
                if args[:2] == ("security", "find-identity"):
                    return IDENTITY
                if args[:2] == ("security", "import"):
                    cert = Path(args[2])
                    self.assertEqual(cert.read_bytes(), b"test-p12")
                failure_prefixes = {
                    "import": ("security", "import"),
                    "notary": ("xcrun", "notarytool", "store-credentials"),
                    "build": ("go", "tool"),
                    "verify": ("codesign", "--verify"),
                    "stapler": ("xcrun", "stapler", "validate"),
                    "gatekeeper": ("spctl", "--assess"),
                }
                prefix = failure_prefixes.get(failure)
                if prefix and args[:len(prefix)] == prefix:
                    raise RuntimeError(f"{failure} failed")
                if failure == "cleanup" and args[:6] == ("security", "default-keychain", "-d", "user", "-s", "/Library/Keychains/login keychain-db"):
                    raise RuntimeError("restore failed")
                if args[:2] == ("go", "tool"):
                    (app / "Contents").mkdir(parents=True)
                    with (app / "Contents" / "Info.plist").open("wb") as output:
                        plistlib.dump({"CFBundleIdentifier": "dev.nsgo.pideckv2"}, output)
                    if not missing_dmg:
                        dmg.parent.mkdir(parents=True)
                        dmg.touch()
                if args[:2] == ("codesign", "-dv"):
                    return DISPLAY
                return ""

            try:
                os.chdir(root)
                with patch.dict(os.environ, {**ENV, "RUNNER_TEMP": temporary}, clear=True), patch.object(macos_release, "run", side_effect=command):
                    if failure or missing_dmg:
                        message = f"{failure} failed" if failure else "exactly one macOS app and DMG"
                        if failure == "cleanup":
                            message = "could not completely restore"
                        with self.assertRaisesRegex(RuntimeError, message):
                            macos_release.release(target, version)
                    else:
                        macos_release.release(target, version)
                self.assertEqual(calls[-3][:6], ("security", "default-keychain", "-d", "user", "-s", "/Library/Keychains/login keychain-db"))
                self.assertEqual(calls[-2], ("security", "list-keychains", "-d", "user", "-s", "/Library/Keychains/login keychain-db", "/Library/Keychains/other.keychain-db"))
                self.assertEqual(calls[-1][:2], ("security", "delete-keychain"))
                self.assertFalse(Path(calls[-1][2]).parent.exists(), "temporary signing files must be removed")
            finally:
                os.chdir(previous)
        return calls

    def test_both_architectures_sign_notarize_and_verify_requested_version(self):
        for target, version in (("macos_arm64", "2.0.1"), ("macos_x64", "2.1.0-dev.1")):
            with self.subTest(target=target):
                calls = self.release_case(target, version)
                build = next(args for args in calls if args[:2] == ("go", "tool"))
                self.assertEqual(build, ("go", "tool", "nsgo", "build", "-target", target, "-version", version, "-sign", FINGERPRINT, "-notarize", "pideck-v2-release"))
                default = next(args[-1] for args in calls if args[:5] == ("security", "default-keychain", "-d", "user", "-s"))
                notary = next(args for args in calls if args[:3] == ("xcrun", "notarytool", "store-credentials"))
                self.assertEqual(notary[notary.index("--keychain") + 1], default)
                self.assertEqual(sum(args[:3] == ("xcrun", "stapler", "validate") for args in calls), 2)
                self.assertEqual(sum(args[:2] == ("spctl", "--assess") for args in calls), 2)

    def test_failures_restore_keychains_and_remove_certificate(self):
        for failure in ("import", "notary", "build", "verify", "stapler", "gatekeeper"):
            with self.subTest(failure=failure):
                self.release_case(failure=failure)

    def test_cleanup_failure_is_reported_and_remaining_cleanup_still_runs(self):
        self.release_case(failure="cleanup")

    def test_missing_packaged_dmg_is_a_release_failure(self):
        self.release_case(missing_dmg=True)

    def test_verification_rejects_bundle_identifier_team_and_runtime_mismatches(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "PiDeck V2.app"
            (app / "Contents").mkdir(parents=True)
            with (app / "Contents" / "Info.plist").open("wb") as output:
                plistlib.dump({"CFBundleIdentifier": "dev.nsgo.pideckv2"}, output)
            for display, message in (
                (DISPLAY.replace("Identifier=dev.nsgo.pideckv2", "Identifier=wrong"), "CFBundleIdentifier"),
                (DISPLAY.replace(TEAM, "OTHER12345"), "Team and hardened runtime"),
                (DISPLAY.replace("0x10000(runtime)", "0x0(none)"), "Team and hardened runtime"),
            ):
                with self.subTest(display=display), patch.object(macos_release, "run", side_effect=lambda *args: display if args[:2] == ("codesign", "-dv") else ""):
                    with self.assertRaisesRegex(RuntimeError, message):
                        macos_release.verify(app, Path(temporary) / "release.dmg", TEAM)


if __name__ == "__main__":
    unittest.main()
