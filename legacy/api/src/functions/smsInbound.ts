import { app, InvocationContext, EventGridEvent } from "@azure/functions";
import { query, HOUSEHOLD_ID } from "../lib/db.js";
import { parseAttendanceReply } from "../lib/reply-parser.js";

// Handles "Microsoft.Communication.SMSReceived" events from ACS via Event Grid.
interface SmsReceivedData {
  from: string;
  to: string;
  message: string;
  receivedTimestamp?: string;
}

async function smsInbound(event: EventGridEvent, ctx: InvocationContext): Promise<void> {
  if (event.eventType !== "Microsoft.Communication.SMSReceived") {
    ctx.log(`Ignoring event type ${event.eventType}`);
    return;
  }
  const data = event.data as unknown as SmsReceivedData;

  await query(
    `INSERT INTO sms_log (direction, from_number, to_number, body, status)
     VALUES ('inbound', $1, $2, $3, 'received')`,
    [data.from, data.to, data.message],
  );

  const response = parseAttendanceReply(data.message);
  if (response === "pending") {
    ctx.log(`Could not parse reply from ${data.from}: "${data.message}"`);
    return;
  }

  // Match the sender to a member and update today's attendance.
  const { rowCount } = await query(
    `UPDATE attendance_response ar
        SET response = $1, responded_at = now()
       FROM family_member fm, meal_event me
      WHERE ar.member_id = fm.id
        AND ar.meal_event_id = me.id
        AND me.household_id = $2
        AND me.date = CURRENT_DATE
        AND fm.phone_e164 = $3`,
    [response, HOUSEHOLD_ID(), data.from],
  );

  if (!rowCount) {
    ctx.log(`No matching member/event for ${data.from}`);
    return;
  }

  // Recompute headcount = count of 'yes' responses.
  await query(
    `UPDATE meal_event me
        SET headcount = (
          SELECT COUNT(*) FROM attendance_response ar
           WHERE ar.meal_event_id = me.id AND ar.response = 'yes')
      WHERE me.household_id = $1 AND me.date = CURRENT_DATE`,
    [HOUSEHOLD_ID()],
  );

  ctx.log(`Recorded "${response}" from ${data.from}`);
}

app.eventGrid("smsInbound", {
  handler: smsInbound,
});
