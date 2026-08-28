import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    // initial value set in the change handler via a microtask to avoid
    // synchronous setState-in-effect cascades flagged by the linter
    const initialTimer = setTimeout(onChange, 0)
    mql.addEventListener("change", onChange)
    return () => {
      clearTimeout(initialTimer)
      mql.removeEventListener("change", onChange)
    }
  }, [])

  return !!isMobile
}
