import { app, InvocationContext, Timer } from "@azure/functions";
import { query, HOUSEHOLD_ID } from "../lib/db.js";
import { sendSms } from "../lib/acs.js";

// Runs daily. NCRONTAB is UTC; adjust for the household timezone as needed.
// "0 0 15 * * *" = 15:00 UTC every day.
async function dinnerPoll(_timer: Timer, ctx: InvocationContext): Promise<void> {
  const household = HOUSEHOLD_ID();

  // Create (or reuse) today's meal event.
  const { rows: eventRows } = await query(
    `INSERT INTO meal_event (household_id, date, status)
     VALUES ($1, CURRENT_DATE, 'polling')
     ON CONFLICT (household_id, date) DO UPDATE SET status = meal_event.status
     RETURNING id`,
    [household],
  );
  const eventId = eventRows[0]?.id as string;

  // Active members to poll.
  const { rows: members } = await query(
    `SELECT id, name, phone_e164 AS "phoneE164" FROM family_member
      WHERE household_id = $1 AND active = TRUE`,
    [household],
  );

  for (const m of members) {
    await query(
      `INSERT INTO attendance_response (meal_event_id, member_id, response)
       VALUES ($1,$2,'pending')
       ON CONFLICT (meal_event_id, member_id) DO NOTHING`,
      [eventId, m.id],
    );
    try {
      await sendSms(
        m.phoneE164 as string,
        `Hi ${m.name}! Are you home for dinner tonight? Reply Y or N.`,
      );
    } catch (err) {
      ctx.error(`Failed to SMS ${m.name}:`, err);
    }
  }

  ctx.log(`Dinner poll sent to ${members.length} members for event ${eventId}`);
}

app.timer("dinnerPoll", {
  schedule: "0 0 15 * * *",
  handler: dinnerPoll,
});
