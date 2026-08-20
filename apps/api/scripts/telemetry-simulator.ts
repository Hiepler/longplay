import { setTimeout as wait } from "node:timers/promises";

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({ path: resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env") });

import { simulatedTelemetry } from "@longplay/telemetry";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const token = process.env.SIMULATOR_TOKEN ?? "local-dev-simulator-token";
const destination = process.env.SIMULATOR_DESTINATION ?? "Lago di Garda";

for (let step = 0; step < 24; step += 1) {
  const event = simulatedTelemetry(step, destination);
  const response = await fetch(`${apiBaseUrl}/internal/telemetry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-simulator-token": token
    },
    body: JSON.stringify(event)
  });
  if (!response.ok) {
    throw new Error(`Simulator post failed with ${response.status}`);
  }
  console.log(`telemetry step ${step + 1}: eta=${event.etaMinutes} region=${event.coarseRegion}`);
  await wait(1500);
}
