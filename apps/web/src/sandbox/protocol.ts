/** Shared primitives only; installed views and historical chat widgets keep separate persistence adapters. */
export const sandboxJSON = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
export const SANDBOX_THEME_SCRIPT = `
function __applyHostTheme(values,scheme,attribute){
  var root=document.documentElement;
  for(var key of Object.keys(values||{}))if(/^--[a-z][a-z0-9-]*$/.test(key)&&typeof values[key]==='string')root.style.setProperty(key,values[key]);
  var dark=scheme==='dark';root.style.colorScheme=dark?'dark':'light';
  root.classList.toggle('dark',dark);root.classList.toggle('light',!dark);
  root.setAttribute(attribute||'data-theme',dark?'dark':'light');
}
`;
