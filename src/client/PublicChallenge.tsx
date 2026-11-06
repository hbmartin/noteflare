import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Turnstile = {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(id: string): void;
  remove(id: string): void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}
let script: Promise<void> | undefined;
function loadScript() {
  if (window.turnstile) return Promise.resolve();
  return (script ??= new Promise<void>((resolve, reject) => {
    const element = document.createElement("script");
    element.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    element.async = true;
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener(
      "error",
      () => {
        script = undefined;
        reject(new Error("Human verification could not load."));
      },
      { once: true },
    );
    document.head.appendChild(element);
  }));
}
export function usePublicChallenge(action: "bootstrap" | "invite" | "sign_in") {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [access, setAccess] = useState<{ available: boolean; required: boolean }>({
    available: false,
    required: false,
  });
  useEffect(() => {
    let cancelled = false;
    void api<{
      turnstile?: { enabled: boolean; siteKey: string | null };
      access?: { available: boolean; required: boolean };
    }>("/api/install")
      .then(async (config) => {
        if (cancelled) return;
        setAccess(config.access ?? { available: false, required: false });
        setEnabled(config.turnstile?.enabled === true);
        if (!config.turnstile?.enabled) {
          setLoaded(true);
          return;
        }
        if (!config.turnstile.siteKey) throw new Error("Human verification is unavailable.");
        await loadScript();
        if (cancelled || !container.current || !window.turnstile) return;
        widget.current = window.turnstile.render(container.current, {
          sitekey: config.turnstile.siteKey,
          action,
          callback: (value) => {
            setToken(value);
            setError("");
          },
          "expired-callback": () => setToken(""),
          "error-callback": () => {
            setToken("");
            setError("Human verification failed. Reload and try again.");
          },
        });
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load sign-in verification. Reload and try again.");
      });
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [action]);
  return {
    token,
    access,
    ready: loaded && (!enabled || !!token),
    reset: () => {
      setToken("");
      if (widget.current) window.turnstile?.reset(widget.current);
    },
    element: (
      <>
        <div ref={container} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </>
    ),
  };
}
