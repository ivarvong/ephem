#!/usr/bin/env python3
"""bounded.py <seconds> <label> <cmd> [args…]: run cmd with a deadline (scripts/deploy.sh wraps every cf step in it).

stdin/stdout/stderr pass through, so `out=$(bounded.py …)` captures as before; the exit code is cmd's. On the deadline it
prints what is still running in cmd's process group (the hung child, e.g. a wedged `docker image ls` under wrangler's
build), kills the whole group (TERM, then KILL after 3 s) and exits 124 with `TIMEOUT <label>`. Added 2026-10-31 after
three ship attempts sat 5-6 min at "deploy ephem-load" with no message (scripts/docker-bounded.sh has the cause).
"""

import os
import signal
import subprocess
import sys

secs, label, cmd = float(sys.argv[1]), sys.argv[2], sys.argv[3:]
p = subprocess.Popen(cmd, start_new_session=True)
try:
    sys.exit(p.wait(timeout=secs))
except subprocess.TimeoutExpired:
    pids = subprocess.run(["pgrep", "-g", str(p.pid)], capture_output=True, text=True).stdout.split()
    ps = (
        subprocess.run(
            ["ps", "-o", "pid,etime,stat,command", "-p", ",".join(pids)], capture_output=True, text=True
        ).stdout
        if pids
        else "(none)"
    )
    print(
        f"TIMEOUT {label}: no exit after {secs:g}s; still running in its process group:\n"
        + "\n".join("  " + l[:200] for l in ps.splitlines()),
        file=sys.stderr,
    )
    for sig, wait in ((signal.SIGTERM, 3), (signal.SIGKILL, 3)):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            break
        try:
            p.wait(timeout=wait)
            break
        except subprocess.TimeoutExpired:
            pass
    sys.exit(124)
except KeyboardInterrupt:
    os.killpg(p.pid, signal.SIGTERM)
    sys.exit(130)
