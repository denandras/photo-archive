import { BUILD_TAG } from "@/build-tag";

/* Build watchdog endpoint: no-store, always the DEPLOYED tag. The client bundle
   carries its own compiled-in tag; a difference means a new build is live.
   (cacheComponents forbids route segment "dynamic" config; the no-store header
   itself keeps Vercel/CDN from caching the response body.) */
export async function GET() {
  return new Response(JSON.stringify({ tag: BUILD_TAG }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
