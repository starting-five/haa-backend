import express from "express";
import cors from "cors";
import { intakeRouter } from "./routes/intake";
import { caseRouter } from "./routes/case";
import { portalRouter } from "./routes/portal";
import { agreementsRouter } from "./routes/agreements";
import { devAuthRouter } from "./routes/dev-auth";
import { ambassadorsRouter } from "./routes/ambassadors";
import { patientRouter } from "./routes/patient";
import { getBuildInfo } from "./lib/build-info";
// Imported unconditionally so the production fail-closed guard runs at boot.
import { isDevOtpBridgeEnabled } from "./lib/dev-auth";

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow all localhost origins in any environment, restrict to FRONTEND_URL in production
      if (!origin) return callback(null, true); // same-origin or non-browser requests
      if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
        return callback(null, true);
      }
      if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Which build is running here. Infrastructure like /health, so it sits beside
// it rather than in a domain router: no session, no database, no git — the
// version and commit are baked into the image and the environment comes from
// deployment configuration.
app.get("/version", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(getBuildInfo());
});

app.use("/intake", intakeRouter);
app.use("/intake", agreementsRouter);

// Development-only. Absent entirely unless explicitly enabled outside production.
if (isDevOtpBridgeEnabled()) {
  app.use("/intake", devAuthRouter);
}
app.use("/case", caseRouter);
app.use("/patient", patientRouter);
app.use("/portal", portalRouter);
app.use("/ambassadors", ambassadorsRouter);

export { app };
