import { z } from "zod"

const envSchema = z.object({
  DATABASE_PATH: z.string().default("./data/dkb.db"),
  LABELLER_BASE_URL: z.string().url().default("http://127.0.0.1:8080"),
  LABELLER_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default("de"),
  LABELLER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  LABELLER_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  LABELLER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  LABELLER_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LABELLER_RETRY_AFTER_FALLBACK_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(5000),
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
