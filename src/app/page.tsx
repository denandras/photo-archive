import { loadManifest } from "@/lib/manifest";
import Gallery from "@/components/Gallery";
import { SiteHeader } from "@/components/Header";
import { SiteFooter } from "@/components/Footer";
import BuildWatchdog from "@/components/BuildWatchdog";

type GalleryPhoto = {
  src: string; // thumbnail (small, fast)
  full: string; // original (lightbox only)
  key: string; // S3 key relative to media/ — permalink identity
  w: number;
  h: number;
};

// Formats browsers render natively. HEIC included since b18-era support: the
// card preview is the WebP thumb and the lightbox "full" is the JPEG
// rendition the thumb builder publishes (media/fulls/<key>.jpg) — raw HEIC
// only renders on iOS Safari, so never link it directly.
const BROWSER_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"]);

export default async function Page() {
  let data: Record<string, Record<string, GalleryPhoto[]>> = {};

  try {
    const manifest = await loadManifest();
    for (const [year, days] of Object.entries(manifest.years)) {
      const yearData: Record<string, GalleryPhoto[]> = {};
      for (const [day, photos] of Object.entries(days)) {
        const galleryPhotos: GalleryPhoto[] = photos
          .filter((p) => {
            const ext = p.key.split(".").pop()?.toLowerCase() || "";
            return BROWSER_EXTS.has(ext);
          })
          .map((p) => {
            const ext = p.key.split(".").pop()?.toLowerCase() || "";
            // HEIC originals are not browser-renderable — serve the JPEG rendition
            const fullKey = ext === "heic" || ext === "heif"
              ? `fulls/${p.key}.jpg`
              : p.key;
            return {
              src: `/api/media?key=${encodeURIComponent("thumbs/" + p.key)}`,
              full: `/api/media?key=${encodeURIComponent(fullKey)}`,
              key: p.key,
              w: p.width || 600,
              h: p.height || 400,
            };
          });
        if (galleryPhotos.length > 0) yearData[day] = galleryPhotos;
      }
      if (Object.keys(yearData).length > 0) data[year] = yearData;
    }
  } catch {
    data = {};
  }

  const hasPhotos = Object.keys(data).length > 0;

  return (
    <main className="min-h-screen bg-black text-white overflow-x-hidden">
      <BuildWatchdog />
      <SiteHeader />
      <div className="px-4 pb-32">
        {hasPhotos ? (
          <Gallery data={data} />
        ) : (
          <div className="px-6 py-20 text-center">
            <p className="text-white/30 font-mono text-sm">
              No public photos yet.
            </p>
          </div>
        )}
      </div>
      <SiteFooter />
    </main>
  );
}
