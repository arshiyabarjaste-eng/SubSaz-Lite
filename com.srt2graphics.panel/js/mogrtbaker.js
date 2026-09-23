/* SubSaz Lite v1.1.0 — MogrtBaker (ported verbatim from SubSaz v3.4.x)
 * ------------------------------------------------------------------
 * Engine B («بیکری»): bakes the Persian subtitle text DIRECTLY into
 * a copy of the user's .mogrt file, per cue. The ExtendScript bridge
 * never sees the text — it only receives ASCII temp file paths, and
 * Premiere imports each baked .mogrt with the text already inside.
 *
 * This removes the entire failure class of v1.x: ComponentParam
 * setValue/getValue string mangling (UTF-16 vs UTF-8 byte-string,
 * NUL truncation, doc JSON surgery) — none of that code runs.
 *
 * What we edit inside the .mogrt (a plain ZIP):
 *   1. definition.json   → clientControls[type=6].value.strDB[*].str
 *                          (what Essential Graphics shows as value)
 *   2. project.prgraphic → ZIP > Untitled.prproj (gzip) > XML >
 *                          "Source Text" param > StartKeyframeValue
 *                          (base64) > binary doc: [u32 payloadLen]
 *                          [u32 0][magic 0x11223344]...[u32 textLen]
 *                          [utf8 text][NUL pad]...  — we splice the
 *                          new text and fix payloadLen by the delta.
 *   3. capsuleID         → randomized per cue (no cross-reference
 *                          inside prgraphic — verified on a real
 *                          Premiere-authored template).
 *   4. v2.4 OBJECT-IDENTITY RE-ISSUE (anti-crash):
 *       Field evidence: Premiere crashed HARD on the SECOND importMGT of a
 *       sibling baked file even with multi-second pauses. Ground truth from
 *       a real Premiere-authored template: the inner prproj carries the
 *       Premiere object-identity system — <Sequence ObjectUID>, MasterClip
 *       ObjectUID/ObjectURef, RootProjectItem, ClipProjectItem, Track refs,
 *       plus <ClipID> elements — and definition.json repeats the Sequence
 *       GUID in sourceInfoLocalized.*.id. v2.0..v2.3 shipped every baked
 *       file with IDENTICAL object identities; the first import registers
 *       them, the second import collides inside Premiere's object registry
 *       (an uncatchable native crash). Fix: per file, every identity GUID is
 *       re-issued (consistent old→new map applied to prproj XML AND
 *       definition.json so references stay coherent). Structural constants
 *       (ClassID=, <MediaType>, <ImplementationID>, <EditingModeID>,
 *       <Preview*>, TrackGroup <First>, the null GUID) are NEVER touched.
 *   5. capsuleName       → per-cue suffix (readable project panel + one more
 *                          uniqueness axis).
 *
 * v3.3 «خواندن از فایل + بازسازی کلیپ» — field proof from the user's host
 * (Premiere 24.x): ComponentParam.getValue() of the text param returns the
 * BINARY doc marshalled as UTF-16LE and truncated at the first NUL byte —
 * the panel reads a single mangled glyph («Ȍ» = U+020C = the first two bytes
 * of the u32 payloadLen) and can NEVER see the real text. Reads via getValue
 * are permanently lossy there, and setValue on the doc param is equally
 * unproven. The text of every clip THIS PANEL created still lives on disk
 * inside the clip's own baked .mogrt (Documents/SubSaz/Baked/<ts>/…), so:
 *   • readTextFromBuffer / readTextFile — read the CURRENT text straight from
 *     the mogrt (definition.json strDB, blob scan fallback). No getValue.
 *   • rebakeFile — re-bake a clip's own media file with new text; the JSX
 *     side then swaps the clip in place (same track, same ticks) using the
 *     SAME proven pipeline the whole product is built on (importMGT+trim).
 * Requires Node (fs, zlib, os, path) — CEP panel must have
 * --enable-nodejs in manifest CEFCommandLine. Falls back gracefully
 * when Node is unavailable (panel then uses Engine A / setValue).
 * ------------------------------------------------------------------ */
