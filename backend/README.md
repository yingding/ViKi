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
   
   Use the following example to retrieval the last message send to the bot. Both the `convId` and `msgId` are set to `0`, so that all the conversation and message are retrieved for the bot user.
   ```powershell
   Invoke-RestMethod -Uri "http://localhost:7071/api/netsfere/webhook" `
     -Method Post `
     -Headers @{ "Content-Type" = "application/json" } `
     -Body '{"convId":0,"msgId":0}'
   ```
   The "senderEmail" must be the user email you want to fetch msg or ignore it.

> Ensure `local.settings.json` contains temporary NetSfere credentials and a Service Bus connection string for local testing only.

## netsfere client sample
```powershell
$body = @{
    email    = "botdo@xxxx"
    password = "xxxxx"
    convId    = "0"
    msgId    = "0"
}

Invoke-RestMethod -Uri "https://api.netsfere.com/get" `
    -Method Post `
    -Body $body
```
Note:`
* use `web.netsfere.com` to see the convID from the webbrowser, or use `convId="0"` and `msgId="0"` to get all the messages for the user with given email.


Use Voice Live API JavaScript Preview SDK:
* https://learn.microsoft.com/en-us/javascript/api/overview/azure/ai-voicelive-readme?view=azure-node-preview#models-and-capabilities
* https://github.com/MicrosoftDocs/azure-docs-sdk-node/blob/main/docs-ref-services/preview/ai-voicelive-readme.md

```
npm install @azure/ai-voicelive @azure/identity
npm install --save-dev @azure/ai-voicelive @azure/identity
```

## Run tests
```
cd backend/functions
npx tsx test/manual_test_voicelive.ts
```

## Install sox
```
WARNING: 'sox' command not found in PATH.
 The 'mic' library requires SoX on Windows/Mac or ALSA on Linux.
 Microphone recording will be DISABLED.
 To enable, install SoX (http://sox.sourceforge.net/) and add to PATH.
```

```
winget install -e --id ChrisBagwell.SoX
```