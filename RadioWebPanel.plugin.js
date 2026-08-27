/**
 * @name RadioWebPanel
 * @author Radio
 * @description Opens the radio web panel in a floating window via a button in the top bar.
 * @version 1.0.0
 * @authorId 0
 * @website https://discord-radio-bot-production.up.railway.app
 * @source https://github.com/frostedipa-debug/discord-radio-bot
 */

const PANEL_URL = "https://discord-radio-bot-production.up.railway.app";
const BUTTON_ID = "radio-web-panel-btn";
const MODAL_ID = "radio-web-panel-modal";
const CSS_ID = "radio-web-panel-css";

module.exports = (() => {
  const config = {
    info: {
      name: "RadioWebPanel",
      authors: [{ name: "Radio" }],
      version: "1.0.0",
      description: "Opens the radio web panel in a floating window via a button in the top bar.",
    },
    changelog: [],
    defaultConfig: [],
  };

  const styles = `
    #${BUTTON_ID} {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; margin-right: 8px; border: none; border-radius: 6px;
      background: transparent; color: var(--interactive-normal); cursor: pointer;
      transition: background .15s, color .15s;
    }
    #${BUTTON_ID}:hover { background: var(--background-modifier-hover); color: var(--interactive-active); }
    #${BUTTON_ID} svg { width: 18px; height: 18px; }
    #${MODAL_ID} {
      position: fixed; top: 12vh; right: 24px; z-index: 99999;
      width: 360px; max-width: 92vw; height: 76vh; max-height: 82vh;
      display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
      background: var(--background-secondary); border: 1px solid var(--background-modifier-accent);
      box-shadow: 0 8px 30px rgba(0,0,0,.5);
      font-family: var(--font-primary);
    }
    #${MODAL_ID}.hidden { display: none; }
    #${MODAL_ID} .rtop {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: var(--background-tertiary);
      cursor: move; user-select: none; flex: 0 0 auto;
    }
    #${MODAL_ID} .rtitle { font-size: 13px; font-weight: 600; color: var(--text-normal); }
    #${MODAL_ID} .rclose {
      border: none; background: transparent; color: var(--text-muted); cursor: pointer;
      font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 4px;
    }
    #${MODAL_ID} .rclose:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
    #${MODAL_ID} iframe { width: 100%; flex: 1; border: none; background: #0f1117; }
  `;

  return class RadioWebPanel {
    constructor() {
      this.observer = null;
      this.dragState = null;
    }

    getName() { return config.info.name; }
    getAuthor() { return config.info.authors.map((a) => a.name).join(", "); }
    getDescription() { return config.info.description; }
    getVersion() { return config.info.version; }

    start() {
      BdApi.injectCSS(CSS_ID, styles);
      this.injectButton();
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      this.removeEl("#" + BUTTON_ID);
      this.removeEl("#" + MODAL_ID);
      BdApi.clearCSS(CSS_ID);
    }

    removeEl(sel) {
      const el = document.querySelector(sel);
      if (el) el.remove();
    }

    unload() {
      this.stop();
    }

    injectButton() {
      const tryInject = () => {
        // Find the top chat header that contains the title/channel name
        const header = document.querySelector(
          '[class*="chatContent"] [class*="header"], [class*="chat"] [class*="title-"], [class*="chat"] header'
        );
        if (header && !header.contains(document.getElementById(BUTTON_ID))) {
          const existing = document.getElementById(BUTTON_ID);
          if (existing) existing.remove();
          const btn = document.createElement("button");
          btn.id = BUTTON_ID;
          btn.title = "Radio Web Panel";
          btn.addEventListener("click", (e) => { e.stopPropagation(); this.toggle(); });
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
          header.prepend(btn);
        }
      };

      tryInject();
      this.observer = new MutationObserver(tryInject);
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    toggle() {
      let modal = document.getElementById(MODAL_ID);
      if (modal) {
        modal.classList.toggle("hidden");
      } else {
        this.createModal();
      }
    }

    createModal() {
      const modal = document.createElement("div");
      modal.id = MODAL_ID;

      const top = document.createElement("div");
      top.className = "rtop";
      top.title = "Drag to move";
      const title = document.createElement("span");
      title.className = "rtitle";
      title.textContent = "🎧 Radio Panel";
      const close = document.createElement("button");
      close.className = "rclose";
      close.textContent = "✕";
      close.addEventListener("click", () => modal.classList.add("hidden"));
      close.addEventListener("mousedown", (e) => e.stopPropagation());
      top.appendChild(title);
      top.appendChild(close);

      const iframe = document.createElement("iframe");
      iframe.src = PANEL_URL;
      iframe.setAttribute("allow", "autoplay");

      modal.appendChild(top);
      modal.appendChild(iframe);

      document.body.appendChild(modal);
      this.makeDraggable(modal, top);
    }

    makeDraggable(modal, handle) {
      handle.addEventListener("mousedown", (e) => {
        if (e.target.closest(".rclose")) return;
        this.dragState = {
          dx: e.clientX - modal.getBoundingClientRect().left,
          dy: e.clientY - modal.getBoundingClientRect().top,
        };
        const move = (ev) => {
          if (!this.dragState) return;
          modal.style.left = (ev.clientX - this.dragState.dx) + "px";
          modal.style.top = (ev.clientY - this.dragState.dy) + "px";
          modal.style.right = "auto";
        };
        const up = () => {
          this.dragState = null;
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    }
  };
})();
