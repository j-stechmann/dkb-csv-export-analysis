export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="7" fill="#333333" />
      <rect x="7" y="17" width="4.5" height="9" rx="1.5" fill="#5ee9b5" />
      <rect x="13.75" y="12" width="4.5" height="14" rx="1.5" fill="#00bc7d" />
      <rect x="20.5" y="6" width="4.5" height="20" rx="1.5" fill="#009671" />
    </svg>
  )
}