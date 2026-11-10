import { S3Client } from "@aws-sdk/client-s3";

export const S3_CONFIG = {
  endpoint: process.env.S4_ENDPOINT || "https://s3.tb1.denandras.cloud",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.S4_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S4_SECRET_ACCESS_KEY || "",
  },
};

export const s3Client = new S3Client({
  ...S3_CONFIG,
  forcePathStyle: true,
});

export const BROWSER_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif",
]);

// HEIC originals don't render outside iOS Safari — display + download the
// JPEG rendition the thumb builder publishes at media/fulls/<key>.jpg.
export function fullKeyOf(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() || "";
  return ext === "heic" || ext === "heif" ? `fulls/${key}.jpg` : key;
}
