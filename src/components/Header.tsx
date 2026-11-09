export function SiteHeader() {
  return (
    <header className="px-6 pt-20 pb-16 md:px-12 lg:px-24 md:text-center">
      <h1 className="text-4xl md:text-6xl font-black tracking-tighter mb-3">
        András Dénes
      </h1>
      <div className="flex items-center gap-3 md:justify-center">
        <div className="h-px w-10 bg-white/40" />
        <p className="text-white/40 font-mono text-[11px] uppercase tracking-[0.2em]">
          photo archive / Fuji X100V&nbsp;&nbsp;·&nbsp;&nbsp;b18
        </p>
      </div>
    </header>
  );
}
