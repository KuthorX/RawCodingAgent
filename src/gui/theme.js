"use strict";
// Loaded in <head>, so a chosen theme applies before the first paint. "light" / "dark"; unset follows the system.
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(localStorage.getItem("rca.theme"));
// Changed in another tab, or in the main page while this is one of its frames.
addEventListener("storage", (ev) => { if (ev.key === "rca.theme") applyTheme(ev.newValue); });
