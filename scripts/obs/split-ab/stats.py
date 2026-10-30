"""A/B stats: AB_COMPUTE=<ephem-compute version id prefix> python3 -I scripts/obs/split-ab/stats.py <tag> r1 r2 ...  Per run per arm metrics, run-to-run spread, paired hierarchical bootstrap
(resample runs, then rows within each run and arm) 95% CI of S − E."""
import json, os, sys, random, collections
D = os.environ.get("AB_DIR", "ab-runs")
tag, runs = sys.argv[1], sys.argv[2:]
W = json.load(open(f"{D}/{tag}.windows.json")); VS, VE = W["S"][:8], W["E"][:8]
L = lambda r, w: json.load(open(f"{D}/{tag}.{r}.{w}.json"))  # noqa: E731
client = collections.defaultdict(list)
for l in open(f"{D}/{tag}.jsonl"):
    x = json.loads(l); client[(x["phase"], x["arm"], x["kind"])].append(x)
def q(v, p):
    v = sorted(v); return v[min(len(v) - 1, int(len(v) * p))] if v else float("nan")
data = {}   # run -> arm -> dict of row lists
for r in runs:
    qpos, sp, post = L(r, "qpos"), L(r, "spans"), L(r, "post")
    for arm, v in (("S", VS), ("E", VE)):
        qwin, win = L(r, f"qwin-{arm}"), L(r, f"win-{arm}")
        vw = os.environ["AB_COMPUTE"][:8] if arm == "S" else VE   # the Worker version that ran this arm's windows (S: ephem-compute's)
        cw = [x for x in win if x["version"] == vw]
        posts = [x for x in post if x["version"] == v and x["entrypoint"] == "default" and x["status"] == 200]
        pos = [x for x in qpos if x["version"] == v]
        data.setdefault(r, {})[arm] = dict(
            pos=[x["wait"] for x in pos],
            e2e=[x["e2e"] for x in sp["e2e"] if x["version"] == v],
            wwait=[x["wait"] for x in qwin if x["version"] == vw],
            hop=[x["ms"] for x in sp["hop"] if x["version"] == v and x["cache"] == "HIT"],
            cl_cold=[x["ms"] for x in client[(r, arm, "cold")] if x["st"] == 200],
            cl_pos=[x["ms"] for x in client[(r, arm, "pos")] if x["st"] == 200],
            errors=sum(1 for k in ("cold", "pos", "warm") for x in client[(r, arm, k)] if x["st"] != 200),
            # per-run scalars
            cpu_scan=(sum(x["cpu"] for x in cw) + sum(x["cpu"] for x in posts)) / max(1, len(posts)),
            win_cpu_scan=sum(x["cpu"] for x in cw) / max(1, len(posts)),
            post_cpu=q([x["cpu"] for x in posts], .5),
            n_posts=len(posts), n_win=len(cw),
            fresh_front=sum(1 for x in pos if x["isolate_computes"] == 1),
            fresh_api=sum(1 for x in cw if x["seq"] == 1),
            gap_fresh=q([x["gap"] for x in cw if x["seq"] == 1 and x["gap"] is not None], .5),
        )
M = {  # name: (row key or None, statistic)
    "pos wait >20ms %": ("pos", lambda v: 100 * sum(1 for x in v if x > 20) / max(1, len(v))),
    "pos wait p99 ms": ("pos", lambda v: q(v, .99)),
    "cold scan e2e p50 ms (server)": ("e2e", lambda v: q(v, .5)),
    "cold scan e2e p90 ms (server)": ("e2e", lambda v: q(v, .9)),
    "window wait p90 ms": ("wwait", lambda v: q(v, .9)),
    "window wait p99 ms": ("wwait", lambda v: q(v, .99)),
    "warm hop p50 ms (api.fetch HIT)": ("hop", lambda v: q(v, .5)),
    "warm hop p99 ms (api.fetch HIT)": ("hop", lambda v: q(v, .99)),
    "cold scan client p50 ms": ("cl_cold", lambda v: q(v, .5)),
    "cold scan client p90 ms": ("cl_cold", lambda v: q(v, .9)),
    "CPU per scan ms (windows + POST)": ("cpu_scan", None),
    "fresh front-door isolates / run": ("fresh_front", None),
    "fresh Api isolates / run": ("fresh_api", None),
}
random.seed(1)
B = int(os.environ.get("B", 2000))
res = {}
for name, (k, f) in M.items():
    per = {a: [(data[r][a][k] if f is None else f(data[r][a][k])) for r in runs] for a in ("S", "E")}
    pooled = {a: (sum(per[a]) / len(runs) if f is None else f([x for r in runs for x in data[r][a][k]])) for a in ("S", "E")}
    diffs = []
    for _ in range(B):
        rs = [random.choice(runs) for _ in runs]
        if f is None:
            d = sum(data[r]["S"][k] - data[r]["E"][k] for r in rs) / len(rs)
        else:
            st = {a: f([x for r in rs for x in random.choices(data[r][a][k], k=len(data[r][a][k]))]) for a in ("S", "E")}
            d = st["S"] - st["E"]
        diffs.append(d)
    lo, hi = q(diffs, .025), q(diffs, .975)
    res[name] = dict(S=pooled["S"], E=pooled["E"], diff=pooled["S"] - pooled["E"], ci=[lo, hi], perS=per["S"], perE=per["E"])
    fm = lambda x: f"{x:.2f}" if abs(x) < 10 else f"{x:.0f}"  # noqa: E731
    print(f"{name:34} S {fm(pooled['S']):>6}  E {fm(pooled['E']):>6}  S−E {fm(pooled['S']-pooled['E']):>6}  CI [{fm(lo)}, {fm(hi)}]{'  *' if lo > 0 or hi < 0 else ''}")
    print(f"{'':34}   runs S {[fm(x) for x in per['S']]}  E {[fm(x) for x in per['E']]}")
for r in runs:
    print(r, {a: {k: data[r][a][k] for k in ("n_posts", "n_win", "errors", "post_cpu", "win_cpu_scan", "gap_fresh")} | {"n_pos": len(data[r][a]["pos"]), "n_e2e": len(data[r][a]["e2e"]), "n_hop": len(data[r][a]["hop"])} for a in ("S", "E")})
json.dump(res, open(f"{D}/{tag}.stats.json", "w"), indent=1)
