"""The telemetry gate's per-event rules (canary-gate.py; tested by packages/worker/test/canary-gate.test.ts on recorded
events in packages/worker/test/fixtures/gate/). Pure: no queries.

    classify(events) -> (errors, aborts)

errors: (event, kind, message) the gate fails on: a server error.
  - an invocation or runtime root span with outcome other than ok / canceled (exception, exceededCpu, ...)
  - a status >= 500
  - a log line at level error, any key ending in `_failed`, any {"evt": "*_failed"}
aborts: (event, kind, message) a client that went away: counted and reported, never a failure.
  - outcome `canceled` (the runtime cancels an invocation whose client disconnected with nothing else pending)
  - the runtime's own `Network connection lost.` exception log when the client disconnected while the response was being
    written: only when that request's invocation is in `events` and shows no server error (outcome ok / canceled, no
    response status or one < 500). Without that evidence it is an error (fail closed).
  - {"evt": "client_aborted"} (src/abort.ts: the front door's record of the disconnect, level info)
"""
import json

DISCONNECT = "Network connection lost."


def ray0(e): return (e["$metadata"].get("rayId") or "").split("-")[0]
def req(e): ev = (e.get("$workers") or {}).get("event"); return ev if isinstance(ev, dict) else {}
def status(e): r = req(e).get("response"); return r.get("status") if isinstance(r, dict) else None


def is_err_log(e):
    """'<kind>: <json>' for a log line the gate counts as an error, else None."""
    if e["$metadata"].get("type") != "cf-worker":
        return None
    src = e.get("source") if isinstance(e.get("source"), dict) else {}
    lvl = e["$metadata"].get("level") or src.get("level")
    failed = [k for k in src if k.endswith("_failed")] + ([src["evt"]] if str(src.get("evt", "")).endswith("_failed") else [])
    if lvl == "error" or failed:
        return (failed[0] if failed else "error") + ": " + json.dumps(src)[:160]
    return None


def is_disconnect_log(e):
    """The runtime's exception record for a response written to a client that is gone."""
    m, src = e["$metadata"], e.get("source") if isinstance(e.get("source"), dict) else {}
    return m.get("type") == "cf-worker" and (m.get("message") == DISCONNECT or src.get("message") == DISCONNECT) and isinstance(src.get("exception"), dict) \
        and not [k for k in src if k.endswith("_failed")]


def server_ok(inv):
    """An invocation that shows no server error: the client's disconnect is all that happened."""
    o, st = (inv.get("$workers") or {}).get("outcome"), status(inv)
    return o in ("ok", "canceled") and (st is None or st < 500)


def classify(events, where=lambda e: "", final=True):
    """Every event once (dedupe by the whole $metadata: $metadata.id is not unique). `where(e)`: a location prefix for messages.
    final=False: a disconnect log whose invocation has not been ingested yet is left out (the invocation event arrives after
    the request's waitUntil ends, ~1 s later than the log); final=True judges it an error."""
    seen, uniq = set(), []
    for e in events:
        k = json.dumps(e["$metadata"], sort_keys=True)
        if k not in seen: seen.add(k); uniq.append(e)
    inv = {}
    for e in uniq:
        if e["$metadata"].get("type") == "cf-worker-event" and ray0(e): inv.setdefault(ray0(e), []).append(e)
    errs, aborts = [], []
    for e in uniq:
        t, w = e["$metadata"].get("type"), where(e)
        pth = req(e).get("request", {}).get("path") or req(e).get("path") or ""
        if t == "cf-worker-event":
            o, st = e["$workers"].get("outcome"), status(e)
            if o == "canceled": aborts.append((e, "outcome canceled", f"client abort: {w} {pth} outcome canceled (ray {ray0(e)})"))
            elif o and o != "ok": errs.append((e, f"outcome {o}", f"outcome: {w} {pth} {o} (ray {ray0(e)})"))
            if isinstance(st, int) and st >= 500: errs.append((e, f"status {st}", f"5xx: {w} {pth} {st} (ray {ray0(e)})"))
        elif t == "span" and isinstance(e.get("source"), dict) and "ray_id" in e["source"].get("cloudflare", {}):
            c = e["source"]["cloudflare"]; sc = ((e["source"].get("http") or {}).get("response") or {}).get("status_code")
            sp = (e["source"].get("url") or {}).get("path", "")
            if c.get("outcome") == "canceled": aborts.append((e, "outcome canceled", f"client abort (root span): {w} {sp} outcome canceled (ray {c.get('ray_id')})"))
            elif c.get("outcome") not in (None, "ok"): errs.append((e, f"outcome {c.get('outcome')}", f"outcome (root span): {w} {sp} {c.get('outcome')} (ray {c.get('ray_id')})"))
            if isinstance(sc, int) and sc >= 500: errs.append((e, f"status {sc}", f"5xx (root span): {w} {sp} {sc} (ray {c.get('ray_id')})"))
        elif t == "cf-worker":
            src = e.get("source") if isinstance(e.get("source"), dict) else {}
            if src.get("evt") == "client_aborted":
                aborts.append((e, "client_aborted", f"client abort: {w} {src.get('phase', '')} {json.dumps(src)[:120]} (ray {ray0(e)})")); continue
            m = is_err_log(e)
            if not m: continue
            mine = inv.get(ray0(e), [])
            if is_disconnect_log(e) and not mine and not final: continue
            if is_disconnect_log(e) and mine and all(server_ok(i) for i in mine):
                aborts.append((e, "disconnect", f"client abort: {w} {pth} {DISCONNECT} (runtime, response not delivered; ray {ray0(e)})"))
            else:
                errs.append((e, "log " + m.split(":")[0], f"error log: {w} {m} (ray {ray0(e)})"))
    return errs, aborts
