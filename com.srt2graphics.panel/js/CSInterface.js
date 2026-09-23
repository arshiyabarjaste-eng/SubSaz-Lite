/**
 * CSInterface — minimal compatible subset (CEP 9..11)
 * Provides: evalScript, getSystemPath, addEventListener, getHostEnvironment
 */
function SystemPath() {}
SystemPath.USER_DATA        = "userData";
SystemPath.COMMON_FILES     = "commonFiles";
SystemPath.MY_DOCUMENTS     = "myDocuments";
SystemPath.APPLICATION      = "application";
SystemPath.EXTENSION        = "extension";
SystemPath.HOST_APPLICATION = "hostApplication";

function CSInterface() {}

CSInterface.EVAL_SCRIPT_ERROR = "EvalScript error.";

CSInterface.prototype.evalScript = function (script, callback) {
  if (callback === null || callback === undefined) { callback = function (result) {}; }
  if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
    window.__adobe_cep__.evalScript(script, callback);
  } else {
    callback(CSInterface.EVAL_SCRIPT_ERROR);
  }
};

CSInterface.prototype.getSystemPath = function (pathType) {
  if (!window.__adobe_cep__ || !window.__adobe_cep__.getSystemPath) { return ""; }
  var path = decodeURIComponent(window.__adobe_cep__.getSystemPath(pathType));
  var OSVersion = this.getOSInformation();
  if (OSVersion.indexOf("Windows") >= 0) {
    path = path.replace("file:///", "").replace(/\//g, "\\");
  } else if (OSVersion.indexOf("Mac") >= 0) {
    path = path.replace("file://", "");
  }
  return path;
};

CSInterface.prototype.getOSInformation = function () {
  var userAgent = navigator.userAgent;
  if ((navigator.platform === "Win32") || (navigator.platform === "Windows")) {
    return "Windows";
  } else if ((navigator.platform === "MacIntel") || (navigator.platform === "Macintosh")) {
    return "Mac OS X";
  }
  return userAgent;
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
  if (window.__adobe_cep__ && window.__adobe_cep__.addEventListener) {
    window.__adobe_cep__.addEventListener(type, listener, obj);
  }
};

CSInterface.prototype.getHostEnvironment = function () {
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return null;
  }
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  try { window.cep.util.openURLInDefaultBrowser(url); } catch (e) {}
};

/** CEP file API wrapper (window.cep.fs) */
function CepFile() {}
CepFile.prototype.readFile = function (path) {
  if (window.cep && window.cep.fs && window.cep.fs.readFile) {
    return window.cep.fs.readFile(path); // {data, err}
  }
  return { err: -1, data: "" };
};
CepFile.prototype.ERR_OK = 0;
