import { z } from "zod"

const envSchema = z.object({
  DATABASE_PATH: z.string().default("./data/dkb.db"),
  LLM_BASE_URL: z.string().url().default("http://127.0.0.1:8080"),
  LLM_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default("de"),
  LLM_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000),
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LLM_NUM_CTX: z.coerce.number().int().min(512).max(131_072).default(8192),
  LLM_MAX_LABELS_PROMPT: z.coerce.number().int().min(0).default(200),
  LLM_MAX_SUGGESTIONS: z.coerce.number().int().min(1).max(10).default(3),
})

export type AppConfig = z.infer<typeof envSchema>

let cached: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
      throw new Error(`Invalid environment configuration: ${issues}`)
    }
    cached = parsed.data
  }
  return cached
}

export function resetConfigCache() {
  cached = null
}
