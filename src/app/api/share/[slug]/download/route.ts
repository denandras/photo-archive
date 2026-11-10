import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { ZipArchive } from "archiver";
import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { s3Client, fullKeyOf } from "@/lib/s3";

type SharePhoto = { key: string; name: string; time: string; width?: number | null; height?: number | null };

function loadShare(slug: string) {
  const file = path.join(process.cwd(), "public", "shares", `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { slug: string; folder: string; photos: SharePhoto[] };
  } catch {
    return null;
  }
}

// GET /api/share/<slug>/download — a ZIP of the whole shared folder, streamed
// member-by-member from S3 (nothing buffered). HEIC members come from the
// JPEG renditions (fulls/<key>.jpg); everything else downloads the original.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const share = loadShare(slug);
  if (!share || share.photos.length === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const archive = new ZipArchive({ store: true }); // photos are already compressed
  const failures: string[] = [];
  const used = new Set<string>();
  for (const p of share.photos) {
    // HEIC members carry the JPEG rendition's bytes (fulls/<key>.jpg) — name
    // them .jpg so recipients never hit an HEIC extension they can't open.
    const isHeic = /\.heic$/i.test(p.key);
    // Flat zip: share folders are usually one day; same-named files across
    // subfolders get a numeric suffix instead of losing content to collisions.
    let name = p.key.split("/").pop() || "photo.jpg";
    if (isHeic) name = `${name.replace(/\.heic$/i, "")}.jpg`;
    const stem = name.replace(/\.[^.]+$/, "");
    const ext = name.slice(stem.length);
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${stem}-${n++}${ext}`;
    used.add(name.toLowerCase());
    try {
      const obj = await s3Client.send(
        new GetObjectCommand({ Bucket: "tb1", Key: `media/${fullKeyOf(p.key)}` })
      );
      archive.append(obj.Body as Readable, { name });
    } catch (e: unknown) {
      failures.push(p.key);
    }
  }

  if (failures.length === share.photos.length) {
    archive.abort();
    return Response.json({ error: "No downloadable files" }, { status: 500 });
  }
  // archive.on handlers: warnings are common (entries interrupted with
  // store:true), errors would otherwise throw unhandled.
  archive.on("warning", (err: Error) => console.error("zip warning:", err));
  archive.on("error", (err: Error) => console.error("zip error:", err));
  void archive.finalize(); // closes the archive once appended members drain

  const safeSlug = (slug as string).replace(/[^\w.\-]/g, "");
  const stream = Readable.toWeb(archive as unknown as Readable) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeSlug || "share"}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
