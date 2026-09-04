import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    iban: text("iban").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [uniqueIndex("accounts_iban_unique").on(t.iban)]
)

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    accountId: integer("account_id").references(() => accounts.id),
    /** parsing | importing | labeling | completed | failed */
    status: text("status").notNull().default("parsing"),
    error: text("error"),
    snapshotDate: text("snapshot_date"),
    snapshotAmountCents: integer("snapshot_amount_cents"),
    rowsTotal: integer("rows_total").notNull().default(0),
    rowsImported: integer("rows_imported").notNull().default(0),
    rowsDuplicate: integer("rows_duplicate").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    labelsTotal: integer("labels_total").notNull().default(0),
    labelsDone: integer("labels_done").notNull().default(0),
    labelsFailed: integer("labels_failed").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    completedAt: text("completed_at"),
  },
  (t) => [index("import_batches_status_idx").on(t.status)]
)

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    language: text("language").notNull(),
    /** manual (user-created/renamed/assigned) | llm (invented by the model) */
    origin: text("origin").notNull().default("llm"),
    /** how often the label was applied/assigned (apply + assign events, not a live transaction count) */
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [uniqueIndex("categories_name_key_unique").on(t.nameKey)]
)

export const labelRules = sqliteTable(
  "label_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    labelId: integer("label_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    /** normalized counterparty IBAN (or IBAN-like key) of learned transactions */
    iban: text("iban").notNull(),
    /** normalized counterparty name key of learned transactions */
    nameKey: text("name_key").notNull(),
    /** counterparty name as learned (display snapshot) */
    name: text("name").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex("label_rules_iban_name_key_unique").on(t.iban, t.nameKey),
    index("label_rules_iban_idx").on(t.iban),
    index("label_rules_label_idx").on(t.labelId),
  ]
)

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    batchId: text("batch_id").references(() => importBatches.id),
    bookingDate: text("booking_date").notNull(),
    valueDate: text("value_date"),
    status: text("status").notNull().default("Gebucht"),
    payer: text("payer"),
    payee: text("payee"),
    purpose: text("purpose"),
    type: text("type").notNull(),
    counterpartyIban: text("counterparty_iban"),
    amountCents: integer("amount_cents").notNull(),
    creditorId: text("creditor_id"),
    mandateRef: text("mandate_ref"),
    customerRef: text("customer_ref"),
    categoryId: integer("category_id").references(() => categories.id),
    /** pending | labeled | failed */
    labelStatus: text("label_status").notNull().default("pending"),
    labelAttempts: integer("label_attempts").notNull().default(0),
    sourceHash: text("source_hash").notNull(),
    occurrenceIndex: integer("occurrence_index").notNull().default(0),
    hashVersion: integer("hash_version").notNull().default(1),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex("transactions_dedupe_unique").on(
      t.accountId,
      t.sourceHash,
      t.occurrenceIndex
    ),
    index("transactions_account_booking_idx").on(t.accountId, t.bookingDate),
    index("transactions_booking_date_idx").on(t.bookingDate),
    index("transactions_label_status_idx").on(t.labelStatus),
    index("transactions_batch_id_idx").on(t.batchId),
    index("transactions_category_idx").on(t.categoryId),
    index("transactions_payee_idx").on(t.payee),
  ]
)

export type Account = typeof accounts.$inferSelect
export type ImportBatch = typeof importBatches.$inferSelect
export type Category = typeof categories.$inferSelect
export type LabelRule = typeof labelRules.$inferSelect
export type Transaction = typeof transactions.$inferSelect
export type NewTransaction = typeof transactions.$inferInsert
