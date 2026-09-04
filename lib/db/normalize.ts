/**
 * Shared normalization helpers for learned label-rule keys.
 *
 * These keys are used for rule lookup/learning only — stored transaction
 * values (counterparty_iban, payer/payee) are never rewritten, because
 * dedupe/fuzzy-match identity in lib/db/match.ts compares them verbatim.
 */

/**
 * Rule key for a counterparty IBAN: trim, uppercase, strip internal
 * whitespace. Deliberately permissive: non-IBAN values from DKB exports
 * (GLN-style card identifiers like "1056387457") stay usable as stable keys.
 */
export function normalizeIbanKey(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw.replace(/\s+/g, "").toUpperCase().trim()
}

/** True when the value plausibly identifies a counterparty account. */
export function isLearnableIbanKey(ibanKey: string): boolean {
  // real IBANs are 15–34 chars; anything shorter cannot identify an account
  if (ibanKey.length < 8) return false
  // real IBANs start with 2 letters + 2 digits; accept any alphanumeric
  // key of sufficient length (GLN/card numbers) but reject obvious junk
  // like "IBAN123" placeholders or all-zero filler
  if (/^[A-Za-z]{2}[0-9]{2}/.test(ibanKey)) return true
  return /^[0-9]{6,}$/.test(ibanKey) && !/^0+$/.test(ibanKey)
}

/**
 * Legal-form and rendering suffixes stripped from counterparty names before
 * comparison. Composite forms ("GmbH & Co. KG") are stripped before bare
 * forms. Ordered longest-first within each pass.
 */
const LEGAL_FORM_COMPOSITES = [
  "GmbH & Co. KGaA",
  "GmbH & Co. KG",
  "UG & Co. KG",
  "AG & Co. KGaA",
  "AG & Co. KG",
  "& Co. KGaA",
  "& Co. KG",
  "GmbH & Co.",
  "& Co.",
]

const LEGAL_FORMS = [
  "Kommanditgesellschaft auf Aktien",
  "Kommanditgesellschaft",
  "Gesellschaft mbH",
  "Gesellschaft bürgerlichen Rechts",
  "Gesellschaft mit beschränkter Haftung",
  "eingetragener Verein",
  "eingetragene Gesellschaft",
  "Bürgerliche Gesellschaft",
  "Partnerschaftsgesellschaft",
  "Rechtsanwaltsgesellschaft",
  "Unternehmensgesellschaft",
  "Aktiengesellschaft",
  "PartG mbB",
  "PartG",
  "GbR",
  "OHG",
  "KGaA",
  "GmbH",
  "e.V.",
  "e. V.",
  "mbH",
  "AG",
  "UG",
  "SE",
  "KG",
  "e.K.",
  "e. K.",
]

const THANK_YOU_SUFFIXES = ["SAGT DANKE", "SAGT DANKE!", "DANKE"]

function stripAll(value: string, needles: string[]): string {
  let out = value
  for (const needle of needles) {
    // case-insensitive whole-token removal: boundaries prevent needles like
    // "AG" matching inside "sagt" or "mbH" inside "gmbh"
    out = out.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`,
        "giu"
      ),
      " "
    )
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Rule key for a counterparty name: NFC normalize, lowercase, strip legal
 * forms / composites / thank-you suffixes, fold "&" to "und", drop
 * punctuation, collapse whitespace. NULL-safe (empty string).
 */
export function normalizeCounterpartyKey(
  raw: string | null | undefined
): string {
  if (!raw) return ""
  let s = raw.normalize("NFC").toLowerCase()
  s = stripAll(s, LEGAL_FORM_COMPOSITES)
  s = stripAll(s, LEGAL_FORMS)
  s = stripAll(s, THANK_YOU_SUFFIXES)
  s = s.replace(/&/g, " und ")
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ")
  return s.replace(/\s+/g, " ").trim()
}

/** Display snapshot of a counterparty name for a learned rule. */
export function counterpartyDisplayName(
  raw: string | null | undefined
): string {
  if (!raw) return ""
  return raw.normalize("NFC").replace(/\s+/g, " ").trim()
}
