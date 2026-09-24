/* eslint-disable */
// SubSaz Lite v1.2.0 - hostscript.jsx  (com.srt2graphics.panel, ScriptPath)
// ExtendScript ES3 inside Premiere Pro. THIS FILE IS ASCII-ONLY:
// Persian UI strings live in main.js on the CEP side; Persian/Arabic chars
// inside a BOM-less .jsx are read via the system codepage and break parsing
// (every call would answer "EvalScript error."). Non-ASCII literals that are
// genuinely needed (regex for Persian property names) are written as \uXXXX
// escapes so the SOURCE stays pure ASCII.
//
// Architecture (3 layers):
//   CEF panel  --evalScript("s2gFn(arg)")-->  this file  --Scripting API--> Premiere
//   - the panel sends ONE expression per call, ASCII-only, via evalArg/evalLit
//   - this file always answers with a JSON string built by s2gJsonStr
//
// Crash-safety contract (mirrors the panel):
//   - one call = up to CHUNK cues; the panel paces chunks (setTimeout 0)
//   - per-cue try/catch shell: max damage from any exception = 1 cue
//   - clip.end set through 3 fallback layers (Time API differs across builds)
//   - text property found in 4 passes, cached (textPropIndex) and invalidated
//     when runId changes (a different template must never reuse the cache)
//   - readback + one retry catches silent setValue failures
//   - first text failure dumps the MOGRT property structure exactly once
//   - clip.name prefix "S2G|" marks clips owned by this plugin only
//
// v1.1.0 BAKED ENGINE (default on the panel side):
//   Field truth from v1.0.0/v1.0.1: on some hosts (incl. the user's) BOTH the
//   MGT capsule write AND the canonical clip.components write are silently
//   ignored -> every layer shows the template placeholder text. Web research
//   (Adobe forums 2024/2025) confirms the JSON-doc requirement of the text
//   param and that script writes are unreliable across builds. The proven fix
//   (shipped in the full SubSaz panel since v2.x) is the BAKED engine: the
//   CEF side bakes one .mogrt per UNIQUE cue with the text already inside
//   (MogrtBaker, Node in CEF) and the host just imports those files:
//     payload.baked === true  ->  each cue = { i, start, end, path, text }
//     importMGT(cue.path, ...) + 3-layer end + clip.name; NO setValue at all.
//   Engine A (setValue passes 0..5 below) stays intact as the fallback.
//
// v1.2.0 FIELD POST-MORTEM (host crash with the baked engine):
//   The panel paced the baked engine with the CHUNK=15 loop, so this host
//   executed 15 back-to-back importMGT calls of 15 DISTINCT baked files in
//   ONE synchronous run - Premiere's graphics engine never got to breathe
//   and the host crashed. The panel now runs the baked engine through the
//   proven full-panel cadence: ONE cue per call, panel-side pauses, deep
//   breath every 10 layers, and the three stability ops below (ported from
//   the full SubSaz panel v2.2/v2.3):
//     s2gAutoSavePark/Restore - auto-save firing in the middle of heavy
//       importMGT churn is a classic crash trigger; park it for the batch.
//     s2gSaveProject          - guarded protective save (NEVER on an
//       untitled project: save() would pop a modal and block the bridge).

$.global.s2gState = {
  runId: "",
  textPropIndex: -1,
  textPropKind: "",
  compPair: null,   // {c, p} = clip.components path cache (v1.0.1)
  diagDumped: false,
  lastAppliedText: "",
  asPrev: true,     // v1.2.0: auto-save state parked by s2gAutoSavePark
  asParked: false   // v1.2.0: true while a baked batch is in flight
};

var S2G_TICKS_PER_SEC = 254016000000; // 254016 * 10^6
var S2G_NAME_RE = null;               // built once by s2gInitNameRe

function s2gInitNameRe() {
  if (S2G_NAME_RE) { return S2G_NAME_RE; }
  // text|caption|subtitle|title|source|matn|onvan|zirnevis
  // (the Persian words are \u-escaped to keep this file ASCII)
  S2G_NAME_RE = new RegExp(
    "text|caption|subtitle|title|source|" +
    "\\u0645\\u062A\\u0646|" +                    // matn
    "\\u0639\\u0646\\u0648\\u0627\\u0646|" +      // onvan
    "\\u0632\\u06CC\\u0631\\u0646\\u0648\\u06CC\\u0633", // zirnevis
    "i");
  return S2G_NAME_RE;
}

