/* =====================================================================
   TEST HARNESS — boots the real dashboard inside jsdom

   The page has no build step, so there's nothing to compile: we stage a copy
   of src/, point its anime.js import at the local node_modules build instead
   of the CDN, and run the real module graph against a stubbed Supabase.

   What jsdom can and can't tell us:
     ✓ module graph loads, components mount, DOM ids line up
     ✓ fetch → aggregate → render is correct (incl. >1000-row pagination)
     ✓ interactions: sort, row-click filtering, refresh diffing
     ✗ actual pixel motion — jsdom has no layout, so getBoundingClientRect()
       is all zeros and FLIP is a no-op here
     ✗ box-shadow — jsdom's computed style returns "", so anime skips writing
       it; flash() is verified through instrumentation instead (see stageSrc)
   ===================================================================== */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const STAGE_ROOT = path.join(__dirname, ".stage");

/** The CDN specifier index.html actually ships. Kept in sync by assertAnimeVersionPinned(). */
export const ANIME_CDN = "https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js";

const ANIME_PKG = path.join(PROJECT_ROOT, "node_modules", "animejs");
const ANIME_ESM = path.join(ANIME_PKG, "dist", "bundles", "anime.esm.min.js");

if (!fs.existsSync(ANIME_ESM)) {
  console.error("anime.js not found in node_modules — run `npm install` first.");
  process.exit(1);
}

/**
 * Guard: the version the browser loads from the CDN must match the version the
 * tests run against, otherwise we'd be testing a build the page never uses.
 */
export function assertAnimeVersionPinned() {
  const installed = JSON.parse(fs.readFileSync(path.join(ANIME_PKG, "package.json"), "utf8")).version;
  const motion = fs.readFileSync(path.join(PROJECT_ROOT, "src", "lib", "motion.js"), "utf8");
  const m = motion.match(/animejs@([\d.]+)\/dist\/bundles\/anime\.esm\.min\.js/);
  if (!m) throw new Error("could not find the pinned anime.js CDN URL in src/lib/motion.js");
  if (m[1] !== installed) {
    throw new Error(
      `anime.js version drift: src/lib/motion.js pins ${m[1]} but node_modules has ${installed}. ` +
      `Update package.json and motion.js together.`
    );
  }
  return installed;
}

let stageSeq = 0;

/**
 * Copy src/ into a scratch dir with the anime CDN import rewritten to the local build.
 * @param {object} opts
 * @param {boolean} opts.demo          blank out the Supabase creds to force DEMO_MODE
 * @param {boolean} opts.instrumentFlash  record flash() calls on globalThis.__flashLog
 */
export function stageSrc({ demo = false, instrumentFlash = false } = {}) {
  const dir = path.join(STAGE_ROOT, `s${++stageSeq}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, "src"), path.join(dir, "src"), { recursive: true });
  fs.copyFileSync(ANIME_ESM, path.join(dir, "anime.esm.min.js"));

  const motionPath = path.join(dir, "src", "lib", "motion.js");
  let motion = fs.readFileSync(motionPath, "utf8");

  if (!motion.includes(ANIME_CDN)) {
    throw new Error(`anime CDN import not found in src/lib/motion.js (expected ${ANIME_CDN})`);
  }
  motion = motion.replace(ANIME_CDN, "../../anime.esm.min.js");

  if (instrumentFlash) {
    // jsdom returns "" for computed box-shadow, so anime never writes it and we
    // can't observe flash() via the style attribute. Record the calls instead.
    const sig = 'export function flash(el, tone = "neutral") {';
    if (!motion.includes(sig)) throw new Error("flash() signature changed — update harness.mjs");
    motion = motion.replace(
      sig,
      sig + '\n  (globalThis.__flashLog ??= []).push({ tone, cell: el?.dataset?.cell, tag: el?.tagName });'
    );
  }

  fs.writeFileSync(motionPath, motion);

  if (demo) {
    const cfgPath = path.join(dir, "src", "config.js");
    const cfg = fs.readFileSync(cfgPath, "utf8")
      .replace(/SUPABASE_URL: "[^"]*"/, 'SUPABASE_URL: "YOUR_SUPABASE_URL"')
      .replace(/SUPABASE_ANON_KEY: "[^"]*"/, 'SUPABASE_ANON_KEY: "YOUR_ANON_KEY"');
    fs.writeFileSync(cfgPath, cfg);
  }

  return { dir, seq: stageSeq };
}

/** DOM constructors anime.js and the components need on globalThis.
 *  Deliberately excludes `performance` and `navigator`: jsdom's versions
 *  delegate back to the Node globals, and copying them recurses forever. */
const DOM_GLOBALS = [
  "window", "document", "requestAnimationFrame", "cancelAnimationFrame",
  "getComputedStyle", "Element", "HTMLElement", "SVGElement", "SVGSVGElement",
  "SVGGeometryElement", "Node", "NodeList", "HTMLCollection", "CSS",
  "MutationObserver", "DOMParser", "customElements", "Event", "CustomEvent", "DOMRect",
];

/**
 * Boot index.html + the staged module graph in a fresh jsdom.
 * @param {object} opts
 * @param {{dir:string,seq:number}} opts.stage      from stageSrc()
 * @param {() => object} opts.supabase              factory returning a Supabase-like client
 * @param {boolean} opts.reduced                    simulate prefers-reduced-motion
 * @param {number} opts.settleMs                    how long to let animations/fetches run
 */
export async function bootDom({ stage, supabase, reduced = false, settleMs = 350 }) {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, "index.html"), "utf8")
    // drop CDN <script> tags (Tailwind/Supabase) and the module tag; we inject our own
    .replace(/<script src="https:\/\/[^"]*"><\/script>/g, "")
    .replace(/<script type="module"[^>]*><\/script>/g, "");

  const dom = new JSDOM(html, { pretendToBeVisual: true, url: "http://localhost/" });
  const { window } = dom;

  const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e.error)));

  window.matchMedia = (q) => ({
    matches: reduced && /prefers-reduced-motion/.test(q),
    media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });

  window.supabase = { createClient: () => supabase() };

  for (const k of DOM_GLOBALS) {
    if (window[k] === undefined) continue;
    try {
      Object.defineProperty(globalThis, k, { value: window[k], writable: true, configurable: true });
    } catch { /* locked in some Node versions; anime only needs window + document */ }
  }
  Object.defineProperty(globalThis, "self", { value: window, writable: true, configurable: true });

  const consoleErrors = [];
  const originalError = console.error;
  console.error = (...a) => { consoleErrors.push(a.map(String).join(" ")); };

  try {
    await import("file://" + path.join(stage.dir, "src", "app.js") + `?v=${stage.seq}`);
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await settle(settleMs);
  } finally {
    console.error = originalError;
  }

  return {
    window,
    store: window.__dashboard?.store,
    errors,
    consoleErrors,
    q: (sel) => window.document.querySelector(sel),
    qa: (sel) => [...window.document.querySelectorAll(sel)],
  };
}

export const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------
   Tiny assertion collector
--------------------------------------------------------------------- */
export function createChecks() {
  const results = [];
  const check = (name, cond, detail = "") => results.push({ name, pass: !!cond, detail: cond ? "" : detail });

  function report(title) {
    console.log(`\n================ ${title} ================`);
    let failed = 0;
    for (const r of results) {
      console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "\n        " + r.detail}`);
      if (!r.pass) failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    return failed;
  }

  return { check, report, results };
}

export function cleanStage() {
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
}
