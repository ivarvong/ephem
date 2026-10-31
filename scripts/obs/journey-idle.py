#!/usr/bin/env python3
# usage: python3 -I scripts/obs/journey-idle.py <journey-out>/<name>.model.json ...
# Idle main-thread cost from a journey model: top-level task time after data drawn + 6 s (past load and the scripted drags),
# and the busiest named events under them (Paint, FireAnimationFrame, TimerFire, ...).
import json, sys, collections
for f in sys.argv[1:]:
    m = json.load(open(f)); data = m["kpi"]["data"]; t0 = data + 6000
    ev = [e for e in m["main"] if e[0] >= t0 and e[0] < 74000]
    top = sum(e[1] for e in ev if e[2] == 0)
    by = collections.Counter()
    for e in ev:
        if e[3] in ("FireAnimationFrame", "TimerFire", "Paint", "FunctionCall", "EventDispatch", "UpdateLayoutTree", "Layout", "PrePaint", "Layerize", "XHRLoad", "ResourceReceivedData"): by[e[3]] += e[1]
    raf = sum(1 for e in ev if e[3] == "FireAnimationFrame"); span = (74000 - t0) / 1000
    print(f"{f.split('/')[-1]:40s} window {span:.0f} s: busy {top:.0f} ms ({top/span:.1f} ms/s), rAF callbacks {raf}, " + ", ".join(f"{k} {v:.0f}" for k, v in by.most_common(6)))
