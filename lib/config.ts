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
  LLM_CTX: z.coerce.number().int().min(1024).default(8192),
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LLM_MAX_LABELS_PROMPT: z.coerce.number().int().min(0).default(200),
  OIDC_ISSUER_URL: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_SCOPES: z.string().default("openid profile email"),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(7 * 24 * 3600),
  SESSION_SECRET: z.string().min(32).optional(),
  APP_ORIGIN: z.string().url().optional(),
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