// ---------------------------------------------------------------- JSON (ES3)
// ExtendScript has no native JSON. These two are compact ES3 implementations.
// s2gJsonStr output is pure ASCII (non-ASCII chars -> \uXXXX), so the
// evalScript return value can never be mangled by encodings.
function s2gJsonParse(text) {
  var s = String(text);
  var i = 0;
  var n = s.length;

  function fail(msg) { throw new Error("JSON parse error at " + i + ": " + msg); }
  function ws() {
    while (i < n) {
      var c0 = s.charAt(i);
      if (c0 === " " || c0 === "\t" || c0 === "\n" || c0 === "\r") { i++; } else { break; }
    }
  }
  function ch() { return s.charAt(i); }
  function lit(t) {
    if (s.substr(i, t.length) !== t) { fail("expected " + t); }
    i += t.length;
  }
  function str() {
    i++; // opening quote
    var out = "";
    while (i < n) {
      var c = s.charAt(i);
      if (c === "\"") { i++; return out; }
      if (c === "\\") {
        i++;
        if (i >= n) { fail("bad escape"); }
        var e = s.charAt(i);
        if (e === "\"") { out += "\""; i++; }
        else if (e === "\\") { out += "\\"; i++; }
        else if (e === "/") { out += "/"; i++; }
        else if (e === "b") { out += "\b"; i++; }
        else if (e === "f") { out += "\f"; i++; }
        else if (e === "n") { out += "\n"; i++; }
        else if (e === "r") { out += "\r"; i++; }
        else if (e === "t") { out += "\t"; i++; }
        else if (e === "u") {
          var hex = s.substr(i + 1, 4);
          if (hex.length < 4) { fail("bad \\u escape"); }
          var code = parseInt(hex, 16);
          if (isNaN(code)) { fail("bad \\u hex"); }
          out += String.fromCharCode(code);
          i += 5;
        } else { fail("bad escape \\" + e); }
      } else {
        out += c;
        i++;
      }
    }
    fail("unterminated string");
    return null;
  }
  function num() {
    var start = i;
    if (ch() === "-") { i++; }
    while (i < n && "0123456789".indexOf(ch()) >= 0) { i++; }
    if (ch() === ".") {
      i++;
      while (i < n && "0123456789".indexOf(ch()) >= 0) { i++; }
    }
    if (ch() === "e" || ch() === "E") {
      i++;
      if (ch() === "+" || ch() === "-") { i++; }
      while (i < n && "0123456789".indexOf(ch()) >= 0) { i++; }
    }
    var t = s.substr(start, i - start);
    if (t.length === 0) { fail("bad number"); }
    var v = Number(t);
    if (isNaN(v)) { fail("bad number " + t); }
    return v;
  }
  function val() {
    ws();
    if (i >= n) { fail("eof"); }
    var c = ch();
    if (c === "{") { return obj(); }
    if (c === "[") { return arr(); }
    if (c === "\"") { return str(); }
    if (c === "t") { lit("true"); return true; }
    if (c === "f") { lit("false"); return false; }
    if (c === "n") { lit("null"); return null; }
    if (c === "-" || (c >= "0" && c <= "9")) { return num(); }
    fail("unexpected char " + c);
    return null;
  }
  function obj() {
    i++; // {
    var o = {};
    ws();
    if (ch() === "}") { i++; return o; }
    while (true) {
      ws();
      if (ch() !== "\"") { fail("expected key"); }
      var k = str();
      ws();
      if (ch() !== ":") { fail("expected :"); }
      i++;
      o[k] = val();
      ws();
      if (ch() === ",") { i++; continue; }
      if (ch() === "}") { i++; return o; }
      fail("expected , or }");
    }
  }
  function arr() {
    i++; // [
    var a = [];
    ws();
    if (ch() === "]") { i++; return a; }
    while (true) {
      a[a.length] = val();
      ws();
      if (ch() === ",") { i++; continue; }
      if (ch() === "]") { i++; return a; }
      fail("expected , or ]");
    }
  }

  var result = val();
  ws();
  return result;
}

function s2gQuote(s) {
  var out = "\"";
  var i, c, code, h;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i);
    code = s.charCodeAt(i);
    if (c === "\"") { out += "\\\""; }
    else if (c === "\\") { out += "\\\\"; }
    else if (c === "\n") { out += "\\n"; }
    else if (c === "\r") { out += "\\r"; }
    else if (c === "\t") { out += "\\t"; }
    else if (code < 32 || code > 126) {
      h = code.toString(16).toUpperCase();
      while (h.length < 4) { h = "0" + h; }
      out += "\\u" + h;
    } else {
      out += c;
    }
  }
  return out + "\"";
}

function s2gJsonStr(v, depth) {
  if (depth === undefined) { depth = 0; }
  if (depth > 12) { return "null"; }
  if (v === null || v === undefined) { return "null"; }
  var t = typeof v;
  if (t === "number") { return isFinite(v) ? String(v) : "null"; }
  if (t === "boolean") { return v ? "true" : "false"; }
  if (t === "string") { return s2gQuote(v); }
  if (t === "object") {
    var j, parts;
    if (v instanceof Array) {
      parts = [];
      for (j = 0; j < v.length; j++) { parts[parts.length] = s2gJsonStr(v[j], depth + 1); }
      return "[" + parts.join(",") + "]";
    }
    parts = [];
    for (var k in v) {
      if (!v.hasOwnProperty(k)) { continue; }
      if (typeof v[k] === "function") { continue; }
      parts[parts.length] = s2gQuote(k) + ":" + s2gJsonStr(v[k], depth + 1);
    }
    return "{" + parts.join(",") + "}";
  }
  return "null";
}

