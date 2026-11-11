// Applies the saved theme before first paint. Same text as @factory/ui themeScript (tests check it);
// a file, not an inline script, because the CSP allows only same-origin scripts.
try{var t=localStorage.getItem("factory-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}
