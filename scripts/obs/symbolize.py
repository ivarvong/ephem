"""Give a prod pprof real function names.

Cloudflare applies the uploaded source map to locations (file:line), but function names stay minified (`rq`, `Dae`)
because the bundle is built with keepNames off. Each location's line is the function's definition line, so the name
is read from the source there: `export const evalBlock = (` → evalBlock, `const g = (dm` → alignment.g. Closures
returned inline (`return (s) =>`) become `<enclosing>.<anon>`.

    python3 scripts/obs/symbolize.py in.pb [out.pb]      # default out: in.sym.pb; plain or gzipped input
"""
import gzip, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
WORKER = os.path.join(ROOT, "packages/worker")      # bundle paths are relative to the worker package


# ── minimal protobuf (just enough for pprof's Profile / Function messages) ──
def varint(b: bytes, i: int):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7F) << s; s += 7
        if c < 0x80: return r, i


def fields(b: bytes):
    i = 0
    while i < len(b):
        key, i = varint(b, i); f, wt = key >> 3, key & 7
        if wt == 0: v, i = varint(b, i)
        elif wt == 2: n, i = varint(b, i); v = b[i:i + n]; i += n
        elif wt == 1: v = b[i:i + 8]; i += 8
        elif wt == 5: v = b[i:i + 4]; i += 4
        else: raise ValueError(f"wire type {wt}")
        yield f, wt, v


def enc_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        c = n & 0x7F; n >>= 7
        if n: out.append(c | 0x80)
        else: out.append(c); return bytes(out)


def enc(f: int, wt: int, v) -> bytes:
    k = enc_varint(f << 3 | wt)
    return k + (enc_varint(v) if wt == 0 else (enc_varint(len(v)) + v if wt == 2 else v))


# ── name from source ──
DECL = [re.compile(p) for p in (
    r"(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function)",
    r"(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)",
    r"^\s*(?:(?:public|private|protected|static|override|readonly|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{",
    r"([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>",
    r"([A-Za-z_$][\w$]*)\s*\(\s*\"",
)]
FN_DECL = re.compile(r"(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^()]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|function)")
cache: dict[str, list[str]] = {}


def src_lines(path: str):
    if path not in cache:
        p = os.path.normpath(os.path.join(WORKER, path))
        try: cache[path] = open(p, encoding="utf8").read().split("\n")
        except OSError: cache[path] = []
    return cache[path]


def name_at(path: str, line: int) -> str | None:
    ls = src_lines(path)
    if not (0 < line <= len(ls)): return None
    text = ls[line - 1]
    for rx in DECL:
        m = rx.search(text)
        if m and m.group(1) not in ("if", "for", "while", "switch", "return", "catch", "function"): return m.group(1)
    for j in range(line - 2, max(-1, line - 80), -1):           # inline closure: name it after the enclosing declaration
        m = FN_DECL.search(ls[j]) or DECL[1].search(ls[j])
        if m and not ls[j].startswith(" " * 6): return m.group(1) + ".<anon>"
    return None


def main():
    src = sys.argv[1]; dst = sys.argv[2] if len(sys.argv) > 2 else re.sub(r"(\.pb)?(\.gz)?$", "", src) + ".sym.pb"
    raw = open(src, "rb").read()
    if raw[:2] == b"\x1f\x8b": raw = gzip.decompress(raw)
    top = list(fields(raw))
    strings = [v.decode("utf8", "replace") for f, wt, v in top if f == 6]
    index = {s: i for i, s in enumerate(strings)}
    added: list[str] = []

    def intern(s: str) -> int:
        if s not in index: index[s] = len(strings) + len(added); added.append(s)
        return index[s]

    renamed = 0; out = bytearray()
    for f, wt, v in top:
        if f != 5: out += enc(f, wt, v); continue
        fn = {ff: vv for ff, _, vv in fields(v)}
        name, fname, line = strings[fn.get(2, 0)], strings[fn.get(4, 0)], fn.get(5, 0)
        real = name_at(fname, line) if fname and fname.endswith(".ts") and not fname.startswith("../../node_modules") else None
        if real and real != name:
            mod = os.path.splitext(os.path.basename(fname))[0]
            fn[2] = intern(f"{mod}.{real}"); fn[3] = intern(f"{mod}.{real} (min:{name})" if name else f"{mod}.{real}"); renamed += 1
        out += enc(5, 2, b"".join(enc(ff, 2 if isinstance(vv, bytes) else 0, vv) for ff, vv in sorted(fn.items())))
    for s in added: out += enc(6, 2, s.encode("utf8"))
    open(dst, "wb").write(bytes(out))
    print(f"{dst}: renamed {renamed} functions from source", file=sys.stderr)


main()
