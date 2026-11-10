import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "@/lib/s3";

// A dot + lowercase p on a title marks it private ("date.p" folder, "name.p.jpg"
// file): excluded server-side at every layer, including this final one.
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".heic"];
function isPrivate(key: string): boolean {
  return key.split("/").some((part) => {
    const low = part.toLowerCase();
    for (const ext of IMAGE_EXTS) {
      if (low.endsWith(ext)) {
        part = part.slice(0, -ext.length);
        break;
      }
    }
    return part.endsWith(".p");
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");

  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  if (isPrivate(key)) {
    // Private marker on any path component (folder or file): not on the site.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Presigned redirect: the browser pulls the bytes straight from the origin,
  // so nothing transits Vercel except this tiny signed URL. The origin's
  // response is authoritative — thumbs carry immutable caching set at upload,
  // and the presign pins the same cache policy for originals.
  // `dl=<filename>` forces a download instead of inline display: the presign
  // pins Content-Disposition on the origin response (works across the 307,
  // which an anchor `download` attr alone would not).
  try {
    const dlName = (searchParams.get("dl") || "")
      .replace(/[^\w.\- ()]/g, "_")
      .slice(0, 120);
    const command = new GetObjectCommand({
      Bucket: "tb1",
      Key: `media/${key}`,
      ResponseCacheControl: "public, max-age=31536000, immutable",
      ...(dlName
        ? { ResponseContentDisposition: `attachment; filename="${dlName}"` }
        : {}),
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return new NextResponse(null, {
      status: 307,
      headers: {
        Location: url,
        // brief browser cache of the redirect itself; the signature outlives it
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e: any) {
    console.error("S3 Error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