// Install a global JSON polyfill too (other code paths may expect it).
if (typeof JSON === "undefined" || !JSON || typeof JSON.parse !== "function") {
  $.global.JSON = {
    parse: function (s) { return s2gJsonParse(String(s)); },
    stringify: function (v) { return s2gJsonStr(v); }
  };
}

// ------------------------------------------------------------------ helpers
function s2gToJSON(o) { return s2gJsonStr(o); }

function s2gAsciiErr(e) {
  var m = "unknown error";
  try {
    if (e && e.message) { m = String(e.message); }
    else if (e) { m = String(e); }
  } catch (e0) {}
  var out = "";
  var i, c, code;
  for (i = 0; i < m.length; i++) {
    c = m.charAt(i);
    code = m.charCodeAt(i);
    if (code >= 32 && code <= 126) { out += c; }
    else if (code === 10 || code === 13) { out += " "; }
  }
  if (out.length > 200) { out = out.substring(0, 200); }
  return out;
}

function s2gGetSeq() {
  try {
    if (app && app.project && app.project.activeSequence) { return app.project.activeSequence; }
  } catch (e0) {}
  try {
    if (app && app.project && app.project.sequences &&
        Number(app.project.sequences.numSequences) === 1) {
      return app.project.sequences[0];
    }
  } catch (e1) {}
  return null;
}

function s2gSecToTicks(s) {
  var v = Number(s);
  if (isNaN(v)) { v = 0; }
  if (v < 0) { v = 0; }
  return String(Math.round(v * S2G_TICKS_PER_SEC));
}

function s2gIsPureNumeric(s) {
  var t = String(s);
  if (t.length === 0) { return false; }
  var i, c;
  for (i = 0; i < t.length; i++) {
    c = t.charAt(i);
    if ("0123456789.-+ %".indexOf(c) < 0) { return false; }
  }
  return true;
}

function s2gEqText(a, b) {
  function norm(x) {
    var t = String(x).split("\r\n").join("\n").split("\r").join("\n");
    while (t.length > 0 && " \t\n".indexOf(t.charAt(0)) >= 0) { t = t.substring(1); }
    while (t.length > 0 && " \t\n".indexOf(t.charAt(t.length - 1)) >= 0) { t = t.substring(0, t.length - 1); }
    return t;
  }
  return norm(a) === norm(b);
}

// ------------------------------------------------------------------- public
function s2gPing() {
  return s2gToJSON({ ok: true, ver: "1.2.0", name: "srt2graphics" });
}

// ------------------------------------------------------------ v1.2.0 ops
// Ported verbatim (renamed) from the full SubSaz panel, where this exact
// trio has kept month-long batch runs crash-free. All guarded: some hosts
// lack these undocumented methods, and every failure is non-fatal.
function s2gAutoSavePark() {
  try {
    if (typeof app === "undefined" || !app || !app.setEnableAutoSave) {
      return s2gToJSON({ ok: true, parked: false });
    }
    var prev = true;
    try { if (app.getEnableAutoSave) { prev = !!app.getEnableAutoSave(); } } catch (eR) { prev = true; }
    try { app.setEnableAutoSave(false); } catch (eS) { return s2gToJSON({ ok: true, parked: false }); }
    s2gState.asPrev = prev;
    s2gState.asParked = true;
    return s2gToJSON({ ok: true, parked: true });
  } catch (eO) { return s2gToJSON({ ok: true, parked: false }); }
}

function s2gAutoSaveRestore() {
  var restored = false;
  if (s2gState.asParked) {
    s2gState.asParked = false;
    try { app.setEnableAutoSave(!!s2gState.asPrev); restored = true; } catch (eS) { restored = false; }
  }
  return s2gToJSON({ ok: true, restored: restored });
}

// ONE protective save, guarded. NEVER on an untitled project: save() would
// pop a modal dialog and block the bridge. The panel calls this every 10
// layers as a mid-run recovery point (crash -> reopen -> saved state).
function s2gSaveProject() {
  try {
    var ppath = "";
    try { ppath = String(app.project.path || ""); } catch (eP) { ppath = ""; }
    if (!ppath) { return s2gToJSON({ ok: true, saved: false, why: "untitled" }); }
    app.project.save();
    return s2gToJSON({ ok: true, saved: true });
  } catch (eS) { return s2gToJSON({ ok: true, saved: false, why: "error" }); }
}

function s2gResetState() {
  s2gState.runId = "";
  s2gState.textPropIndex = -1;
  s2gState.textPropKind = "";
  s2gState.compPair = null;
  s2gState.diagDumped = false;
  s2gState.lastAppliedText = "";
  return s2gToJSON({ ok: true });
}

