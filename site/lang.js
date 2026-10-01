/* Runs synchronously in <head> so the chosen language paints first (no flash). */
(function () {
  var root = document.documentElement;
  function norm(value) {
    if (!value) return null;
    value = String(value).toLowerCase();
    if (value.indexOf("zh") === 0) return "zh";
    if (value.indexOf("en") === 0) return "en";
    return null;
  }
  var requested = null;
  var saved = null;
  try { requested = new URLSearchParams(window.location.search).get("lang"); } catch (e) {}
  try { saved = window.localStorage.getItem("tedh-project-lang"); } catch (e) {}
  var langs = navigator.languages || [navigator.language || ""];
  var browser = "en";
  for (var i = 0; i < langs.length; i++) {
    if (String(langs[i]).toLowerCase().indexOf("zh") === 0) { browser = "zh"; break; }
  }
  var lang = norm(requested) || norm(saved) || browser;
  root.setAttribute("data-lang", lang);
  root.lang = lang === "zh" ? "zh-Hant" : "en";
})();
