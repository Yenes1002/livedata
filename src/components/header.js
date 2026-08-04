/* =====================================================================
   HEADER — 时钟、刷新倒计时环、LIVE 脉冲、扫光、TV 模式

   倒计时改成由 anime 的 createTimer 驱动（原来是 setInterval + 手动减
   1000ms，标签页被后台节流时会走偏）。timer 自己管时间，
   顺手还能拿到 iterationProgress 去画环形进度。
   ===================================================================== */
import { CONFIG } from "../config.js";
import { localTimeStr, mmss } from "../lib/format.js";
import {
  MOTION,
  animate,
  createTimer,
  livePulse,
  headerScan,
  flash,
} from "../lib/motion.js";

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function mountHeader({ store, onRefreshDue }) {
  const clockEl = document.getElementById("clock");
  const countdownEl = document.getElementById("countdown");
  const ringEl = document.getElementById("countdownRing");
  const lastRefreshEl = document.getElementById("lastRefresh");
  const statusPill = document.getElementById("statusPill");
  const statusLabel = document.getElementById("statusLabel");
  const pulseRing = document.getElementById("pulseRing");
  const scanEl = document.getElementById("headerScan");

  if (ringEl) {
    ringEl.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    ringEl.style.strokeDashoffset = "0";
  }

  livePulse(pulseRing);
  headerScan(scanEl);

  /* ---- 时钟：每秒一次就够，独立于刷新倒计时 ---- */
  const clockTimer = createTimer({
    duration: 1000,
    loop: true,
    onLoop: () => { if (clockEl) clockEl.textContent = localTimeStr(); },
  });
  if (clockEl) clockEl.textContent = localTimeStr();

  /* ---- 刷新倒计时 ---- */
  const refreshTimer = createTimer({
    duration: CONFIG.REFRESH_INTERVAL_MS,
    loop: true,
    onUpdate: (self) => {
      const remaining = CONFIG.REFRESH_INTERVAL_MS - self.iterationCurrentTime;
      if (countdownEl) countdownEl.textContent = mmss(remaining);
      if (ringEl) {
        // 环从满到空
        const left = 1 - self.iterationProgress;
        ringEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - left));
      }
    },
    onLoop: () => onRefreshDue(),
  });

  /** 手动刷新后把倒计时归零重新开始 */
  function resetCountdown() {
    refreshTimer.restart();
  }

  /* ---- 状态灯：loading / ready / error ---- */
  const STATUS = {
    idle:    { text: "IDLE",    color: "var(--text-mid)" },
    loading: { text: "SYNCING", color: "var(--gold-bright)" },
    ready:   { text: "LIVE",    color: "var(--green)" },
    error:   { text: "ERROR",   color: "var(--red)" },
  };

  store.subscribe((state, reason) => {
    const s = STATUS[state.status] || STATUS.idle;
    if (statusLabel) {
      statusLabel.textContent = s.text;
      statusLabel.style.color = s.color;
    }
    if (pulseRing) pulseRing.style.borderColor = s.color;
    const dot = document.getElementById("pulseDot");
    if (dot) dot.style.background = s.color;

    if (statusPill && MOTION.enabled && reason === "loading") {
      animate(statusPill, {
        scale: [1, 1.06, 1],
        duration: 520,
        ease: MOTION.ease.soft,
      });
    }

    if (reason === "data") {
      if (lastRefreshEl) lastRefreshEl.textContent = localTimeStr(state.lastRefresh);
      resetCountdown();
    }
    if (reason === "error") {
      if (lastRefreshEl) lastRefreshEl.textContent = "同步失败";
      flash(statusPill, "down");
    }
  });

  mountTvMode();

  return { resetCountdown, clockTimer, refreshTimer };
}

/* ---------------------------------------------------------------------
   TV MODE — 无人值守大屏的慢速来回滚动
   原来用 setInterval 每 40ms 跳 1.2px，观感是抖的；
   改成 anime timer 按 deltaTime 累积，帧率无关且平滑。
--------------------------------------------------------------------- */
function mountTvMode() {
  const btn = document.getElementById("tvScrollToggle");
  if (!btn) return;

  let timer = null;
  let dir = 1;
  let pos = window.scrollY;

  const SPEED = 28; // px/秒

  btn.addEventListener("click", () => {
    if (timer) {
      timer.pause();
      timer = null;
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
      return;
    }

    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    pos = window.scrollY;

    timer = createTimer({
      duration: 1000,
      loop: true,
      onUpdate: (self) => {
        const max = document.body.scrollHeight - window.innerHeight;
        if (max <= 0) return;
        pos += dir * SPEED * (self.deltaTime / 1000);
        if (pos >= max) { pos = max; dir = -1; }
        else if (pos <= 0) { pos = 0; dir = 1; }
        window.scrollTo({ top: pos });
      },
    });
  });
}
