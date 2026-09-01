import { AppNav } from "@/components/app-nav"
import { Providers } from "@/components/providers"
import { LabellerHealthBadge } from "@/components/labeller-health-badge"
import { ThemeToggle } from "@/components/theme-toggle"
import "./globals.css"

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body className="font-serif antialiased">
        <Providers>
          <div className="flex min-h-svh flex-col">
            <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-4">
                <div className="flex items-center gap-6">
                  <span className="text-sm font-semibold tracking-tight">
                    DKB Analytics
                  </span>
                  <AppNav />
                </div>
                <div className="flex items-center gap-2">
                  <LabellerHealthBadge />
                  <ThemeToggle />
                </div>
              </div>
            </header>
            <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  )
}
