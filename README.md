# ViKi – Virtual Kinderklinik MVP

Minimal viable product for a virtual pediatric clinic that ingests secure NetSfere consults and provides a specialist-facing portal to review and respond.

## Repos Structure

| Path | Description |
| --- | --- |
| `infra/` | Bicep templates for Azure resources (Functions, Service Bus, Key Vault, Storage, App Insights). |
| `backend/` | Azure Functions TypeScript app handling NetSfere webhooks and queueing consults. |
| `frontend/` | Next.js specialist portal MVP. |
| `docs/` | Architecture notes and operational guidance. |

## Quickstart

1. **Provision Infrastructure**
   - Update `infra/main.bicep` parameters with your environment details.
   - Deploy via `az deployment group create ...` as outlined in `infra/README.md`.
2. **Configure NetSfere**
   - Enable API + webhook for the bot identity (e.g., `botdo@sweethomeonline.de`).
   - Point the webhook to `https://<function-app>.azurewebsites.net/api/netsfere-webhook`.
3. **Run Backend Locally**
   <!-- used npm start to start azurite storage emulator and func start
   Start `Azurite`
   ```powershell
   # $ProjPath is the subpath from USERPROFILE to the current virtual clinic repository
   $ProjPath="Documents\VCS\pocs\virtualclinic";
   azurite --silent --location $env:USERPROFILE\$ProjPath --debug $env:USERPROFILE\$ProjPath\debug.log;
   ```
   -->
   
   Create a `local.settings.json` in `backend/functions` folder to save the config for backend.
   ```
   cd backend/functions
   npm install
   npm run build
   npm start
   ```
4. **Run Specialist Portal**
   ```
   cd frontend/portal
   npm install
   npm run dev
   ```

### Start All Services (One-Click)
Start both Backend (Functions + Azurite) and Frontend (Next.js) with a single script:
```powershell
.\start_project.ps1
```
*Note: This script automatically configures the backend for HTTPS (required for voice streaming) and enables Mock Voice mode by default.*

#### Troubleshooting Voice Connectivity
If you see connection errors when starting a voice session:
1. Ensure the backend is running on **HTTPS** (Port 7071).
2. Visit `https://localhost:7071/api/consults` in your browser.
3. Accept the self-signed certificate warning ("Proceed to localhost (unsafe)").
4. Restart the session in the portal.

## Next Steps
- Replace mock data in the portal with a REST endpoint sourcing Service Bus output.
- Add attachment ingestion + storage binding in the backend.
- Integrate Azure Speech + GPT-4o for real-time conversational reviews.
- Harden credential management by sourcing NetSfere secrets from Key Vault.

## Netsfere api doc
* netsfere api doc: https://api.netsfere.com

## Manual Installation
```
npm install --save-dev azurite
```

