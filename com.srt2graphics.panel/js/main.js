/* SubSaz Lite v1.2.0 — main.js
 * UI + run loop (CEP side). Heavy work (import + set time + set text) happens
 * inside ExtendScript in chunks; this file only queues, encodes, and paints.
 *
 * v1.1.0 — BAKED ENGINE (fixes the field bug "every layer shows the template
 * placeholder text"): on the user's host every script-side text write (MGT
 * capsule AND clip.components) is silently ignored. The proven cure from the
 * full SubSaz panel: bake one .mogrt per UNIQUE cue with the text already
 * inside (MogrtBaker.js, Node in CEF) and let the host import those files —
 * the ExtendScript layer then contains NO text handling at all. Engine A
 * (direct setValue, v1.0.x) stays as the selectable fallback.
 *
 * v1.1.1 — BAKE IS THE ONLY DEFAULT. Field post-mortem: v1.1.0 shipped with
 * engine=auto, and every bake failure (Node off after install without a
 * Premiere restart, template quirk, disk error) SILENTLY degraded into the
 * direct engine — which reproduces the exact placeholder bug the user keeps
 * reporting, so the fix looked broken. Now: default = bake-only; a bake
 * failure FAILS LOUDLY in Persian (with the remedy), never falls back
 * silently; the final status names the engine that actually ran; auto/direct
 * remain as explicit opt-ins for other hosts.
 *
 * v1.2.0 — FIELD POST-MORTEM: THE BAKED ENGINE CRASHED THE HOST. The v1.1.x
 * build paced baked inserts with the CHUNK=15 loop, so Premiere had to
 * execute 15 back-to-back importMGT calls of 15 DISTINCT baked files inside
 * ONE synchronous ExtendScript run — its graphics engine never got to
 * breathe, and with auto-save able to fire mid-churn the host went down
 * (user report). The full SubSaz panel runs the SAME bake engine crash-free
 * with the proven v2.1..v2.4 cadence, which this build now ports verbatim:
 *   - ONE cue per evalScript call (Core.createStepLoop)
 *   - a 3s pause between layers (selectable 1/2/3/5s), doubled after a
 *     failed layer (max 10s), back to base once inserts run smoothly again
 *   - a deep breath (+2s) every 10 layers
 *   - Premiere auto-save PARKED during the batch, restored at the end
 *   - a guarded mid-run project save every 10 layers (recovery points)
 *   - ONE retry of a failed first insert after 3s (layer-zero window)
 *   - cancel honored within 500ms during pauses
 * The direct engine keeps the CHUNK=15 loop (legacy fallback, not default).
 *
 * Crash-safety recap (mirror of the architecture):
 *   - single-flight queue (core.createBridge) — never 2 evalScript at once
 *   - baked engine: 1 cue per call + pacing; direct engine: CHUNK_SIZE = 15
 *     cues per call + setTimeout(next, 0) between chunks
 *   - cancel is honored between layers (baked) / chunks (direct)
 *   - setBusy locks every control -> a double-click can never start 2 runs
 *   - fatal codes stop the run; per-cue problems are logged and the run lives
 *   - DUMP rows are routed to the debug box, everything else to Persian logs
 */
