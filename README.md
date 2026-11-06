# CampusConnect

CampusConnect is a local presentation prototype for discovering university events and managing event registrations. It uses fictional demo accounts and sample events, and is not connected to a university service.

## Run locally

Requirements: Node.js 20.19 or newer and npm.

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite server proxies API requests to the local Express server on port 3001. SQLite data is stored in `data/campusconnect.sqlite`.

Demo sign-in:

| Role | Email | Password |
|---|---|---|
| Student | `student@campusconnect.test` | `CampusDemo!2026` |
| Organizer | `organizer@campusconnect.test` | `CampusDemo!2026` |

New accounts must provide a name, fictional email address ending in `.test`, faculty, course, password, and matching password confirmation. The local one-time Organizer invitation is `local-organizer-invite`. Set `ORGANIZER_INVITE_CODE` before starting the API to use a different local invitation.

## Checks

```powershell
npm run typecheck
npm test
npm run build
npm run lint
```

## Data and integrations

- Events, registrations, and room bookings are stored locally in SQLite. Included sample events and account data are fictional.
- `data/rooms.json` is intentionally empty. Room allocation remains unconfigured until an administrator enters verified room details. Do not enter unverified venue facts.
- In-app notifications are stored locally. Web Push and SMS are not configured, and no external messages are sent.
- Attendance check-in is available for registered students at in-person and hybrid events while the event is underway. The organizer opens and closes attendance; opening requires their device location and sets a 100 m check-in radius. Student location is checked for the request and not stored. Each check-in keeps the student's name, email, faculty, course, and check-in time for future reference, visible to that event's organizer. The room inventory has no verified coordinates yet, so the opening location is the temporary location reference.
- Dates are presented in the `Africa/Nairobi` time zone.
- Signup, Organizer invitations, and local authentication are for this presentation prototype only. Do not use real student identities, passwords, production data, or deploy this as a university service.
