"""Basin request logs: resource status, send-failure counts, provisioning, canned Basin SQL, and the o11y cross-check.

    python3 scripts/obs/basin.py status                       # streams, sinks, pipelines, catalog, token present?
    python3 scripts/obs/basin.py failures [--minutes 60]      # basin_send_failed / request_log_failed lines (ephem, ephem-tail)
    python3 scripts/obs/basin.py provision                    # sinks + pipelines + catalog credential (needs the R2 admin token)
    python3 scripts/obs/basin.py sql <name> [--hours 1]       # a canned query (see QUERIES), or: sql --raw "SELECT ..."
    python3 scripts/obs/basin.py crosscheck --from <iso> --to <iso>   # Basin rows vs Workers Observability invocations
    python3 scripts/obs/basin.py types                        # regenerate packages/worker/src/basin.generated.ts (wrangler types)

The R2 Account API token (Admin Read & Write) is read from ~/.config/ephem/r2-admin-token and only ever passed on stdin or in
the child's environment (WRANGLER_BASIN_SQL_AUTH_TOKEN); it is never printed, logged or written anywhere.
"""
import argparse, collections, json, os, re, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from telemetry import eq, events  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
OPS = os.path.join(ROOT, "packages/worker/ops/basin")
ACCOUNT = "5ad2236b39de4c8bd8f6270ea63f3ea9"
BUCKET = "ephem-logs"
WAREHOUSE = f"{ACCOUNT}_{BUCKET}"
NAMESPACE = "ephem"
TOKEN_FILE = os.path.expanduser("~/.config/ephem/r2-admin-token")
# stream name → (stream id, Iceberg table, sink name, pipeline name, schema file)
STREAMS = {
    "ephem_requests": ("d43e9589a2784812afda39033b6792eb", "requests", "ephem_requests_sink", "ephem_requests_pipeline", "requests.schema.json"),
    "ephem_invocations": ("2d45db937f214e5cae5c19ba4c099779", "invocations", "ephem_invocations_sink", "ephem_invocations_pipeline", "invocations.schema.json"),
}
ROLL_S = 60

T = f"{NAMESPACE}.requests"
I = f"{NAMESPACE}.invocations"
QUERIES = {
    # cpu-by-version-style counts: every request appears once with role = 'front'
    "by-route": f"SELECT version, route, status, COUNT(*) AS n, approx_percentile_cont(wall_ms, 0.5) AS wall_p50, approx_percentile_cont(wall_ms, 0.99) AS wall_p99 "
                f"FROM {T} WHERE role = 'front' AND ts >= '{{since}}' GROUP BY version, route, status ORDER BY n DESC LIMIT 100",
    "api-cache": f"SELECT route, api_cache, COUNT(*) AS n FROM {T} WHERE role = 'front' AND ts >= '{{since}}' AND route LIKE '/v1/%' GROUP BY route, api_cache ORDER BY route, n DESC",
    "weather-tiers": f"SELECT feed_cache, weather_tier, COUNT(*) AS n, AVG(data_age_s) AS age_s FROM {T} WHERE route = '/v1/weather' AND ts >= '{{since}}' AND feed_cache IS NOT NULL GROUP BY feed_cache, weather_tier ORDER BY n DESC",
    "work": f"SELECT route, blocks_cache, COUNT(*) AS n, AVG(blocks) AS blocks, AVG(block_reads) AS block_reads, AVG(iterations) AS iterations "
            f"FROM {T} WHERE role = 'api' AND ts >= '{{since}}' GROUP BY route, blocks_cache ORDER BY n DESC LIMIT 50",
    "errors": f"SELECT route, status, error_tag, COUNT(*) AS n FROM {T} WHERE role = 'front' AND ok = false AND ts >= '{{since}}' GROUP BY route, status, error_tag ORDER BY n DESC",
    "clients": f"SELECT ua_family, mcp_method, mcp_tool, COUNT(*) AS n FROM {T} WHERE role = 'front' AND ts >= '{{since}}' GROUP BY ua_family, mcp_method, mcp_tool ORDER BY n DESC LIMIT 50",
    "outcomes": f"SELECT script_version, entrypoint, outcome, COUNT(*) AS n, SUM(basin_send_failed) AS send_failed, approx_percentile_cont(cpu_ms, 0.99) AS cpu_p99 "
                f"FROM {I} WHERE ts >= '{{since}}' GROUP BY script_version, entrypoint, outcome ORDER BY n DESC",
    "latest": f"SELECT * FROM {T} ORDER BY ts DESC LIMIT 10",
}


