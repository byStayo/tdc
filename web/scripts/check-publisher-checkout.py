"""Read the publisher's local and advertised remote revisions without moving either branch."""
import os
import subprocess
import sys

WORK_BRANCH = "codex/daily-consensus-polish"
REMOTE_BRANCH = "refs/heads/codex/daily-consensus-relaunch"


def git(*args):
    result = subprocess.run(
        ["/usr/bin/git", *args], text=True, capture_output=True, timeout=20,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"},
    )
    if result.returncode:
        message = result.stderr.strip().splitlines()
        raise ValueError(message[-1][:250] if message else "Git returned " + str(result.returncode))
    return result.stdout.strip()


def verify():
    branch = git("branch", "--show-current")
    if branch != WORK_BRANCH:
        raise ValueError(f"expected {WORK_BRANCH}, found {branch or 'detached HEAD'}")
    changes = git("status", "--porcelain")
    if changes:
        raise ValueError("uncommitted work: " + " | ".join(changes.splitlines()[:4]))
    if git("config", "--get", f"branch.{branch}.remote") != "origin" or git("config", "--get", f"branch.{branch}.merge") != REMOTE_BRANCH:
        raise ValueError("branch tracking does not point to origin/" + REMOTE_BRANCH.removeprefix("refs/heads/"))
    head, tracking = git("rev-parse", "HEAD"), git("rev-parse", "@{upstream}")
    if head != tracking:
        raise ValueError(f"local {head} differs from its tracking ref {tracking}")
    advertised = git("ls-remote", "--exit-code", "--refs", "origin", REMOTE_BRANCH).split()
    if len(advertised) != 2 or advertised[1] != REMOTE_BRANCH:
        raise ValueError("origin did not advertise the expected publication branch")
    if advertised[0] != head:
        raise ValueError(f"origin advertises {advertised[0]} while the local checkout is {head}")
    print("Verified clean publishing branch at " + head)


if __name__ == "__main__":
    try:
        verify()
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print("Publisher preflight failed: " + str(error), file=sys.stderr)
        sys.exit(2)
