#!/usr/bin/env python3
"""Save FINRA credentials for this Mac's publisher; no network requests."""
import argparse
import getpass
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import warnings


class SetupError(Exception):
    pass


def valid_credentials(client_id, client_secret):
    return (
        isinstance(client_id, str) and isinstance(client_secret, str)
        and bool(client_id.strip()) and bool(client_secret.strip())
        and len(client_id) <= 4096 and len(client_secret) <= 4096
        and not any(c in client_id for c in ":\r\n\0")
        and not any(c in client_secret for c in "\r\n\0")
    )


def require_private(info, directory=False):
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not expected or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SetupError("The credential location must be owned by you and accessible only to you.")
    if not directory and info.st_nlink != 1:
        raise SetupError("The credential file must not be linked to another location.")


def save_credentials(path, client_id, client_secret, replace=False):
    if not valid_credentials(client_id, client_secret):
        raise SetupError("The credential values are empty or invalid. Nothing was saved.")
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require_private(path.parent.lstat(), directory=True)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = ".finra-" + secrets.token_hex(12) + ".tmp"
    try:
        require_private(os.fstat(directory), directory=True)
        try:
            existing = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            require_private(existing)
            if not replace:
                raise SetupError("Credentials already exist. Use --replace only when intentionally rotating them.")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump({"clientId": client_id, "clientSecret": client_secret}, output)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        else:
            # A same-directory link installs atomically without overwriting a concurrent setup.
            os.link(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace", action="store_true", help="replace an existing private credential when rotating it")
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Run this command yourself in Terminal. Piped or logged credential input is refused.", file=sys.stderr)
        return 2
    print("Use the activated Public ($0/month) FINRA API credential, not your Gateway login.")
    print("Both values are hidden as you type or paste. This command does not contact FINRA.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            client_id = getpass.getpass("FINRA API Client ID (hidden): ")
            client_secret = getpass.getpass("FINRA API Client Secret (hidden): ")
            confirmation = getpass.getpass("Confirm API Client Secret (hidden): ")
        if client_secret != confirmation:
            raise SetupError("The secrets did not match. Nothing was saved.")
        path = Path.home() / ".config/the-daily-consensus/finra.json"
        save_credentials(path, client_id, client_secret, args.replace)
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 2
    except (OSError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print("Setup stopped. No credential values were printed. Check that Terminal is interactive and the local credential folder is private.", file=sys.stderr)
        return 2
    print("Saved privately for the local publisher (folder 0700, file 0600), outside Git and Vercel.")
    print("Setup is saved; FINRA access has not been tested. You can tell Codex 'FINRA configured'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
