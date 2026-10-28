import { z } from "zod";

// FR-NTF-01/02/04/05/06, FR-INB-01: verified events → one deduplicated in-app notification each.
// Text is built from facts only (truth hierarchy): "done" means the matching terminal state, never agent narration.

export const NotificationCategory = z.enum([
  "INFORMATIONAL",
  "TASK_DONE",
  "TASK_FAILED",
  "APPROVAL_REQUIRED",
  "BUSINESS_EXCEPTION",
  "SECURITY_CRITICAL",
]);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

export const NotificationStatus = z.enum(["UNREAD", "READ", "ACKNOWLEDGED"]);
export type NotificationStatus = z.infer<typeof NotificationStatus>;

export const Notification = z.object({
  id: z.uuid(),
  // null only for owner-wide notices (e.g. runner revoked, emergency stop).
  projectId: z.uuid().nullable(),
  category: NotificationCategory,
  title: z.string().max(200),
  // Redacted, no secrets / customer data; safe for a future lock-screen push (FR-CSP-03).
  body: z.string().max(1000),
  // Deep link target: the exact object that caused it (FR-NTF-06/08).
  subject: z.object({
    jobId: z.uuid().nullable(),
    approvalId: z.uuid().nullable(),
    incidentId: z.uuid().nullable().optional(), // EPIC MON incidents (P1)
  }),
  status: NotificationStatus,
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof Notification>;

export const ListNotificationsQuery = z.object({
  status: NotificationStatus.optional(),
  category: NotificationCategory.optional(),
  projectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const NotificationList = z.object({
  items: z.array(Notification),
  unreadCount: z.int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationList>;

// POST /v1/notifications/:id/status
export const SetNotificationStatusRequest = z.strictObject({
  status: NotificationStatus.exclude(["UNREAD"]),
});
export type SetNotificationStatusRequest = z.infer<typeof SetNotificationStatusRequest>;
