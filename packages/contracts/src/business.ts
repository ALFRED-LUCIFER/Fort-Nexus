import { z } from "zod";
import { TimeZone } from "./research.ts";

// EPIC CON + DATA + BIZ (FR-CON-01..06, FR-DATA-01..09, FR-BIZ-01..07). Read-only sources, typed metric tools only:
// no generic SQL, no raw rows, never a number the source didn't produce (DATA-G01..G04, BIZ-G01).

// Supabase = its Postgres reached through a dedicated read-only role (FR-DATA-01/02).
export const ConnectorProvider = z.enum(["POSTGRES", "SUPABASE"]);
export type ConnectorProvider = z.infer<typeof ConnectorProvider>;

export const ConnectorEnvironment = z.enum(["DEV", "STAGING", "PROD"]);
export type ConnectorEnvironment = z.infer<typeof ConnectorEnvironment>;

export const ConnectorStatus = z.enum(["UNTESTED", "CONNECTED", "FAILED", "DISABLED"]);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

// Names a mode-0600 file ~/.nexus/connectors/<ref>.json on the home host; the secret never enters the DB,
// the browser, a prompt or a log (FR-CON-03, FR-SEC-03).
export const CredentialRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

// Lower-case SQL identifier; quoted server-side and checked against the schema allowlist.
export const SqlIdentifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
export const QualifiedTable = z.string().regex(/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/);

export const CreateConnectorRequest = z.strictObject({
  projectId: z.uuid(), // a Business project (FR-BIZ-01)
  name: z.string().trim().min(1).max(80),
  provider: ConnectorProvider,
  environment: ConnectorEnvironment,
  credentialRef: CredentialRef,
  schemaAllowlist: z.array(SqlIdentifier).min(1).max(20),
  statementTimeoutMs: z.int().min(500).max(30_000).default(5_000),
});
export type CreateConnectorRequest = z.infer<typeof CreateConnectorRequest>;

export const UpdateConnectorRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    credentialRef: CredentialRef, // rotation = point at a new file, then test (FR-CON-03)
    schemaAllowlist: z.array(SqlIdentifier).min(1).max(20),
    statementTimeoutMs: z.int().min(500).max(30_000),
    disabled: z.boolean(),
  })
  .partial()
  .refine((u) => Object.keys(u).length > 0, "Nothing to update");
export type UpdateConnectorRequest = z.infer<typeof UpdateConnectorRequest>;

export const Connector = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  provider: ConnectorProvider,
  environment: ConnectorEnvironment,
  credentialRef: CredentialRef,
  schemaAllowlist: z.array(SqlIdentifier),
  statementTimeoutMs: z.int(),
  status: ConnectorStatus,
  lastTestedAt: z.iso.datetime({ offset: true }).nullable(),
  // Safe, key-free message from the last failed test.
  lastError: z.string().nullable(),
  hasDictionary: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Connector = z.infer<typeof Connector>;

export const ConnectorList = z.object({ items: z.array(Connector) });
export type ConnectorList = z.infer<typeof ConnectorList>;

