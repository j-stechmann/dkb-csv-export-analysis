"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import { NAV_ITEMS, NAV_LINK_CLASS } from "@/components/app-nav"
import { Button } from "@/components/ui/button"
import { useSessionUser } from "@/components/user-session"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

export function MobileNav() {
  const pathname = usePathname()
  const user = useSessionUser()
  const [open, setOpen] = React.useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Menü öffnen"
            className="sm:hidden"
          />
        }
      >
        <Menu className="size-4" />
      </SheetTrigger>
      <SheetContent side="right" className="w-64">
        <SheetHeader>
          <SheetTitle>Geldlage</SheetTitle>
          <SheetDescription className="sr-only">Navigation</SheetDescription>
        </SheetHeader>
        <nav className="flex flex-col gap-1 px-4">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  NAV_LINK_CLASS,
                  "py-2",
                  active && "bg-accent text-foreground"
                )}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        {user && (
          <SheetFooter className="border-t">
            <span
              className="truncate px-1 text-sm text-muted-foreground"
              title={user.email}
            >
              {user.name || user.email || "Angemeldet"}
            </span>
            <form action="/auth/logout" method="post">
              <button
                type="submit"
                className={cn(NAV_LINK_CLASS, "w-full justify-start py-2")}
              >
                <LogOut className="size-4" />
                Abmelden
              </button>
            </form>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
