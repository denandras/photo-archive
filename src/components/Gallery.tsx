"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";

type Photo = { src: string; full: string; key: string; w: number; h: number };

const DRAG_THRESHOLD = 6;
/* Horizontal look-ahead per side, in px. b37: back to the plain band (no
   base shift, no staging — they churned on real phones). 1200 covers drags;
   latched loading (below) makes band edges impossible to flash. */
const LOAD_MARGIN = 1200;
/* Vertical band: rows compute their in-range cards only near the viewport */
const V_BAND = 900;

function PhotoCard({
  photo,
  dataIdx,
  active,
  onClick,
}: {
  photo: Photo;
  dataIdx: number;
  active: boolean;
  onClick: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Double rAF: guarantee the not-loaded state (cropped-to-point image,
  // corners converged in the middle) paints once before the expansion runs.
  // "Loaded" is a direct DOM class, NOT React state: dozens of thumbs finish
  // around the same time while the marquee runs — a setState per image
  // re-renders on the main thread and the rows visibly froze mid-scroll (b20).
  // Already-complete thumbnails (cache/preload) skip the choreography (b22):
  // the rushed-looking fast animation reads wrong for the calm feel.
  const flip = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const img = el.querySelector("img");
        if (img?.complete) el.classList.add("instant");
        el.classList.add("loaded");
      })
    );
  }, []);

  // b31: `active` (src on/off) is DERIVED FROM THE MARQUEE MATH by ScrollRow —
  // IntersectionObserver here was a dead end: the rows' clipping ancestors
  // (overflow-x clip, needed for the hover-pop) clip cards geometrically and
  // IO intersects against ancestor clips BEFORE rootMargin applies — margins
  // silently did nothing (proved: fresh IO with 2000px margin ≡ 0px).
  // We are the transform source, so we know each card's layout span and the
  // live offset — direction-symmetric by construction.

  return (
    <div
      ref={cardRef}
      className="photo-card"
      data-photo-idx={dataIdx}
      style={{ aspectRatio: `${photo.w} / ${photo.h}` }}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={active ? photo.src : undefined}
        alt=""
        width={photo.w}
        height={photo.h}
        decoding="async"
        draggable={false}
        onLoad={flip}
      />
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
    </div>
  );
}

/* Lightbox stage: big image + corners uncrop together, exactly like the cards */
/* ===== Lightbox stage v2 (b29, rebuilt): two stacked slots.
   Swap: the incoming image stays invisible until its bytes arrive, then it
   expands on top while the outgoing reverses underneath — no frame has
   nothing on screen. Fast swipes retarget the pending slot. ===== */
