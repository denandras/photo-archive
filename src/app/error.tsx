"use client";

/* b56b: route error boundary. A client exception used to surface as the bare
   Next/Vercel "This page couldn't load" interstitial; this recovers with a
   retry instead (photo-archive = one page, mono chrome, no redirects). */

export default function RouteError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center">
      <div className="text-center px-8">
        <p className="font-mono text-sm text-white/40">the page hit an error</p>
        <button
          onClick={reset}
          className="mt-5 border border-white/25 px-6 py-2.5 font-mono text-xs tracking-widest text-white/70 hover:text-white hover:border-white/60 transition cursor-pointer"
        >
          TRY AGAIN
        </button>
      </div>
    </main>
  );
}
