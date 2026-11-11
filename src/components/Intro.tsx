"use client";

/* b56: initial landing reveal. A centered frame — the app's L corner
   markers + the header text — flashes in the middle (the photo-card
   load-in's start state), then plays the big "picture opening": the frame
   expands to the full viewport while the overlay fades, revealing the page.
   Plays once per session (sessionStorage), never under reduced motion, and
   it never blocks the page: the gallery hydrates underneath it. */

import { useEffect, useState } from "react";

export default function Intro() {
  const [gone, setGone] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || sessionStorage.getItem("introPlayed")) {
      setGone(true);
      return;
    }
    sessionStorage.setItem("introPlayed", "1");
    const t1 = window.setTimeout(() => setOpening(true), 1000);
    const t2 = window.setTimeout(() => setGone(true), 2100);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  if (gone) return null;
  return (
    <div className={`intro${opening ? " intro-opening" : ""}`} aria-hidden="true">
      <div className="intro-frame">
        <span className="intro-t1">photo archive</span>
        <span className="intro-t2">Fuji X100V</span>
        <span className="corner tl" />
        <span className="corner tr" />
        <span className="corner bl" />
        <span className="corner br" />
      </div>
    </div>
  );
}
