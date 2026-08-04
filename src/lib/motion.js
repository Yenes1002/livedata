/* =====================================================================
   MOTION — 所有动画都从这里走，组件不直接 import anime
   anime.js v4（ESM，named exports；跟 v3 的 anime() 默认导出不一样）
   ===================================================================== */
import {
  animate,
  createTimer,
  createSpring,
  createDrawable,
  stagger,
  utils,
} from "https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js";

// Only what components genuinely reach for. Everything else stays internal to
// this module, so anime's API surface doesn't leak across the whole app.
export { animate, createTimer };

/** 系统层面要求减少动效时，全部动画降级为「直接到终态」 */
const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

export const MOTION = {
  get enabled() {
    return !reduceQuery.matches;
  },
  dur: {
    fast: 220,
    base: 420,
    slow: 700,
    count: 900,   // 数字滚动
    draw: 1100,   // sparkline 描线
  },
  ease: {
    out: "outExpo",
    inOut: "inOutQuad",
    soft: "outQuad",
    back: "outBack",
  },
  /** FLIP 换位用弹簧，比固定曲线更像「东西被推过去」。建一次复用，别每个元素都 new 一个 */
  get spring() {
    _spring ??= createSpring({ stiffness: 130, damping: 16 });
    return _spring;
  },
};
let _spring = null;

/* ---------------------------------------------------------------------
   COUNT-UP — 数值刷新时从旧值滚到新值
   直接 tween 一个 {v} 对象，onUpdate 里再格式化写回文本，
   这样千分位 / 货币前缀不会被动画拆坏。
--------------------------------------------------------------------- */
export function countUp(el, from, to, format, { duration = MOTION.dur.count } = {}) {
  if (!el) return null;

  const target = Number(to);
  // 终态非数字（比如 ROAS 在没花费时是 null）就不做动画
  if (!Number.isFinite(target)) {
    el.textContent = format(to);
    return null;
  }

  const start = Number.isFinite(Number(from)) ? Number(from) : 0;
  if (!MOTION.enabled || start === target) {
    el.textContent = format(target);
    return null;
  }

  const proxy = { v: start };
  return animate(proxy, {
    v: target,
    duration,
    ease: MOTION.ease.out,
    onUpdate: () => { el.textContent = format(proxy.v); },
    onComplete: () => { el.textContent = format(target); },
  });
}

/* ---------------------------------------------------------------------
   FLASH — 值变了就闪一下：涨=金色，跌=红色
   取代原来那个「每次 render 都无脑闪」的 .flash-update CSS 动画
--------------------------------------------------------------------- */
const FLASH_TONES = {
  up: "52,211,153",
  down: "248,113,113",
  neutral: "246,214,113",
};

/**
 * 两个关键帧的 box-shadow 结构必须完全一致（同样是 2 层阴影、
 * 每层同样 4 个数值 + 1 个颜色），否则 anime 没法逐个数值插值。
 * 收尾也不要褪成黑色，而是褪成同色 alpha 0。
 */
export function flash(el, tone = "neutral") {
  if (!el || !MOTION.enabled) return null;
  const rgb = FLASH_TONES[tone] || FLASH_TONES.neutral;
  return animate(el, {
    boxShadow: [
      `0 0 0 1px rgba(${rgb},0.55), 0 0 26px 0 rgba(${rgb},0.45)`,
      `0 0 0 0 rgba(${rgb},0), 0 0 0 0 rgba(${rgb},0)`,
    ],
    duration: 1100,
    ease: MOTION.ease.soft,
  });
}

/* ---------------------------------------------------------------------
   REVEAL — 首次出现 / 重新渲染时的错落入场
--------------------------------------------------------------------- */
export function reveal(els, { delayStep = 34, y = 10, duration = MOTION.dur.base } = {}) {
  const list = Array.from(els || []);
  if (!list.length) return null;
  if (!MOTION.enabled) {
    list.forEach((el) => { el.style.opacity = ""; el.style.transform = ""; });
    return null;
  }
  return animate(list, {
    opacity: [0, 1],
    translateY: [y, 0],
    duration,
    delay: stagger(delayStep),
    ease: MOTION.ease.out,
  });
}

