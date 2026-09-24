/* SubSaz Lite v1.1.1 — core.js
 * The evalScript bridge + safe encoding + Persian error translation.
 * Runs in CEF (this file never touches Premiere APIs directly).
 *
 * Contract with the host (jsx/hostscript.jsx, ASCII-only ES3):
 *   - every call is ONE expression:  fn(arg)  where arg is ASCII-only
 *   - the host always answers with a JSON string (toJSON)
 *   - payloads (Persian text!) go through evalArg  -> \uXXXX inside JSON
 *   - raw literals (file path, number)  go through evalLit -> one quote layer
 */
(function (global) {
  "use strict";

  var CHUNK_SIZE = 15;   // cues per evalScript call (320 cues -> ~22 round-trips)
  var GUARD_MS = 15000;  // single-call watchdog; the queue must never die

  // ---------- safeParse ----------
  function safeParse(s) {
    if (s === "EvalScript error.") {
      return { ok: false, code: "EVAL_ERROR", error: s };
    }
    if (s === null || s === undefined || s === "") {
      return { ok: false, code: "EMPTY_REPLY", error: "empty reply" };
    }
    try {
      return JSON.parse(s);
    } catch (e) {
      return { ok: false, code: "BAD_JSON", error: String(s).slice(0, 200) };
    }
  }

  // ---------- evalArg / evalLit ----------
  function toU(ch) {
    return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
  }

  // evalArg(obj) — object payload; host receives JSON.parse-able ASCII.
  // Without escaping, Persian/control chars inside the expression cause
  // a SyntaxError -> "EvalScript error." on every call.
  function evalArg(obj) {
    var json = JSON.stringify(obj);
    var ascii = json.replace(/[\u0080-\uFFFF]/g, toU);
    return JSON.stringify(ascii); // one extra quote layer -> a JS string literal
  }

  // evalLit(v) — raw literal (file path / number). Exactly ONE quote+escape
  // layer. History: applying evalArg to a path double-stringified it and the
  // host saw "\"C:\\Users\\...\"" -> phantom MOGRT_MISSING.
  function evalLit(v) {
    if (typeof v === "number" && isFinite(v)) return String(v);
    return JSON.stringify(String(v)).replace(/[\u0080-\uFFFF]/g, toU);
  }

  // ---------- single-flight queue with a 15s guard ----------
  // ExtendScript is NOT concurrent: parallel evalScript = race + crash.
  // queueBusy guarantees zero overlap; the guard guarantees the queue can
  // never deadlock if a callback never arrives; `done` (both sides) blocks
  // double-callbacks and ignores late replies after the guard fired.
  function createBridge(evalScriptFn, guardMs) {
    var GUARD = guardMs || GUARD_MS;
    var queue = [];
    var queueBusy = false;

    function pump() {
      if (queueBusy) return;        // never 2 evalScript at once
      if (queue.length === 0) return;
      var job = queue.shift();
      queueBusy = true;
      var expr = job.fn + "(" + job.arg + ")";
      var done = false;
      var guard = setTimeout(function () {
        if (done) return;
        done = true;
        queueBusy = false;
        job.cb({ ok: false, code: "EMPTY_REPLY", error: "timeout after " + GUARD + "ms" });
        pump();                     // the queue must not die
      }, GUARD);
      try {
        evalScriptFn(expr, function (result) {
          if (done) return;         // late reply after timeout -> ignored
          done = true;
          clearTimeout(guard);
          queueBusy = false;
          job.cb(safeParse(result));
          pump();
        });
      } catch (eSync) {             // sync throw -> queue must not die either
        if (done) return;
        done = true;
        clearTimeout(guard);
        queueBusy = false;
        job.cb({ ok: false, code: "EVAL_ERROR", error: String((eSync && eSync.message) || eSync) });
        pump();
      }
    }

    function callHost(fn, argStr, cb) {
      queue.push({ fn: fn, arg: argStr || "", cb: cb });
      pump();
    }

    return {
      callHost: callHost,
      pending: function () { return queue.length; },
      isBusy: function () { return queueBusy; }
    };
  }

  // ---------- error translation (host speaks ASCII, UI speaks Persian) ----------
  var FATAL_CODES = ["NO_SEQUENCE", "NO_PROJECT", "TRACK_MISSING", "BAD_TRACK",
                     "MOGRT_MISSING", "NO_MOGRT", "EVAL_ERROR"];

  function isFatalCode(code) {
    for (var i = 0; i < FATAL_CODES.length; i++) {
      if (FATAL_CODES[i] === code) return true;
    }
    return false;
  }

  function trError(code) {
    switch (code) {
      case "NO_SEQUENCE":  return "هیچ سکانسی باز نیست — ابتدا پروژه و سکانس را در پریمیر باز کنید.";
      case "NO_PROJECT":   return "هیچ پروژه‌ای باز نیست.";
      case "TRACK_MISSING":return "ترک انتخابی پیدا نشد — فهرست ترک‌ها دوباره بارگذاری می‌شود.";
      case "BAD_TRACK":    return "ترک مقصد نامعتبر است.";
      case "MOGRT_MISSING":return "فایل MOGRT پیدا نشد — دوباره انتخابش کنید.";
      case "NO_MOGRT":     return "فایل انتخاب‌شده MOGRT نیست (پسوند .mogrt).";
      case "EVAL_ERROR":   return "خطای اجرای اسکریپت در پریمیر (EvalScript error).";
      case "BAD_JSON":     return "پاسخ نامعتبر از پریمیر (BAD_JSON).";
      case "EMPTY_REPLY":  return "پاسخی از پریمیر نرسید (تایم‌اوت) — چانک بعدی ادامه پیدا کرد.";
      case "BAD_PAYLOAD":  return "داده‌ی ارسالی به پریمیر خراب بود (BAD_PAYLOAD).";
      default:             return "خطای ناشناخته (" + code + ").";
    }
  }

  function trReason(r) {
    var s = String(r || "");
    if (s === "no MGT component") return "کامپوننت گرافیک یافت نشد";
    if (s === "no properties") return "پراپرتی‌ای یافت نشد";
    var m = s.match(/^no match among (\d+) props$/);
    if (m) return "هیچ فیلد متنی از بین " + m[1] + " پراپرتی پیدا نشد";
    return s;
  }

  var HOST_MSG_DICT = {
    "importMGT returned null": "درج کلیپ MOGRT ناموفق بود",
    "no text field in MOGRT": "فیلد متن در MOGRT پیدا نشد",
    "text not applied (readback mismatch)": "متن اعمال شد ولی بازخوانی با متن یکسان نبود (یک بار تلاش مجدد شد)",
    "text not applied (retry failed)": "متن اعمال نشد (تلاش مجدد هم ناموفق بود)",
    "set end failed": "تنظیم زمان پایان کلیپ ناموفق بود",
    "baked path missing": "مسیر فایل بیکری این زیرنویس گم شد",
    "baked file missing": "فایل بیکری این زیرنویس روی دیسک پیدا نشد"
  };

  // "cue 3: no text field in MOGRT (no match among 12 props)" -> Persian line
  // DUMP lines are handled by the caller (tryShowDump), not here.
  function trHostMsg(msg) {
    var m = String(msg || "").match(/^cue (\d+): (.*)$/);
    if (!m) return null;
    var n = m[1], rest = m[2];
    var rm = rest.match(/^no text field in MOGRT \((.*)\)$/);
    if (rm) return "کیو " + n + ": فیلد متن در MOGRT پیدا نشد (" + trReason(rm[1]) + ")";
    if (HOST_MSG_DICT[rest]) return "کیو " + n + ": " + HOST_MSG_DICT[rest];
    return "کیو " + n + ": " + rest;
  }

  // v1.1.1 — translate MogrtBaker failure codes into Persian WITH the remedy.
  // Field lesson: a raw code like "E_NONODE" tells the user nothing; the same
  // failure silently degraded into the broken direct engine and the user saw
  // the placeholder bug AGAIN. Every bake failure must name the next action.
  function trBakeErr(err) {
    var s = String(err || "");
    if (s.indexOf("E_NONODE") === 0) return "Node در پنل غیرفعال است — پریمیر را کامل ببندید و دوباره باز کنید (بعد از نصب/به‌روزرسانی پنل حتماً لازم است).";
    if (s.indexOf("E_TPLREAD") === 0) return "فایل قالب خوانده نشد — فایل MOGRT را دوباره انتخاب کنید (یا جایش را عوض نکنید تا پایان کار).";
    if (s.indexOf("E_EMPTYOLDTEXT") === 0) return "متن نمونه‌ی داخل قالب خالی است — در پریمیر داخل قالب یک متن نمونه بنویسید و دوباره به‌عنوان MOGRT اکسپورت کنید.";
    if (s.indexOf("E_NOTEXTCTL") === 0) return "این قالب فیلد متن قابل‌تشخیص ندارد — داخل قالب یک لایه‌ی متن با متن نمونه بگذارید و دوباره اکسپورت کنید.";
    if (s.indexOf("E_NODEF") === 0 || s.indexOf("E_DEFJSON") === 0) return "ساختار definition.json این قالب خوانده نشد — قالب باید از پنل گرافیک اساسی پریمیر اکسپورت شده باشد (نه از افترافکت).";
    if (s.indexOf("E_NOPRGRAPHIC") === 0 || s.indexOf("E_PRGRAPHIC") === 0) return "داده‌ی گرافیکی قالب (project.prgraphic) پیدا نشد — قالب باید از پریمیر اکسپورت شده باشد.";
    if (s.indexOf("E_XMLPATCH") === 0) return "متنِ سند گرافیکی قالب با متن نمونه‌ی پنل گرافیک یکی نیست — در پریمیر متن داخل قالب را ویرایش کنید و دوباره اکسپورت کنید.";
    if (s.indexOf("E_VERIFY") === 0) return "بازبینی فایل بیکری ناموفق بود — یک بار دیگر تلاش کنید؛ اگر تکرار شد، قالب را دوباره اکسپورت کنید.";
    if (s.indexOf("E_WRITE") === 0) return "نوشتن فایل بیکری روی دیسک ناموفق بود — فضای دیسک و دسترسی پوشه‌ی Documents را بررسی کنید.";
    if (s.indexOf("E_TMPDIR") === 0) return "ساخت پوشه‌ی بیکری ناموفق بود — دسترسی پوشه‌ی Documents را بررسی کنید.";
    if (s.indexOf("E_ZIPREAD") === 0) return "فایل قالب به‌عنوان ZIP باز نشد — فایل احتمالاً خراب است؛ دوباره از پریمیر اکسپورتش کنید.";
    if (s.indexOf("E_TPLBUF") === 0 || s.indexOf("E_EMPTYTEXT") === 0) return "ورودی بیکری نامعتبر بود — یک بار دیگر تلاش کنید.";
    return s;
  }

  global.S2GCore = {
    CHUNK_SIZE: CHUNK_SIZE,
    GUARD_MS: GUARD_MS,
    safeParse: safeParse,
    evalArg: evalArg,
    evalLit: evalLit,
    createBridge: createBridge,
    isFatalCode: isFatalCode,
    trError: trError,
    trBakeErr: trBakeErr,
    trHostMsg: trHostMsg,
    trReason: trReason
  };
})(this);