(function (global) {
  "use strict";

  var Core = global.S2GCore;
  var SRT = global.S2GSRT;
  var Baker = global.MogrtBaker; // v1.1.0 baked engine (js/mogrtbaker.js)
  var cs = new global.CSInterface();
  var bridge = Core.createBridge(function (expr, cb) { cs.evalScript(expr, cb); });
  var callHost = bridge.callHost;

  var state = {
    cues: null,
    mogrtPath: "",
    trackIndex: -1,
    engine: "bake",   // v1.1.1: bake is THE default — direct never runs unless picked
    bake: null,       // v1.1.0: { items, cueMap, dir } after a successful bake
    engineUsed: "",   // v1.1.1: which engine actually produced the layers ("bake"|"direct")
    usedFallback: false, // v1.1.1: auto mode degraded to direct (must warn loudly)
    paceMs: 3000,     // v1.2.0: base pause between baked inserts (crash prevention)
    midSave: true,    // v1.2.0: protective project save every 10 layers
    savedN: 0,        // v1.2.0: how many mid-run saves actually happened
    asParked: false,  // v1.2.0: Premiere auto-save parked during the batch
    stepLoop: null,   // v1.2.0: Core.createStepLoop handle (baked engine)
    running: false,
    cancel: false,
    runId: "",
    total: 0,
    processed: 0,
    problemSet: {},   // global cue indexes (1-based) with ANY reported problem
    errors: []
  };

  function $(id) { return document.getElementById(id); }

  // ---------- tiny UI helpers ----------
  function setStatus(msg, kind) {
    var el = $("lblStatus");
    el.textContent = msg;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function progress(done, total) {
    var pct = total > 0 ? Math.round((done * 100) / total) : 0;
    $("barFill").style.width = pct + "%";
    $("lblProgress").textContent = done + " / " + total + " (" + pct + "%)";
  }

  function setBusy(b) {
    $("btnRun").disabled = b;
    $("btnCancel").hidden = !b;
    $("btnCancel").disabled = false;
    $("btnPickSrt").disabled = b;
    $("btnPickMogrt").disabled = b;
    $("fileSrt").disabled = b;
    $("fileMogrt").disabled = b;
    $("selTrack").disabled = b;
    $("selEngine").disabled = b;
    $("chkClear").disabled = b;
    if ($("selPace")) { $("selPace").disabled = b; }
    if ($("chkMidSave")) { $("chkMidSave").disabled = b; }
  }

  function clearErrors() {
    state.errors = [];
    $("listErrors").innerHTML = "";
    $("boxErrors").hidden = true;
  }

  function showErrors() {
    var list = $("listErrors");
    list.innerHTML = "";
    var MAX = 30;
    var n = Math.min(state.errors.length, MAX);
    for (var i = 0; i < n; i++) {
      var li = document.createElement("li");
      li.textContent = state.errors[i];
      list.appendChild(li);
    }
    if (state.errors.length > MAX) {
      var more = document.createElement("li");
      more.textContent = "… و " + (state.errors.length - MAX) + " خطای دیگر";
      list.appendChild(more);
    }
    $("boxErrors").hidden = state.errors.length === 0;
  }

  function recordError(line) {
    state.errors.push(line);
  }

  function tryShowDump(jsonStr) {
    var pre = $("preDump");
    try {
      pre.textContent = JSON.stringify(JSON.parse(jsonStr), null, 2);
    } catch (e) {
      pre.textContent = String(jsonStr);
    }
    $("boxDump").hidden = false;
  }

  function hideDump() {
    $("boxDump").hidden = true;
    $("preDump").textContent = "";
  }

  // ---------- tracks ----------
  function fillTracks(tracks, seqName) {
    var sel = $("selTrack");
    var prev = state.trackIndex;
    sel.innerHTML = "";
    if (!tracks || tracks.length === 0) {
      state.trackIndex = -1;
      var o = document.createElement("option");
      o.value = "-1";
      o.textContent = "سکانسی باز نیست";
      sel.appendChild(o);
      return;
    }
    var prompt = document.createElement("option");
    prompt.value = "-1";
    prompt.textContent = "— انتخاب ترک —";
    sel.appendChild(prompt);
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var opt = document.createElement("option");
      opt.value = String(t.i);
      var label = (t.name && t.name !== "") ? t.name : ("ترک " + (t.i + 1));
      if (t.clips >= 0) label += " (" + t.clips + " کلیپ)";
      opt.textContent = label;
      sel.appendChild(opt);
    }
    if (prev >= 0 && prev < tracks.length) {
      sel.value = String(prev);
    } else if (tracks.length === 1) {
      sel.value = "0";
    } else {
      sel.value = "-1";
    }
    state.trackIndex = parseInt(sel.value, 10);
    if (seqName) $("chipVer").title = "سکانس: " + seqName;
  }

  function loadTracks() {
    if (state.running) return;
    callHost("s2gListTracks", "", function (r) {
      if (r && r.ok) {
        fillTracks(r.tracks || [], r.seqName || "");
      } else if (r && r.code === "NO_SEQUENCE") {
        fillTracks([], "");
      }
      // other failures: keep whatever the list shows, ping/retry handles the rest
    });
  }

  function ping(retries) {
    callHost("s2gPing", "", function (r) {
      if (r && r.ok) {
        $("chipVer").textContent = "v" + (r.ver || "1.0.0");
        setStatus("متصل به پریمیر — آماده کار.", "ok");
        loadTracks();
      } else if (retries > 0) {
        setTimeout(function () { ping(retries - 1); }, 700); // ScriptPath may still be loading
      } else {
        setStatus("پریمیر پاسخ نمی‌دهد — پنل را ببندید و دوباره باز کنید.", "err");
      }
    });
  }

  // ---------- file pickers ----------
  function bindUi() {
    $("btnPickSrt").addEventListener("click", function () { $("fileSrt").click(); });
    $("btnPickMogrt").addEventListener("click", function () { $("fileMogrt").click(); });

    $("fileSrt").addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (!f) return;
      $("lblSrt").textContent = f.name || "(بدون نام)";
      $("lblSrtCount").textContent = "";
      var reader = new FileReader();
      reader.onload = function () {
        try {
          state.cues = SRT.parse(reader.result);
          $("lblSrtCount").textContent = state.cues.length + " زیرنویس";
          if (state.cues.length === 0) {
            setStatus("هیچ زیرنویس معتبری در این فایل پیدا نشد.", "warn");
          } else {
            setStatus("SRT خوانده شد: " + state.cues.length + " زیرنویس.", "ok");
          }
        } catch (e) {
          state.cues = null;
          setStatus("خطا در خواندن SRT: " + (e.message || e), "err");
        }
      };
      reader.onerror = function () {
        setStatus("خواندن فایل SRT ناموفق بود.", "err");
      };
      reader.readAsText(f, "utf-8");
    });

    $("fileMogrt").addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (!f) return;
      if (!/\.mogrt$/i.test(f.name || "")) {
        setStatus("فایل انتخاب‌شده MOGRT نیست.", "warn");
        return;
      }
      // CEF flag --allow-file-access -> input.files[0].path = full windows path
      state.mogrtPath = f.path || "";
      $("lblMogrt").textContent = f.name;
      if (!state.mogrtPath) {
        setStatus("مسیر کامل فایل گرفته نشد — فایل را دوباره انتخاب کنید.", "warn");
      } else {
        setStatus("قالب انتخاب شد.", "ok");
      }
    });

    $("selTrack").addEventListener("change", function () {
      state.trackIndex = parseInt(this.value, 10);
    });

    $("selEngine").addEventListener("change", function () {
      state.engine = this.value;
    });

    if ($("selPace")) {
      $("selPace").addEventListener("change", function () {
        state.paceMs = parseInt(this.value, 10) || 3000;
      });
    }
    if ($("chkMidSave")) {
      $("chkMidSave").addEventListener("change", function () {
        state.midSave = this.checked;
      });
    }

    $("btnRun").addEventListener("click", run);
    $("btnCancel").addEventListener("click", function () {
      if (!state.running) return;
      state.cancel = true;
      this.disabled = true;
      setStatus("در حال لغو… در اولین فرصت (حداکثر نیم ثانیه) متوقف می‌شود.", "warn");
    });
  }

  // ---------- the run flow ----------
  function run() {
    if (state.running) return; // double-run lock (line 2 of defense)
    if (!state.cues || state.cues.length === 0) {
      setStatus("اول فایل SRT را انتخاب کنید.", "warn");
      return;
    }
    if (!state.mogrtPath) {
      setStatus("اول فایل قالب MOGRT را انتخاب کنید.", "warn");
      return;
    }
    if (state.trackIndex < 0) {
      setStatus("ترک مقصد را انتخاب کنید.", "warn");
      return;
    }

    state.running = true;
    state.cancel = false;
    state.runId = "run_" + (new Date().getTime());
    state.total = state.cues.length;
    state.processed = 0;
    state.problemSet = {};
    state.bake = null;
    state.engineUsed = "";
    state.usedFallback = false;
    state.savedN = 0;       // v1.2.0
    state.asParked = false; // v1.2.0
    state.stepLoop = null;  // v1.2.0
    clearErrors();
    hideDump();
    setBusy(true);
    progress(0, state.total);
    setStatus("شروع تبدیل…", "info");

    callHost("s2gResetState", "", function (r1) {
      callHost("s2gValidate", Core.evalLit(state.mogrtPath) + "," + String(state.trackIndex), function (r2) {
        if (!r2 || !r2.ok) {
          var code = (r2 && r2.code) ? r2.code : "EVAL_ERROR";
          fail(Core.trError(code));
          return;
        }
        var go = function () { engineStart(); };
        if ($("chkClear").checked) {
          callHost("s2gClearPrevious", String(state.trackIndex), function (r3) {
            if (r3 && r3.ok && r3.removed > 0) {
              setStatus(r3.removed + " زیرنویس قبلی حذف شد.", "info");
            }
            go();
          });
        } else {
          go();
        }
      });
    });
  }

  // ---------- v1.1.0 engine selection + baked engine ----------
  // ASCII-safe dedupe key for identical subtitle texts (djb2 over the UTF-8
  // bytes + length suffix). Identical cues share ONE baked file — faster bake,
  // fewer near-clone files for Premiere to juggle.
  function textHash(s) {
    var bytes;
    try { bytes = unescape(encodeURIComponent(s || "")); } catch (eH) { bytes = String(s || ""); }
    var h = 5381;
    for (var i = 0; i < bytes.length; i++) { h = (((h << 5) + h) + bytes.charCodeAt(i)) >>> 0; }
    return h.toString(16) + "x" + bytes.length;
  }

  function engineStart() {
    var eng = state.engine;
    if (eng === "direct" || !Baker) {
      if (eng === "bake") {
        fail("موتور بیکری بارگذاری نشده — اسکریپت mogrtbaker.js در پوشه‌ی پنل نیست.");
        return;
      }
      // auto + baker file missing -> degrade, but SAY SO (v1.1.1: never silent)
      state.usedFallback = true;
      recordError("موتور بیکری بارگذاری نشده — با روش مستقیم ادامه می‌دهیم.");
      startChunks(false);
      return;
    }
    if (!Baker.nodeAvailable()) {
      if (eng === "bake") {
        fail("موتور بیکری در دسترس نیست — Node در پنل غیرفعال است (پنل را ببندید و دوباره باز کنید).");
        return;
      }
      state.usedFallback = true;
      recordError("موتور بیکری در دسترس نیست — با روش مستقیم ادامه می‌دهیم.");
      startChunks(false);
      return;
    }
    try { Baker.cleanupTemp(); } catch (eC) {}

    // bake UNIQUE texts only; identical cues share one baked file.
    // cueMap[globalCueIndex0based] = index of that cue's baked file.
    var list = [];
    var cueMap = [];
    var byKey = {};
    for (var i = 0; i < state.cues.length; i++) {
      var c = state.cues[i];
      var txt = String(c.text || "").replace(/\n/g, "\r\n");
      var key = textHash(txt);
      if (byKey[key] === undefined) {
        byKey[key] = list.length;
        list.push({ text: txt, label: " — " + (list.length + 1) });
      }
      cueMap.push(byKey[key]);
    }

    var info = $("lblBakeInfo");
    info.hidden = true;
    setStatus("ساخت قالب‌های اختصاصی (موتور بیکری)…", "info");
    var done = function (res) {
      if (state.cancel) { finish(true); return; }
      if (res && res.ok) {
        state.bake = { items: res.items, cueMap: cueMap, dir: res.dir };
        info.textContent = "قالب‌های اختصاصی: " + res.dir + " (رسانه‌ی پروژه — پاکش نکنید)";
        info.hidden = false;
        setStatus("بیکری آماده شد — " + res.items.length + " قالب اختصاصی برای " + state.total + " لایه (متن‌های تکراری مشترک).", "ok");
        progress(0, state.total);
        parkAndStartBaked(); // v1.2.0: proven anti-crash cadence (1 cue/call + pauses)
      } else {
        var err = Core.trBakeErr((res && res.error) ? res.error : "نامشخص");
        if (eng === "bake") {
          fail("بیکری ناموفق بود: " + err);
          return;
        }
        state.usedFallback = true;
        recordError("بیکری ناموفق بود (" + err + ") — با روش مستقیم ادامه می‌دهیم.");
        startChunks(false);
      }
    };
    if (Baker.bakeCueListAsync) {
      Baker.bakeCueListAsync(state.mogrtPath, list, function (p) {
        progress(p.done, p.total);
        setStatus("بیکری: " + p.done + " / " + p.total + " قالب…", "info");
      }, done);
    } else {
      setTimeout(function () { done(Baker.bakeCueList(state.mogrtPath, list)); }, 0);
    }
  }

  // ---------- v1.2.0: baked engine on the proven anti-crash cadence ----------
  // FIELD POST-MORTEM: v1.1.x ran the baked engine through startChunks(), so
  // the host executed 15 back-to-back importMGT calls of 15 DISTINCT baked
  // files inside ONE synchronous ExtendScript run and Premiere CRASHED. The
  // full SubSaz panel runs the exact same bake engine crash-free with:
  // ONE layer per call, a 3s pause between layers, pause doubled after a
  // failure (max 10s), a deep breath every 10 layers, Premiere auto-save
  // parked during the batch, and a mid-run save every 10 layers. That
  // cadence is ported here verbatim via Core.createStepLoop.
  function parkAndStartBaked() {
    callHost("s2gAutoSavePark", "", function (rp) {
      state.asParked = !!(rp && rp.ok && rp.parked);
      startBakedSteps();
    });
  }

  function startBakedSteps() {
    state.engineUsed = "bake";
    var loop = Core.createStepLoop({
      total: state.total,
      settleMs: 1200, // v3.4.2 lesson: let the clear wave settle before import #1
      pauseMs: function () { return state.paceMs; },
      isCanceled: function () { return state.cancel; },
      step: function (idx, cb) {
        var c = state.cues[idx];
        var it = state.bake.items[state.bake.cueMap[c.i - 1]]; // cue.i is 1-based
        var payload = {
          runId: state.runId,
          baked: true,
          mogrtPath: state.mogrtPath,
          trackIndex: state.trackIndex,
          cues: [{ i: c.i, start: c.start, end: c.end, path: it ? it.path : "", text: c.text }]
        };
        callHost("s2gInsertChunk", Core.evalArg(payload), function (r) {
          var okStep = false;
          if (r && r.ok) {
            var errs = r.errors || [];
            for (var k = 0; k < errs.length; k++) {
              var line = String(errs[k]);
              if (line.indexOf("DUMP ") === 0) {
                tryShowDump(line.slice(5));
              } else {
                recordError(Core.trHostMsg(line) || line);
              }
            }
            markCueProblems(errs);
            okStep = r.inserted > 0;
            if (!okStep) { state.problemSet[c.i] = true; }
          } else {
            var code = (r && r.code) ? r.code : "UNKNOWN";
            if (Core.isFatalCode(code)) {
              fail(Core.trError(code));
              return;
            }
            recordError("لایه " + c.i + ": " + (Core.trError(code) || code));
            state.problemSet[c.i] = true;
          }
          cb(okStep);
        });
      },
      onSave: function (i, sCb) {
        callHost("s2gSaveProject", "", function (rs) {
          if (rs && rs.ok && rs.saved) { state.savedN++; }
          sCb();
        });
      },
      onRetryFirst: function () {
        recordError("اولین درج ناموفق بود — پس از ۳ ثانیه یک بار دیگر تلاش می‌شود…");
      },
      onPaceUp: function (ms) {
        recordError("یک لایه ناموفق شد — مکث احتیاطی به " + Math.round(ms / 1000) + " ثانیه افزایش یافت.");
      },
      onProgress: function (done) {
        state.processed = done;
        progress(done, state.total);
      },
      onDone: function (canceled) {
        finish(canceled);
      }
    });
    state.stepLoop = loop;
    loop.start();
  }

  function startChunks(baked) {
    state.engineUsed = baked ? "bake" : "direct"; // v1.1.1: stamp the final status with this
    var i = 0;
    var total = state.total;

    function next() {
      if (state.cancel) { finish(true); return; }
      if (i >= total) { finish(false); return; }

      var chunk = state.cues.slice(i, i + Core.CHUNK_SIZE);
      var from = i;
      i += chunk.length;

      var payload;
      if (baked && state.bake) {
        // baked mode: each cue carries its own .mogrt path (text inside).
        var out = [];
        for (var k = 0; k < chunk.length; k++) {
          var c = chunk[k];
          var it = state.bake.items[state.bake.cueMap[c.i - 1]]; // cue.i is 1-based
          out[out.length] = { i: c.i, start: c.start, end: c.end, path: it ? it.path : "", text: c.text };
        }
        payload = { runId: state.runId, baked: true, mogrtPath: state.mogrtPath, trackIndex: state.trackIndex, cues: out };
      } else {
        payload = { runId: state.runId, mogrtPath: state.mogrtPath, trackIndex: state.trackIndex, cues: chunk };
      }

      callHost("s2gInsertChunk", Core.evalArg(payload), function (r) {
        if (r && r.ok) {
          var errs = r.errors || [];
          for (var k = 0; k < errs.length; k++) {
            var line = String(errs[k]);
            if (line.indexOf("DUMP ") === 0) {
              tryShowDump(line.slice(5));
            } else {
              recordError(Core.trHostMsg(line) || line);
            }
          }
          // host counts a clip as inserted even when its text failed (spec);
          // the panel therefore counts PROBLEM CUES from the error lines
          markCueProblems(errs);
        } else {
          var code = (r && r.code) ? r.code : "UNKNOWN";
          if (Core.isFatalCode(code)) {
            fail(Core.trError(code));
            return;
          }
          recordError("چانک " + (from + 1) + " تا " + (from + chunk.length) + ": " + (Core.trError(code) || code));
          for (var c = from + 1; c <= from + chunk.length; c++) {
            state.problemSet[c] = true; // chunk lost -> every cue in it is a problem
          }
        }

        state.processed = Math.min(total, from + chunk.length);
        progress(state.processed, total);

        if (state.cancel) { finish(true); return; }
        setTimeout(next, 0); // let the CEF event loop breathe (repaint + clicks)
      });
    }

    next();
  }

  // "cue 7: ..." error lines -> mark global cue index 7 as problematic
  function markCueProblems(errs) {
    for (var k = 0; k < errs.length; k++) {
      var m = String(errs[k]).match(/^cue (\d+):/);
      if (m) { state.problemSet[parseInt(m[1], 10)] = true; }
    }
  }

  function problemCount() {
    var n = 0, k;
    for (k in state.problemSet) {
      if (state.problemSet.hasOwnProperty(k)) { n++; }
    }
    return n;
  }

  function finish(canceled) {
    state.running = false;
    setBusy(false);
    restoreAutosave(function () {
      loadTracks(); // clip counts changed
      paintFinish(canceled);
    });
  }

  // v1.2.0: always give Premiere its auto-save back, then paint the result.
  function restoreAutosave(after) {
    if (!state.asParked) { after(); return; }
    state.asParked = false;
    callHost("s2gAutoSaveRestore", "", function () { after(); });
  }

  function paintFinish(canceled) {
    var done = canceled ? state.processed : state.total;
    var prob = problemCount();
    var good = Math.max(0, done - prob);
    // v1.1.1: the final status ALWAYS names the engine that ran — the user must
    // never have to guess whether the baked fix was actually in effect.
    var stamp;
    if (state.usedFallback) {
      stamp = " (با موتور مستقیم ساخته شد — اگر متن لایه‌ها اشتباه است، روش «فقط بیکری» را انتخاب کنید)";
    } else if (state.engineUsed === "bake") {
      stamp = " (موتور بیکری)";
    } else if (state.engineUsed === "direct") {
      stamp = " (موتور مستقیم)";
    } else {
      stamp = "";
    }
    if (state.savedN > 0) { stamp += " — ذخیره‌ی میانی: " + state.savedN + " بار"; }
    if (canceled) {
      setStatus("لغو شد — " + good + " موفق، " + prob + " مشکل‌دار." + stamp, "warn");
    } else if (prob > 0) {
      setStatus("تمام شد — " + good + " لایه سالم، " + prob + " مشکل‌دار." + stamp, "warn");
      showErrors();
    } else {
      setStatus("تمام شد — " + good + " لایه با موفقیت ساخته شد." + stamp, "ok");
    }
  }

  function fail(msg) {
    state.running = false;
    setBusy(false);
    restoreAutosave(function () {
      loadTracks();
      setStatus("خطا: " + msg, "err");
      showErrors();
    });
  }

  // ---------- boot (lifecycle from the architecture doc) ----------
  function boot() {
    bindUi();
    ping(8); // ScriptPath may load late -> retry x8 every 700ms
    setTimeout(loadTracks, 400);
    setTimeout(loadTracks, 1200);
    global.addEventListener("focus", function () {
      if (!state.running) loadTracks();
    });
    var polls = 0;
    var poller = setInterval(function () {
      polls++;
      if ($("selTrack").options.length <= 1 && polls <= 15) {
        loadTracks(); // activeSequence is sometimes ready late after focus
      } else {
        clearInterval(poller);
      }
    }, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(this);
