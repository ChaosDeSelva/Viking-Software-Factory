// Applies the saved theme before first paint (the CSP forbids inline scripts, so it is a file).
try {
  var t = localStorage.getItem("factory-theme");
  if (t === "light" || t === "dark")
    document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
