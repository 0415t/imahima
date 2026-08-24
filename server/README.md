# Node.js API server

## Setup

Copy `.env.example` to `.env` and set the server-only Supabase values.

```powershell
Copy-Item server/.env.example server/.env
npm run server
```

Health check: `http://localhost:3000/health`

`SUPABASE_SERVICE_ROLE_KEY` must only be used by this server. Never put it in the Expo app or commit it to Git.