/* ---------------------------------------------------------------------
   FLIP — 排名换位 / 表格重排时，让每一行从旧位置滑到新位置

   mutate() 里重建 DOM；前后各量一次 getBoundingClientRect，
   用 data-flip-key 把「同一个项目」在新旧 DOM 之间对上。
--------------------------------------------------------------------- */
export function flip(container, mutate, { duration = MOTION.dur.slow } = {}) {
  if (!container) { mutate(); return; }

  const readRects = () => {
    const map = new Map();
    container.querySelectorAll("[data-flip-key]").forEach((el) => {
      map.set(el.dataset.flipKey, el.getBoundingClientRect());
    });
    return map;
  };

  if (!MOTION.enabled) { mutate(); return; }

  const before = readRects();
  mutate();

  const moved = [];
  const entered = [];

  container.querySelectorAll("[data-flip-key]").forEach((el) => {
    const b = before.get(el.dataset.flipKey);
    if (!b) { entered.push(el); return; }
    const a = el.getBoundingClientRect();
    const dy = b.top - a.top;
    const dx = b.left - a.left;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    moved.push({ el, dx, dy });
  });

  for (const { el, dx, dy } of moved) {
    animate(el, {
      translateX: [dx, 0],
      translateY: [dy, 0],
      duration,
      ease: MOTION.spring,
    });
  }

  // 新进榜的项目：淡入，不参与位移
  if (entered.length) {
    animate(entered, {
      opacity: [0, 1],
      translateX: [-12, 0],
      duration: MOTION.dur.base,
      delay: stagger(40),
      ease: MOTION.ease.out,
    });
  }
}

/* ---------------------------------------------------------------------
   BAR — 进度条 / 占比条宽度过渡
--------------------------------------------------------------------- */
export function animateBar(el, toPct, { duration = MOTION.dur.slow, delay = 0 } = {}) {
  if (!el) return null;
  const target = `${utils.clamp(Number(toPct) || 0, 0, 100)}%`;
  if (!MOTION.enabled) { el.style.width = target; return null; }
  return animate(el, {
    width: [el.style.width || "0%", target],
    duration,
    delay,
    ease: MOTION.ease.out,
  });
}

/* ---------------------------------------------------------------------
   DRAW — sparkline 描线（anime v4 的 createDrawable）
--------------------------------------------------------------------- */
export function drawPath(pathEl, { duration = MOTION.dur.draw, delay = 0 } = {}) {
  if (!pathEl) return null;
  if (!MOTION.enabled) {
    pathEl.style.strokeDasharray = "none";
    pathEl.style.strokeDashoffset = "0";
    return null;
  }
  try {
    const [drawable] = createDrawable(pathEl);
    return animate(drawable, {
      draw: ["0 0", "0 1"],
      duration,
      delay,
      ease: MOTION.ease.inOut,
    });
  } catch (err) {
    // createDrawable 依赖 SVG getTotalLength()，某些环境下拿不到。
    // 描线只是锦上添花，失败就直接显示完整的线，别把整次渲染带崩。
    console.warn("[motion] sparkline 描线动画不可用，回退为直接显示：", err);
    pathEl.style.strokeDasharray = "none";
    pathEl.style.strokeDashoffset = "0";
    return null;
  }
}

/* ---------------------------------------------------------------------
   PULSE — LIVE 指示点（原来是 CSS @keyframes pulse）
--------------------------------------------------------------------- */
export function livePulse(ringEl) {
  if (!ringEl || !MOTION.enabled) return null;
  return animate(ringEl, {
    scale: [0.4, 1.9],
    opacity: [0.9, 0],
    duration: 1800,
    loop: true,
    ease: MOTION.ease.soft,
  });
}

/* ---------------------------------------------------------------------
   SCAN — header 上那道金色扫光（原来是 CSS @keyframes scan）
--------------------------------------------------------------------- */
export function headerScan(el) {
  if (!el || !MOTION.enabled) return null;
  return animate(el, {
    left: ["-30%", "110%"],
    duration: 6000,
    loop: true,
    ease: "linear",
  });
}
