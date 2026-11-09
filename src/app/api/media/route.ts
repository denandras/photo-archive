import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const S3_CONFIG = {
  endpoint: process.env.S4_ENDPOINT || "https://s3.tb1.denandras.cloud",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.S4_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S4_SECRET_ACCESS_KEY || "",
  },
};

const s3Client = new S3Client({
  ...S3_CONFIG,
  forcePathStyle: true,
});

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
  try {
    const command = new GetObjectCommand({
      Bucket: "tb1",
      Key: `media/${key}`,
      ResponseCacheControl: "public, max-age=31536000, immutable",
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
