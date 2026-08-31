/**
 * github-social/extension/embed.js
 *
 * Drop-in embed for any third-party page. Three usage modes:
 *
 *   1. Auto-mount all <gh-social-tab login="neohiro"></gh-social-tab> elements:
 *      <script src="https://frenzypenguin-media.github.io/github-social/embed.js"></script>
 *
 *   2. Auto-mount by data attribute:
 *      <div data-gh-social="neohiro" data-mode="tab"></div>
 *      <div data-gh-social="neohiro" data-mode="embed"></div>
 *      <div data-gh-social="neohiro" data-mode="graph"></div>
 *
 *   3. Programmatic:
 *      import { GHSocialWidget } from "https://.../embed.js";
 *      const w = GHSocialWidget.mount(el, "neohiro", { mode: "tab", token: "ghp_..." });
 *
 * The widget is also exposed as a Web Component (`<gh-social-tab>`) for users who
 * prefer declarative markup.
 *
 * The bundle is self-contained (no external deps) and ~25KB minified.
 */

import { GHSocialWidget, SocialWidget } from "../src/social-widget.js";

class GHSocialTabElement extends HTMLElement {
  static get observedAttributes() {
    return ["login", "user", "mode", "theme", "accent", "token"];
  }

  connectedCallback() {
    const login = this.getAttribute("login") || this.getAttribute("user");
    if (!login) return;
    this._mountWidget(login);
  }

  disconnectedCallback() {
    this._widget?.destroy();
    this._widget = null;
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (!this._widget) return;
    // Re-mount on relevant attribute changes
    if (["login", "user", "mode", "theme", "accent", "token"].includes(name)) {
      this._widget.destroy();
      const login = this.getAttribute("login") || this.getAttribute("user");
      this._mountWidget(login);
    }
  }

  _mountWidget(login) {
    const options = {
      mode: this.getAttribute("mode") || "tab",
      theme: this.getAttribute("theme") || "auto",
      accent: this.getAttribute("accent") || "",
      token: this.getAttribute("token") || "",
    };
    this._widget = new SocialWidget(this, login, options);
    this._widget.mount();
  }
}

if (!customElements.get("gh-social-tab")) {
  customElements.define("gh-social-tab", GHSocialTabElement);
}

// Auto-mount on DOMContentLoaded (idempotent — safe to load at top or bottom)
function _autoMount() {
  try { GHSocialWidget.mountAll(); } catch (e) { console.warn("[ghsocial] auto-mount failed:", e); }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _autoMount);
} else {
  _autoMount();
}

// Re-scan for new elements when DOM mutates (e.g. SPAs)
if (typeof MutationObserver !== "undefined") {
  const mo = new MutationObserver(() => {
    document.querySelectorAll("[data-gh-social]:not([data-ghsocial-mounted])").forEach(el => {
      el.dataset.ghsocialMounted = "1";
      const login = el.dataset.ghSocial;
      if (!login) return;
      const opts = { ...el.dataset };
      delete opts.ghSocial; delete opts.ghsocialMounted;
      new SocialWidget(el, login, opts).mount();
    });
  });
  if (document.body) {
    mo.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", () => mo.observe(document.body, { childList: true, subtree: true }));
  }
}

export { GHSocialWidget, SocialWidget, GHSocialTabElement };
