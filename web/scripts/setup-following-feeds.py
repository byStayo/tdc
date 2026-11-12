#!/usr/bin/env python3
"""Store read-only social feed credentials locally without printing them."""

import argparse
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import warnings


def require_private(info, *, directory=False):
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    expected_mode = 0o700 if directory else 0o600
    if not valid_type or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != expected_mode:
        raise ValueError("The configuration directory and files must be owner-only (0700 and 0600).")


def save_config(directory, platform, credentials):
    directory.mkdir(mode=0o700, exist_ok=True)
    require_private(directory.lstat(), directory=True)
    destination = directory / "following-config.json"
    lock_path = directory / "following-config.lock"
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600), "r+") as lock:
        require_private(os.fstat(lock.fileno()))
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            descriptor = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            config = {}
        else:
            with os.fdopen(descriptor, "rb") as source:
                require_private(os.fstat(source.fileno()))
                raw = source.read(8193)
                if len(raw) > 8192:
                    raise ValueError("Existing configuration exceeds the publisher limit.")
                try:
                    config = json.loads(raw)
                except (UnicodeError, ValueError):
                    raise ValueError("Existing configuration is invalid JSON.") from None
                if not isinstance(config, dict):
                    raise ValueError("Existing configuration is not an object.")
        config[platform] = credentials
        data = (json.dumps(config, indent=2) + "\n").encode()
        if len(data) > 8192:
            raise ValueError("Combined configuration exceeds the publisher limit.")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, prefix=".following-setup-", delete=False) as target:
                temporary = Path(target.name)
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, destination)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def enter(label, pattern, secret=False):
    value = (getpass.getpass(label) if secret else input(label)).strip()
    if not re.fullmatch(pattern, value):
        raise ValueError("Invalid " + label.partition(":")[0] + ". Setup was stopped.")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=("x", "x-public", "instagram"))
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Open an interactive Terminal to enter credentials privately.", file=sys.stderr)
        return 2

    print("Paste only developer credentials into the hidden prompts. Login passwords are entered on the platform itself.")
    key = r"[!-~]{1,2048}"
    number = r"[0-9]{1,25}"
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            if args.platform == "x":
                credentials = {
                    "userId": enter("X numeric user ID: ", number),
                    "apiKey": enter("OAuth 1.0a app API key: ", key, secret=True),
                    "apiSecret": enter("OAuth 1.0a app API key secret: ", key, secret=True),
                    "accessToken": enter("Read-only user access token: ", key, secret=True),
                    "accessSecret": enter("Read-only user access token secret: ", key, secret=True),
                }
            elif args.platform == "x-public":
                credentials = {"bearerToken": enter("X app bearer token: ", key, secret=True)}
            else:
                credentials = {
                    "graphVersion": enter("Meta Graph API version (vNN.0): ", r"v[0-9]{1,2}\.0"),
                    "accountId": enter("Linked Instagram professional account ID: ", number),
                    "token": enter("Meta user access token: ", key, secret=True),
                }
                handles = [item.strip().lower().removeprefix("@") for item in input(
                    "Public professional Instagram handles, comma-separated: "
                ).split(",")]
                if not 1 <= len(handles) <= 20 or len(set(handles)) != len(handles) or any(
                    not re.fullmatch(r"[a-z0-9._]{1,30}", handle) for handle in handles
                ):
                    raise ValueError("Enter 1–20 distinct public professional account handles.")
                credentials["handles"] = handles
        section = "xPublic" if args.platform == "x-public" else args.platform
        save_config(Path(__file__).resolve().parents[1] / ".editorial", section, credentials)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    except (OSError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print("Setup stopped. Check the private directory and interactive Terminal.", file=sys.stderr)
        return 2
    print("Saved the local credentials. The platform API has not been called.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
