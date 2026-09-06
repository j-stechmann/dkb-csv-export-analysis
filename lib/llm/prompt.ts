import { normalizeWhitespace } from "@/lib/money"

const LANGUAGE_NAMES: Record<string, string> = {
  de: "German",
  en: "English",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  sv: "Swedish",
  da: "Danish",
  pl: "Polish",
  cs: "Czech",
  tr: "Turkish",
}

export function languageDisplay(lang: string): string {
  return LANGUAGE_NAMES[lang] ?? "English"
}

export interface PromptTransaction {
  id: string
  amountCents: number
  counterparty: string
  purpose: string
  bookingDate: string
  /** category from a human-learned rule for this exact counterparty combination */
  ruleLabel: string | null
}

/**
 * Renders the system prompt: role, output contract, labelling rules, the
 * existing-label list (usage-ranked, verbatim reuse required) and the
 * rule_label contract. A rule_label comes from a learned counterparty rule
 * (human-made) — the model confirms it or deviates when it clearly doesn't
 * fit.
 */
export function systemPrompt(lang: string, existingLabels: string[]): string {
  const langName = languageDisplay(lang)
  let s = ""
  s += "You are a bank transaction classifier. "
  s +=
    "For each transaction you receive, choose one short category label that best describes what the transaction is for.\n"
  s +=
    'Reply ONLY with a JSON object: {"results":[{"index":<int>,"label":"<category name>"}]} — one result per transaction, same order.\n'
  s += "Rules:\n"
  s +=
    "- The response MUST be a single valid JSON object, no markdown, no extra text.\n"
  s += `\
- IMPORTANT: write the label in ${langName}. The whole label must be in ${langName}.\n`
  s += "- Keep labels short: 1–3 words, no punctuation, sentence case.\n"
  s +=
    "- Reuse the same wording for the same kind of transaction (consistency within the batch matters).\n"
  s +=
    "- Choose the category by what the transaction is FOR, not by its wording.\n"
  s +=
    "- If nothing specific fits, use a generic label for outflows and a generic label for inflows.\n"
  if (existingLabels.length > 0) {
    s += "\nExisting category labels already in use"
    if (langName !== "English") {
      s += ` (in ${langName})`
    }
    s += ":\n"
    for (const label of existingLabels) {
      const clean = label.replace(/[\n\r]/g, " ")
      s += `- ${clean}\n`
    }
    s += "\nRULES FOR EXISTING LABELS:\n"
    s +=
      "- If one of these labels fits a transaction, you MUST use it EXACTLY as written (character-for-character).\n"
    s +=
      "- Only invent a new label when none of the existing labels fits. New labels are added to the list automatically.\n"
  }
  s += "\nRULES FOR RULE_LABEL:\n"
  s +=
    "- Some transactions carry rule_label: a category the user has manually assigned to this exact counterparty combination (payer + payee + account) before. It is a human-made rule, not a hint.\n"
  s +=
    "- You MUST reuse the rule_label EXACTLY as written (character-for-character) unless it clearly does not fit the transaction (e.g. the purpose contradicts the category).\n"
  s +=
    "- If the rule_label clearly does not fit, choose from the existing labels above or invent a new label.\n"
  return s
}

/**
 * Neutralizes prompt-structure markers so a stored label always survives
 * rendering unchanged: `<<`/`>>` runs collapse to single `<`/`>`, `index=`
 * loses its `=`, `|` becomes `/`. The angle replacements iterate to a fixed
 * point — a single pass only halves odd runs (`a<<<b` → `a<<b` still reads
 * as a marker opener).
 */
export function neutralizeMarkers(s: string): string {
  let out = s
  for (;;) {
    const next = out.replaceAll("<<", "<").replaceAll(">>", ">")
    if (next === out) break
    out = next
  }
  return out.replaceAll("index=", "index ").replaceAll("|", "/")
}

/**
 * Strips control chars and prompt-structure markers from model input fields.
 * Shared by the prompt renderer (sanitizeField) and the model-output path
 * (sanitizeLabel) so stored labels and their prompt rendering stay identical.
 */
export function sanitizeField(raw: string): string {
  return neutralizeMarkers(
    raw
      .split("")
      .filter((c) => {
        const code = c.codePointAt(0) ?? 0
        // C0 controls + DEL
        return code >= 0x20 && code !== 0x7f
      })
      .join("")
  )
}

export function formatAmount(cents: number): string {
  const euros = cents / 100
  if (Number.isInteger(euros) && Math.abs(euros) < 1e13) {
    return euros.toFixed(0)
  }
  return euros.toFixed(2)
}

/** Renders the user prompt for one batch of transactions. */
export function userPrompt(txs: PromptTransaction[]): string {
  let s = "Classify these transactions:\n"
  txs.forEach((tx, i) => {
    const ruleLabel = tx.ruleLabel
      ? `; rule_label=<<${sanitizeField(tx.ruleLabel)}>>`
      : ""
    s += `[${i}] date=${sanitizeField(tx.bookingDate)}; amount=${formatAmount(tx.amountCents)}; currency=EUR; counterparty=<<${sanitizeField(tx.counterparty)}>>; purpose=<<${sanitizeField(tx.purpose)}>>${ruleLabel}\n`
  })
  return s
}

/**
 * JSON schema for llama-server grammar-constrained decoding. The label is a
 * free string (no enum — the model may invent); length bounds are advisory,
 * the client re-sanitizes/caps at runtime. `itemCount` bounds the echoed
 * index (and the array length) to the batch, so the grammar itself can't
 * produce out-of-range indices.
 */
export function responseSchema(itemCount: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        minItems: itemCount,
        maxItems: itemCount,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", minimum: 0, maximum: itemCount - 1 },
            label: { type: "string", minLength: 1, maxLength: 64 },
          },
          required: ["index", "label"],
        },
      },
    },
    required: ["results"],
  }
}

/** Shared field truncation for prompt inputs (UTF-8 byte capped). */
const MAX_FIELD_BYTES = 512
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function truncateField(s: string): string {
  const normalized = normalizeWhitespace(s)
  const bytes = textEncoder.encode(normalized)
  if (bytes.length <= MAX_FIELD_BYTES) return normalized
  let end = MAX_FIELD_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return textDecoder.decode(bytes.subarray(0, end))
}
