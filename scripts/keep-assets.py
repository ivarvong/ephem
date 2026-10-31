#!/usr/bin/env python3
"""keep-assets.py <base url> <assets dir>: carry the live version's static assets into this build, so a page that the live
version served keeps working after this deploy replaces it (its lazily loaded core module and its fonts are fetched after
load, by their content-hashed URLs; Workers Static Assets serves only the files the active version uploaded).

Reads <base>/ephem-assets.json (the live version's own file list, written by scripts/build-web.ts), downloads every file this
build lacks into <assets dir> and prints what it carried. Only the previous version's own files are carried (its list names
its own build, not what it carried), so old files age out after one deploy. Best effort: a failure is printed and skipped
(the page then falls back: the API answers, the system font shows; Under the hood says why). deploy.sh runs it after the
web build, before the upload and the gate."""

import json
import os
import sys
import urllib.request

base, out = sys.argv[1].rstrip("/"), sys.argv[2]


def get(path):
    req = urllib.request.Request(base + path, headers={"user-agent": "ephem-deploy keep-assets"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.read()


try:
    st, body = get("/ephem-assets.json")
    files = json.loads(body)["files"]
except Exception as e:
    print(f"keep-assets: no live asset list ({e}); nothing carried")
    sys.exit(0)
carried, failed = [], []
for f in files:
    if not f.startswith("/assets/") or "/" in f[len("/assets/") :] or ".." in f:
        continue
    dest = os.path.join(out, f.lstrip("/"))
    if os.path.exists(dest):
        continue
    try:
        st, data = get(f)
        if st != 200 or not data:
            raise RuntimeError(f"status {st}")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)
        carried.append(f"{f} ({len(data)} B)")
    except Exception as e:
        failed.append(f"{f}: {e}")
print(
    f"keep-assets: {len(files)} live files, carried {len(carried)}: {', '.join(carried) or 'none'}"
    + (f"; FAILED {len(failed)}: {'; '.join(failed)}" if failed else "")
)
