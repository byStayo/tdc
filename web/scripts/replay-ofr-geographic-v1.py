"""Run the registered OFR evaluator with its original price reader and the current publication ledger."""
from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
from shutil import copyfile
from subprocess import run
from tempfile import TemporaryDirectory
import json
import os

WEB = Path(__file__).resolve().parents[1]
STUDY = "scripts/research-ofr-geographic.ts"
PRICE = "lib/consensus/research-price-capture.ts"
REGISTRATION = "scripts/ofr-geographic-scoring-lock.json"


def replay(node, study_dir, price_root):
    # Node normally resolves the real location of a symlinked module. Copy the
    # registered entry and reader so their relative paths resolve in this view.
    manifest = json.loads((WEB / REGISTRATION).read_bytes())
    files = {STUDY: WEB / STUDY, PRICE: WEB / "lib/consensus/research-price-capture-ofr-v1.ts"}
    with TemporaryDirectory(prefix="ofr-geographic-v1-") as temp:
        root = Path(temp)
        for rel, source in files.items():
            if sha256(source.read_bytes()).hexdigest() != manifest["sourceCodeSHA256"][rel]:
                raise ValueError("Changed registered OFR implementation: " + rel)
            dest = root / rel
            dest.parent.mkdir(mode=0o700, exist_ok=True, parents=True)
            copyfile(source, dest)
        # All remaining prerequisites, including the current archive and transaction
        # guard, come from the real checkout. No prices or snapshots are duplicated.
        for folder in ["", "lib", "lib/consensus", "scripts"]:
            for entry in (WEB / folder).iterdir():
                target = root / folder / entry.name
                if not target.exists() and not target.is_symlink():
                    if not folder and entry.name not in {"package.json","public",".consensus","node_modules"}:
                        continue
                    target.symlink_to(entry, target_is_directory=entry.is_dir())
        run([node, "--disable-warning=ExperimentalWarning", root / STUDY,
             study_dir.resolve(), price_root.resolve(), "--replay"], check=True)


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("study_dir", type=Path)
    parser.add_argument("price_root", type=Path)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    os.umask(0o077)
    replay(args.node, args.study_dir, args.price_root)
