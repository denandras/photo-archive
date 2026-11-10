"use client";

import { useEffect } from "react";
import { BUILD_TAG } from "@/build-tag";

/* Build watchdog (b39): a deployed build older than the live one hard-reloads
   once, so phones (and bfcache/long-lived tabs) can never keep streaming a
   stale bundle. Runs on load AND when a bfcache restore surfaces the tab. */
export default function BuildWatchdog() {
  useEffect(() => {
    let inFlight = false;
    const check = async (via: string) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/build", { cache: "no-store" });
        const { tag } = (await res.json()) as { tag: string };
        if (tag && tag !== BUILD_TAG) {
          const key = "pv-reloaded-for";
          // guard against a reload loop: only once per stale tag per session
          if (sessionStorage.getItem(key) !== tag) {
            sessionStorage.setItem(key, tag);
            location.reload();
            return;
          }
        } else if (via === "pageshow") {
          // back on the live build again: re-arm for the next stale deploy
          sessionStorage.removeItem("pv-reloaded-for");
        }
      } catch {
        /* offline / probe failure: keep serving what we have */
      } finally {
        inFlight = false;
      }
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void check("pageshow");
    };
    void check("load");
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  return null;
}
