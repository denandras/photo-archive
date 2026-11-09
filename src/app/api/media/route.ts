import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");

  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  try {
    const command = new GetObjectCommand({
      Bucket: "tb1",
      Key: `media/${key}`,
    });

    const response = await s3Client.send(command);
    const body = await response.Body?.transformToByteArray();

    if (!body) {
      return NextResponse.json({ error: "Empty body" }, { status: 404 });
    }

    return new NextResponse(body as any, {
      headers: {
        "Content-Type": response.ContentType || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e: any) {
    console.error("S3 Error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
