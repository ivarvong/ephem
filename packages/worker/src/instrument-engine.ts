// The /instrument calculator's logic, as browser JS source (ES5, no DOM): the RPN stack machine, number formatting and the
// text of every LCD line. src/instrument.ts inlines it into the page; test/instrument-engine.test.ts runs the very same string
// (new Function) so what is tested is what ships. It is a string, not a function's .toString(), because the Worker bundler
// may wrap functions in helpers (keepNames) that do not exist in the browser. No backticks or dollar-brace inside.
//
// The model is an RPL calculator (48-series behaviour, no maker's branding):
// - stack[0] is level 1. Digits build a command line; ENTER (or any command) parses it, space-separated numbers push in
//   order. ENTER with no command line is DUP. A command consumes its arguments only when it succeeds; a failed one shows
//   "<CMD> ERROR:" / "<MESSAGE>" in the two status lines until the next key, with the stack untouched.
// - Numbers carry a unit (°, h, km, %, m/s^2) and an optional tag ("AZ T: 254.39_°"). Arithmetic drops tags, checks units
//   (+ − need the same unit, trig takes ° or none), and keeps full double precision; only the display rounds.
// - Display mode FIX 2 (the default: every live readout at two decimals, like the homepage) or STD (12 significant digits,
//   no trailing zeros). FIX switches to SCI when the value would not show (|x| < .005 or ≥ 1E12). No leading zero (".25").
// - The LCD is 131 × 64 dots. Stack lines: 21 columns of the 6-dot RPN Dot face. Status lines and menu labels: the
//   proportional 3×5 RPN Dot Small face, whose ink widths are SMALL_W (advance = width + 1).
export const ENGINE_JS = String.raw`
var RPNEngine = (function () {
  "use strict";
  var COLS = 21, LINES = 5, STATUS_DOTS = 125, CELL_DOTS = 21;
  var SMALL_W = { "I": 1, "M": 5, "N": 4, "W": 5, ".": 1, ":": 1, "'": 1, "!": 1, " ": 2, "(": 2, ")": 2, "[": 2, "]": 2, ",": 2,
    "→": 4, "←": 4, "√": 4, "π": 4, "…": 5, "↰": 4, "↱": 4 };
  function up(s) { return String(s).replace(/[a-z]/g, function (c) { return c.toUpperCase(); }); }   // ASCII only: π stays π
  function smallWidth(s) {
    s = up(s); var w = 0;
    for (var i = 0; i < s.length; i++) w += (SMALL_W[s[i]] || 3) + (i ? 1 : 0);
    return w;
  }
  function fitSmall(s, dots) {
    s = String(s); if (smallWidth(s) <= dots) return s;
    while (s.length > 1 && smallWidth(s + "…") > dots) s = s.slice(0, -1);
    return s + "…";
  }

  function noLead(s) { return s.replace(/^(-?)0\.(?=\d)/, "$1."); }
  function sci(v, digits) {
    var p = v.toExponential(digits).split("e");
    return p[0] + "E" + parseInt(p[1], 10);
  }
  function fmtStd(v) {
    var a = Math.abs(v), s;
    if (a >= 1e12 || a < 1e-6) s = sci(v, 11).replace(/\.?0+E/, "E");
    else { s = String(Number(v.toPrecision(12))); if (s.indexOf("e") >= 0) s = Number(v.toPrecision(12)).toFixed(11).replace(/\.?0+$/, ""); }
    return noLead(s);
  }
  function fmtFix(v, n) {
    var a = Math.abs(v);
    if (a >= 1e12 || a < 0.5 * Math.pow(10, -n)) return sci(v, n);
    var s = v.toFixed(n);
    if (/^-0\.0*$/.test(s)) s = s.slice(1);
    return noLead(s);
  }
  function fmtNum(v, mode) {
    if (v !== v) return "NaN";
    if (!isFinite(v)) return v > 0 ? "MAXR" : "-MAXR";
    if (v === 0) return mode === "STD" ? "0" : "0.00";
    return mode === "STD" ? fmtStd(v) : fmtFix(v, 2);
  }
  function fmt(o, mode) {
    if (o.k === "s") return '"' + o.v + '"';
    var s = fmtNum(o.v, mode) + (o.u ? "_" + o.u : "");
    return o.tag ? o.tag + ": " + s : s;
  }
  function num(v, u, tag) { return { k: "n", v: v, u: u || "", tag: tag || null }; }
  function str(v) { return { k: "s", v: String(v) }; }
  function Err(cmd, msg, keepEntry) { this.cmd = cmd; this.msg = msg; this.keepEntry = !!keepEntry; }
  function wrap360(x) { x = x % 360; if (x < 0) x += 360; return x >= 359.995 ? 0 : x; }
  function toHMS(x) {
    var sg = x < 0 ? -1 : 1, t = Math.round(Math.abs(x) * 3600 * 1e4) / 1e4, h = Math.floor(t / 3600), m = Math.floor((t - h * 3600) / 60);
    return sg * (h + m / 100 + (t - h * 3600 - m * 60) / 10000);
  }
  function fromHMS(x) {
    var sg = x < 0 ? -1 : 1, a = Math.abs(x), h = Math.floor(a + 1e-12), f = Math.round((a - h) * 1e10) / 1e8, m = Math.floor(f + 1e-9);
    return sg * (h + m / 60 + (f - m) * 100 / 3600);
  }

  var D = Math.PI / 180;
  /* key id -> shifted function (the lavender left shift, the aqua right shift) and its legend */
  var SHIFTED = {
    L: { NXT: "PREV", SIN: "ASIN", COS: "ACOS", TAN: "ATAN", SQRT: "SQ", "y^x": "10^x", INV: "e^x", NEG: "ABS", EEX: "PI", DEL: "CLEAR" },
    R: { "y^x": "LOG", INV: "LN", BACK: "DROP", "7": "SUN", "8": "MOON", "4": "TOHMS", "5": "FROMHMS" }
  };
  var ORDER = ["SKY", "DAY", "CONST", "MAIN"];

  function create(env) {
    env = env || {};
    var sky = function () { return env.sky ? env.sky() : {}; };
    var st = { stack: [], entry: null, shift: null, menu: "SKY", body: "SUN", err: null, mode: "FIX", last: null, undo: null };

    function need(n, cmd) { if (st.stack.length < n) throw new Err(cmd, "Too Few Arguments"); }
    function isNum(o, cmd) { if (o.k !== "n") throw new Err(cmd, "Bad Argument Type"); return o; }
    function args(n) { st.last = st.stack.slice(0, n); }
    function unary(cmd, f, unitRule) {
      need(1, cmd); var x = isNum(st.stack[0], cmd);
      var u = unitRule ? unitRule(x.u) : (x.u && x.u !== "°" ? null : "");
      if (u === null) throw new Err(cmd, "Inconsistent Units");
      var r = f(x.v); if (r !== r) throw new Err(cmd, "Undefined Result");
      if (!isFinite(r)) throw new Err(cmd, "Infinite Result");
      args(1); st.stack[0] = num(r, u);
    }
    function binary(cmd, f, unitRule) {
      need(2, cmd); var x = isNum(st.stack[0], cmd), y = isNum(st.stack[1], cmd);
      var u = unitRule(y.u, x.u, x.v); if (u === null) throw new Err(cmd, "Inconsistent Units");
      var r = f(y.v, x.v); if (r !== r) throw new Err(cmd, "Undefined Result");
      if (!isFinite(r)) throw new Err(cmd, "Infinite Result");
      args(2); st.stack.splice(0, 2, num(r, u));
    }
    var same = function (a, b) { return a === b ? a : null; };
    var deg = function (u) { return u ? null : "°"; };
    var hms = function (u) { return u === "" || u === "h" || u === "°" ? "" : null; };
    var OPS = {
      "+": function () { binary("+", function (a, b) { return a + b; }, same); },
      "-": function () { binary("-", function (a, b) { return a - b; }, same); },
      "*": function () { binary("*", function (a, b) { return a * b; }, function (a, b) { return a && b ? a + "*" + b : a || b; }); },
      "/": function () { binary("/", function (a, b) { return b === 0 ? (a === 0 ? NaN : Infinity) : a / b; }, function (a, b) { return a === b ? "" : !b ? a : !a ? "1/" + b : a + "/" + b; }); },
      "y^x": function () { binary("^", Math.pow, function (a, b, x) { return b ? null : a ? a + "^" + fmtNum(x, "STD") : ""; }); },
      "10^x": function () { unary("ALOG", function (x) { return Math.pow(10, x); }); },
      LOG: function () { unary("LOG", function (x) { return x > 0 ? Math.log(x) / Math.LN10 : x === 0 ? -Infinity : NaN; }); },
      "e^x": function () { unary("EXP", Math.exp); },
      LN: function () { unary("LN", function (x) { return x > 0 ? Math.log(x) : x === 0 ? -Infinity : NaN; }); },
      SQRT: function () { unary("√", function (x) { return x >= 0 ? Math.sqrt(x) : NaN; }, function (u) { return u ? (/\^2$/.test(u) ? u.slice(0, -2) : null) : ""; }); },
      SQ: function () { unary("SQ", function (x) { return x * x; }, function (u) { return u ? u + "^2" : ""; }); },
      INV: function () { unary("INV", function (x) { return x === 0 ? Infinity : 1 / x; }, function (u) { return u ? "1/" + u : ""; }); },
      SIN: function () { unary("SIN", function (x) { return Math.sin(x * D); }); },
      COS: function () { unary("COS", function (x) { return Math.cos(x * D); }); },
      TAN: function () { unary("TAN", function (x) { return Math.abs(((x % 180) + 180) % 180 - 90) < 1e-12 ? Infinity : Math.tan(x * D); }); },
      ASIN: function () { unary("ASIN", function (x) { return Math.abs(x) <= 1 ? Math.asin(x) / D : NaN; }, deg); },
      ACOS: function () { unary("ACOS", function (x) { return Math.abs(x) <= 1 ? Math.acos(x) / D : NaN; }, deg); },
      ATAN: function () { unary("ATAN", function (x) { return Math.atan(x) / D; }, deg); },
      ABS: function () { unary("ABS", Math.abs, function (u) { return u; }); },
      NEG: function () { unary("NEG", function (x) { return -x; }, function (u) { return u; }); },
      TOHMS: function () { unary("→HMS", toHMS, hms); },
      FROMHMS: function () { unary("HMS→", fromHMS, hms); },
      SWAP: function () { need(2, "SWAP"); args(2); var a = st.stack[0]; st.stack[0] = st.stack[1]; st.stack[1] = a; },
      DROP: function () { need(1, "DROP"); args(1); st.stack.shift(); },
      DUP: function () { need(1, "DUP"); args(1); st.stack.unshift(st.stack[0]); },
      OVER: function () { need(2, "OVER"); args(2); st.stack.unshift(st.stack[1]); },
      ROT: function () { need(3, "ROT"); args(3); st.stack.unshift(st.stack.splice(2, 1)[0]); },
      DEPTH: function () { st.stack.unshift(num(st.stack.length)); },
      CLEAR: function () { st.stack = []; },
      PI: function () { st.stack.unshift(num(Math.PI)); },
      LAST: function () {
        if (!st.last || !st.last.length) throw new Err("LASTARG", "No Arguments Saved");
        var a = st.last.slice(); for (var i = a.length - 1; i >= 0; i--) st.stack.unshift(a[i]);
      }
    };
    var MUTATES = { DEPTH: 1, CLEAR: 1, PI: 1, LAST: 1 };   // stack changers with no arguments (UNDO must see them too)

    /* soft menus: what the six labels do. Live values come from env.sky() at the moment of the press. */
    function live(label, tag, unit, get, why) {
      return { label: label, title: tag, push: function () {
        var v = get();
        if (typeof v !== "number" || !isFinite(v)) throw new Err(label, why ? why() : "No Data");
        return num(v, unit, tag);
      } };
    }
    function bodyOf() { return (sky()[st.body]) || {}; }
    var MENUS = {
      MAIN: function () { return [{ label: "SKY", dir: true, go: "SKY" }, { label: "DAY", dir: true, go: "DAY" }, { label: "CONST", dir: true, go: "CONST" }, {}, {}, {}]; },
      SKY: function () {
        return [
          live("AZ T", "AZ T", "°", function () { var a = bodyOf().AZ; return a == null ? a : wrap360(a); }),
          live("AZ M", "AZ M", "°", function () { var a = bodyOf().AZ, d = sky().MAGDEC; return a == null || d == null ? null : wrap360(a - d); }),
          live("ALT", "ALT", "°", function () { return bodyOf().ALT; }),
          live("DECL", "DECL", "°", function () { return bodyOf().DECL; }),
          live("DIST", null, "km", function () { return bodyOf().DIST; }),   // untagged: the Sun's 148544785.97_km fills the line
          { label: st.body === "SUN" ? "MOON" : "SUN", dir: true, body: true }
        ];
      },
      DAY: function () {
        var ev = function (k, tag) {
          return live(tag, tag, "h", function () { var d = sky().DAY; return d && d[st.body] ? d[st.body][k] : null; },
            function () { return sky().DAY ? "No " + st.body + " " + tag + " Today" : "No Data"; });
        };
        return [ev("rise", "RISE"), ev("set", "SET"), ev("transit", "TRANS"),
          live("NOW", "NOW", "h", function () { return sky().HOURS; }),
          { label: "PHASE", title: "PHASE", push: function () { var p = (sky().MOON || {}).PHASE; if (!p) throw new Err("PHASE", "No Data"); return str(p); } },
          live("ILLUM", "ILLUM", "%", function () { return (sky().MOON || {}).ILLUM; })];
      },
      CONST: function () {
        return [
          { label: "AU", push: function () { return num(149597870.7, "km", "AU"); } },
          { label: "C", push: function () { return num(299792.458, "km/s", "C"); } },
          { label: "RE", push: function () { return num(6378.137, "km", "RE"); } },
          { label: "G", push: function () { return num(9.80665, "m/s^2", "G"); } },
          { label: "π", push: function () { return num(Math.PI); } },
          { label: "MAIN", dir: true, go: "MAIN" }
        ];
      }
    };
    function menuItems() { return MENUS[st.menu](); }

    /* the command line */
    function tokens(e) { return e.split(" ").filter(function (t) { return t !== ""; }); }
    function parseTok(t) {
      if (!/^-?(\d+\.?\d*|\.\d+)(E-?\d*)?$/.test(t)) return NaN;
      return Number(t.replace(/E-?$/, "").replace("E", "e"));
    }
    function commit() {
      if (st.entry == null) return;
      var ts = tokens(st.entry), vs = ts.map(parseTok);
      for (var i = 0; i < vs.length; i++) if (vs[i] !== vs[i]) throw new Err("", "Invalid Syntax", true);
      st.entry = null;
      vs.forEach(function (v) { st.stack.unshift(num(v)); });
    }
    function cur() { var e = st.entry || "", i = e.lastIndexOf(" "); return { head: e.slice(0, i + 1), tok: e.slice(i + 1) }; }
    function type(ch) {
      if (st.entry == null) st.entry = "";
      if (st.entry.length >= 60) return;
      var c = cur(), t = c.tok;
      if (ch === " ") { if (t !== "") st.entry += " "; return; }
      if (ch === ".") { if (/[.E]/.test(t)) return; }
      if (ch === "E") { if (/E/.test(t)) return; if (t === "" || t === "-") t += "1"; }
      st.entry = c.head + t + ch;
    }
    function negEntry() {
      var c = cur(), t = c.tok, i = t.indexOf("E");
      if (i >= 0) t = t.slice(0, i + 1) + (t[i + 1] === "-" ? t.slice(i + 2) : "-" + t.slice(i + 1));
      else if (t === "") return false;
      else t = t[0] === "-" ? t.slice(1) : "-" + t;
      st.entry = c.head + t; return true;
    }

    function exec(id) {
      if (/^[0-9]$/.test(id)) { type(id); return; }
      if (id === ".") { type("."); return; }
      if (id === "EEX") { type("E"); return; }
      if (id === "SPC") { type(" "); return; }
      if (id === "NEG" && st.entry != null && negEntry()) return;
      if (id === "BACK" && st.entry != null) { st.entry = st.entry.slice(0, -1); if (st.entry === "") st.entry = null; return; }
      if (id === "DEL") { st.entry = null; return; }
      if (id === "ON") { st.entry = null; return; }
      if (id === "FIX") { st.mode = st.mode === "FIX" ? "STD" : "FIX"; return; }
      if (id === "SKY" || id === "DAY" || id === "CONST" || id === "MAIN") { st.menu = id; return; }
      if (id === "NXT" || id === "PREV") { st.menu = ORDER[(ORDER.indexOf(st.menu) + (id === "NXT" ? 1 : ORDER.length - 1)) % ORDER.length]; return; }
      if (id === "SUN" || id === "MOON") { st.body = id; return; }
      var soft = /^SOFT([0-5])$/.exec(id), it = soft ? menuItems()[+soft[1]] : null;
      if (soft && (!it || !it.label)) return;
      if (it && it.go) { st.menu = it.go; return; }
      if (it && it.body) { st.body = st.body === "SUN" ? "MOON" : "SUN"; return; }
      if (id === "UNDO") {
        commit(); if (!st.undo) return;
        var u = st.undo; st.undo = st.stack.slice(); st.stack = u; return;
      }
      if (id === "ENTER" && st.entry != null) { var before = st.stack.slice(); commit(); st.undo = before; return; }
      var op = id === "ENTER" || id === "BACK" ? (id === "ENTER" ? "DUP" : "DROP") : id;
      if (!it && !OPS[op]) return;
      var snap = st.stack.slice();
      commit();
      if (it) { var o = it.push(); st.stack.unshift(o); }
      else OPS[op]();
      st.undo = snap;
    }

    function press(id) {
      var shift = st.shift; st.shift = null; st.err = null;
      if (id === "SHL" || id === "SHR") { var s = id === "SHL" ? "L" : "R"; st.shift = shift === s ? null : s; return; }
      var f = shift ? SHIFTED[shift][id] : null;
      try { exec(f || id); }
      catch (e) { if (!(e instanceof Err)) throw e; st.err = e; if (!e.keepEntry) st.entry = null; }
    }

    function pad(l, r) { var n = COLS - l.length - r.length; return n >= 0 ? l + new Array(n + 1).join(" ") + r : (l + r).slice(0, COLS); }
    function fitVal(v, w) { return v.length > w ? v.slice(0, Math.max(1, w - 1)) + "…" : v; }
    function view() {
      var s = sky(), mode = st.mode, lines = [], entryLine = -1, cursorCol = -1;
      var shown = st.entry != null ? LINES - 1 : LINES;
      for (var lvl = shown; lvl >= 1; lvl--) {
        var tag = lvl + ":", o = st.stack[lvl - 1];
        lines.push(pad(tag, o ? fitVal(fmt(o, mode), COLS - tag.length - 1) : ""));
      }
      if (st.entry != null) {
        var e = st.entry, tail = e.length > COLS - 1 ? "…" + e.slice(e.length - COLS + 2) : e;
        lines.push(pad(tail, "")); entryLine = LINES - 1; cursorCol = tail.length;
      }
      var status;
      if (st.err) status = [[(st.err.cmd ? st.err.cmd + " " : "") + "ERROR:", ""], [st.err.msg.toUpperCase(), ""]];
      else {
        var r1 = (st.shift === "L" ? "↰ " : st.shift === "R" ? "↱ " : "") + (s.TIME || "--:--");
        var r2 = st.menu === "SKY" || st.menu === "DAY" ? st.body : "";
        status = [["DEG " + (mode === "FIX" ? "FIX 2" : "STD"), r1], [s.WHERE || "{ HOME }", r2]];
      }
      status = status.map(function (p) {
        var r = p[1], room = STATUS_DOTS - (r ? smallWidth(r) + 4 : 0);
        return [fitSmall(up(p[0]), room), r];
      });
      var menu = menuItems().map(function (m) { return { label: m.label || "", dir: !!m.dir }; });
      return { lines: lines, entryLine: entryLine, cursorCol: cursorCol, status: status, menu: menu, shift: st.shift, err: !!st.err, menuName: st.menu, body: st.body, mode: mode };
    }

    return {
      press: press, view: view,
      state: function () { return { stack: st.stack.map(function (o) { return fmt(o, "STD"); }), raw: st.stack.slice(), entry: st.entry, shift: st.shift, menu: st.menu, body: st.body, mode: st.mode, err: st.err ? (st.err.cmd ? st.err.cmd + " " : "") + "Error: " + st.err.msg : null }; },
      seed: function (items) { if (!st.stack.length && st.entry == null) st.stack = items.slice(); },
      clearError: function () { st.err = null; }
    };
  }

  return { create: create, fmtNum: fmtNum, fmt: fmt, num: num, str: str, smallWidth: smallWidth, fitSmall: fitSmall, toHMS: toHMS, fromHMS: fromHMS,
    wrap360: wrap360, SMALL_W: SMALL_W, SHIFTED: SHIFTED, COLS: COLS, LINES: LINES, CELL_DOTS: CELL_DOTS };
})();
`
