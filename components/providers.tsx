"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { ThemeProvider } from "@/components/theme-provider"
import { DragDropProvider } from "@/components/drag-drop-provider"
import { ActiveImportProvider } from "@/components/active-import-provider"
import { ImportProgressPill } from "@/components/import-progress-pill"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={200}>
          <ActiveImportProvider>
            <DragDropProvider>
              {children}
              <ImportProgressPill />
              <Toaster richColors position="bottom-right" />
            </DragDropProvider>
          </ActiveImportProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}