function s2gListTracks() {
  var seq = s2gGetSeq();
  if (!seq) { return s2gToJSON({ ok: false, code: "NO_SEQUENCE" }); }
  var tracks = [];
  try {
    var vt = seq.videoTracks;
    var n = Number(vt.numTracks);
    for (var i = 0; i < n; i++) {
      var nm = "";
      try { nm = String(vt[i].name || ""); } catch (e1) { nm = ""; }
      var cc = -1;
      try { cc = Number(vt[i].clips.numItems); } catch (e2) { cc = -1; }
      tracks[tracks.length] = { i: i, name: nm, clips: cc };
    }
  } catch (e0) {
    return s2gToJSON({ ok: false, code: "NO_SEQUENCE" });
  }
  return s2gToJSON({ ok: true, seqName: String(seq.name || ""), tracks: tracks });
}

// Panel call: s2gValidate(<evalLit(mogrtPath)>, <trackIndex>)
function s2gValidate(pathStr, trackIndex) {
  var seq = s2gGetSeq();
  if (!seq) { return s2gToJSON({ ok: false, code: "NO_SEQUENCE" }); }
  try {
    if (!app.project) { return s2gToJSON({ ok: false, code: "NO_PROJECT" }); }
  } catch (eP) {
    return s2gToJSON({ ok: false, code: "NO_PROJECT" });
  }
  var ti = Number(trackIndex);
  if (isNaN(ti) || ti < 0) { return s2gToJSON({ ok: false, code: "BAD_TRACK" }); }
  var vt = null;
  try { vt = seq.videoTracks; } catch (eV) {}
  if (!vt || ti >= Number(vt.numTracks)) { return s2gToJSON({ ok: false, code: "TRACK_MISSING" }); }

  var path = String(pathStr || "");
  // defense: if the panel ever double-stringified the path, unwrap it
  if (path.length >= 2 && path.charAt(0) === "\"") {
    var unwrapped = null;
    try { unwrapped = s2gJsonParse(path); } catch (eJ) {}
    if (typeof unwrapped === "string") { path = unwrapped; }
  }
  if (path === "") { return s2gToJSON({ ok: false, code: "MOGRT_MISSING" }); }
  var lower = path.toLowerCase();
  if (lower.length < 6 || lower.substr(lower.length - 6) !== ".mogrt") {
    return s2gToJSON({ ok: false, code: "NO_MOGRT" });
  }
  var f = null;
  try { f = new File(path); } catch (eF) {}
  if (!f || !f.exists) { return s2gToJSON({ ok: false, code: "MOGRT_MISSING" }); }
  return s2gToJSON({ ok: true, seqName: String(seq.name || ""), trackCount: Number(vt.numTracks) });
}

// Only clips THIS plugin created carry the "S2G|" name prefix.
function s2gClearPrevious(trackIndex) {
  var seq = s2gGetSeq();
  if (!seq) { return s2gToJSON({ ok: false, code: "NO_SEQUENCE" }); }
  var removed = 0;
  try {
    var track = seq.videoTracks[Number(trackIndex)];
    var clips = track.clips;
    for (var i = clips.numItems - 1; i >= 0; i--) {
      var nm = "";
      try { nm = String(clips[i].name || ""); } catch (e1) {}
      if (nm.indexOf("S2G|") === 0) {
        try { clips[i].remove(true); removed++; }
        catch (e2) {
          try { clips[i].remove(); removed++; } catch (e3) {}
        }
      }
    }
  } catch (e0) {
    return s2gToJSON({ ok: false, code: "BAD_TRACK", removed: removed });
  }
  return s2gToJSON({ ok: true, removed: removed });
}

// ------------------------------------------------------------- text writing
function s2gGetProps(clip) {
  var comp = null;
  try { comp = clip.getMGTComponent(); } catch (eC) { comp = null; }
  if (!comp) { return null; }
  var props = null;
  try { props = comp.properties; } catch (eP) { props = null; }
  return props;
}

function s2gPropCount(props) {
  try { return Number(props.numItems); } catch (e) { return 0; }
}

// s2gMutateTextValue: the heart of set-text. Returns the NEW value
// (string or live object) or null when this current value is not a text doc.
// Two shapes exist across Premiere builds:
//   A) getValue() returns a JSON STRING ("{\"textEditValue\":...}")
//   B) getValue() returns a live OBJECT ({textEditValue: ...})
function s2gMutateTextValue(cur, text) {
  var obj;
  if (typeof cur === "string") {
    if (cur.length > 1 && cur.charAt(0) === "{") {
      try { obj = s2gJsonParse(cur); } catch (e1) { return null; }
      if (obj && typeof obj === "object" && !(obj instanceof Array)) {
        if (typeof obj.textEditValue === "string") { obj.textEditValue = text; return s2gJsonStr(obj); }
        if (typeof obj.text === "string") { obj.text = text; return s2gJsonStr(obj); }
        if (typeof obj.value === "string") { obj.value = text; return s2gJsonStr(obj); }
      }
      return null;
    }
    return null;
  }
  if (cur && typeof cur === "object") {
    if (typeof cur.textEditValue === "string") { cur.textEditValue = text; return cur; }
    if (cur.sourceText && typeof cur.sourceText === "object" &&
        typeof cur.sourceText.textEditValue === "string") {
      cur.sourceText.textEditValue = text;
      return cur;
    }
    if (typeof cur.text === "string") { cur.text = text; return cur; }
    return null;
  }
  return null;
}

