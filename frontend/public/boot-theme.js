(function () {
  var mode = "auto";
  try { mode = window.localStorage.getItem("dstu-theme-mode") || "auto"; } catch (_) {}
  var isDark = mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  root.dataset.theme = isDark ? "dark" : "light";
  root.style.colorScheme = isDark ? "dark" : "light";
})();
