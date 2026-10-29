"""Shared helper: run a Workers Observability query through the cf CLI and return the parsed JSON."""
import json, subprocess, time

SERVICE = "ephem"


def query(view: str, minutes: float, filters: list | None = None, limit: int = 1000, extra: dict | None = None, window: tuple[int, int] | None = None) -> dict:
    """window: absolute (from_ms, to_ms); overrides minutes."""
    now = int(time.time() * 1000)
    params = {"filters": [{"key": "$metadata.service", "operation": "eq", "type": "string", "value": SERVICE}, *(filters or [])]}
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


def events(minutes: float, filters: list | None = None, limit: int = 1000, window: tuple[int, int] | None = None) -> list[dict]:
    return query("events", minutes, filters, limit, window=window).get("events", {}).get("events", [])
