"""Shared helper: run a Workers Observability query through the cf CLI and return the parsed JSON."""
import json, os, subprocess, time

# The Worker queried: "ephem" (front door, MetarFeed) or "ephem-compute" (Api, BlockStore; since the compute split). Scripts
# take --service; EPHEM_SERVICE sets the default.
SERVICE = os.environ.get("EPHEM_SERVICE", "ephem")


def query(view: str, minutes: float, filters: list | None = None, limit: int = 1000, extra: dict | None = None, window: tuple[int, int] | None = None, service: str | None = None) -> dict:
    """window: absolute (from_ms, to_ms); overrides minutes. service: overrides SERVICE for this call (thread-safe)."""
    now = int(time.time() * 1000)
    params = {"filters": [{"key": "$metadata.service", "operation": "eq", "type": "string", "value": service or SERVICE}, *(filters or [])]}
    params.update(extra or {})
    body = {"queryId": "adhoc", "timeframe": {"from": window[0], "to": window[1]} if window else {"from": now - int(minutes * 60_000), "to": now}, "view": view, "limit": limit, "parameters": params}
    out = subprocess.run(["cf", "o11y", "telemetry", "query", "--body", json.dumps(body)], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"cf o11y telemetry query failed:\n{out.stderr or out.stdout}")
    return json.loads(out.stdout)


def eq(key: str, value: str) -> dict:
    return {"key": key, "operation": "eq", "type": "string", "value": value}


def starts(key: str, value: str) -> dict:
    return {"key": key, "operation": "starts_with", "type": "string", "value": value}


def events(minutes: float, filters: list | None = None, limit: int = 1000, window: tuple[int, int] | None = None, service: str | None = None) -> list[dict]:
    return query("events", minutes, filters, limit, window=window, service=service).get("events", {}).get("events", [])


def events_all(filters: list, window: tuple[int, int], step: int = 60_000, workers: int = 8, service: str | None = None) -> list[dict]:
    """Every event in an absolute window: slices of `step` ms queried in parallel, and any slice that hits the view's
    1000-row cap is halved and re-queried, so busy windows are never silently truncated. Deduplicated by the whole $metadata
    (slice edges can repeat an event). Never by $metadata.id: distinct events share ids (78 rows, 67 ids for 78 distinct
    rays, 2026-10-30), and deduplicating by it dropped 14-24% of events."""
    import threading   # not concurrent.futures: it imports the stdlib `queue`, which scripts/obs/queue.py shadows
    def pmap(ws: list) -> list:
        res: list = [None] * len(ws); nxt = iter(range(len(ws))); lock = threading.Lock()
        def run() -> None:
            while True:
                with lock:
                    i = next(nxt, None)
                if i is None:
                    return
                res[i] = events(0, filters, window=ws[i], service=service)
        th = [threading.Thread(target=run) for _ in range(min(workers, len(ws)))]
        [t.start() for t in th]; [t.join() for t in th]
        return res
    out, seen, todo = [], set(), [(t, min(window[1], t + step)) for t in range(window[0], window[1], step)]
    while todo:
        batch, todo = todo, []
        for (a, b), ev in zip(batch, pmap(batch)):
            if len(ev) >= 1000 and b - a > 50:
                m = (a + b) // 2; todo += [(a, m), (m, b)]; continue
            for e in ev:
                i = json.dumps(e.get("$metadata", {}), sort_keys=True)   # NOT $metadata.id: it is not unique (gotcha, 2026-10-30)
                if i not in seen:
                    seen.add(i); out.append(e)
    return out
