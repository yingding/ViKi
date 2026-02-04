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

### VoiceLive Manual Test

This test verifies the Realtime Voice AI integration, including bilateral audio (microphone input / speaker output), function calling (weather tool), and barge-in capabilities.

**Prerequisites:**
1. **Install SoX** (Required for audio interaction):
   ```powershell
   winget install -e --id ChrisBagwell.SoX
   ```
   *After installation, restart your terminal.*

2. **Microphone Setup (Windows)**:
   - Ensure "Microphone access" is **ON** in Windows Privacy settings.
   - Ensure your desired microphone is set as the **Default Recording Device** in Sound Settings.

**Running the Test:**

Run the PowerShell helper script from the `backend/functions` directory:

```powershell
cd backend/functions;
.\test\run_test.ps1
```

**Interaction Guide:**
1. **Start**: The script will connect to the VoiceLive session.
2. **Speak**: The AI uses Server VAD (Voice Activity Detection). Just start speaking when you see the logs.
   - *Example: "Hello ViKi, what can you do?"*
   - *Example: "What is the weather in Seattle?"* (Triggers the `get_weather` tool)
3. **Listen**: The AI response will be played through your default speakers (via SoX) and logged to the console.
4. **Barge-in**: You can interrupt the AI while it is speaking by talking. The playback will stop immediately, and the AI will listen to your new input.
5. **Stop**: Press `Ctrl+C` to exit cleanly.

**Output:**
- Received audio is saved to `backend/functions/test/output_audio.pcm`.
- Session logs (including tool calls and transcripts) are printed to the console.
