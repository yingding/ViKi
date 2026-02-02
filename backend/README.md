# Backend

Azure Functions codebase that ingests NetSfere consults and forwards them to downstream processing components.

## Structure

- `functions/src/functions/netsfereWebhook.ts` — HTTP endpoint registered as the NetSfere webhook target.
- `functions/src/lib` — shared utilities (environment validation, NetSfere API client, Service Bus helpers).

## Local Development

1. Install dependencies:
   ```
   cd backend/functions
   npm install
   ```
2. Run the build to emit JavaScript into `dist/`:
   ```
   npm run build
   ```
3. Start the Azure Functions host:
   ```
   npm start
   ```
4. Use a tool like `curl` to POST sample webhook payloads:
   In Bash:
   ```bash
   curl -X POST http://localhost:7071/api/netsfere/webhook \
     -H "Content-Type: application/json" \
     -d '{"convId":27848,"msgId":212619,"senderEmail":"physician@example.com"}'
   ```
   or Powershell
   ```powershell
   Invoke-RestMethod -Uri "http://localhost:7071/api/netsfere/webhook" `
     -Method Post `
     -Headers @{ "Content-Type" = "application/json" } `
     -Body '{"convId":27848,"msgId":212619,"senderEmail":"physician@example.com"}'
   ```

> Ensure `local.settings.json` contains temporary NetSfere credentials and a Service Bus connection string for local testing only.
