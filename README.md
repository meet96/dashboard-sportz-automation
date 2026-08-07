# dashboard-sportz-automation

Scoring microservice for dashboard-sportz. Owns cricket (Cricbuzz) and football (ESPN)
scoring logic, exposes an authenticated HTTP API, and runs a scheduled job that detects
finished matches and scores them automatically.

## Environment variables (set in Railway project settings)

| Variable | Description |
|---|---|
| `MONGODB_URI` | Same MongoDB cluster/database as the main `dashboard-sportz` app |
| `CRICBUZZ_API_KEY` | Same RapidAPI key as the main app's `.env` |
| `CRICBUZZ_API_HOST` | `cricbuzz-cricket.p.rapidapi.com` |
| `API_KEY_MAIN_APP` | Bearer key the main app uses to call this service |
| `API_KEY_MOBILE` | Reserved for a future mobile app caller |
| `AGENDASH_USER` / `AGENDASH_PASSWORD` | Basic-auth credentials for `/admin/jobs` |
| `PORT` | Railway sets this automatically |

## Local development

```bash
npm install
cp .env.example .env   # fill in real values
npm run dev
```

## API

All routes require `Authorization: Bearer <API_KEY_*>`.

- `POST /matches/:id/score/classic`
- `POST /matches/:id/score/fantasy11`
- `POST /matches/:id/score/football`
- `POST /matches/:id/score/football-classic`

## Ops UI

`/admin/jobs` (Agendash) — job history, next scheduled run, manual "run now".
