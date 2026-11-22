# Windows kiosk setup

> **Status: preliminary.** Full kiosk deployment is **Phase 6** and is not
> built. What follows is verified-where-marked development setup plus a
> hardening checklist. Nothing here has been tested on the target 10-inch
> hardware, because that hardware has not been available to this work. Treat
> every item marked *unverified* as a task, not an instruction that is known
> to work.

## Development setup (verified on Node 22.23.5)

```powershell
cd "C:\Users\User\Desktop\coffee-ordering-kiosk"
node -v            # must be 22.x or newer
npm.cmd install
```

Set the till passwords before first run. Without them, development builds
create accounts with **known default passwords** and warn loudly on every boot.

```powershell
$env:POS_MANAGER_PASSWORD = "choose-something-long"
$env:POS_BARISTA_PASSWORD = "choose-something-else"
$env:STAFF_PIN = "654321"          # Version 3 app only
```

Then either app:

```powershell
npm.cmd run dev            # Version 3 app  → http://localhost:5173 + API on 3001
npm.cmd run dev:platform   # Phase 1 platform → http://localhost:4001
npm.cmd run dev:all        # all three together
```

| What | URL |
|---|---|
| Kiosk menu API | `http://localhost:4001/api/kiosk/menu` |
| Kiosk health | `http://localhost:4001/api/kiosk/health` |
| **Demo POS staff console** | `http://localhost:4001/demo-pos/` |
| Version 3 customer UI | `http://localhost:5173` |

In Git Bash use `/c/Users/User/Desktop/coffee-ordering-kiosk` and `npm`; in
PowerShell use the Windows path and `npm.cmd`. Do not mix the two.

## Target hardware baseline

| Item | Requirement |
|---|---|
| Machine | Windows mini PC, x86-64 |
| Memory | 8 GB |
| Storage | 128 GB SSD |
| Display | 10" landscape primary; also 10" portrait and 27" portrait |
| Ports | USB for the card reader and receipt printer |
| Network | Ethernet preferred, Wi-Fi fallback |

## Browser kiosk mode — *unverified*

Microsoft Edge in `--kiosk` mode:

```powershell
start msedge --kiosk "http://localhost:4001" --edge-kiosk-type=fullscreen --no-first-run
```

> **F11 fullscreen is not a lockdown.** The existing README suggests F11 for
> development; that is fine for a demo on a desk and is **not** adequate for a
> machine the public can touch. A customer can leave the page, open a new tab,
> reach the file system, or close the browser. Real lockdown needs Windows
> **Assigned Access** (kiosk mode) with a dedicated local account, plus policy
> to disable keyboard shortcuts, the on-screen keyboard where not needed,
> Ctrl+Alt+Del options and USB autorun. None of this is configured or tested.

## Still to do in Phase 6

- Auto-start on boot and automatic restart after a browser or app crash
- Windows Assigned Access configuration, tested against someone trying to escape it
- Kiosk registration with a one-time provisioning code, then config pull
- Fleet dashboard: heartbeat, app version, POS sync health, printer and terminal state
- Staged update and rollback
- TLS for anything not on `localhost`; the kiosk API currently binds `0.0.0.0`
  over plain HTTP, which is acceptable only on a trusted local network
- Explicit per-store offline policy: safe queuing with paid-order recovery, or
  kiosk marked unavailable
- Performance measurement against the brief's targets, which are currently
  **stated goals, not measured results**

## Known deployment gaps today

| Gap | Consequence |
|---|---|
| No HTTPS | Credentials and order data travel in clear on the LAN. Local demo only. |
| `/api/kiosk/*` is unauthenticated | Correct for a customer kiosk, but anyone on the network can place orders. Needs network isolation or kiosk identity. |
| Rate limiting is per-process, in memory | Restarting the API clears it. |
| `node:sqlite` is flagged experimental | Prints a warning; a future Node release could change behaviour. |
| Dev passwords exist if the env vars are unset | The app warns on every boot and refuses to start in production without them. |
