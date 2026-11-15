// Native `title` tooltips are drawn by macOS in a separate window that
// Glance's content protection doesn't cover, so they leak into an
// entire-screen share even while the overlay itself is hidden. Pull every
// `title` off the DOM and draw an equivalent tooltip inside the page (the
// protected webContents) instead. A MutationObserver keeps doing it for
// titles that app.js sets later or injects through innerHTML.
(() => {
  const ATTR = "data-tt";
  let tip = null;
  let current = null;

  const ensure = () => {
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "tt";
      tip.setAttribute("role", "tooltip");
      tip.setAttribute("aria-hidden", "true");
      document.body.appendChild(tip);
    }
    return tip;
  };

  // Strip the native title so macOS never draws its own bubble; keep the text.
  const adopt = (el) => {
    if (!el || el.nodeType !== 1 || !el.hasAttribute("title")) return;
    const text = el.getAttribute("title");
    el.removeAttribute("title");
    if (text) el.setAttribute(ATTR, text);
    else el.removeAttribute(ATTR);
    // `title` doubled as the accessible name for icon-only controls; keep it.
    if (text && !el.getAttribute("aria-label") && !el.textContent.trim()) el.setAttribute("aria-label", text);
    if (el === current) {
      if (text) ensure().textContent = text;
      else hide();
    }
  };
  const sweep = (root) => {
    if (!root || root.nodeType !== 1) return;
    if (root.hasAttribute("title")) adopt(root);
    for (const el of root.querySelectorAll("[title]")) adopt(el);
  };

  const place = (el, t) => {
    const r = el.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const m = 6;
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(m, Math.min(left, window.innerWidth - tr.width - m));
    let top = r.bottom + m;
    if (top + tr.height > window.innerHeight - m) top = r.top - tr.height - m;
    top = Math.max(m, top);
    t.style.left = `${Math.round(left)}px`;
    t.style.top = `${Math.round(top)}px`;
  };
  const show = (el) => {
    const text = el.getAttribute(ATTR);
    if (!text) return;
    const t = ensure();
    t.textContent = text;
    current = el;
    t.classList.add("show");
    t.setAttribute("aria-hidden", "false");
    place(el, t);
  };
  const hide = () => {
    current = null;
    if (tip) {
      tip.classList.remove("show");
      tip.setAttribute("aria-hidden", "true");
    }
  };

  const target = (e) => e.target?.closest?.(`[${ATTR}]`) || null;
  const onOver = (e) => {
    const el = target(e);
    if (el && el !== current) show(el);
    else if (!el && current) hide();
  };
  const onFocus = (e) => {
    const el = target(e);
    if (el && el.matches(":focus-visible")) show(el);
    else hide();
  };

  const init = () => {
    sweep(document.body);
    ensure();
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes") adopt(m.target);
        else for (const n of m.addedNodes) sweep(n);
      }
      if (current && !current.isConnected) hide();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("mousedown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