(function (root) {
  'use strict';

  // ---------- Node detection ----------
  function getNodeRequire() {
    try {
      if (typeof window !== 'undefined' && window.cep_node && window.cep_node.require) {
        return window.cep_node.require;
      }
    } catch (e0) {}
    try {
      if (typeof require === 'function') { return require; }
    } catch (e1) {}
    return null;
  }

  var _req = null, _fs = null, _zlib = null, _os = null, _path = null;
  function initNode() {
    if (_fs) { return true; }
    _req = getNodeRequire();
    if (!_req) { return false; }
    try {
      _fs = _req('fs');
      _zlib = _req('zlib');
      _os = _req('os');
      _path = _req('path');
      return !!(_fs && _zlib && _os && _path);
    } catch (e) { return false; }
  }

  function nodeAvailable() { return initNode(); }

  // ---------- Buffer helpers (work on old & new Node) ----------
  function toBuf(x, enc) {
    if (typeof Buffer.from === 'function') { return enc ? Buffer.from(x, enc) : Buffer.from(x); }
    return new Buffer(x, enc);  // eslint-disable-line
  }
  function allocBuf(n) {
    if (typeof Buffer.alloc === 'function') { return Buffer.alloc(n); }
    return new Buffer(n);  // eslint-disable-line
  }

  // ---------- CRC32 ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- minimal ZIP reader (store + deflate) ----------
  // returns { ok, entries: [{name, data(Buffer), method}], error }
  function zipRead(buf) {
    try {
      // locate EOCD
      var eocd = -1;
      var min = Math.max(0, buf.length - 66000);
      for (var i = buf.length - 22; i >= min; i--) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
      }
      if (eocd < 0) { return { ok: false, error: 'EOCD not found' }; }
      var count = buf.readUInt16LE(eocd + 10);
      var cdOff = buf.readUInt32LE(eocd + 16);
      var entries = [];
      var p = cdOff;
      for (var e = 0; e < count; e++) {
        if (buf.readUInt32LE(p) !== 0x02014B50) { return { ok: false, error: 'bad central dir @' + e }; }
        var method = buf.readUInt16LE(p + 10);
        var compSize = buf.readUInt32LE(p + 20);
        var nameLen = buf.readUInt16LE(p + 28);
        var extraLen = buf.readUInt16LE(p + 30);
        var cmtLen = buf.readUInt16LE(p + 32);
        var localOff = buf.readUInt32LE(p + 42);
        var name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        // local header
        if (buf.readUInt32LE(localOff) !== 0x04034B50) { return { ok: false, error: 'bad local hdr: ' + name }; }
        var lNameLen = buf.readUInt16LE(localOff + 26);
        var lExtraLen = buf.readUInt16LE(localOff + 28);
        var dataStart = localOff + 30 + lNameLen + lExtraLen;
        var comp = buf.slice(dataStart, dataStart + compSize);
        var data;
        if (method === 0) { data = toBuf(comp); }  // eslint-disable-line
        else if (method === 8) { data = _zlib.inflateRawSync(comp); }
        else { return { ok: false, error: 'unsupported method ' + method + ' for ' + name }; }
        entries.push({ name: name, data: data, method: method });
        p += 46 + nameLen + extraLen + cmtLen;
      }
      return { ok: true, entries: entries };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // ---------- minimal ZIP writer (deflate when smaller, else store) ----------
  function dosDateTime(d) {
    d = d || new Date(2024, 0, 1, 0, 0, 0);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date: date & 0xFFFF, time: time & 0xFFFF };
  }

  // obj: { name: Buffer } → Buffer
  function zipWrite(obj) {
    var names = [];
    for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { names.push(k); } }
    var dt = dosDateTime();
    var locals = [], centrals = [], offset = 0;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var data = obj[name];
      if (!Buffer.isBuffer(data)) { data = toBuf(String(data), 'utf8'); }  // eslint-disable-line
      var nameBuf = toBuf(name, 'utf8');  // eslint-disable-line
      var crc = crc32(data);
      var method = 0, payload = data;
      try {
        var def = _zlib.deflateRawSync(data, { level: 6 });
        if (def.length < data.length) { method = 8; payload = def; }
      } catch (eD) { method = 0; payload = data; }

      var lh = allocBuf(30 + nameBuf.length);  // eslint-disable-line
      lh.writeUInt32LE(0x04034B50, 0);
      lh.writeUInt16LE(20, 4);          // version needed
      lh.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(dt.time, 10);
      lh.writeUInt16LE(dt.date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(payload.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(0, 28);
      nameBuf.copy(lh, 30);
      locals.push(lh, payload);

      var ch = allocBuf(46 + nameBuf.length);  // eslint-disable-line
      ch.writeUInt32LE(0x02014B50, 0);
      ch.writeUInt16LE(0x0014, 4);      // version made by
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(dt.time, 12);
      ch.writeUInt16LE(dt.date, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(payload.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt16LE(0, 30);          // extra
      ch.writeUInt16LE(0, 32);          // comment
      ch.writeUInt16LE(0, 34);          // disk
      ch.writeUInt16LE(0, 36);          // internal attrs
      ch.writeUInt32LE(0, 38);          // external attrs
      ch.writeUInt32LE(offset, 42);
      nameBuf.copy(ch, 46);
      centrals.push(ch);

      offset += lh.length + payload.length;
    }
    var cdStart = offset, cdSize = 0;
    for (var c = 0; c < centrals.length; c++) { cdSize += centrals[c].length; }
    var eocd = allocBuf(22);  // eslint-disable-line
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(names.length, 8);
    eocd.writeUInt16LE(names.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat(locals.concat(centrals).concat([eocd]));
  }

  // ---------- binary text-doc patching ----------
  // Locate [u32 len][utf8 text] where text === oldTextUtf8, splice newText.
  // Also fix the u32 payloadLen at blob start by the length delta.
  // Returns { ok, out(Buffer), patches } or { ok:false, error }
  function patchTextDocBlob(raw, oldTextUtf8, newTextUtf8) {
    if (!Buffer.isBuffer(raw)) { return { ok: false, error: 'blob not buffer' }; }
    if (raw.length < 16) { return { ok: false, error: 'blob too small' }; }
    // find candidates: any occurrence of oldText preceded by u32 length
    var positions = [];
    var from = 0;
    for (;;) {
      var idx = raw.indexOf(oldTextUtf8, from);
      if (idx < 0) { break; }
      if (idx >= 4) {
        var len = raw.readUInt32LE(idx - 4);
        if (len === oldTextUtf8.length) { positions.push(idx); }
      }
      from = idx + 1;
    }
    if (!positions.length) { return { ok: false, error: 'text slot not found in binary doc' }; }

    // sanity: payloadLen field at offset 0 (relative fix-up by delta)
    var delta = newTextUtf8.length - oldTextUtf8.length;
    var out = allocBuf(raw.length + delta * positions.length);  // eslint-disable-line
    var w = 0, r = 0;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var headEnd = pos - 4;
      raw.copy(out, w, r, headEnd);           // header up to len prefix
      w += headEnd - r;
      out.writeUInt32LE(newTextUtf8.length, w); // new length prefix
      w += 4;
      newTextUtf8.copy(out, w);               // new text bytes
      w += newTextUtf8.length;
      r = pos + oldTextUtf8.length;           // resume AFTER old text
      if (p === positions.length - 1) {
        raw.copy(out, w, r, raw.length);      // tail (NUL pads + trailing structs)
        w += raw.length - r;
      }
    }
    // fix payloadLen at offset 0 (and only there) by total delta
    var totalDelta = w - raw.length;
    if (out.length >= 4) {
      var plen = out.readUInt32LE(0);
      if (plen === raw.length - 12) {
        // absolute payload length counts from offset 12 — trust & re-set
        out.writeUInt32LE(out.length - 12, 0);
      } else if (plen > 0 && plen <= raw.length) {
        out.writeUInt32LE(plen + totalDelta, 0);
      }
    }
    return { ok: true, out: out, patches: positions.length };
  }

  // ---------- definition.json text control ----------
  // returns { ok, control, oldText } — first clientControls entry with type===6
  function findTextControl(def) {
    if (!def || !def.clientControls || !def.clientControls.length) { return null; }
    for (var i = 0; i < def.clientControls.length; i++) {
      var c = def.clientControls[i];
      if (Number(c.type) === 6 && c.value && c.value.strDB && c.value.strDB.length) {
        return c;
      }
    }
    return null;
  }

  function setTextControl(def, newText) {
    var c = findTextControl(def);
    if (!c) { return { ok: false, error: 'no TEXT client control in definition.json' }; }
    var oldText = null;
    for (var i = 0; i < c.value.strDB.length; i++) {
      if (oldText === null) { oldText = String(c.value.strDB[i].str || ''); }
      c.value.strDB[i].str = newText;
    }
    return { ok: true, oldText: (oldText === null ? '' : oldText), control: c };
  }

  function makeGuid() {
    var h = '0123456789abcdef', s = '';
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { s += '-'; }
      else { s += h.charAt(Math.floor(Math.random() * 16)); }
    }
    return s;
  }

  // ---------- v2.4: per-file object-identity re-issue ----------
  // The inner prproj identifies Premiere objects with dash-GUIDs:
  //   identities (re-issued per baked file):
  //     • ObjectUID="…" / ObjectURef="…" attributes (Sequence, MasterClip,
  //       RootProjectItem, ClipProjectItem, Track refs — they cross-reference
  //       each other, so one consistent old→new map keeps them coherent)
  //     • <ClipID>…</ClipID> element text
  //   constants (NEVER touched — semantic values, identical in every project):
  //     • ClassID="…" attributes, <MediaType>, TrackGroup <First>,
  //       <ImplementationID>, <EditingModeID>, <PreviewFileFormatID>,
  //       <PreviewFormatIdentifier>, the all-zero GUID
  // The same map is applied to the definition.json STRING as well, because
  // sourceInfoLocalized.*.id repeats the Sequence ObjectUID there.
  var GUID_PAT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  var NULL_GUID = '00000000-0000-0000-0000-000000000000';

  function collectGuidAttrs(xml, attrRe, out) {
    var re = new RegExp(attrRe, 'g');
    var m;
    while ((m = re.exec(xml)) !== null) { out[m[1]] = true; }
  }

  function reidentifyPrproj(xml, defStr) {
    var cand = {};
    var fixed = {};
    var m;
    // 1) identity candidates
    collectGuidAttrs(xml, 'ObjectUID="(' + GUID_PAT + ')"', cand);
    collectGuidAttrs(xml, 'ObjectURef="(' + GUID_PAT + ')"', cand);
    collectGuidAttrs(xml, '<ClipID>(' + GUID_PAT + ')</ClipID>', cand);
    // 2) constants that must never move
    fixed[NULL_GUID] = true;
    collectGuidAttrs(xml, 'ClassID="(' + GUID_PAT + ')"', fixed);
    var constTags = ['MediaType', 'ImplementationID', 'EditingModeID',
      'PreviewFileFormatID', 'PreviewFormatIdentifier', 'First'];
    for (var t = 0; t < constTags.length; t++) {
      collectGuidAttrs(xml, '<' + constTags[t] + '>(' + GUID_PAT + ')</' + constTags[t] + '>', fixed);
    }
    // 3) build the consistent old→new map
    var map = {};
    var n = 0;
    for (var g in cand) {
      if (Object.prototype.hasOwnProperty.call(cand, g) && !fixed[g]) { map[g] = makeGuid(); n++; }
    }
    // 4) apply everywhere (identity strings cannot occur inside base64 —
    //    the base64 alphabet has no dashes)
    var outXml = xml, outDef = defStr;
    for (var old in map) {
      if (!Object.prototype.hasOwnProperty.call(map, old)) { continue; }
      outXml = outXml.split(old).join(map[old]);
      outDef = outDef.split(old).join(map[old]);
    }
    return { xml: outXml, def: outDef, remapped: n, map: map };
  }

  // ---------- prgraphic surgery ----------
  // project.prgraphic = ZIP > Untitled.prproj (gzip) > XML text
  function loadPrgraphic(prgraphicBuf) {
    var zr = zipRead(prgraphicBuf);
    if (!zr.ok) { return { ok: false, error: 'prgraphic zip: ' + zr.error }; }
    var innerName = null, innerBuf = null;
    for (var i = 0; i < zr.entries.length; i++) {
      if (/\.prproj$/i.test(zr.entries[i].name)) { innerName = zr.entries[i].name; innerBuf = zr.entries[i].data; break; }
    }
    if (!innerBuf) { return { ok: false, error: 'no .prproj inside prgraphic' }; }
    var xml;
    try { xml = _zlib.gunzipSync(innerBuf).toString('utf8'); }
    catch (eG) { return { ok: false, error: 'prproj gunzip: ' + String(eG && eG.message || eG) }; }
    return { ok: true, innerName: innerName, xml: xml };
  }

  function savePrgraphic(innerName, xml) {
    var gz = _zlib.gzipSync(toBuf(xml, 'utf8'));  // eslint-disable-line
    var obj = {};
    obj[innerName || 'Untitled.prproj'] = gz;
    return zipWrite(obj);
  }

  // Patch every Source-Text StartKeyframeValue base64 blob that contains
  // oldTextUtf8 at a valid [u32 len] slot. Returns { ok, xml, patches }.
  function patchXmlSourceText(xml, oldTextUtf8, newTextUtf8) {
    var paramRe = /<ArbVideoComponentParam\b[\s\S]*?<\/ArbVideoComponentParam>/g;
    var svRe = /(<StartKeyframeValue\b[^>]*>)([\s\S]*?)(<\/StartKeyframeValue>)/g;
    var patches = 0;
    var outXml = xml;
    var m;
    while ((m = paramRe.exec(xml)) !== null) {
      var block = m[0];
      if (!/<Name>\s*Source Text\s*<\/Name>/.test(block)) { continue; }
      var newBlock = block.replace(svRe, function (whole, open, inner, close) {
        var b64 = inner.replace(/\s+/g, '');
        if (!b64) { return whole; }
        var raw;
        try { raw = toBuf(b64, 'base64'); }  // eslint-disable-line
        catch (eB) { return whole; }
        if (raw.indexOf(oldTextUtf8) < 0) { return whole; }
        var pr = patchTextDocBlob(raw, oldTextUtf8, newTextUtf8);
        if (!pr.ok) { return whole; }
        patches++;
        // re-wrap base64 at 76 cols (Premiere wraps too)
        var nb = pr.out.toString('base64');
        var wrapped = nb.replace(/(.{76})/g, '$1\n');
        return open + wrapped + close;
      });
      if (newBlock !== block) { outXml = outXml.replace(block, newBlock); }
    }
    if (!patches) { return { ok: false, error: 'no Source-Text blob contained the template text' }; }
    return { ok: true, xml: outXml, patches: patches };
  }

  // ---------- public: bake one mogrt ----------
  // templateBuf: Buffer of the original .mogrt
  // newText: string (may contain \r\n, Persian, ZWNJ — all UTF-8 safe)
  // label: optional per-cue suffix for capsuleName (readable project panel)
  // returns { ok, buffer, oldText, patches, reissued } or { ok:false, error }
  function bakeFromBuffer(templateBuf, newText, label) {
    if (!initNode()) { return { ok: false, error: 'E_NONODE' }; }
    if (!Buffer.isBuffer(templateBuf)) { return { ok: false, error: 'E_TPLBUF' }; }
    if (typeof newText !== 'string' || !newText.length) { return { ok: false, error: 'E_EMPTYTEXT' }; }

    var outer = zipRead(templateBuf);
    if (!outer.ok) { return { ok: false, error: 'E_ZIPREAD: ' + outer.error }; }

    // 1) definition.json
    var defBuf = null;
    var others = {};
    for (var i = 0; i < outer.entries.length; i++) {
      var en = outer.entries[i];
      if (en.name === 'definition.json') { defBuf = en.data; }
      else { others[en.name] = en.data; }
    }
    if (!defBuf) { return { ok: false, error: 'E_NODEF' }; }

    var def;
    try { def = JSON.parse(defBuf.toString('utf8')); }
    catch (eJ) { return { ok: false, error: 'E_DEFJSON: ' + String(eJ && eJ.message || eJ) }; }

    var setRes = setTextControl(def, newText);
    if (!setRes.ok) { return { ok: false, error: 'E_NOTEXTCTL: ' + setRes.error }; }
    var oldText = setRes.oldText;
    if (!oldText.length) { return { ok: false, error: 'E_EMPTYOLDTEXT (template placeholder is empty — put sample text in the template first)' }; }

    // unique identity per cue (capsuleID is NOT referenced inside prgraphic)
    def.capsuleID = makeGuid();

    // v2.4: per-cue capsule name — the project panel then shows one entry per
    // layer ("nilztest — 007") instead of N identical names, and Premiere gets
    // one more uniqueness axis across the batch.
    if (label) {
      if (typeof def.capsuleName === 'string' && def.capsuleName.length) { def.capsuleName = def.capsuleName + label; }
      if (def.capsuleNameLocalized && def.capsuleNameLocalized.strDB) {
        for (var lc = 0; lc < def.capsuleNameLocalized.strDB.length; lc++) {
          var eL = def.capsuleNameLocalized.strDB[lc];
          if (eL && typeof eL.str === 'string' && eL.str.length) { eL.str = eL.str + label; }
        }
      }
    }

    // 2) project.prgraphic
    var prgraphicBuf = others['project.prgraphic'];
    if (!prgraphicBuf) { return { ok: false, error: 'E_NOPRGRAPHIC' }; }
    delete others['project.prgraphic'];

    var pg = loadPrgraphic(prgraphicBuf);
    if (!pg.ok) { return { ok: false, error: 'E_PRGRAPHIC: ' + pg.error }; }

    var oldTextUtf8 = toBuf(oldText, 'utf8');       // eslint-disable-line
    var newTextUtf8 = toBuf(newText, 'utf8');       // eslint-disable-line
    var px = patchXmlSourceText(pg.xml, oldTextUtf8, newTextUtf8);
    if (!px.ok) { return { ok: false, error: 'E_XMLPATCH: ' + px.error }; }

    // v2.4 ANTI-CRASH: re-issue the prproj object identities (ObjectUID /
    // ObjectURef / ClipID) with a consistent per-file map, mirrored into the
    // definition.json string (sourceInfoLocalized.*.id repeats the Sequence
    // GUID there). v2.0..v2.3 shipped every sibling baked file with IDENTICAL
    // object identities — import #1 registers them, import #2 collides inside
    // Premiere's object registry → the "second layer" hard crash the user saw
    // even with long pauses. Constants (ClassID/MediaType/…) are never moved.
    var defStr = JSON.stringify(def, null, 1);
    var ri = reidentifyPrproj(px.xml, defStr);

    var newDefBuf = toBuf(ri.def, 'utf8');          // eslint-disable-line
    var newPrgraphic = savePrgraphic(pg.innerName, ri.xml);

    // 3) rebuild the mogrt zip
    var obj = { 'definition.json': newDefBuf, 'project.prgraphic': newPrgraphic };
    for (var k in others) { if (Object.prototype.hasOwnProperty.call(others, k)) { obj[k] = others[k]; } }
    var out = zipWrite(obj);

    // 4) self-verification: re-read our own output and confirm the text
    var chk = verifyBuffer(out, newText);
    if (!chk.ok) { return { ok: false, error: 'E_VERIFY: ' + chk.error }; }

    return { ok: true, buffer: out, oldText: oldText, patches: px.patches, reissued: ri.remapped };
  }

  // re-read a baked buffer and confirm definition text + binary text
  function verifyBuffer(buf, expectedText) {
    var zr = zipRead(buf);
    if (!zr.ok) { return { ok: false, error: 'rezip: ' + zr.error }; }
    var defBuf = null, prgBuf = null;
    for (var i = 0; i < zr.entries.length; i++) {
      if (zr.entries[i].name === 'definition.json') { defBuf = zr.entries[i].data; }
      if (zr.entries[i].name === 'project.prgraphic') { prgBuf = zr.entries[i].data; }
    }
    if (!defBuf || !prgBuf) { return { ok: false, error: 'missing entries' }; }
    var def;
    try { def = JSON.parse(defBuf.toString('utf8')); } catch (e) { return { ok: false, error: 'def json' }; }
    var c = findTextControl(def);
    if (!c) { return { ok: false, error: 'no text ctl' }; }
    for (var s = 0; s < c.value.strDB.length; s++) {
      if (String(c.value.strDB[s].str) !== expectedText) { return { ok: false, error: 'def text mismatch' }; }
    }
    var pg = loadPrgraphic(prgBuf);
    if (!pg.ok) { return { ok: false, error: 'prgraphic: ' + pg.error }; }
    var expUtf8 = toBuf(expectedText, 'utf8');  // eslint-disable-line
    var svRe = /<StartKeyframeValue\b[^>]*>([\s\S]*?)<\/StartKeyframeValue>/g;
    var m, found = 0;
    var paramRe = /<ArbVideoComponentParam\b[\s\S]*?<\/ArbVideoComponentParam>/g;
    var pm;
    while ((pm = paramRe.exec(pg.xml)) !== null) {
      if (!/<Name>\s*Source Text\s*<\/Name>/.test(pm[0])) { continue; }
      while ((m = svRe.exec(pm[0])) !== null) {
        var b64 = m[1].replace(/\s+/g, '');
        var raw;
        try { raw = toBuf(b64, 'base64'); } catch (eB) { continue; }  // eslint-disable-line
        if (raw.indexOf(expUtf8) >= 0) { found++; }
      }
    }
    if (!found) { return { ok: false, error: 'binary text mismatch' }; }
    return { ok: true, hits: found };
  }

  // ---------- v3.3: read the CURRENT text of a mogrt (no getValue) ----------
  // definition.json's TEXT client control is what Essential Graphics shows;
  // it is plain UTF-8 JSON inside the zip — trivially readable.
  function blobLongestText(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 8) { return ''; }
    var best = '', bestLen = 0;
    var limit = raw.length - 4;
    for (var o = 0; o < limit; o++) {
      var len = 0;
      try { len = raw.readUInt32LE(o); } catch (eL) { break; }
      if (len <= 0 || len > 4096 || o + 4 + len > raw.length) { continue; }
      var txt = '';
      try { txt = raw.slice(o + 4, o + 4 + len).toString('utf8'); } catch (eU) { continue; }
      if (!txt.length) { continue; }
      var printable = true;
      for (var i = 0; i < txt.length; i++) {
        var c = txt.charCodeAt(i);
        if (c < 9 || (c > 13 && c < 32) || (c >= 0xD800 && c <= 0xDFFF)) { printable = false; break; }
      }
      if (!printable) { continue; }
      if (txt.length > bestLen) { best = txt; bestLen = txt.length; }
    }
    return best;
  }

  // Returns { ok, text, via:'def'|'blob' } | { ok:false, error }
  function readTextFromBuffer(templateBuf) {
    if (!initNode()) { return { ok: false, error: 'E_NONODE' }; }
    if (!Buffer.isBuffer(templateBuf)) { return { ok: false, error: 'E_TPLBUF' }; }
    var outer = zipRead(templateBuf);
    if (!outer.ok) { return { ok: false, error: 'E_ZIPREAD: ' + outer.error }; }
    var defBuf = null, prgBuf = null;
    for (var i = 0; i < outer.entries.length; i++) {
      if (outer.entries[i].name === 'definition.json') { defBuf = outer.entries[i].data; }
      if (outer.entries[i].name === 'project.prgraphic') { prgBuf = outer.entries[i].data; }
    }
    if (defBuf) {
      var def = null;
      try { def = JSON.parse(defBuf.toString('utf8')); } catch (eJ) { def = null; }
      if (def) {
        var c = findTextControl(def);
        if (c) {
          for (var s = 0; s < c.value.strDB.length; s++) {
            var st = String(c.value.strDB[s].str || '');
            if (st.length) { return { ok: true, text: st, via: 'def' }; }
          }
        }
      }
    }
    if (prgBuf) {
      var pg = loadPrgraphic(prgBuf);
      if (pg.ok) {
        var svRe = /<StartKeyframeValue\b[^>]*>([\s\S]*?)<\/StartKeyframeValue>/g;
        var m, best = '', pm;
        var paramRe = /<ArbVideoComponentParam\b[\s\S]*?<\/ArbVideoComponentParam>/g;
        while ((pm = paramRe.exec(pg.xml)) !== null) {
          if (!/<Name>\s*Source Text\s*<\/Name>/.test(pm[0])) { continue; }
          while ((m = svRe.exec(pm[0])) !== null) {
            var b64 = m[1].replace(/\s+/g, '');
            if (!b64) { continue; }
            var raw = null;
            try { raw = toBuf(b64, 'base64'); } catch (eB) { continue; }
            var t = blobLongestText(raw);
            if (t && t.length > best.length) { best = t; }
          }
        }
        if (best) { return { ok: true, text: best, via: 'blob' }; }
      }
    }
    return { ok: false, error: 'E_NOTEXT' };
  }

  function readTextFile(p) {
    if (!initNode()) { return { ok: false, error: 'E_NONODE' }; }
    var buf;
    try { buf = _fs.readFileSync(p); }
    catch (eR) { return { ok: false, error: 'E_READ: ' + String(eR && eR.message || eR) }; }
    return readTextFromBuffer(buf);
  }

  // ---------- v3.3: re-bake an EXISTING clip media file with new text ----------
  // This is the write path for clips whose text cannot be trusted to setValue:
  // the clip's own baked .mogrt is re-baked with the diacritized text and the
  // JSX side swaps the clip in place (same track, same start/end ticks).
  function rebakeFile(srcPath, newText, label) {
    if (!initNode()) { return { ok: false, error: 'E_NONODE' }; }
    var tpl;
    try { tpl = _fs.readFileSync(srcPath); }
    catch (eR) { return { ok: false, error: 'E_READ: ' + String(eR && eR.message || eR) }; }
    var res = bakeFromBuffer(tpl, newText, label);
    if (!res.ok) { return { ok: false, error: res.error }; }
    var dir;
    try {
      dir = _path.join(bakeBaseDir(), 'aerab');
      _fs.mkdirSync(dir, { recursive: true });
    } catch (eM) { return { ok: false, error: 'E_TMPDIR: ' + String(eM && eM.message || eM) }; }
    var p = _path.join(dir, 'aerab_' + Date.now() + '_' + Math.floor(Math.random() * 100000) + '.mogrt');
    try { _fs.writeFileSync(p, res.buffer); }
    catch (eW) { return { ok: false, error: 'E_WRITE: ' + String(eW && eW.message || eW) }; }
    return { ok: true, path: p, oldText: res.oldText, patches: res.patches };
  }

  // ---------- public: bake a whole cue list to temp files ----------
  // templatePath: string; cues: [{startTicks, endTicks, text}]
  // returns { ok, dir, items:[{path, startTicks, endTicks}], probeText, error }
  // v2.2 — baked files become real project media (the imported MGT clips
  // reference them), so they must live in a STABLE folder. The OS temp dir is
  // wiped by disk-cleanup tools, which would make subtitles go offline.
  function bakeBaseDir() {
    try {
      var home = _os.homedir ? _os.homedir() : '';
      if (home) {
        var base = _path.join(home, 'Documents', 'SubSaz-Lite', 'Baked');
        try { _fs.mkdirSync(base, { recursive: true }); return base; } catch (eM) { }
      }
    } catch (eH) { }
    return _path.join(_os.tmpdir(), 'srt2graphics_baked_lite');
  }

  function bakeCueList(templatePath, cues) {
    if (!initNode()) { return { ok: false, error: 'E_NONODE' }; }
    var tpl;
    try { tpl = _fs.readFileSync(templatePath); }
    catch (eR) { return { ok: false, error: 'E_TPLREAD: ' + String(eR && eR.message || eR) }; }

    var dir;
    try {
      dir = _path.join(bakeBaseDir(), String(Date.now()));
      _fs.mkdirSync(dir, { recursive: true });
    } catch (eM) {
      try { dir = _path.join(_os.tmpdir(), 'srt2graphics_baked_lite_' + Date.now()); _fs.mkdirSync(dir); }
      catch (eM2) { return { ok: false, error: 'E_TMPDIR: ' + String(eM2 && eM2.message || eM2) }; }
    }

    var items = [];
    var oldTextSeen = '';
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var res = bakeFromBuffer(tpl, cue.text, cue.label);
      if (!res.ok) { return { ok: false, error: res.error, dir: dir, bakedSoFar: items.length }; }
      oldTextSeen = res.oldText;
      var p = _path.join(dir, 'baked_' + ('0000' + i).slice(-4) + '.mogrt');
      try { _fs.writeFileSync(p, res.buffer); }
      catch (eW) { return { ok: false, error: 'E_WRITE: ' + String(eW && eW.message || eW), dir: dir, bakedSoFar: items.length }; }
      items.push({ path: p, startTicks: cue.startTicks, endTicks: cue.endTicks });
    }
    return { ok: true, dir: dir, items: items, oldText: oldTextSeen };
  }

  // ---------- cleanup old baked dirs (best effort) ----------
  // v2.2: retention raised 2 days → 60 days — baked files ARE project media;
  // deleting them too early makes the subtitles in saved projects go offline.
  function cleanupTemp() {
    if (!initNode()) { return false; }
    var bases = [];
    try { bases.push(_path.join(_os.tmpdir(), 'srt2graphics_baked_lite')); } catch (e0) {}
    try { bases.push(bakeBaseDir()); } catch (e1) {}
    var cutoff = Date.now() - 60 * 24 * 3600 * 1000; // keep 60 days
    for (var b = 0; b < bases.length; b++) {
      try {
        var dirs = _fs.readdirSync(bases[b]);
        for (var i = 0; i < dirs.length; i++) {
          var d = _path.join(bases[b], dirs[i]);
          var st = _fs.statSync(d);
          if (st.isDirectory() && st.mtimeMs < cutoff) {
            var files = _fs.readdirSync(d);
            for (var f = 0; f < files.length; f++) { try { _fs.unlinkSync(_path.join(d, files[f])); } catch (eU) {} }
            try { _fs.rmdirSync(d); } catch (eR) {}
          }
        }
      } catch (e) {}
    }
    return true;
  }

  // ---------- v2.2: chunked async bake ----------
  // Keeps the panel UI alive on big SRT files and reports progress.
  // cb receives exactly the same result object shape as bakeCueList.
  function bakeCueListAsync(templatePath, cues, onProgress, cb) {
    if (typeof cb !== 'function') { cb = function () {}; }
    if (!initNode()) { cb({ ok: false, error: 'E_NONODE' }); return; }
    var tpl;
    try { tpl = _fs.readFileSync(templatePath); }
    catch (eR) { cb({ ok: false, error: 'E_TPLREAD: ' + String(eR && eR.message || eR) }); return; }

    var dir;
    try {
      dir = _path.join(bakeBaseDir(), String(Date.now()));
      _fs.mkdirSync(dir, { recursive: true });
    } catch (eM) { cb({ ok: false, error: 'E_TMPDIR: ' + String(eM && eM.message || eM) }); return; }

    var items = [];
    var oldTextSeen = '';
    var i = 0;
    var CHUNK = 15;
    function step() {
      var end = Math.min(i + CHUNK, cues.length);
      for (; i < end; i++) {
        var res = bakeFromBuffer(tpl, cues[i].text, cues[i].label);
        if (!res.ok) { cb({ ok: false, error: res.error, dir: dir, bakedSoFar: items.length }); return; }
        oldTextSeen = res.oldText;
        var p = _path.join(dir, 'baked_' + ('0000' + i).slice(-4) + '.mogrt');
        try { _fs.writeFileSync(p, res.buffer); }
        catch (eW) { cb({ ok: false, error: 'E_WRITE: ' + String(eW && eW.message || eW), dir: dir, bakedSoFar: items.length }); return; }
        items.push({ path: p, startTicks: cues[i].startTicks, endTicks: cues[i].endTicks });
      }
      if (typeof onProgress === 'function') { try { onProgress({ done: items.length, total: cues.length }); } catch (eP) {} }
      if (i < cues.length) { setTimeout(step, 0); }
      else { cb({ ok: true, dir: dir, items: items, oldText: oldTextSeen }); }
    }
    step();
  }

  // ---------- exports ----------
  var MogrtBaker = {
    nodeAvailable: nodeAvailable,
    bakeFromBuffer: bakeFromBuffer,
    bakeCueList: bakeCueList,
    bakeCueListAsync: bakeCueListAsync,
    verifyBuffer: verifyBuffer,
    cleanupTemp: cleanupTemp,
    // v3.3: read + re-bake existing clips' media files
    readTextFromBuffer: readTextFromBuffer,
    readTextFile: readTextFile,
    rebakeFile: rebakeFile,
    // exposed for tests
    _zipRead: zipRead,
    _zipWrite: zipWrite,
    _patchTextDocBlob: patchTextDocBlob,
    _patchXmlSourceText: patchXmlSourceText,
    _reidentifyPrproj: reidentifyPrproj
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = MogrtBaker; }
  root.MogrtBaker = MogrtBaker;
})(typeof window !== 'undefined' ? window : globalThis);
