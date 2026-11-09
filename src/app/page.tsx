import { loadManifest } from "@/lib/manifest";
import Gallery from "@/components/Gallery";
import { SiteHeader } from "@/components/Header";
import { SiteFooter } from "@/components/Footer";

type GalleryPhoto = {
  src: string; // thumbnail (small, fast)
  full: string; // original (lightbox only)
  key: string; // S3 key relative to media/ — permalink identity
  w: number;
  h: number;
};

// Only show formats browsers can render natively (HEIC excluded)
const BROWSER_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

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
          .map((p) => ({
            src: `/api/media?key=${encodeURIComponent("thumbs/" + p.key)}`,
            full: `/api/media?key=${encodeURIComponent(p.key)}`,
            key: p.key,
            w: p.width || 600,
            h: p.height || 400,
          }));
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
