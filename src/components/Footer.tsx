import { BUILD_TAG } from "@/build-tag";

export function SiteFooter() {
  return (
    <footer className="px-6 py-12 border-t border-white/5 flex items-center justify-between">
      <p className="text-white/20 text-[10px] font-mono uppercase tracking-widest">
        © 2026
      </p>
      <p className="text-white/20 text-[10px] font-mono uppercase tracking-widest">
        {BUILD_TAG}
      </p>
    </footer>
  );
}