def cf(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["cf", *args], input=stdin, capture_output=True, text=True)


def token() -> str | None:
    try:
        st = os.stat(TOKEN_FILE)
    except FileNotFoundError:
        return None
    if st.st_mode & 0o077:
        raise SystemExit(f"{TOKEN_FILE} is readable by group/others; chmod 600 it first")
    t = open(TOKEN_FILE).read().strip()
    return t or None


def status(_a) -> None:
    for kind in ("streams", "sinks"):
        out = cf("pipelines", kind, "list")
        rows = json.loads(out.stdout or "[]") if out.returncode == 0 else []
        rows = rows if isinstance(rows, list) else rows.get("result", rows.get(kind, []))
        print(f"{kind}:", [(r.get("name"), r.get("id")) for r in rows if str(r.get("name", "")).startswith("ephem")] or "none")
    out = cf("pipelines", "list")
    rows = json.loads(out.stdout or "[]") if out.returncode == 0 else []
    rows = rows if isinstance(rows, list) else rows.get("result", [])
    print("pipelines:", [(r.get("name"), r.get("id"), r.get("status")) for r in rows if str(r.get("name", "")).startswith("ephem")] or "none")
    cat = json.loads(cf("basin-catalog", "get", BUCKET).stdout or "{}")
    print("catalog:", cat.get("name"), cat.get("status"), "credential:", cat.get("credential_status"))
    print("token file:", "present" if token() else f"absent ({TOKEN_FILE})")


def failures(a) -> None:
    now = int(time.time() * 1000)
    for svc in ("ephem", "ephem-tail"):
        for needle in ("basin_send_failed", "request_log_failed"):
            filt = [{"key": "$metadata.service", "operation": "eq", "type": "string", "value": svc},
                    {"key": "$metadata.message", "operation": "includes", "type": "string", "value": needle}]
            body = {"queryId": "adhoc", "timeframe": {"from": now - int(a.minutes * 60_000), "to": now}, "view": "events", "limit": 1000, "parameters": {"filters": filt}}
            r = cf("o11y", "telemetry", "query", "--body", json.dumps(body))
            if r.returncode:
                raise SystemExit(r.stderr or r.stdout)
            n = len(json.loads(r.stdout).get("events", {}).get("events", []))
            print(f"{svc:11} {needle:20} {n}{'+' if n >= 1000 else ''}  (last {a.minutes:g} min)")


def provision(_a) -> None:
    tok = token()
    if not tok:
        raise SystemExit(f"no token at {TOKEN_FILE}: Ivar creates an R2 Account API token (Admin Read & Write) and puts it there (chmod 600)")
    r = cf("basin-catalog", "credentials", "create", BUCKET, "--body", "@/dev/stdin", stdin=json.dumps({"token": tok}))
    print("catalog credential:", "ok" if r.returncode == 0 else (r.stderr or r.stdout).replace(tok, "<redacted>")[:300])
    for stream, (_sid, table, sink, pipeline, schema) in STREAMS.items():
        fields = json.load(open(os.path.join(OPS, schema)))
        body = {"name": sink, "type": "basin_catalog", "format": {"type": "parquet", "compression": "zstd"}, "schema": {"fields": fields},
                "config": {"account_id": ACCOUNT, "bucket": BUCKET, "namespace": NAMESPACE, "table_name": table, "token": tok, "rolling_policy": {"interval_seconds": ROLL_S}}}
        r = cf("pipelines", "sinks", "create", "--body", "@/dev/stdin", stdin=json.dumps(body))
        msg = (r.stdout if r.returncode == 0 else r.stderr or r.stdout).replace(tok, "<redacted>")
        print(f"sink {sink}:", json.loads(msg).get("id") if r.returncode == 0 else msg[:400])
        r = cf("pipelines", "create", "--name", pipeline, "--sql", f"INSERT INTO {sink} SELECT * FROM {stream}")
        print(f"pipeline {pipeline}:", json.loads(r.stdout).get("id") if r.returncode == 0 else (r.stderr or r.stdout)[:400])


