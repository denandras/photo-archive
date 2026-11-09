"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";

type Photo = { src: string; w: number; h: number };

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
  return (
    <div
      className="photo-card"
      data-photo-idx={dataIdx}
      style={{ aspectRatio: `${photo.w} / ${photo.h}` }}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.src}
        alt=""
        width={photo.w}
        height={photo.h}
        loading="lazy"
        draggable={false}
      />
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
    </div>
  );
}

function ScrollRow({
  photos,
  direction,
  onPhotoClick,
}: {
  photos: Photo[];
  direction: "left" | "right";
  onPhotoClick: (photos: Photo[], index: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const isDragging = useRef(false);
  const dragMoved = useRef(false);
  const lastX = useRef(0);
  const startX = useRef(0);
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
        if (!Number.isNaN(i) && photos.length > 0) onPhotoClick(photos, i % photos.length);
      }
    }
  }, [photos, onPhotoClick]);

  const handleCardClick = useCallback((idx: number) => {
    if (dragMoved.current) return;
    onPhotoClick(photos, idx);
  }, [photos, onPhotoClick]);

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
}: {
  year: string;
  days: Record<string, Photo[]>;
  onPhotoClick: (photos: Photo[], index: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const dayEntries = Object.entries(days);

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
              direction={i % 2 === 0 ? "left" : "right"}
              onPhotoClick={onPhotoClick}
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
  const [lightbox, setLightbox] = useState<{ photos: Photo[]; index: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

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

  const years = Object.entries(data).sort((a, b) => b[0].localeCompare(a[0]));

  return (
    <>
      {years.map(([year, days]) => (
        <YearSection
          key={year}
          year={year}
          days={days}
          onPhotoClick={(photos, index) => setLightbox({ photos, index })}
        />
      ))}

      {mounted && lightbox &&
        createPortal(
          <div
            className="lightbox"
            onClick={() => setLightbox(null)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div
              className="lightbox-stage"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <img
                src={lightbox.photos[lightbox.index].src}
                alt=""
                className="lightbox-img"
                draggable={false}
              />
              {/* Corner markers over the preview — screenshot deterrence */}
              <span className="corner lt-tl" />
              <span className="corner lt-tr" />
              <span className="corner lt-bl" />
              <span className="corner lt-br" />
            </div>
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
          </div>,
          document.body,
        )}
    </>
  );
}
