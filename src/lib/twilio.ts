import { normalizePhone } from "./phone";

const TWILIO_REQUIRED_VARS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

interface TwilioSendResult {
  sid: string;
}

export function loadTwilioConfig(env: NodeJS.ProcessEnv = process.env): TwilioConfig {
  const missing = TWILIO_REQUIRED_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing Twilio env vars: ${missing.join(", ")}`);
  }

  const fromNumber = normalizePhone(env.TWILIO_FROM_NUMBER);
  if (!fromNumber) {
    throw new Error("TWILIO_FROM_NUMBER must be E.164, for example +14075551234");
  }

  return {
    accountSid: env.TWILIO_ACCOUNT_SID!.trim(),
    authToken: env.TWILIO_AUTH_TOKEN!.trim(),
    fromNumber,
  };
}

export function isTwilioConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadTwilioConfig(env);
    return true;
  } catch {
    return false;
  }
}

export async function sendTwilioSms(to: string, body: string, env: NodeJS.ProcessEnv = process.env): Promise<TwilioSendResult> {
  const config = loadTwilioConfig(env);
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    throw new Error("recipient phone must be E.164, for example +14075551234");
  }

  const payload = new URLSearchParams({
    To: normalizedTo,
    From: config.fromNumber,
    Body: body,
  });

  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload,
  });

  const json = (await response.json().catch(() => ({}))) as {
    sid?: string;
    message?: string;
    code?: number;
  };

  if (!response.ok || !json.sid) {
    const reason = [json.message, typeof json.code === "number" ? `code ${json.code}` : ""]
      .filter((value) => Boolean(value))
      .join(" - ");
    throw new Error(`Twilio SMS send failed (${response.status})${reason ? `: ${reason}` : ""}`);
  }

  return { sid: json.sid };
}