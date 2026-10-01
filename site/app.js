(function () {
  "use strict";
  var root = document.documentElement;
  var buttons = document.querySelectorAll("[data-language]");
  var description = document.querySelector('meta[name="description"]');

  function apply(lang, updateUrl) {
    var next = lang === "zh" ? "zh" : "en";
    root.setAttribute("data-lang", next);
    root.lang = next === "zh" ? "zh-Hant" : "en";
    var title = root.getAttribute("data-title-" + next);
    var desc = root.getAttribute("data-desc-" + next);
    if (title) document.title = title;
    if (desc && description) description.setAttribute("content", desc);
    buttons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-language") === next));
    });
    try { window.localStorage.setItem("tedh-project-lang", next); } catch (e) {}
    if (updateUrl && window.history && window.URL) {
      var url = new URL(window.location.href);
      if (next === "zh") url.searchParams.set("lang", "zh-TW");
      else url.searchParams.delete("lang");
      window.history.replaceState({}, "", url);
    }
  }

  buttons.forEach(function (button) {
    button.addEventListener("click", function () { apply(button.getAttribute("data-language"), true); });
  });
  apply(root.getAttribute("data-lang"), false);

  var menu = document.querySelector(".menu-button");
  var nav = document.querySelector(".site-nav");
  if (menu && nav) {
    menu.addEventListener("click", function () {
      var open = menu.getAttribute("aria-expanded") !== "true";
      menu.setAttribute("aria-expanded", String(open));
      nav.classList.toggle("is-open", open);
    });
    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        menu.setAttribute("aria-expanded", "false");
        nav.classList.remove("is-open");
      });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        menu.setAttribute("aria-expanded", "false");
        nav.classList.remove("is-open");
        menu.focus();
      }
    });
  }

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var target = document.getElementById(button.getAttribute("data-copy"));
      if (!target || !navigator.clipboard) return;
      navigator.clipboard.writeText(target.innerText.replace(/\n$/, "")).then(function () {
        button.classList.add("is-done");
        setTimeout(function () { button.classList.remove("is-done"); }, 1600);
      });
    });
  });

  // Chinese has no spaces between words, so a long heading can break inside a
  // word. Mark the word boundaries (Intl.Segmenter) as break points; the
  // stylesheet keeps the characters between them together.
  if (window.Intl && Intl.Segmenter) {
    var segmenter = new Intl.Segmenter("zh-Hant", { granularity: "word" });
    var han = /[\u3400-\u9fff\uf900-\ufaff]/;
    document.querySelectorAll('h1[lang^="zh"], h2[lang^="zh"], h1 [lang^="zh"], h2 [lang^="zh"], .quote[lang^="zh"]').forEach(function (heading) {
      var walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (node) {
        if (!han.test(node.data)) return;
        var parts = Array.from(segmenter.segment(node.data), function (s) { return s.segment; });
        if (parts.length < 2) return;
        var fragment = document.createDocumentFragment();
        parts.forEach(function (part, i) {
          if (i > 0 && han.test(part.charAt(0)) && han.test(parts[i - 1].slice(-1))) {
            fragment.appendChild(document.createElement("wbr"));
          }
          fragment.appendChild(document.createTextNode(part));
        });
        node.parentNode.replaceChild(fragment, node);
      });
    });
  }

  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();
