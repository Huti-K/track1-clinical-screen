/** The app's mark: a dark glyph on a light pink tile. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className="shrink-0">
      <rect width="100" height="100" fill="#F6E7F3" />
      <path
        d="M74.047 73.0203C74.047 73.0203 76.1143 50.8484 74.0762 32.3094C72.0381 13.7704 26.1525 18.1928 26.0762 32.2316C26 46.2703 26 79.2315 26 79.2315L38 79.251L38.0478 49.751L44.5478 49.7615L44.5 79.2615L55.5 79.2793L55.547 50.2794C55.547 50.2794 59.3547 49.462 61.547 50.2891C67.3789 52.4894 61.547 73 61.547 73L74.047 73.0203Z"
        fill="#211103"
        stroke="#211103"
      />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      <span className="text-sm font-semibold tracking-tight">Roter Faden</span>
    </div>
  );
}
