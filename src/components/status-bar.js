/* =====================================================================
   STATUS BAR — 顶部加载进度条 + 错误横幅 + demo 提示

   原来出错只写一句 "Error — see console"，在大屏上等于看不见。
   现在会明确显示是哪一步失败、失败原因，并给一个重试按钮。
   ===================================================================== */
import { DEMO_MODE } from "../config.js";
import { esc } from "../lib/format.js";
import { MOTION, animate } from "../lib/motion.js";

export function mountStatusBar({ store }) {
  const bar = document.getElementById("loadBar");
  const banner = document.getElementById("statusBanner");

  if (DEMO_MODE) {
    showBanner(
      banner,
      "warn",
      "DEMO MODE — 尚未连接 Supabase，当前是示例数据。请在 src/config.js 里填入 SUPABASE_URL 和 SUPABASE_ANON_KEY。"
    );
  }

  let barAnim = null;

  store.subscribe((state, reason) => {
    if (reason === "loading") {
      startBar();
    } else if (reason === "data") {
      finishBar();
      if (!DEMO_MODE) hideBanner(banner);
    } else if (reason === "error") {
      finishBar();
      showBanner(
        banner,
        "error",
        `同步失败：${esc(state.error?.message || "未知错误")}`,
        { retry: () => store.refresh() }
      );
    }
  });

  function startBar() {
    if (!bar) return;
    bar.style.opacity = "1";
    if (!MOTION.enabled) { bar.style.width = "70%"; return; }
    barAnim?.pause();
    // 爬到 70% 就停住等真实完成，避免假装已经好了
    barAnim = animate(bar, {
      width: ["0%", "70%"],
      duration: 1400,
      ease: "outQuad",
    });
  }

  function finishBar() {
    if (!bar) return;
    barAnim?.pause();
    if (!MOTION.enabled) { bar.style.width = "0%"; bar.style.opacity = "0"; return; }
    barAnim = animate(bar, {
      width: [bar.style.width || "70%", "100%"],
      duration: 260,
      ease: "outQuad",
      onComplete: () => {
        animate(bar, {
          opacity: [1, 0],
          duration: 300,
          onComplete: () => { bar.style.width = "0%"; },
        });
      },
    });
  }
}

function showBanner(banner, tone, message, { retry } = {}) {
  if (!banner) return;

  const TONES = {
    warn:  { bg: "rgba(232,185,62,0.10)", border: "rgba(232,185,62,0.35)", color: "var(--gold-bright)" },
    error: { bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.40)", color: "var(--red)" },
  };
  const t = TONES[tone] || TONES.warn;

  banner.style.background = t.bg;
  banner.style.borderColor = t.border;
  banner.style.color = t.color;
  banner.innerHTML =
    `<span>${message}</span>` +
    (retry ? `<button class="retry-btn" id="statusRetry">重试</button>` : "");
  banner.classList.remove("hidden");

  if (retry) {
    banner.querySelector("#statusRetry")?.addEventListener("click", retry);
  }

  if (MOTION.enabled) {
    animate(banner, {
      opacity: [0, 1],
      translateY: [-8, 0],
      duration: MOTION.dur.base,
      ease: MOTION.ease.out,
    });
  }
}

function hideBanner(banner) {
  if (!banner || banner.classList.contains("hidden")) return;
  if (!MOTION.enabled) { banner.classList.add("hidden"); return; }
  animate(banner, {
    opacity: [1, 0],
    translateY: [0, -8],
    duration: MOTION.dur.fast,
    onComplete: () => banner.classList.add("hidden"),
  });
}
