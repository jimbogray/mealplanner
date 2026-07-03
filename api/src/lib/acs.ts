import { SmsClient } from "@azure/communication-sms";
import { query } from "./db.js";

let client: SmsClient | undefined;

function getClient(): SmsClient {
  if (!client) {
    const conn = process.env.ACS_CONNECTION_STRING;
    if (!conn) throw new Error("ACS_CONNECTION_STRING is not set");
    client = new SmsClient(conn);
  }
  return client;
}

/** Send an SMS via Azure Communication Services and log it. */
export async function sendSms(to: string, body: string): Promise<void> {
  const from = process.env.ACS_FROM_NUMBER;
  if (!from) throw new Error("ACS_FROM_NUMBER is not set");

  const [result] = await getClient().send({ from, to: [to], message: body });

  await query(
    `INSERT INTO sms_log (direction, from_number, to_number, body, acs_message_id, status)
     VALUES ('outbound', $1, $2, $3, $4, $5)`,
    [from, to, body, result?.messageId ?? null, result?.successful ? "sent" : "failed"],
  );

  if (!result?.successful) {
    throw new Error(`SMS to ${to} failed: ${result?.errorMessage ?? "unknown error"}`);
  }
}
