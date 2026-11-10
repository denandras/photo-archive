import { BUILD_TAG } from "@/build-tag";

export function SiteHeader() {
  return (
    <header className="px-6 pt-20 pb-16 md:px-12 lg:px-24 md:text-center">
      <h1 className="text-4xl md:text-6xl font-black tracking-tighter mb-3">
        András Dénes
      </h1>
      <p className="text-white/40 font-mono text-[11px] uppercase tracking-[0.2em]">
        photo archive / Fuji X100V&nbsp;&nbsp;·&nbsp;&nbsp;{BUILD_TAG}
      </p>
    </header>
  );
}
