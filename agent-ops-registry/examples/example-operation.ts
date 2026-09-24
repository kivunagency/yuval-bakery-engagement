import { z } from "zod";
import { defineOperation } from "../lib/operations/types";
import { ok, fail } from "../lib/result";

/**
 * ============================================================================
 *  EXAMPLE: one business operation, annotated
 * ============================================================================
 *
 * Copy this shape for every operation you add. The metadata is not decoration:
 * `description`, `permission`, `roles`, and `requiresConfirmation` are what the
 * agent and the dispatcher actually act on.
 */
export const recordRentPayment = defineOperation({
  name: "recordRentPayment",

  title: "Record Rent Payment",

  /**
   * The agent chooses tools by reading this. Say what it does, what it needs,
   * and what comes back. Name the prerequisite explicitly when one exists.
   *
   * Bad:  "Records a payment."
   * Good: the text below.
   */
  description:
    "Record a rent payment against a property and compute the management commission. " +
    "Requires the propertyId (from searchProperties), the amount in agorot, and the payment date. " +
    "Returns the created payment record and the updated balance. " +
    "Destructive: writes to the ledger and cannot be undone by the agent.",

  permission: "write",

  /** Least privilege. A viewer must not be able to move money. */
  roles: ["operator", "admin"],

  /**
   * Financial and destructive operations set this. The dispatcher and the UI
   * enforce it. Never rely on prompt text alone to make an agent ask first.
   */
  requiresConfirmation: true,

  /** Places the operation in the tree that `explore` walks. */
  module: "properties.payments",

  /** Writes default to false. Leave it. */
  parallelSafe: false,

  /**
   * Money in the smallest unit, as an integer. Never floats for currency.
   * Zod is the single validation point: the dispatcher runs this before your
   * handler ever sees the input, so the handler can trust its arguments.
   */
  inputSchema: {
    propertyId: z.string().min(1).describe("Property identifier, e.g. '872-2358'."),
    amountAgorot: z.number().int().positive().describe("Amount received, in agorot (1 ILS = 100)."),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Payment date, ISO YYYY-MM-DD."),
    commissionPct: z.number().min(0).max(100).optional().describe("Override the default commission percentage."),
    note: z.string().max(500).optional().describe("Free-text note for the audit trail."),
  },

  async handler(input, ctx) {
    // ctx.userId / ctx.tenantId are server-derived. NEVER read identity from
    // `input`: an agent can be talked into sending any value it is told to.
    const property = await db.property.findFirst({
      where: { id: input.propertyId, tenantId: ctx.tenantId },
    });

    // Return the SAME error whether the row is missing or belongs to another
    // tenant. A distinguishable "forbidden" leaks that the id exists.
    if (!property) {
      return fail("NOT_FOUND", `Property '${input.propertyId}' was not found.`);
    }

    const commissionPct = input.commissionPct ?? property.defaultCommissionPct;
    const commissionAgorot = Math.round((input.amountAgorot * commissionPct) / 100);

    const payment = await db.payment.create({
      data: {
        tenantId: ctx.tenantId,
        propertyId: property.id,
        amountAgorot: input.amountAgorot,
        commissionAgorot,
        paidOn: input.paidOn,
        note: input.note,
        recordedBy: ctx.userId,
      },
    });

    // Return what the agent needs to confirm success and nothing more. Every
    // field here is re-read by the model on later turns, so extra data is a
    // recurring token cost and a needless disclosure.
    return ok({
      paymentId: payment.id,
      propertyId: property.id,
      amountAgorot: payment.amountAgorot,
      commissionAgorot,
      balanceAgorot: property.balanceAgorot - input.amountAgorot,
    });
  },
});

// Placeholder so this example type-checks in isolation. Delete in a real project.
declare const db: any;