// ---- Pass-5 engine: the canonical clip.components path (v1.0.1) ----------
// Field report: on some Premiere builds the MGT capsule property accepts the
// write but the graphics text never changes (or the capsule cannot be used
// at all). The documented alternative is: clip.components -> component
// "Text" (AE.ADBE Text) -> property "Source Text" -> setValue. This engine
// adds that path as pass 5 with its own per-run cache (compPair).
function s2gIsTextish(name) {
  var s = String(name || "");
  return s !== "" && S2G_NAME_RE.test(s);
}

function s2gCompTextCandidates(clip) {
  var out = [];
  var comps = null;
  try { comps = clip.components; } catch (eC0) { return out; }
  if (!comps) { return out; }
  var nc = 0;
  try { nc = Number(comps.numItems); } catch (eC1) { return out; }
  for (var ci = 0; ci < nc; ci++) {
    var comp = null, cdn = "", props = null, np = 0;
    try { comp = comps[ci]; } catch (eC2) { continue; }
    if (!comp) { continue; }
    try { cdn = String(comp.displayName || ""); } catch (eC3) {}
    try { props = comp.properties; } catch (eC4) { continue; }
    if (!props) { continue; }
    try { np = Number(props.numItems); } catch (eC5) { continue; }
    var compTextish = s2gIsTextish(cdn); // e.g. the "Text" (AE.ADBE Text) comp
    for (var pi = 0; pi < np; pi++) {
      var prop = null, pdn = "";
      try { prop = props[pi]; } catch (eC6) { continue; }
      if (!prop) { continue; }
      try { pdn = String(prop.displayName || ""); } catch (eC7) {}
      if (pdn === "Source Text" || s2gIsTextish(pdn) || compTextish) {
        out[out.length] = { c: ci, p: pi, prop: prop, dn: pdn };
      }
    }
  }
  // "Source Text" first (canonical), then every other candidate in scan order
  out.sort(function (a, b) {
    var x = (a.dn === "Source Text") ? 0 : 1;
    var y = (b.dn === "Source Text") ? 0 : 1;
    return x - y;
  });
  return out;
}

function s2gApplyCompProp(prop, text) {
  // Write in the shape of the CURRENT value when that shape is a known text
  // document; plain string as the universal fallback. Numeric params are
  // refused outright (never write text into Font Size / Opacity).
  var cur = null;
  try { cur = prop.getValue(); } catch (eV) { cur = null; }
  if (cur !== null && typeof cur === "number") { return false; }
  if (typeof cur === "string" && s2gIsPureNumeric(cur)) { return false; }
  var shaped = null;
  if (cur && (typeof cur === "object" ||
      (typeof cur === "string" && cur.length > 1 && cur.charAt(0) === "{"))) {
    shaped = s2gMutateTextValue(cur, text); // null when unknown JSON shape
  }
  if (shaped !== null) {
    try { prop.setValue(shaped); s2gState.lastAppliedText = text; return true; } catch (eS1) {}
  }
  try { prop.setValue(text); s2gState.lastAppliedText = text; return true; } catch (eS2) {}
  if (shaped !== null) {
    try { prop.setValue(shaped, true); s2gState.lastAppliedText = text; return true; } catch (eS3) {}
  }
  try { prop.setValue(text, true); s2gState.lastAppliedText = text; return true; } catch (eS4) {}
  return false;
}

function s2gApplyCompPair(clip, pair, text) {
  var comps = null;
  try { comps = clip.components; } catch (eP0) { return false; }
  if (!comps) { return false; }
  var comp = null;
  try { comp = comps[Number(pair.c)]; } catch (eP1) { return false; }
  if (!comp) { return false; }
  var props = null;
  try { props = comp.properties; } catch (eP2) { return false; }
  var np = 0;
  try { np = Number(props.numItems); } catch (eP3) { return false; }
  if (Number(pair.p) >= np) { return false; }
  var prop = null;
  try { prop = props[Number(pair.p)]; } catch (eP4) { return false; }
  if (!prop) { return false; }
  return s2gApplyCompProp(prop, text);
}

function s2gSetTextCompPath(clip, text) {
  var cands = s2gCompTextCandidates(clip);
  for (var i = 0; i < cands.length; i++) {
    if (s2gApplyCompProp(cands[i].prop, text)) {
      s2gState.compPair = { c: cands[i].c, p: cands[i].p };
      s2gState.textPropKind = "comp";
      return { ok: true, index: -1, kind: "comp" };
    }
  }
  return { ok: false, index: -1, kind: "", reason: "comp path empty" };
}

