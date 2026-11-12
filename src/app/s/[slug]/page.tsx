import fs from "fs";
import path from "path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ShareGallery from "@/components/ShareGallery";
import { SiteHeader } from "@/components/Header";
import { SiteFooter } from "@/components/Footer";
import BuildWatchdog from "@/components/BuildWatchdog";

type SharePhoto = {
  key: string; // S3 key relative to media/
  name: string;
  time: string;
  width?: number | null;
  height?: number | null;
};

type ShareFile = { slug: string; folder: string; photos: SharePhoto[] };
type ShareIndex = { [slug: string]: { folder: string; photos: number } };

const BROWSER_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"]);

// HEIC originals don't render outside iOS Safari — display + download the
// JPEG rendition the thumb builder publishes at media/fulls/<key>.jpg.
function fullKeyOf(p: SharePhoto): string {
  const ext = p.key.split(".").pop()?.toLowerCase() || "";
  return ext === "heic" || ext === "heif" ? `_web-archive/fulls/${p.key}.jpg` : p.key;
}

function loadShare(slug: string): ShareFile | null {
  const filePath = path.join(process.cwd(), "public", "shares", `${slug}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ShareFile;
  } catch {
    return null;
  }
}

function loadShareIndex(): ShareIndex {
  const filePath = path.join(process.cwd(), "public", "shares", "index.json");
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ShareIndex;
  } catch {
    return {};
  }
}

export function generateStaticParams() {
  const slugs = Object.keys(loadShareIndex());
  // cacheComponents forbids an EMPTY generateStaticParams — before the first
  // shared folder is listed, keep the build green with a 404 placeholder.
  return slugs.length ? slugs.map((slug) => ({ slug })) : [{ slug: "__none__" }];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const share = loadShare(slug);
  return {
    title: share ? `${share.folder} — photo share` : "photo share",
    description: "Shared photo folder",
  };
}

const mediaUrl = (key: string) => `/api/media?key=${encodeURIComponent(key)}`;

export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const share = loadShare(slug);
  if (!share) notFound();

  const photos = share.photos
    .filter((p) => BROWSER_EXTS.has(p.key.split(".").pop()?.toLowerCase() || ""))
    .map((p) => {
      const ext = p.key.split(".").pop()?.toLowerCase() || "";
      // download name: keep the original basename but make HEIC land as a .jpg
      const dlName =
        ext === "heic" || ext === "heif"
          ? `${p.key.split("/").pop()}.jpg`
          : p.key.split("/").pop() || "photo.jpg";
      return {
        src: mediaUrl(`_web-archive/thumbs/${p.key}`),
        full: mediaUrl(fullKeyOf(p)),
        key: p.key,
        name: dlName,
        w: p.width || 600,
        h: p.height || 400,
      };
    });

  return (
    <main className="min-h-screen bg-black text-white overflow-x-hidden">
      <BuildWatchdog />
      <SiteHeader />
      <div className="pb-32">
        <ShareGallery photos={photos} slug={slug} />
      </div>
      <SiteFooter />
    </main>
  );
}
