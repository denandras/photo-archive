"use client";

/* Single-roll share page gallery: same card/ring/lightbox mechanics as the
   landing Gallery, ONE row, bigger cards, and a Download button in the
   lightbox that fetches the FULL-size original (HEIC originals download as
   the 2560px JPEG rendition the thumb builder publishes). */

import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { ScrollRow, LightboxStage } from "./Gallery";

type Photo = { src: string; full: string; key: string; w: number; h: number; name: string };

function downloadHref(p: Photo) {
  // `dl=<filename>` pins Content-Disposition: attachment at the origin — the
  // presigned redirect carries it, which an anchor download attr can't.
  const sep = p.full.includes("?") ? "&" : "?";
  return `${p.full}${sep}dl=${encodeURIComponent(p.name)}`;
}

export default function ShareGallery({ photos }: { photos: Photo[] }) {
  const [lightbox, setLightbox] = useState<{ photos: Photo[]; index: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [lbClosing, setLbClosing] = useState(false);
  const lbCloseTimer = useRef<number | null>(null);
  const lbBusyRef = useRef(false);

  const handleLbBusy = useCallback((b: boolean) => {
    lbBusyRef.current = b;
  }, []);

  const stepLightbox = useCallback((dir: 1 | -1) => {
    if (lbBusyRef.current) return;
    setLightbox((p) => {
      if (!p) return p;
      if (dir < 0) return p.index < p.photos.length - 1 ? { ...p, index: p.index + 1 } : p;
      return p.index > 0 ? { ...p, index: p.index - 1 } : p;
    });
  }, []);

  const closeLightbox = useCallback(() => {
    if (lbCloseTimer.current) return;
    setLbClosing(true);
    lbCloseTimer.current = window.setTimeout(() => {
      lbCloseTimer.current = null;
      setLbClosing(false);
      setLightbox(null);
    }, 700);
  }, []);

  useEffect(() => setMounted(true), []);

  const openLightbox = useCallback((index: number) => {
    if (lbCloseTimer.current) {
      clearTimeout(lbCloseTimer.current);
      lbCloseTimer.current = null;
      setLbClosing(false);
    }
    setLightbox({ photos, index });
  }, [photos]);

  // Keyboard nav + scroll lock when lightbox is open
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") stepLightbox(1);
      else if (e.key === "ArrowRight") stepLightbox(-1);
    };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [lightbox, closeLightbox, stepLightbox]);

  // Discrete flick = one step (same gate: one swap at a time, b46)
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);

  if (photos.length === 0) {
    return (
      <div className="px-6 py-20 text-center">
        <p className="text-white/30 font-mono text-sm">This shared folder is empty.</p>
      </div>
    );
  }

  return (
    <>
      <ScrollRow
        photos={photos}
        direction="right"
        day="share"
        onOpen={openLightbox}
        variant="share"
      />

      {mounted && lightbox &&
        createPortal(
          <div
            className={`lightbox${lbClosing ? " closing" : ""}`}
            onClick={closeLightbox}
            onContextMenu={(e) => e.preventDefault()}
            onTouchStart={(e) => {
              if (lbClosing || lbBusyRef.current) return;
              const t = e.touches[0];
              touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
            }}
            onTouchEnd={(e) => {
              const s = touchStart.current;
              touchStart.current = null;
              if (!s || lbClosing || lbBusyRef.current) return;
              const t = e.changedTouches[0];
              const dx = t.clientX - s.x;
              const dy = t.clientY - s.y;
              if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
              if (Date.now() - s.t > 700) return;
              e.stopPropagation();
              stepLightbox(dx < 0 ? -1 : 1);
            }}
          >
            <div className="lightbox-fit">
              <LightboxStage photo={lightbox.photos[lightbox.index]} onBusyChange={handleLbBusy} closing={lbClosing} />
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
                        stepLightbox(1);
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
                        stepLightbox(-1);
                      }}
                      aria-label="Next"
                    >
                      &#8250;
                    </button>
                  )}
                </>
              )}
              {/* Full-size download of the photo in preview */}
              <a
                className="lightbox-download"
                href={downloadHref(lightbox.photos[lightbox.index])}
                onClick={(e) => e.stopPropagation()}
                download
              >
                Download
              </a>
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