function LightboxStage({ photo }: { photo: Photo }) {
  type SlotLb = { photo: Photo | null; loaded: boolean; above: boolean };
  const [slots, setSlots] = useState<SlotLb[]>([
    { photo, loaded: false, above: false },
    { photo: null, loaded: false, above: false },
  ]);
  const activeRef = useRef(0);
  const incomingRef = useRef<number | null>(null);
  const shownRef = useRef<string | null>(null);
  const fallbackTimer = useRef<number | null>(null);

  // Finalize: promoted slot becomes the background; retired slot emptied.
  const finalize = useCallback((promoted: number) => {
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    incomingRef.current = null;
    activeRef.current = promoted;
    setSlots(prev =>
      prev.map((s, i) =>
        i === promoted
          ? { ...s, above: false }
          : { photo: null, loaded: false, above: false }
      )
    );
  }, []);

  const markLoaded = useCallback((i: number) => {
    setSlots(prev => {
      if (prev[i]?.loaded || !prev[i]?.photo) return prev; // b42: guard cleared slots
      const next = prev.map((s, j) => (j === i ? { ...s, loaded: true } : s));
      if (incomingRef.current !== i) return next;
      // incoming arrived while swapping: reverse the outgoing underneath
      return next.map((s, j) => (j !== i && s.photo && s.loaded ? { ...s, loaded: false } : s));
    });
    if (incomingRef.current !== i) return;
    // settle shortly after both choreographies, with a load-error fallback
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    fallbackTimer.current = window.setTimeout(() => {
      finalize(i);
    }, 950);
  }, [finalize]);

  useEffect(() => {
    if (shownRef.current === photo.full) return;
    const first = shownRef.current === null;
    shownRef.current = photo.full;
    if (first) return;
    // start / retarget a swap: newest photo goes to the non-active slot, on top
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    setSlots(prev => {
      const incoming = prev.findIndex(s => s.above);
      if (incoming === -1) {
        const target = 1 - activeRef.current;
        incomingRef.current = target;
        return prev.map((s, i) =>
          i === target ? { photo, loaded: false, above: true } : { ...s, above: false }
        );
      }
      // mid-swap retarget: same slot takes the newest photo, re-expands
      incomingRef.current = incoming;
      return prev.map((s, i) =>
        i === incoming ? { photo, loaded: false, above: true } : s
      );
    });
  }, [photo]);

  return (
    <div
      className="lightbox-stage"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {slots.map((s, i) =>
        s.photo ? (
          <div
            key={`${i}-${s.photo.full}`}
            className={`lb-slot${s.above ? " lb-above" : ""}`}
          >
            <div className={`lb-inner${s.loaded ? " loaded" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.photo.full}
                alt=""
                className="lightbox-img"
                width={s.photo.w || undefined}
                height={s.photo.h || undefined}
                decoding="async"
                draggable={false}
                onLoad={() => markLoaded(i)}
                ref={(el) => {
                  /* b42: CACHED fulls are complete synchronously — flipping
                     loaded during the first paint skips the b14 start state
                     entirely and the photo just pops in with no animation
                     ("the new one just opens"). Double-rAF so the converged
                     corners + center-point clip paint FIRST, then expand. */
                  if (el && el.complete && el.naturalWidth > 0) {
                    requestAnimationFrame(() => requestAnimationFrame(() => markLoaded(i)));
                  }
                }}
              />
              <span className="corner lt-tl" />
              <span className="corner lt-tr" />
              <span className="corner lt-bl" />
              <span className="corner lt-br" />
            </div>
          </div>
        ) : null
      )}
    </div>
  );
}

function ScrollRow({
  photos,
  direction,
  day,
  onOpen,
}: {
  photos: Photo[];
  direction: "left" | "right";
  day: string;
  onOpen: (index: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  /* b44 WINDOWED RING: the huge max-content track is GONE. What remains is a
     zero-width group element whose COMPOSITED LAYER covers only the painted
     window (viewport + LOAD_MARGIN on both sides ≈ ~2.7k CSS px — far under
     Metal's 16,384-device-px texture ceiling that killed the iPhone rows).
     Instances are repositioned only when coverage re-syncs (rare); between
     re-syncs every instance rides rigidly with ONE per-frame transform write
     on the group ⇒ GPU-composited 60fps smoothness (the b40 motion the user
     wants back) with a small, bounded layer (no b41 tap-deadness). */
  const stripRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const isDragging = useRef(false);
  const dragMoved = useRef(false);
  const lastX = useRef(0);
  const startX = useRef(0);
  const posRef = useRef(0); // continuous position (px, unbounded — no wrap jump)
  const velRef = useRef(0); // drag inertia, px/frame
  const velSamples = useRef<number[]>([]);
  const speedRef = useRef(direction === "left" ? 0.35 : -0.35);
  const pSyncRef = useRef(0); // position anchor of the last coverage re-sync
  const halfRef = useRef(0);
  const measured = useRef(false);
  const spansRef = useRef<{ l: number; r: number }[] | null>(null);
  const latchedRef = useRef<Set<number>>(new Set());
  const inRangeRef = useRef<Set<number>>(new Set());
  const [inRange, setInRangeState] = useState<Set<number>>(new Set());
  const [poolK, setPoolK] = useState(2); // instances per index (coverage tiles)
  const poolKRef = useRef(2);
  const inBandRef = useRef(true);
  const bandCheckRef = useRef(0);
  const initPhase = useRef(false);

  // setState only when the set actually changes (rAF loop calls every frame)
  const setInRange = useCallback((next: Set<number>) => {
    const prev = inRangeRef.current;
    if (prev.size === next.size && [...next].every((x) => prev.has(x))) return;
    inRangeRef.current = next;
    setInRangeState(next);
  }, []);

  /* Measure card spans from the DOM. Images carry width/height + aspect-ratio,
     so widths are laid out before any bytes load. */
  const measure = useCallback((): boolean => {
    const strip = stripRef.current;
    const vp = viewportRef.current;
    if (!strip || !vp) return false;
    const nP = photos.length;
    if (!nP) return false;
    const kids = strip.children;
    if (!kids.length) return false;
    const first = kids[0] as HTMLElement;
    if (!first.offsetWidth || first.offsetWidth < 8) return false; // layout not ready
    const spans: { l: number; r: number }[] = [];
    let x = 0;
    for (let i = 0; i < nP; i++) {
      const el = kids[i * poolKRef.current] as HTMLElement; // instance 0
      const w = el.offsetWidth;
      if (!w || w < 8) return false; // collapsed or mid-init
      spans.push({ l: x, r: x + w });
      x += w + 14; // inter-card gap == trailing pad (b38 invariant)
    }
    const half = x;
    if (half <= 100) return false;
    // Enough instances to cover viewport + full load band, one tile to spare
    const vw = vp.clientWidth;
    const need = Math.ceil((vw + 2 * LOAD_MARGIN) / half) + 1;
    if (need > poolKRef.current && poolKRef.current < 6) {
      poolKRef.current = Math.min(6, need);
      setPoolK(poolKRef.current);
      spansRef.current = null;
      return false; // re-rendered pool gets measured on the next frames
    }
    const K = poolKRef.current;
    if (K * Math.round(half) < vw + 2 * LOAD_MARGIN) return false; // still short
    spansRef.current = spans;
    halfRef.current = half;
    return true;
  }, [photos.length]);

  /* b44c wave: reposition every instance so the strip tiles CONTIGUOUSLY over
     the coverage window. Global tiling — instance (i, j) sits at
     base_i + (nMin(i,j) + j)·half − pSync, with nMin chosen per index so the
     first tile is in [−M, −M + half) relative to the CURRENT position. The
     earlier per-index `mod half` anchor wrapped WIDE-period rows one period
     behind their neighbours (left hole: "images on the left don't load
     initially" — user, fixed on scroll because a re-sync re-measured).
     Between waves all instances ride rigidly on the group transform; at the
     wave boundary instance (i, j) hands over to instance (i, j±1) — the same
     photo, pixel-identical. */
  const syncWave = useCallback(() => {
    const strip = stripRef.current;
    const spans = spansRef.current;
    const half = halfRef.current;
    if (!strip || !spans || !half) return;
    const stripEl = strip as HTMLElement;
    const kids = stripEl.children;
    const K = poolKRef.current;
    const p = posRef.current;
    for (let i = 0; i < spans.length; i++) {
      const base = spans[i].l;
      // first tile covering the window: base + n·half ∈ [−M, −M + half)
      const nMin = Math.ceil((-LOAD_MARGIN - base + p) / half);
      for (let j = 0; j < K; j++) {
        (kids[i * K + j] as HTMLElement).style.transform =
          `translate3d(${base - p + (nMin + j) * half}px, 0, 0)`;
      }
    }
    pSyncRef.current = p;
    stripEl.style.transform = "translate3d(0px, 0, 0)";
  }, []);

  const tick = useCallback(
    (now: number) => {
      const vp = viewportRef.current;
      const strip = stripRef.current;
      if (!vp || !strip) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(3, Math.max(0.25, (now - (lastFrameRef.current || now)) / 16.7));
      lastFrameRef.current = now;
      // Vertical band, rechecked every ~10th frame (cheap: one rect read)
      if (++bandCheckRef.current % 10 === 0 || !measured.current) {
        const rc = vp.getBoundingClientRect();
        inBandRef.current = rc.bottom > -V_BAND && rc.top < innerHeight + V_BAND;
        if (inBandRef.current && !measured.current) {
          measured.current = measure();
          if (measured.current && !initPhase.current) {
            // Mirrored start (b10): left-streaming rows begin with the strip's
            // END at the right edge. Continuous position = (half − vw).
            initPhase.current = true;
            if (direction === "left") {
              posRef.current = halfRef.current - vp.clientWidth;
            }
            pSyncRef.current = posRef.current;
          }
        }
      }
      if (inBandRef.current && measured.current) {
        /* b44b: DETERMINISTIC placement — the poolK-effect syncWave raced
           measure completion (some mount orders got placed, others never
           did until drift > half/2; the unplaced rows stacked every instance
           at x=0 ⇒ "one image, the rest empty", every 2nd row on the
           phone). After the first successful measure — and after any pool
           change / resize that invalidates positions — wave immediately. */
        if (!placedRef.current) {
          placedRef.current = true;
          syncWave();
        }
        if (!isDragging.current) {
          if (Math.abs(velRef.current) > 0.02) {
            posRef.current += velRef.current * dt;
            velRef.current *= Math.pow(0.94, dt);
          } else {
            velRef.current = 0;
            posRef.current += speedRef.current * dt;
          }
        }
        const drift = posRef.current - pSyncRef.current;
        const half = halfRef.current;
        const spans = spansRef.current;
        if (spans) {
          // ONE per-frame write: the group transform (compositor-smooth)
          if (Math.abs(drift - (lastDriftRef.current ?? 0)) >= 0.01 || !lastDriftRef.current) {
            lastDriftRef.current = drift;
            strip.style.transform = `translate3d(${-drift}px, 0, 0)`;
          }
          // coverage guard: re-sync before any instance leaves the coverage
          if (Math.abs(drift) > half / 2) syncWave();
          // Latch: index i is latched when its instance chain overlaps
          // [−LOAD_MARGIN, vw + LOAD_MARGIN]. b44c: chain = global tiling —
          // first tile at base_i − p + nMin(i)·half, K consecutive tiles.
          const vw = vp.clientWidth;
          const K = poolKRef.current;
          const next = new Set(latchedRef.current);
          for (let i = 0; i < spans.length; i++) {
            const base = spans[i].l;
            const nMin = Math.ceil((-LOAD_MARGIN - base + posRef.current) / half);
            const l = base - posRef.current + nMin * half;
            if (l < vw + LOAD_MARGIN && l + (K - 1) * half + (spans[i].r - spans[i].l) > -LOAD_MARGIN) {
              next.add(i);
            }
          }
          latchedRef.current = next;
          setInRange(next);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measure, syncWave]
  );

  const lastFrameRef = useRef(0);
  const lastDriftRef = useRef<number | null>(null);
  const placedRef = useRef(false); // b44b: coverage instances placed at least once

  useEffect(() => {
    lastFrameRef.current = 0;
    rafRef.current = requestAnimationFrame((t) => tick(t));
    const onResize = () => {
      measured.current = false;
      spansRef.current = null;
      placedRef.current = false;
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [tick]);

  /* After a pool change the DOM children are fresh (empty transforms) — the
     tick loop's placedRef gate re-places them on the next frame. (Resize
     invalidates directly in its handler.) */
  useEffect(() => {
    placedRef.current = false;
    measured.current = false;
    spansRef.current = null;
  }, [poolK]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isDragging.current = true;
    dragMoved.current = false;
    velRef.current = 0;
    velSamples.current = [];
    lastX.current = e.clientX;
    startX.current = e.clientX;
    const viewport = viewportRef.current;
    if (viewport) {
      try { viewport.setPointerCapture(e.pointerId); } catch {}
      viewport.style.cursor = "grabbing";
    }
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastX.current;
    lastX.current = e.clientX;
    if (Math.abs(e.clientX - startX.current) > DRAG_THRESHOLD) {
      dragMoved.current = true;
    }
    if (dx === 0) return;
    posRef.current -= dx;
    velSamples.current.push(-dx);
    if (velSamples.current.length > 6) velSamples.current.shift();
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const viewport = viewportRef.current;
    if (viewport) {
      try { viewport.releasePointerCapture?.(e.pointerId); } catch {}
      viewport.style.cursor = "";
    }
    const s = velSamples.current.slice(-6);
    velRef.current = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    velSamples.current = [];
    setTimeout(() => { dragMoved.current = false; }, 250);
    if (!dragMoved.current) {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const card = el?.closest("[data-photo-idx]") as HTMLElement | null;
      if (card) {
        const i = Number(card.getAttribute("data-photo-idx"));
        if (!Number.isNaN(i) && photos.length > 0) onOpen(i % photos.length);
      }
    }
  }, [photos, onOpen]);

  const handleCardClick = useCallback((idx: number) => {
    if (dragMoved.current) return;
    onOpen(idx);
  }, [onOpen]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const dx = e.deltaMode === 0 ? e.deltaX : e.deltaX * (e.deltaMode === 1 ? 16 : 100);
    if (!dx) return;
    posRef.current -= dx;
  }, []);

  return (
    <div
      className="scroll-viewport"
      ref={viewportRef}
      data-day={day}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      <div className="scroll-strip" ref={stripRef}>
        {Array.from({ length: poolK * photos.length }, (_, f) => {
          const i = Math.floor(f / poolK);
          return (
            <PhotoCard
              key={`${i}-${f % poolK}`}
              photo={photos[i]}
              dataIdx={i}
              active={inRange.has(i)}
              onClick={() => handleCardClick(i)}
            />
          );
        })}
      </div>
    </div>
  );
}

function YearSection({
  year,
  days,
  onPhotoClick,
  anchorDay,
  stayOpen,
}: {
  year: string;
  days: Record<string, Photo[]>;
  onPhotoClick: (photos: Photo[], index: number, meta: { year: string; day: string }) => void;
  anchorDay: string | null; // permalink ?d=: scroll this day row into view
  stayOpen: boolean; // permalink ?y=: expand this year on load
}) {
  const [collapsed, setCollapsed] = useState(true);
  const dayEntries = Object.entries(days);
  const contentRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<Animation | null>(null);

  const toggleCollapsed = () => {
    const el = contentRef.current;
    if (!el) {
      setCollapsed((c) => !c);
      return;
    }
    /* b43: year open/close via WAAPI height animation — the old 0fr↔1fr grid
       transition is treated as DISCRETE (verified: transitionrun fires, height
       snaps 0→870 in one step), and plain height transitions proved
       unreliable on this element; WAAPI is rAF-driven and exact. */
    animRef.current?.cancel();
    animRef.current = null;
    const dur = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500;
    if (collapsed) {
      // EXPAND: flip the class first (React commit), then pin + animate.
      setCollapsed(false);
      requestAnimationFrame(() => {
        const target = el.scrollHeight;
        el.style.overflowY = "hidden";
        const a = el.animate(
          [{ height: "0px" }, { height: `${target}px` }],
          { duration: dur, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
        );
        animRef.current = a;
        a.onfinish = () => {
          el.style.overflowY = "";
          animRef.current = null;
        };
      });
    } else {
      // COLLAPSE: animate from today's height to 0, THEN collapse the class
      // (which skips rendering the rows) — content stays put while shrinking.
      const from = el.getBoundingClientRect().height;
      el.style.overflowY = "hidden";
      const a = el.animate(
        [{ height: `${from}px` }, { height: "0px" }],
        { duration: dur, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
      );
      animRef.current = a;
      a.onfinish = () => {
        el.style.overflowY = "";
        setCollapsed(true);
        animRef.current = null;
      };
    }
  };

  // Expand client-side only (SSR renders collapsed; hydration timing with
  // window-dependent initial state is unreliable) — permalink ?y= expands.
  useEffect(() => {
    if (stayOpen) setCollapsed(false);
  }, [stayOpen]);

  // Permalink scroll: wait for a tick so the expanded content is laid out.
  useEffect(() => {
    if (!anchorDay) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-day="${CSS.escape(anchorDay)}"]`);
      el?.scrollIntoView({ block: "center" });
    }, 120);
    return () => clearTimeout(t);
  }, [anchorDay]);

  return (
    <section className={`year-section${collapsed ? " collapsed" : ""}`}>
      <button
        className="year-header"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${year}` : `Collapse ${year}`}
      >
        <h2 className="year-text">{year}</h2>
        <div className="year-toggle-wrapper">
          <span className="toggle-icon" />
        </div>
      </button>
      <div className="year-content" ref={contentRef}>
        <div className="year-content-inner">
          {dayEntries.map(([day, photos], i) => (
            <ScrollRow
              key={day}
              photos={photos}
              direction={i % 2 === 0 ? "right" : "left"}
              day={day}
              onOpen={(index) => onPhotoClick(photos, index, { year, day })}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Gallery({
  data,
}: {
  data: Record<string, Record<string, Photo[]>>;
}) {
  const [lightbox, setLightbox] = useState<{
    photos: Photo[];
    index: number;
    meta: { year: string; day: string };
  } | null>(null);
  const [mounted, setMounted] = useState(false);
  /* b42: lightbox CLOSING animation — the open choreography's exact inverse
     (overlay fades, loaded image collapses to the center point, corners
     converge). The overlay stays mounted ~700ms, then unmounts. */
  const [lbClosing, setLbClosing] = useState(false);
  const lbCloseTimer = useRef<number | null>(null);
  const closeLightbox = useCallback(() => {
    if (lbCloseTimer.current) return; // already closing
    setLbClosing(true);
    lbCloseTimer.current = window.setTimeout(() => {
      lbCloseTimer.current = null;
      setLbClosing(false);
      setLightbox(null);
    }, 700);
  }, []);

  useEffect(() => setMounted(true), []);

  const openLightbox = useCallback(
    (photos: Photo[], index: number, meta: { year: string; day: string }) => {
      // b42: reopening while a close animation is still running cancels it
      if (lbCloseTimer.current) {
        clearTimeout(lbCloseTimer.current);
        lbCloseTimer.current = null;
        setLbClosing(false);
      }
      setLightbox({ photos, index, meta });
    },
    []
  );

  // Permalinks: ?y=YEAR[&d=YYYY-MM-DD[&i=filename.jpg]] preselect a year,
  // a day row and/or open a photo's lightbox directly (shareable URLs).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const y = params.get("y");
    const d = params.get("d");
    const i = params.get("i");
    if (!y || !data[y]) return;
    if (!d) return;
    const photos = data[y][d];
    if (!photos || !i) return;
    const idx = photos.findIndex((p) => p.key.split("/").pop() === i);
    if (idx >= 0) setLightbox({ photos, index: idx, meta: { year: y, day: d } });
  }, [data]);

  const syncLightboxUrl = useCallback(
    (lb: { photos: Photo[]; index: number; meta: { year: string; day: string } } | null) => {
      const params = new URLSearchParams(window.location.search);
      if (lb) {
        params.set("y", lb.meta.year);
        params.set("d", lb.meta.day);
        params.set("i", lb.photos[lb.index]?.key.split("/").pop() || "");
      } else {
        params.delete("i");
      }
      history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    }, []);

  // Keyboard nav + scroll lock when lightbox is open
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft")
        setLightbox((p) => (p && p.index > 0 ? { ...p, index: p.index - 1 } : p));
      else if (e.key === "ArrowRight")
        setLightbox((p) =>
          p && p.index < p.photos.length - 1 ? { ...p, index: p.index + 1 } : p,
        );
    };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [lightbox, closeLightbox]);

  // Mobile: a discrete horizontal flick acts exactly like an arrow key —
  // one step per gesture, no continuous drag/scroll mechanic (b22). The
  // gesture starts on the lightbox layer only; a vertical flick does nothing.
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);

  // Shareable URL stays in sync as the user browses the lightbox
  useEffect(() => {
    if (!mounted) return;
    syncLightboxUrl(lightbox);
  }, [lightbox, mounted, syncLightboxUrl]);

  const years = Object.entries(data).sort((a, b) => b[0].localeCompare(a[0]));
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search
  );
  const linkY = params.get("y");

  return (
    <>
      {years.map(([year, days]) => (
        <YearSection
          key={year}
          year={year}
          days={days}
          onPhotoClick={openLightbox}
          anchorDay={linkY === year ? params.get("d") : null}
          stayOpen={linkY === year}
        />
      ))}

      {mounted && lightbox &&
        createPortal(
          <div
            className={`lightbox${lbClosing ? " closing" : ""}`}
            onClick={closeLightbox}
            onContextMenu={(e) => e.preventDefault()}
            onTouchStart={(e) => {
              const t = e.touches[0];
              touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
            }}
            onTouchEnd={(e) => {
              const s = touchStart.current;
              touchStart.current = null;
              if (!s) return;
              const t = e.changedTouches[0];
              const dx = t.clientX - s.x;
              const dy = t.clientY - s.y;
              // Discrete flick: mostly horizontal, real distance, quick. One
              // gesture = one arrow-key step — no drag tracking in between.
              if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
              if (Date.now() - s.t > 700) return;
              e.stopPropagation();
              setLightbox((p) => {
                if (!p) return p;
                if (dx < 0)
                  return p.index < p.photos.length - 1
                    ? { ...p, index: p.index + 1 }
                    : p;
                return p.index > 0 ? { ...p, index: p.index - 1 } : p;
              });
            }}
          >
            {/* Safe-viewport box: sits between the iOS browser bars, which
                overlap plain fixed/vh sizes — top AND bottom were cut. */}
            <div className="lightbox-fit">
              <LightboxStage photo={lightbox.photos[lightbox.index]} />
              {lightbox.photos.length > 1 && (
                <>
                  <span className="lightbox-counter">
                    {lightbox.index + 1} / {lightbox.photos.length}
                  </span>
                  {lightbox.index > 0 && (
                    <button
                      className="lightbox-nav lightbox-prev"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightbox((p) => (p ? { ...p, index: p.index - 1 } : p));
                      }}
                      aria-label="Previous"
                    >
                      &#8249;
                    </button>
                  )}
                  {lightbox.index < lightbox.photos.length - 1 && (
                    <button
                      className="lightbox-nav lightbox-next"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightbox((p) => (p ? { ...p, index: p.index + 1 } : p));
                      }}
                      aria-label="Next"
                    >
                      &#8250;
                    </button>
                  )}
                </>
              )}
              <button
                className="lightbox-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeLightbox();
                }}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
