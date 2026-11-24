import { Router, type Request, type Response } from "express";
import { establishDevSession, normalizePhone, verifyDevOtp } from "../lib/dev-auth";
import { type VerifyOtpPayload } from "../types/intake";

// Mounted only when lib/dev-auth reports the bridge enabled. In production the
// route does not exist at all rather than existing and refusing, so there is
// nothing to misconfigure into service. See lib/dev-auth.ts for why this is not
// authentication.
export const devAuthRouter = Router();

devAuthRouter.post("/verify-otp", async (req: Request, res: Response) => {
  const { phone, code } = req.body as Partial<VerifyOtpPayload>;

  if (!phone || !code) {
    res.status(400).json({ error: "missing_phone_or_code" });
    return;
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  // The decision is made here and nowhere else. A caller cannot assert that a
  // code was checked, and nothing about the request other than the phone
  // influences which identity is returned.
  if (!verifyDevOtp(code)) {
    res.status(401).json({ error: "invalid_code" });
    return;
  }

  try {
    const session = await establishDevSession(normalized);
    res.status(200).json(session);
  } catch (error) {
    // Message only — it is written to carry no token or address.
    console.error("dev auth session failed:", (error as Error).message);
    res.status(502).json({ error: "session_unavailable" });
  }
});