// kind: "auto" | "json" | "obj" | "string"
function s2gApplyToProp(prop, text, kind) {
  var cur = null;
  try { cur = prop.getValue(); } catch (eV) { cur = null; }
  var val = null;

  if (kind === "json" || kind === "obj") {
    val = s2gMutateTextValue(cur, text);
    if (val === null) { return false; }
  } else if (kind === "auto") {
    if (typeof cur === "string") {
      if (cur.length > 1 && cur.charAt(0) === "{") {
        val = s2gMutateTextValue(cur, text);
        if (val === null) {
          // looked like JSON but is not -> treat as a plain string
          if (s2gIsPureNumeric(cur)) { return false; }
          val = text;
        }
      } else {
        if (s2gIsPureNumeric(cur)) { return false; } // never write into "50" (Opacity)
        val = text;
      }
    } else if (cur === null || cur === undefined) {
      val = text;
    } else if (typeof cur === "object") {
      val = s2gMutateTextValue(cur, text);
      if (val === null) { return false; }
    } else {
      return false;
    }
  } else { // "string": empty/null fields, or the field this run wrote before
    if (cur === null || cur === undefined || cur === "" ||
        (s2gState.lastAppliedText !== "" && cur === s2gState.lastAppliedText)) {
      val = text;
    }
    else { return false; }
  }

  try { prop.setValue(val); s2gState.lastAppliedText = text; return true; }
  catch (eS1) {
    try { prop.setValue(val, true); s2gState.lastAppliedText = text; return true; } // some builds need 2 args
    catch (eS2) { return false; }
  }
}

function s2gSetText(clip, text) {
  var props = s2gGetProps(clip);
  if (!props) { return { ok: false, index: -1, kind: "", reason: "no MGT component" }; }
  var n = s2gPropCount(props);
  if (n <= 0) { return { ok: false, index: -1, kind: "", reason: "no properties" }; }

  // Pass 0: cached property from earlier cues of the same run
  if (s2gState.textPropIndex >= 0 && s2gState.textPropIndex < n) {
    var cached = null;
    try { cached = props[s2gState.textPropIndex]; } catch (eC) { cached = null; }
    if (cached) {
      var ck = s2gState.textPropKind || "auto";
      if (s2gApplyToProp(cached, text, ck)) {
        return { ok: true, index: s2gState.textPropIndex, kind: ck };
      }
    }
    // stale cache -> invalidate, fall through to a full scan
    s2gState.textPropIndex = -1;
    s2gState.textPropKind = "";
  }

  // Pass 0b: cached component-pair from an earlier cue of the same run
  if (s2gState.compPair) {
    if (s2gApplyCompPair(clip, s2gState.compPair, text)) {
      return { ok: true, index: -1, kind: "comp" };
    }
    s2gState.compPair = null;
    s2gState.textPropKind = "";
  }

  s2gInitNameRe();
  var i, prop, dn, cur;

  // Pass 1: displayName matches a known text-ish name
  for (i = 0; i < n; i++) {
    prop = null; dn = "";
    try { prop = props[i]; dn = String(prop.displayName || ""); } catch (e1) { continue; }
    if (dn !== "" && S2G_NAME_RE.test(dn)) {
      if (s2gApplyToProp(prop, text, "auto")) { return { ok: true, index: i, kind: "auto" }; }
    }
  }

  // Pass 2: value is a JSON STRING carrying textEditValue/text/value
  for (i = 0; i < n; i++) {
    prop = null; cur = null;
    try { prop = props[i]; cur = prop.getValue(); } catch (e2) { continue; }
    if (typeof cur === "string" && cur.length > 1 && cur.charAt(0) === "{") {
      if (s2gApplyToProp(prop, text, "json")) { return { ok: true, index: i, kind: "json" }; }
    }
  }

  // Pass 3: value is a live OBJECT carrying textEditValue/text/value
  for (i = 0; i < n; i++) {
    prop = null; cur = null;
    try { prop = props[i]; cur = prop.getValue(); } catch (e3) { continue; }
    if (cur && typeof cur === "object") {
      if (s2gApplyToProp(prop, text, "obj")) { return { ok: true, index: i, kind: "obj" }; }
    }
  }

  // Pass 4: empty/null fields, or the field this run wrote before (an
  // anonymous text field still holds the PREVIOUS cue's text), never numbers
  for (i = 0; i < n; i++) {
    prop = null; cur = null;
    try { prop = props[i]; cur = prop.getValue(); } catch (e4) { continue; }
    if (cur === null || cur === undefined || cur === "" ||
        (s2gState.lastAppliedText !== "" && cur === s2gState.lastAppliedText)) {
      if (s2gApplyToProp(prop, text, "string")) { return { ok: true, index: i, kind: "string" }; }
    }
  }

  // Pass 5 (v1.0.1): the canonical clip.components path. Runs only after the
  // MGT capsule failed all four passes, so builds where the capsule works
  // keep the exact same behavior as v1.0.0.
  var resComp = s2gSetTextCompPath(clip, text);
  if (resComp.ok) { return resComp; }

  return { ok: false, index: -1, kind: "", reason: "no match among " + n + " props" };
}

