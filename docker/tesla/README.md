# Tesla Fleet Telemetry Notes

This directory is reserved for local Tesla Fleet Telemetry configuration files
that should not be committed, such as generated keys and vehicle-specific
configuration.

The streaming stack expects the official Tesla Fleet Telemetry reference server
to dispatch records into Mosquitto/MQTT:

- Broker: `mqtt://localhost:1883` locally or `mqtt://mosquitto:1883` inside Coolify.
- Topic base: `tesla/telemetry`; Tesla's MQTT dispatcher publishes fields below
  `tesla/telemetry/<VIN>/v/<field_name>`.
- Backend env: `TESLA_TELEMETRY_ENABLED=true`.
- Vehicle Command Proxy config lives under `docker/tesla/vehicle-command/` when using the optional
  local compose profile:
  - `fleet-key.pem` — private command-auth key used to sign Fleet Telemetry config.
  - `tls-cert.pem` / `tls-key.pem` — internal TLS cert/key for `tesla/vehicle-command` on port `4444`.
  - `telemetry_config.json` — optional local signing dry-run input for `tesla-jws`.

For local work without a vehicle, use:

```bash
npm run telemetry:sim -w @longplay/api
```

The simulator emits the same normalized event shape used by the backend.