// FR-CON-02: harmless reads only. read_only fails if the role can write anything in the allowlisted schemas.
export const ConnectionCheck = z.object({
  name: z.enum(["credential", "network", "auth", "read_only", "schema_allowlist", "dictionary"]),
  ok: z.boolean(),
  detail: z.string(),
});
export const ConnectionTestResult = z.object({
  ok: z.boolean(),
  checks: z.array(ConnectionCheck),
  testedAt: z.iso.datetime({ offset: true }),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

// FR-DATA-06 metric dictionary: what an order / payment / gross sale is, per connector.
export const MetricDictionary = z
  .strictObject({
    reportingTimezone: TimeZone,
    currency: z.string().regex(/^[A-Z]{3}$/),
    orders: z.strictObject({
      table: QualifiedTable,
      createdAtColumn: SqlIdentifier,
      statusColumn: SqlIdentifier,
      amountColumn: SqlIdentifier,
      // MINOR = integer cents; MAJOR = decimal units.
      amountUnit: z.enum(["MINOR", "MAJOR"]),
      // Rows with these statuses count as sales; every other status is listed as excluded, never silently dropped.
      paidStatuses: z.array(z.string().min(1).max(64)).min(1).max(20),
      // Needed to join order items (FR-BIZ-05).
      idColumn: SqlIdentifier.optional(),
    }),
    payments: z
      .strictObject({
        table: QualifiedTable,
        createdAtColumn: SqlIdentifier,
        statusColumn: SqlIdentifier,
        reasonColumn: SqlIdentifier,
        failedStatuses: z.array(z.string().min(1).max(64)).min(1).max(20),
      })
      .optional(),
    // FR-BIZ-04: refunds counted on the day they were issued (not the order day); net = gross − refunds.
    refunds: z
      .strictObject({
        table: QualifiedTable,
        createdAtColumn: SqlIdentifier,
        amountColumn: SqlIdentifier,
        amountUnit: z.enum(["MINOR", "MAJOR"]),
      })
      .optional(),
    // FR-BIZ-05: line items of paid orders, joined on orders.idColumn.
    orderItems: z
      .strictObject({
        table: QualifiedTable,
        orderIdColumn: SqlIdentifier,
        productColumn: SqlIdentifier,
        quantityColumn: SqlIdentifier,
        amountColumn: SqlIdentifier,
        amountUnit: z.enum(["MINOR", "MAJOR"]),
      })
      .optional(),
  })
  .refine((d) => !d.orderItems || d.orders.idColumn, {
    message: "orders.idColumn is required to join order items",
    path: ["orders", "idColumn"],
  });
export type MetricDictionary = z.infer<typeof MetricDictionary>;

// FR-DATA-07 provenance on every metric value.
export const MetricProvenance = z.object({
  connectorId: z.uuid(),
  connectorName: z.string(),
  environment: ConnectorEnvironment,
  dataset: QualifiedTable,
  timezone: TimeZone,
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  filters: z.record(z.string(), z.array(z.string())),
  // Human-readable formula, e.g. "sum(amount)/100 where status in (paid) and created_at in [from, to)".
  formula: z.string(),
  queriedAt: z.iso.datetime({ offset: true }),
  // Newest record in the source table; null when the table is empty.
  latestRecordAt: z.iso.datetime({ offset: true }).nullable(),
  // The window ends after "now" in the reporting time zone (BIZ-G01).
  partial: z.boolean(),
});
export type MetricProvenance = z.infer<typeof MetricProvenance>;

// DATA-G02: no source → UNAVAILABLE with a reason, never a zero.
export const UnavailableReason = z.enum([
  "NO_CONNECTOR",
  "CONNECTOR_DISABLED",
  "CONNECTOR_FAILED",
  "NOT_DEFINED",
  "TIMEOUT",
]);
export const Unavailable = z.object({
  status: z.literal("UNAVAILABLE"),
  reason: UnavailableReason,
  message: z.string(),
});
export type Unavailable = z.infer<typeof Unavailable>;

const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

export const SalesSummary = z.object({
  status: z.literal("AVAILABLE"),
  paidOrders: z.int().nonnegative(),
  grossSales: Decimal, // exact decimal string in `currency`
  currency: z.string(),
  byStatus: z.array(z.object({ status: z.string(), count: z.int().nonnegative() })),
  excludedStatuses: z.array(z.string()),
  provenance: MetricProvenance,
});
export type SalesSummary = z.infer<typeof SalesSummary>;

export const SalesSummaryResult = z.discriminatedUnion("status", [SalesSummary, Unavailable]);
export type SalesSummaryResult = z.infer<typeof SalesSummaryResult>;

export const PaymentFailures = z.object({
  status: z.literal("AVAILABLE"),
  attempts: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  failureRate: z.number().min(0).max(1).nullable(), // null when there were no attempts
  // Reason strings are masked (emails, long digit runs) before they leave the gateway (FR-DATA-09).
  byReason: z.array(z.object({ reason: z.string(), count: z.int().nonnegative() })),
  provenance: MetricProvenance,
});
export type PaymentFailures = z.infer<typeof PaymentFailures>;

export const PaymentFailuresResult = z.discriminatedUnion("status", [PaymentFailures, Unavailable]);
export type PaymentFailuresResult = z.infer<typeof PaymentFailuresResult>;

// `today` runs to now (partial); `compare` adds the previous day over the same local clock window (BIZ-G01).
export const MetricQuery = z.object({
  connectorId: z.uuid(),
  day: z.union([z.enum(["today", "yesterday"]), z.iso.date()]).default("today"),
  compare: z.stringbool().default(false),
});
export type MetricQuery = z.infer<typeof MetricQuery>;

export const SalesSummaryResponse = z.object({
  current: SalesSummaryResult,
  previous: SalesSummaryResult.nullable(),
});
export type SalesSummaryResponse = z.infer<typeof SalesSummaryResponse>;

export const PaymentFailuresResponse = z.object({
  current: PaymentFailuresResult,
  previous: PaymentFailuresResult.nullable(),
});
export type PaymentFailuresResponse = z.infer<typeof PaymentFailuresResponse>;

// FR-BIZ-04: gross, refunds and net with the exact formula; refunds and orders each carry their own provenance.
export const RevenueSummary = z.object({
  status: z.literal("AVAILABLE"),
  grossSales: Decimal,
  refunds: Decimal,
  netSales: Decimal,
  currency: z.string(),
  formula: z.string(), // e.g. "net = gross (paid orders by order time) − refunds (by refund time)"
  provenance: MetricProvenance, // orders
  refundsProvenance: MetricProvenance,
});
export type RevenueSummary = z.infer<typeof RevenueSummary>;

export const RevenueSummaryResult = z.discriminatedUnion("status", [RevenueSummary, Unavailable]);
export type RevenueSummaryResult = z.infer<typeof RevenueSummaryResult>;

export const RevenueSummaryResponse = z.object({
  current: RevenueSummaryResult,
  previous: RevenueSummaryResult.nullable(),
});
export type RevenueSummaryResponse = z.infer<typeof RevenueSummaryResponse>;

export const TOP_PRODUCTS_LIMIT = 10;

// FR-BIZ-05: top products of paid orders by revenue. Product names are masked like payment reasons (FR-DATA-09).
export const TopProducts = z.object({
  status: z.literal("AVAILABLE"),
  currency: z.string(),
  items: z
    .array(z.object({ product: z.string(), quantity: z.int().nonnegative(), revenue: Decimal }))
    .max(TOP_PRODUCTS_LIMIT),
  provenance: MetricProvenance, // order items joined to paid orders
});
export type TopProducts = z.infer<typeof TopProducts>;

export const TopProductsResult = z.discriminatedUnion("status", [TopProducts, Unavailable]);
export type TopProductsResult = z.infer<typeof TopProductsResult>;

export const TopProductsResponse = z.object({
  current: TopProductsResult,
  previous: TopProductsResult.nullable(),
});
export type TopProductsResponse = z.infer<typeof TopProductsResponse>;
