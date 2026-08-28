import { describe, it, expect } from "vitest"
import { parseDkbCsv, peekDkbCsvAccount, CsvParseError } from "@/lib/csv/parser"

const HEADER =
  "Buchungsdatum;Wertstellung;Status;Zahlungspflichtige*r;Zahlungsempfänger*in;Verwendungszweck;Umsatztyp;IBAN;Betrag (€);Gläubiger-ID;Mandatsreferenz;Kundenreferenz"

function buildCsv(opts: {
  accountRow?: string
  zeitraumRow?: string
  saldoRow?: string
  dataRows?: string[]
}) {
  const lines = [
    opts.accountRow ?? "Girokonto;DE02120300000000202051;",
    opts.zeitraumRow ?? "Zeitraum:;01.01.2026 – 31.01.2026;",
    opts.saldoRow ?? "Kontostand vom 17.01.2026:;1.234,56\u00A0€;",
    "",
    HEADER,
    ...(opts.dataRows ?? []),
  ]
  return "\uFEFF" + lines.join("\n") + "\n"
}

const validRow =
  "03.02.26;03.02.26;Gebucht;MAX MUSTERMANN;REWE SAGT DANKE;Einkauf 03.02;Ausgang;DE02100100123456789001;-42,13;;;"

describe("parseDkbCsv", () => {
  it("parses a well-formed export", () => {
    const csv = buildCsv({ dataRows: [validRow] })
    const parsed = parseDkbCsv(csv)
    expect(parsed.accountName).toBe("Girokonto")
    expect(parsed.accountIban).toBe("DE02120300000000202051")
    expect(parsed.snapshotDate).toBe("2026-01-17")
    expect(parsed.snapshotAmountCents).toBe(123456)
    expect(parsed.rows).toHaveLength(1)
    const r = parsed.rows[0]
    expect(r.bookingDate).toBe("2026-02-03")
    expect(r.amountCents).toBe(-4213)
    expect(r.payee).toBe("REWE SAGT DANKE")
    expect(r.payer).toBe("MAX MUSTERMANN")
    expect(r.type).toBe("Ausgang")
    expect(r.counterpartyIban).toBe("DE02100100123456789001")
  })

  it("tolerates BOM, NBSP in saldo, trailing empty columns", () => {
    const parsed = parseDkbCsv(buildCsv({ dataRows: [validRow] }))
    expect(parsed.snapshotAmountCents).toBe(123456)
    expect(parsed.rows[0].creditorId).toBe("")
  })

  it("maps columns by header name, not position", () => {
    // reorder header + row identically
    const reorderedHeader =
      "Betrag (€);Buchungsdatum;Wertstellung;Status;Zahlungspflichtige*r;Zahlungsempfänger*in;Verwendungszweck;Umsatztyp;IBAN;Gläubiger-ID;Mandatsreferenz;Kundenreferenz"
    const reorderedRow =
      "-42,13;03.02.26;03.02.26;Gebucht;MAX MUSTERMANN;REWE SAGT DANKE;Einkauf;Ausgang;DE02100100123456789001;;;"
    const csv = "\uFEFF" + [
      "Girokonto;DE02120300000000202051;",
      "Zeitraum:;x – y;",
      "Kontostand vom 17.01.2026:;1.234,56;",
      "",
      reorderedHeader,
      reorderedRow,
    ].join("\n")
    const parsed = parseDkbCsv(csv)
    expect(parsed.rows[0].amountCents).toBe(-4213)
    expect(parsed.rows[0].bookingDate).toBe("2026-02-03")
    expect(parsed.rows[0].payee).toBe("REWE SAGT DANKE")
  })

  it("handles quoted multi-line Verwendungszweck", () => {
    const csv = "\uFEFF" + [
      "Girokonto;DE02120300000000202051;",
      "Zeitraum:;x – y;",
      "Kontostand vom 17.01.2026:;1.234,56;",
      "",
      HEADER,
      '05.02.26;05.02.26;Gebucht;A;B;"SVWZ+Erste Zeile\nZweite Zeile";Ausgang;IBAN123;-10;;;',
    ].join("\n")
    const parsed = parseDkbCsv(csv)
    expect(parsed.rows[0].purpose).toBe("SVWZ+Erste Zeile Zweite Zeile")
  })

  it("skips all-empty padded rows", () => {
    const csv = buildCsv({ dataRows: [validRow, ";;;;;;;;;;;", validRow] })
    const parsed = parseDkbCsv(csv)
    expect(parsed.rows).toHaveLength(2)
  })

  it("fails fast on invalid date with row number", () => {
    const csv = buildCsv({
      dataRows: [validRow, "DD.MM.YY;03.02.26;Gebucht;A;B;C;Ausgang;I;-5;;;"],
    })
    expect(() => parseDkbCsv(csv)).toThrow(/row 6.*Buchungsdatum|malformed date/)
  })

  it("fails fast on ambiguous amount", () => {
    const csv = buildCsv({
      dataRows: [validRow, "03.02.26;03.02.26;Gebucht;A;B;C;Ausgang;I;12.345.6;;;"],
    })
    expect(() => parseDkbCsv(csv)).toThrow(/ambiguous/)
  })

  it("fails fast on Umsatztyp/sign mismatch", () => {
    const csv = buildCsv({
      dataRows: ["03.02.26;03.02.26;Gebucht;A;B;C;Ausgang;I;+50;;;"],
    })
    expect(() => parseDkbCsv(csv)).toThrow(/Ausgang but amount is positive/)
  })

  it("fails fast on invalid Umsatztyp", () => {
    const csv = buildCsv({
      dataRows: ["03.02.26;03.02.26;Gebucht;A;B;C;Lastschrift;I;-5;;;"],
    })
    expect(() => parseDkbCsv(csv)).toThrow(/invalid Umsatztyp/)
  })

  it("rejects placeholder template dates (DD.MM.YY)", () => {
    const csv = buildCsv({
      dataRows: ["DD.MM.YY;DD.MM.YY;Gebucht;A;B;C;Ausgang;I;-5;;;"],
    })
    expect(() => parseDkbCsv(csv)).toThrow(CsvParseError)
  })

  it("accepts zero-amount rows", () => {
    const csv = buildCsv({
      dataRows: ["03.02.26;03.02.26;Gebucht;A;B;C;Eingang;I;0;;;"],
    })
    const parsed = parseDkbCsv(csv)
    expect(parsed.rows[0].amountCents).toBe(0)
  })

  it("missing header throws", () => {
    expect(() => parseDkbCsv("not,a,dkb\nfile")).toThrow(CsvParseError)
  })

  it("peekDkbCsvAccount returns account info without data validation", () => {
    const csv = buildCsv({ dataRows: ["garbage that is not valid data"] })
    const info = peekDkbCsvAccount(csv)
    expect(info.accountIban).toBe("DE02120300000000202051")
    expect(info.snapshotAmountCents).toBe(123456)
  })

  it("peekDkbCsvAccount rejects placeholder IBAN", () => {
    const csv = buildCsv({
      accountRow: "Girokonto;Beispiel-IBAN hier;",
      dataRows: [],
    })
    expect(() => peekDkbCsvAccount(csv)).toThrow(/IBAN/)
  })
})