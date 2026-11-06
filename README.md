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

You can create multiple separate accounts from the Register form. Each needs its own unique fictional email address ending in `.test` and password; signing up signs that account in, and it can be used again from Sign in. Never use a real student identity or email. The local one-time Organizer invitation is `local-organizer-invite`. Set `ORGANIZER_INVITE_CODE` before starting the API to use a different local invitation.

## Checks

```powershell
npm run typecheck
npm test
npm run build
npm run lint
```

## Data and integrations

- Events, registrations, and room bookings are stored locally in SQLite. Included sample events and account data are fictional; sample events show in-person venue labels for Tuition Complex Room 20, Pavilion Grounds, and Amphitheatre.
- `data/rooms.json` is intentionally empty. The sample venue labels are for presentation only; room allocation remains unconfigured until an administrator enters verified room details and booking data.
- In-app notifications are stored locally. Web Push and SMS are not configured, and no external messages are sent.
- Dates are presented in the `Africa/Nairobi` time zone.
- Signup, Organizer invitations, and local authentication are for this presentation prototype only. Do not use real student identities, passwords, production data, or deploy this as a university service.
