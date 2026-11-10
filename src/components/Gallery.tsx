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
      if (prev[i]?.loaded) return prev;
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
                  if (el && el.complete && el.naturalWidth > 0) markLoaded(i);
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
  const trackRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const isDragging = useRef(false);
  const dragMoved = useRef(false);
  const lastX = useRef(0);
  const startX = useRef(0);
  const initPhase = useRef(false); // start-phase applied once (mirrored rows)
  const posRef = useRef(0); // px offset into the first copy [0..half)
  const halfRef = useRef(0); // cached copy (period) width
  const repsRef = useRef(3); // current copy count (must reach setReps when grown)
  const repsCheck = useRef(0); // frame counter for cheap periodic re-measure
  const velRef = useRef(0); // drag inertia, px/frame
  const velSamples = useRef<number[]>([]);
  const speedRef = useRef(direction === "left" ? 0.35 : -0.35);
  const [reps, setReps] = useState(3); // copies rendered; grows to cover the viewport
  /* b31: in-range photo indices, computed from the marquee math (NOT IO —
     the rows' overflow clips defeat IO margins entirely). Keyed by index
     within one copy; every replica uses the same mapping. */
  const spansRef = useRef<{ l: number; r: number }[] | null>(null); // first-copy card spans
  const latchedRef = useRef<Set<number>>(new Set()); // b37: indices that keep src forever
  const inRangeRef = useRef<Set<number>>(new Set());
  const [inRange, setInRangeState] = useState<Set<number>>(new Set());
  const lastPaintRef = useRef(-1); // b41: skip transform writes for sub-pixel moves
  const bandCheckRef = useRef(0); // b41: throttle the per-frame rect read
  const bandVisibleRef = useRef(true); // cached ±900 vertical-band verdict
  // setState only when the set actually changes (rAF loop calls every frame)
  const setInRange = useCallback((next: Set<number>) => {
    const prev = inRangeRef.current;
    if (prev.size === next.size && [...next].every((x) => prev.has(x))) return;
    inRangeRef.current = next;
    setInRangeState(next);
  }, []);

  // One period = one copy's width (its box includes the trailing 14px pad, so
  // copies tile seamlessly with the same gap as inside a copy). 0 while the
  // section is collapsed or off-screen (content-visibility).
  const measureHalf = useCallback(() => {
    const track = trackRef.current;
    if (!track) return 0;
    const copy = track.firstElementChild as HTMLElement | null;
    if (!copy) return 0;
    return Math.max(0, copy.getBoundingClientRect().width);
  }, []);

  const render = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    let half = halfRef.current;
    if (half <= 0) {
      half = measureHalf();
      if (half <= 100) return; // not measurable / collapsed / mid-init layout
      halfRef.current = half;
    }
    // Always keep pos in [0..half) — seamless in both directions
    let p = posRef.current % half;
    if (p < 0) p += half;
    if (!initPhase.current) {
      // Mirrored start: left-streaming rows begin with the strip's start just
      // off the right edge, so photos stream right-to-left ("begin from the
      // right, load to the left"); right-streaming rows start at the left edge.
      initPhase.current = true;
      if (direction === "left") {
        const viewport = viewportRef.current;
        const vw = viewport ? viewport.clientWidth : 0;
        p = ((half - vw) % half + half) % half;
        posRef.current = p;
      }
    }
    posRef.current = p;
    /* b41: 2D transform ONLY — translate3d/translateZ is ITSELF a layer
       promotion in WebKit: with will-change gone, a 3D matrix would still
       hand the whole max-content track to the compositor and hit Metal's
       16,384-device-px texture ceiling (⇒ iPhone rows paint blank then
       "die"). 2D translateX paints through the tiled main-thread path.

       b41b: main-thread painting must stay CHEAP or iOS gets tap-dead
       (12 strips repainted every frame starve the event loop). The marquee
       moves ~0.35px/frame — write the transform only when ~1.25px have
       accumulated (≈15Hz instead of 60Hz), or during drags/inertia when
       movement per frame is larger anyway. Motion stays sub-pixel-smooth;
       latching below is position-based and unaffected. */
    const moved = Math.abs(p - (lastPaintRef.current < 0 ? p : lastPaintRef.current));
    const shouldPaint = lastPaintRef.current < 0 || moved >= 1.25 || isDragging.current;
    const paint = () => {
      lastPaintRef.current = p;
      track.style.transform = `translateX(${-p}px)`;
    };
    if (shouldPaint) paint();

    // b31: derive which cards are in load range from the marquee math —
    // direction-symmetric, clip-proof (IO margins are defeated by the rows'
    // overflow clipping, so IO can't do this job at all).
    // b41b: the rect read happens every ~10th frame; between checks the last
    // verdict (±900 band) is reused. Scrolling still triggers prompt checks
    // because scroll changes land within a frame or two of the next read.
    const viewport = viewportRef.current;
    if (viewport && (++bandCheckRef.current % 10 === 0 || !spansRef.current)) {
      const rc = viewport.getBoundingClientRect();
      bandVisibleRef.current = rc.bottom > -V_BAND && rc.top < innerHeight + V_BAND;
    }
    if (viewport && bandVisibleRef.current) {
        if (!spansRef.current) {
          const copy = track.firstElementChild;
          if (copy) {
            spansRef.current = [...copy.children].map((c) => {
              const el = c as HTMLElement;
              const l = el.offsetLeft; // layout space — transform-proof
              return { l, r: l + el.offsetWidth };
            });
          }
        }
        const spans = spansRef.current;
        if (spans && spans.length > 0) {
          const vw = viewport.clientWidth;
          const needed = Math.min(
            10,
            Math.max(3, Math.ceil((vw + 2 * LOAD_MARGIN) / half) + 2)
          );
          // grow-only (b35): bidirectional resizing let a jittery re-measure
          // flap the copy count and read as a "reset" — growth is capped, so
          // leaving stale extra copies is harmless
          if (needed > repsRef.current) {
            repsRef.current = needed;
            setReps(needed);
          }
          // b37 LATCH: once an index has been in range, it NEVER leaves —
          // removing src unloads the bitmap and pops it back on re-entry
          // (the "dragging makes it flashy" report, confirmed by phone CDP:
          // src counts flapped 22/23 → 22/22 → 23/23 while idle). The set
          // only ever grows, bounded by photos-per-day per row.
          const next = new Set(latchedRef.current);
          for (let c = 0; c < repsRef.current; c++) {
            const cOff = c * half;
            for (let i = 0; i < spans.length; i++) {
              const l = spans[i].l + cOff - p;
              const r = spans[i].r + cOff - p;
              if (r > -LOAD_MARGIN && l < vw + LOAD_MARGIN) next.add(i);
            }
          }
          latchedRef.current = next;
          setInRange(next);
          return;
        }
      }
    // Out-of-band rows only repaint (no latching) — same cheapness guard.
    if (shouldPaint) paint();
  }, [measureHalf, setInRange]);

  // Marquee loop via rAF + transform (compositor-friendly, works on iOS)
  useEffect(() => {
    let last = performance.now();
    const animate = (now: number) => {
      const dt = Math.min(3, Math.max(0.25, (now - last) / 16.7)); // ~1 at 60Hz
      last = now;
      // Ensure enough copies cover the viewport with a full period to spare
      // ("real endlessness"): needed = ceil(vw/half) + 1. Checked cheaply
      // every ~2s and whenever the cached period is re-measured.
      if (++repsCheck.current >= 120 && !isDragging.current) {
        repsCheck.current = 0;
        halfRef.current = 0; // re-measure (images may have resized copies)
        spansRef.current = null;
        const track = trackRef.current;
        const viewport = viewportRef.current;
        if (track && viewport) {
          const half = measureHalf();
          if (half > 0 && half > 100) {
            const vw = viewport.clientWidth;
            // Same coverage formula as the eager path in render(): viewport +
            // the load band on both sides + the left base shift
            const B = Math.ceil(LOAD_MARGIN / half) * half;
            const needed = Math.min(
              8,
              Math.max(3, Math.ceil((vw + 2 * LOAD_MARGIN + B) / half) + 1)
            );
            // grow-only, mirrors the eager path (b35)
            if (needed > repsRef.current) {
              repsRef.current = needed;
              setReps(needed);
            }
          }
        }
      }
      if (!isDragging.current) {
        if (Math.abs(velRef.current) > 0.02) {
          // inertia from the last drag, decaying
          posRef.current += velRef.current * dt;
          velRef.current *= Math.pow(0.94, dt);
        } else {
          velRef.current = 0;
          posRef.current += speedRef.current * dt;
        }
        render();
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    const onResize = () => { halfRef.current = 0; spansRef.current = null; };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [render]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isDragging.current = true;
    dragMoved.current = false;
    velRef.current = 0;
    velSamples.current = [];
    lastX.current = e.clientX;
    startX.current = e.clientX;
    const viewport = viewportRef.current;
    if (viewport) {
      // Capture may throw NotFoundError (pointer already gone / buggy iOS)
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
    render();
  }, [render]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const viewport = viewportRef.current;
    if (viewport) {
      try { viewport.releasePointerCapture?.(e.pointerId); } catch {}
      viewport.style.cursor = "";
    }
    // Release inertia: average of recent per-event deltas
    const s = velSamples.current.slice(-6);
    velRef.current = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    velSamples.current = [];
    // Keep dragMoved true briefly so a trailing click can check it
    setTimeout(() => { dragMoved.current = false; }, 250);
    // Tap→preview: resolve the card directly from the pointer position, since
    // pointer capture can retarget/swallow the click on touch (esp. iOS Safari)
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

  // Copies of the same sequence; count grows (never shrinks) so the track
  // always covers viewport + one period — a drag or the marquee can never
  // reach an end. Position wraps modulo ONE copy, so loop is seamless.
  const copies = Array.from({ length: reps }, (_, c) => c);

  // Horizontal wheel (Magic Mouse-style horizontal scroll / trackpads): drive
  // the same JS position — the marquee position is the single source of truth.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Only horizontal deltas move the row; vertical deltas keep scrolling the page
    const dx = e.deltaMode === 0 ? e.deltaX : e.deltaX * (e.deltaMode === 1 ? 16 : 100);
    if (!dx) return;
    posRef.current -= dx;
    render();
  }, [render]);

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
      <div className="scroll-track" ref={trackRef}>
        {copies.map((c) => (
          <div className="scroll-copy" key={c} aria-hidden={c > 0}>
            {photos.map((p, i) => (
              <PhotoCard
                key={i}
                photo={p}
                dataIdx={i}
                active={inRange.has(i)}
                onClick={() => handleCardClick(i % photos.length)}
              />
            ))}
          </div>
        ))}
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
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${year}` : `Collapse ${year}`}
      >
        <h2 className="year-text">{year}</h2>
        <div className="year-toggle-wrapper">
          <span className="toggle-icon" />
        </div>
      </button>
      <div className="year-content">
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

  useEffect(() => setMounted(true), []);

  const openLightbox = useCallback(
    (photos: Photo[], index: number, meta: { year: string; day: string }) => {
      setLightbox({ photos, index, meta });
    }, []
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
      if (e.key === "Escape") setLightbox(null);
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
  }, [lightbox]);

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
            className="lightbox"
            onClick={() => setLightbox(null)}
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
                  setLightbox(null);
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
