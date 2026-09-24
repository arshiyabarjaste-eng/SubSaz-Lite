/* SubSaz Lite v1.0.0 — srt.js
 * SRT parser living entirely in the CEP/CEF layer (zero Premiere cost):
 * the parsed cue list crosses the evalScript bridge exactly ONCE per chunk,
 * already ASCII-escaped via evalArg. Text never round-trips twice.
 *  - strips BOM U+FEFF
 *  - normalizes \r\n / \r -> \n
 *  - splits blocks on /\n{2,}/
 *  - finds the time line within the FIRST 3 lines of a block
 *  - accepts , and . as the milliseconds separator (SRT=, WebVTT=.)
 *  - hmsToSec keeps millisecond precision (1 or 2 digit ms -> x100 / x10)
 *  - cleanCueText removes <i>/<font>/ASS codes, trims, keeps \n
 *  - sorts by start, clamps overlaps (max damage = duration), renumbers
 * Output: [{ i, start, end, text }] with start/end as float seconds.
 */
(function (global) {
  "use strict";

  var TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

  function hmsToSec(h, m, s, msRaw) {
    var ms = String(msRaw == null ? "0" : msRaw);
    while (ms.length < 3) ms += "0"; // "5" -> "500", "50" -> "500"
    ms = ms.slice(0, 3);
    var hh = parseInt(h, 10) || 0;
    var mm = parseInt(m, 10) || 0;
    var ss = parseInt(s, 10) || 0;
    var msn = parseInt(ms, 10) || 0;
    return hh * 3600 + mm * 60 + ss + msn / 1000;
  }

  function cleanCueText(t) {
    var lines = String(t == null ? "" : t).split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i]
        .replace(/<[^>]*>/g, "")      // <i>, </b>, <font ...> ...
        .replace(/\{\\[^}]*\}/g, "")  // ASS override blocks {\an8} {\i1}
        .replace(/\{[^}]*\}/g, "")    // plain ASS/SSA braces
        .replace(/^\s*[\u200e\u200f]+/, "") // stray direction marks
        .trim();
      if (L !== "") out.push(L);
    }
    return out.join("\n");
  }

  function parseSRT(raw) {
    var s = String(raw == null ? "" : raw);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // BOM
    s = s.replace(/\r\n?/g, "\n");

    var blocks = s.split(/\n{2,}/);
    var cues = [];
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      if (!block || block.trim() === "") continue;
      var lines = block.split("\n");

      // the time line sits within the first 3 lines (index line may be absent)
      var m = null;
      var limit = Math.min(3, lines.length);
      for (var k = 0; k < limit; k++) {
        m = lines[k].match(TIME_RE);
        if (m) break;
      }
      if (!m) continue;

      var start = hmsToSec(m[1], m[2], m[3], m[4]);
      var end = hmsToSec(m[5], m[6], m[7], m[8]);
      var text = cleanCueText(lines.slice(k + 1).join("\n"));
      if (text === "") continue;
      if (end <= start) end = start + 1.0; // defensive: zero/negative duration

      cues.push({ i: cues.length + 1, start: start, end: end, text: text });
    }

    cues.sort(function (a, b) { return a.start - b.start; });

    // overlap pre-clamp: on one track, clip N must end before clip N+1 starts.
    // Keep at least 50ms so a clamped cue never becomes zero-length.
    for (var c = 0; c + 1 < cues.length; c++) {
      if (cues[c].end > cues[c + 1].start) {
        var minDur = Math.min(0.05, cues[c].end - cues[c].start);
        var clamped = cues[c + 1].start - minDur;
        if (clamped > cues[c].start) cues[c].end = clamped;
      }
    }

    for (var r = 0; r < cues.length; r++) cues[r].i = r + 1; // renumber
    return cues;
  }

  global.S2GSRT = {
    parse: parseSRT,
    cleanCueText: cleanCueText,
    hmsToSec: hmsToSec,
    TIME_RE: TIME_RE
  };
})(this);
