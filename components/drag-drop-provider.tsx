"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useActiveImport } from "@/components/active-import-provider"

interface DragDropContextValue {
  isDragging: boolean
}

const DragDropContext = React.createContext<DragDropContextValue>({
  isDragging: false,
})

export function useIsDraggingFile() {
  return React.useContext(DragDropContext).isDragging
}

/**
 * Global drag-and-drop: dragging a file anywhere over the app shows an
 * overlay; dropping uploads it and kicks off an async import.
 */
export function DragDropProvider({ children }: { children: React.ReactNode }) {
  const [isDragging, setIsDragging] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const dragCounter = React.useRef(0)
  const { startPolling } = useActiveImport()

  const uploadFile = React.useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        toast.error("Nur CSV-Dateien werden unterstützt", {
          description: file.name,
        })
        return
      }
      setIsUploading(true)
      try {
        const body = new FormData()
        body.append("file", file)
        const res = await fetch("/api/imports", { method: "POST", body })
        const data = (await res.json()) as {
          batchId?: string
          error?: string
          message?: string
        }
        if (res.status === 202 && data.batchId) {
          toast.success("Import gestartet", {
            description: `${file.name} wird verarbeitet`,
          })
          startPolling(data.batchId)
        } else if (res.status === 409) {
          toast.error("Import läuft bereits", {
            description:
              "Bitte warten, bis der aktuelle Import abgeschlossen ist.",
          })
        } else {
          toast.error("Import fehlgeschlagen", {
            description: data.error ?? data.message ?? `HTTP ${res.status}`,
          })
        }
      } catch (err) {
        toast.error("Upload fehlgeschlagen", {
          description: (err as Error).message,
        })
      } finally {
        setIsUploading(false)
      }
    },
    [startPolling]
  )

  React.useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return
      e.preventDefault()
      dragCounter.current++
      setIsDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return
      e.preventDefault()
    }
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return
      dragCounter.current = Math.max(0, dragCounter.current - 1)
      if (dragCounter.current === 0) setIsDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return
      e.preventDefault()
      dragCounter.current = 0
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) void uploadFile(file)
    }

    window.addEventListener("dragenter", onDragEnter)
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("dragleave", onDragLeave)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragenter", onDragEnter)
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("dragleave", onDragLeave)
      window.removeEventListener("drop", onDrop)
    }
  }, [uploadFile])

  const value = React.useMemo(() => ({ isDragging }), [isDragging])

  return (
    <DragDropContext.Provider value={value}>
      {children}
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary bg-background px-12 py-10 shadow-lg">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-primary"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" x2="12" y1="3" y2="15" />
            </svg>
            <p className="text-lg font-medium">
              CSV hier ablegen, um zu importieren
            </p>
          </div>
        </div>
      )}
      {isUploading && (
        <div className="fixed right-4 bottom-4 z-[100] rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground shadow-lg">
          Datei wird hochgeladen…
        </div>
      )}
    </DragDropContext.Provider>
  )
}