function s2gDecodeTextValue(v) {
  if (typeof v === "string") {
    if (v.length > 1 && v.charAt(0) === "{") {
      var o = null;
      try { o = s2gJsonParse(v); } catch (eJ) { o = null; }
      if (o && typeof o === "object" && typeof o.textEditValue === "string") { return o.textEditValue; }
      if (o && typeof o === "object" && typeof o.text === "string") { return o.text; }
      if (o && typeof o === "object" && typeof o.value === "string") { return o.value; }
      return v;
    }
    return v;
  }
  if (v && typeof v === "object") {
    if (typeof v.textEditValue === "string") { return v.textEditValue; }
    if (v.sourceText && typeof v.sourceText.textEditValue === "string") { return v.sourceText.textEditValue; }
    if (typeof v.text === "string") { return v.text; }
  }
  return null;
}

function s2gReadCompPair(clip, pair) {
  var comps = null;
  try { comps = clip.components; } catch (eR0) { return null; }
  if (!comps) { return null; }
  var comp = null;
  try { comp = comps[Number(pair.c)]; } catch (eR1) { return null; }
  if (!comp) { return null; }
  var props = null;
  try { props = comp.properties; } catch (eR2) { return null; }
  var prop = null;
  try { prop = props[Number(pair.p)]; } catch (eR3) { return null; }
  if (!prop) { return null; }
  try { return s2gDecodeTextValue(prop.getValue()); } catch (eR4) { return null; }
}

function s2gReadText(clip) {
  // v1.0.1: when the text was written through the components path, read
  // the value back from there (the MGT capsule may not reflect it).
  if (s2gState.textPropKind === "comp" && s2gState.compPair) {
    return s2gReadCompPair(clip, s2gState.compPair);
  }
  var props = s2gGetProps(clip);
  if (!props) { return null; }
  var n = s2gPropCount(props);
  var idx = s2gState.textPropIndex;
  if (idx < 0 || idx >= n) { return null; } // caller treats null as "cannot verify"
  try {
    var v = props[idx].getValue();
    if (typeof v === "string") {
      if (v.length > 1 && v.charAt(0) === "{") {
        var o = s2gJsonParse(v);
        if (o && typeof o === "object" && typeof o.textEditValue === "string") { return o.textEditValue; }
        return v;
      }
      return v;
    }
    if (v && typeof v === "object") {
      if (typeof v.textEditValue === "string") { return v.textEditValue; }
      if (v.sourceText && typeof v.sourceText.textEditValue === "string") { return v.sourceText.textEditValue; }
      if (typeof v.text === "string") { return v.text; }
    }
  } catch (e1) { return null; }
  return null;
}

// One-shot diagnostics: the real property structure of the failing MOGRT.
function s2gPreviewValue(v, max) {
  var s;
  if (v === null || v === undefined) { s = ""; }
  else if (typeof v === "object") { s = s2gJsonStr(v); }
  else { s = String(v); }
  if (s.length > max) { s = s.substring(0, max) + "..."; }
  return s;
}

function s2gDumpPropsJson(clip) {
  var out = { mgt: [], comps: [] }; // v1.0.1: also dump the components tree
  try {
    var props = s2gGetProps(clip);
    if (props) {
      var n = s2gPropCount(props);
      if (n > 24) { n = 24; } // keep the reply small
      for (var i = 0; i < n; i++) {
        var o = { i: i, dn: "", val: "" };
        try { o.dn = String(props[i].displayName || ""); } catch (e1) {}
        try { o.val = s2gPreviewValue(props[i].getValue(), 120); } catch (e2) { o.val = "<err>"; }
        out.mgt[out.mgt.length] = o;
      }
    }
  } catch (e0) {}
  try {
    var cands = s2gCompTextCandidates(clip);
    var mc = cands.length > 12 ? 12 : cands.length;
    for (var k = 0; k < mc; k++) {
      var q = { c: cands[k].c, p: cands[k].p, dn: cands[k].dn, val: "" };
      try { q.val = s2gPreviewValue(cands[k].prop.getValue(), 120); } catch (e3) { q.val = "<err>"; }
      out.comps[out.comps.length] = q;
    }
  } catch (e4) {}
  return s2gJsonStr(out);
}