def basin_sql(q: str) -> str:
    tok = token()
    if not tok:
        raise SystemExit(f"no token at {TOKEN_FILE} (Basin SQL needs the R2 Account API token)")
    env = {k: v for k, v in os.environ.items() if k != "CLOUDFLARE_API_TOKEN"} | {"WRANGLER_BASIN_SQL_AUTH_TOKEN": tok}
    r = subprocess.run([os.path.join(ROOT, "node_modules/.bin/wrangler"), "basin", "sql", "query", WAREHOUSE, q], capture_output=True, text=True, env=env, cwd=ROOT)
    out = (r.stdout + r.stderr).replace(tok, "<redacted>")
    if r.returncode != 0:
        raise SystemExit(out)
    return out


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def sql(a) -> None:
    since = iso(datetime.now(timezone.utc) - timedelta(hours=a.hours))
    q = a.raw or QUERIES[a.name].format(since=since)
    print(f"-- {q}\n-- (rows land in Iceberg about every {ROLL_S} s: the newest minute or two is not there yet)")
    print(basin_sql(q))


def crosscheck(a) -> None:
    """Front-door Basin rows per (version, route, status) vs Workers Observability invocations of the default entrypoint."""
    q = (f"SELECT version, route, status, COUNT(*) AS n FROM {T} WHERE role = 'front' AND ts >= '{a.frm}' AND ts < '{a.to}' "
         f"GROUP BY version, route, status ORDER BY version, route, status")
    print(f"-- {q}")
    print(basin_sql(q))
    ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
    from urllib.parse import urlparse  # noqa: E402
    counts = collections.Counter()
    evs = events(0, [eq("$metadata.type", "cf-worker-event")], window=(ms(a.frm), ms(a.to)))
    for e in evs:
        w = e["$workers"]
        if w.get("entrypoint") not in (None, "default"):
            continue
        ev = w.get("event") if isinstance(w.get("event"), dict) else {}
        counts[(w["scriptVersion"]["id"], urlparse(ev.get("request", {}).get("url", "")).path, ev.get("response", {}).get("status"))] += 1
    print(f"-- Workers Observability, default entrypoint, {a.frm} .. {a.to} ({len(evs)} events{'; capped at 1000, narrow the window' if len(evs) >= 1000 else ''})")
    for (v, p, s), n in sorted(counts.items(), key=lambda kv: (kv[0][0], kv[0][1], str(kv[0][2]))):
        print(f"{v}  {p:16} {s!s:>4} {n:>6}")


def types(_a) -> None:
    with tempfile.TemporaryDirectory() as d:
        cfg = {"name": "x", "main": "i.ts", "compatibility_date": "2026-10-01",
               "pipelines": [{"binding": s.upper(), "stream": sid} for s, (sid, *_r) in STREAMS.items()]}
        open(os.path.join(d, "wrangler.jsonc"), "w").write(json.dumps(cfg)); open(os.path.join(d, "i.ts"), "w").write("export default {}\n")
        env = {k: v for k, v in os.environ.items() if k != "CLOUDFLARE_API_TOKEN"}
        subprocess.run([os.path.join(ROOT, "node_modules/.bin/wrangler"), "types", "--include-runtime=false", os.path.join(d, "out.d.ts")], cwd=d, env=env, check=True, capture_output=True)
        recs = re.findall(r"type (Ephem\w+Record) = (\{[^}]*\})", open(os.path.join(d, "out.d.ts")).read())
    if len(recs) != len(STREAMS):
        raise SystemExit(f"expected {len(STREAMS)} typed records, got {len(recs)} (logged in? stream ids right?)")
    out = os.path.join(ROOT, "packages/worker/src/basin.generated.ts")
    with open(out, "w") as f:
        f.write(f"// Generated by `wrangler types` from the live Basin stream schemas ({', '.join(STREAMS)}), {time.strftime('%Y-%m-%d')}.\n")
        f.write("// test/requestlog.test.ts and packages/tail/test check the row types are assignable to these. Regenerate: scripts/obs/basin.py types\n")
        for name, body in recs:
            f.write(f"export type {name} = {body}\n")
    print("wrote", out, [n for n, _ in recs])


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
sub.add_parser("status").set_defaults(f=status)
p = sub.add_parser("failures"); p.add_argument("--minutes", type=float, default=60); p.set_defaults(f=failures)
sub.add_parser("provision").set_defaults(f=provision)
p = sub.add_parser("sql"); p.add_argument("name", nargs="?", choices=sorted(QUERIES), default="by-route"); p.add_argument("--hours", type=float, default=1); p.add_argument("--raw"); p.set_defaults(f=sql)
p = sub.add_parser("crosscheck"); p.add_argument("--from", dest="frm", required=True); p.add_argument("--to", required=True); p.set_defaults(f=crosscheck)
sub.add_parser("types").set_defaults(f=types)
a = ap.parse_args()
a.f(a)
