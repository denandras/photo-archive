"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";

type Photo = { src: string; full: string; key: string; w: number; h: number };

const DRAG_THRESHOLD = 6;

function PhotoCard({
  photo,
  dataIdx,
  onClick,
}: {
  photo: Photo;
  dataIdx: number;
  onClick: () => void;
}) {
  const [active, setActive] = useState(false);
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

  // Native loading="lazy" measures layout distance and ignores the
  // transform marquee: mirrored rows show their strip far from the DOM
  // origin, so those images never qualified and the rows looked empty on
  // the right. IO is transform-aware — gate the src on it instead.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      setActive(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActive(true);
            io.disconnect();
          }
        }
      },
      // Load ~1200px ahead horizontally, ~800px vertically: after a fast
      // swipe lands on a new row its thumbs should already be in flight;
      // zero vertical margin made freshly-revealed rows render as empty
      // strips (b25).
      { rootMargin: "800px 1200px 800px 1200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

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
function LightboxStage({ photo }: { photo: Photo }) {
  const [loaded, setLoaded] = useState(false);
  // b25: photo changes play the choreography in reverse at normal speed —
  // the old image closes back to its center point, then the new one expands.
  const [current, setCurrent] = useState(photo);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (photo.full === current.full) return;
    // Close: dropping .loaded runs the transition backwards (old image stays
    // mounted underneath until the swap).
    setLoaded(false);
    const t = window.setTimeout(() => setCurrent(photo), 780);
    return () => clearTimeout(t);
    // current.full omitted on purpose: only respond to the incoming prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.full]);
  const flip = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setLoaded(true)));
  }, []);
  return (
    <div
      className={`lightbox-stage${loaded ? " loaded" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current.full}
        alt=""
        className="lightbox-img"
        width={current.w || undefined}
        height={current.h || undefined}
        decoding="async"
        draggable={false}
        onLoad={flip}
        ref={(el) => {
          if (el && el.complete && el.naturalWidth > 0) flip();
        }}
      />
      <span className="corner lt-tl" />
      <span className="corner lt-tr" />
      <span className="corner lt-bl" />
      <span className="corner lt-br" />
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
      if (half <= 0) return; // not measurable yet (collapsed/off-screen)
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
    // GPU transform marquee — bypasses iOS Safari's compositor-owned scrollLeft
    track.style.transform = `translate3d(${-p}px, 0, 0)`;
  }, [measureHalf]);

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
        const track = trackRef.current;
        const viewport = viewportRef.current;
        if (track && viewport) {
          const half = measureHalf();
          if (half > 0) {
            const vw = viewport.clientWidth;
            const needed = Math.max(3, Math.ceil(vw / half) + 1);
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
    const onResize = () => { halfRef.current = 0; };
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
              <PhotoCard key={i} photo={p} dataIdx={i} onClick={() => handleCardClick(i % photos.length)} />
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