// -------------------------------------------------------------- chunk insert
// Panel call: s2gInsertChunk(<evalArg({runId, mogrtPath, trackIndex, cues})>)
function s2gInsertChunk(payloadJson) {
  var p = null;
  if (typeof payloadJson === "string") {
    try { p = s2gJsonParse(payloadJson); }
    catch (eP) { return s2gToJSON({ ok: false, code: "BAD_PAYLOAD" }); }
  } else if (payloadJson && typeof payloadJson === "object") {
    p = payloadJson; // defense: panel always sends a string, but be safe
  }
  if (!p || !p.cues || typeof p.cues.length !== "number" || p.cues.length === 0) {
    return s2gToJSON({ ok: false, code: "BAD_PAYLOAD" });
  }

  // runId lock: a new run must never reuse the previous template's cache
  if (p.runId && p.runId !== s2gState.runId) {
    s2gState.runId = String(p.runId);
    s2gState.textPropIndex = -1;
    s2gState.textPropKind = "";
    s2gState.compPair = null;
    s2gState.lastAppliedText = "";
  }

  var seq = s2gGetSeq();
  if (!seq) { return s2gToJSON({ ok: false, code: "NO_SEQUENCE" }); }

  var trackIdx = Number(p.trackIndex);
  var path = String(p.mogrtPath || "");
  // v1.1.0: baked engine - one pre-baked .mogrt file per cue (text inside).
  var isBaked = (p.baked === true);
  var cues = p.cues;
  var inserted = 0;
  var skipped = 0;
  var errors = [];

  for (var ci = 0; ci < cues.length; ci++) {
    var cue = cues[ci];
    var cueI = "?";
    try { cueI = String(cue.i); } catch (eI) {}
    try { // ---- per-cue fault isolation shell: max damage = 1 cue ----
      var text = String(cue.text);
      var startTicks = s2gSecToTicks(cue.start);
      var endTicks = s2gSecToTicks(cue.end);

      var clip = null;
      // baked mode: every cue imports ITS OWN file (text already inside).
      var srcPath = isBaked ? String(cue.path || "") : path;
      if (isBaked && srcPath === "") {
        skipped++;
        errors[errors.length] = "cue " + cueI + ": baked path missing";
        continue;
      }
      if (isBaked) {
        var bf = null;
        try { bf = new File(srcPath); } catch (eBF) { bf = null; }
        if (!bf || !bf.exists) {
          skipped++;
          errors[errors.length] = "cue " + cueI + ": baked file missing";
          continue;
        }
      }
      // known-good signature: importMGT(path, ticksString, videoTrack, -1)
      try { clip = seq.importMGT(srcPath, startTicks, trackIdx, -1); } catch (eImp) { clip = null; }
      if (!clip) {
        skipped++;
        errors[errors.length] = "cue " + cueI + ": importMGT returned null";
        continue;
      }

      // set END: three fallback layers (Time API differs across builds)
      try {
        var endT = new Time();
        endT.ticks = endTicks;
        clip.end = endT;
      } catch (eEnd1) {
        try { clip.end.ticks = endTicks; }
        catch (eEnd2) {
          try { clip.end.seconds = Number(cue.end); }
          catch (eEnd3) { errors[errors.length] = "cue " + cueI + ": set end failed"; }
        }
      }

      // set TEXT + verify (readback + one retry; MGT is sometimes not ready)
      // Baked mode skips ALL of this - the text is part of the file itself.
      if (!isBaked) {
      var res = s2gSetText(clip, text);
      if (res && res.ok) {
        if (s2gState.textPropIndex < 0 && res.index >= 0) {
          s2gState.textPropIndex = res.index;
          s2gState.textPropKind = res.kind;
        }
        var readback = s2gReadText(clip);
        if (readback !== null && !s2gEqText(readback, text)) {
          var res2 = s2gSetText(clip, text); // retry (now escalates to pass 5)
          var rb2 = (res2 && res2.ok) ? s2gReadText(clip) : null;
          if (rb2 !== null && !s2gEqText(rb2, text) && s2gState.textPropKind !== "comp") {
            // v1.0.1 escalation: the capsule write "took" but the graphics
            // text did not change -> force the canonical components path.
            s2gState.textPropIndex = -1;
            s2gState.textPropKind = "";
            var res3 = s2gSetTextCompPath(clip, text);
            var rb3 = (res3 && res3.ok) ? s2gReadText(clip) : null;
            if (rb3 === null || !s2gEqText(rb3, text)) {
              errors[errors.length] = "cue " + cueI + ": text not applied (readback mismatch)";
            }
          } else if (rb2 !== null && !s2gEqText(rb2, text)) {
            errors[errors.length] = "cue " + cueI + ": text not applied (readback mismatch)";
          }
        }
      } else {
        errors[errors.length] = "cue " + cueI + ": no text field in MOGRT" +
          (res && res.reason ? (" (" + s2gAsciiErr(res.reason) + ")") : "");
        if (!s2gState.diagDumped) {
          s2gState.diagDumped = true; // one-shot DUMP for the whole run
          errors[errors.length] = "DUMP " + s2gDumpPropsJson(clip);
        }
      }
      } // end !isBaked

      try { clip.name = "S2G|" + text.substring(0, 60); } catch (eN) {}
      inserted++;
    } catch (eCue) { // nothing escapes this shell
      skipped++;
      errors[errors.length] = "cue " + cueI + ": " + s2gAsciiErr(eCue);
    }
  }

  return s2gToJSON({ ok: true, inserted: inserted, skipped: skipped, errors: errors });
}
