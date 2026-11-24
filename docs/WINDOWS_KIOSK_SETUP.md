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

## Screen orientation

### Target hardware

Samsung DB10E-T (`LH10DBEPTGC`), 10.1 inch, **1280 x 800**, display area
217.0 mm x 135.6 mm, driven over HDMI from the Windows mini PC.

That works out to 5.90 px/mm, so the 9 mm minimum touch target is **53 px**.
Interactive controls are set to 54 px in portrait and on small screens.

| Target            | Resolution  | Notes                                   |
|-------------------|-------------|-----------------------------------------|
| 10.1" landscape   | 1280 x 800  | native orientation                      |
| 10.1" portrait    | 800 x 1280  | panel physically rotated 90 degrees     |
| 27" portrait      | 1080 x 1920 | larger type, controls kept low for reach |

### Testing orientation without rotating hardware

Chrome DevTools is far quicker than rotating a panel for every CSS change:

1. `npm run dev`, open the kiosk in Chrome
2. `F12`, then `Ctrl+Shift+M` for device toolbar
3. Choose **Responsive** and type the resolution: `800 x 1280`
4. The rotate button beside the dimensions flips orientation

In development only, `?screen=menu` and `?lang=ar` jump straight to a screen
and language, so styling does not mean clicking through the flow each time.
Valid screens: `welcome`, `menu`, `customize`, `cart`, `checkout`. These
query parameters are stripped from production builds by `import.meta.env.DEV`
and do nothing in a deployed kiosk.

### Rotating the real display (Windows)

The HDMI display rotates independently of the laptop screen:

1. **Settings > System > Display**
2. Click the box representing the Samsung panel, not the built-in screen
3. Set **Display orientation** to **Portrait** (or *Portrait (flipped)*,
   depending which way the panel is physically turned)
4. Keep the built-in laptop screen on **Landscape** — only the selected
   display changes

The panel must also be physically mounted at 90 degrees. Rotating in Windows
only rotates the signal.

Verify the kiosk fills the panel: the browser must be fullscreen on that
display (`F11`, or Edge kiosk mode as described above), not on the laptop
screen.


## Adaptive layout

The kiosk does not target a list of devices. Layout is derived from the space
available, so an unlisted screen size is not a special case:

- **Product grid** uses `repeat(auto-fit, minmax(min(258px, 100%), 1fr))`.
  The column count follows the width: 2 columns at 600px, 3 at 800px, 4 at
  1280px and above. Nothing names a device.
- **Product photos** use `aspect-ratio` rather than a pixel height, so a photo
  scales with the card it sits in.
- **Type and spacing** use `clamp()`, so they scale continuously instead of
  jumping at a breakpoint.
- **Two-pane screens** (customize, checkout) are wrapping flex rows with a
  minimum basis; they fold to one column when there is no room for two,
  whatever the viewport happens to be.

### What "adaptive" means here

Rotating a panel changes **how many items fit on a row, and nothing else**.
A product card is one fixed width and its text is one fixed size, in both
orientations:

| Viewport    | Card width | Cards per row |
|-------------|-----------|----------------|
| 1280 x 800  | 272px     | 4              |
| 800 x 1280  | 272px     | 2              |
| 1080 x 1920 | 430px     | 2              |

This is why the grid uses `repeat(auto-fit, min(var(--card-width), 100%))`
with `justify-content: center`, not `minmax(..., 1fr)`. A `1fr` maximum
stretches tracks to fill the row, which would make a portrait card 351px
against a landscape card's 274px — same font, different card.

Card text is deliberately **not** sized in `vw`. Viewport units change with
orientation, so a `clamp(17px, 1.35vw, 22px)` heading shrinks when the same
physical screen is turned on its side.

### Units

No pixels and no viewport units anywhere in the layout.

- **`rem` for everything** — type, spacing, radii, touch targets, card
  width. `rem` is relative to the root font size, so the whole interface
  scales from one value, and unlike `vw` it does not change when the same
  physical panel is rotated.
- **`px` appears once**, on `html { font-size: 16px }`. That is the anchor
  every other size is measured against.
- **`vh` only where height genuinely is the constraint** — the welcome hero,
  which should fill a tall panel rather than a wide one.

The 27-inch panel is read from further away, so it raises the root size to
`20px` and everything follows: type, padding, touch targets, card width and
gaps, in the same proportions as the 10-inch. That replaced about thirty
individual overrides.

### Tuning

| Want | Change |
|------|--------|
| Whole interface bigger or smaller | `html { font-size }` |
| More or fewer cards per row | `--card-width` on `.products-grid` |

`--card-width: 17rem` gives 4 per row at 1280x800 and 2 at 800x1280.
About `14rem` gives 4 and 3.

Touch targets never drop below 44px and reach 54px on the kiosk panels; the
9mm minimum on the DB10E-T is 53px.

## Running full screen with no browser UI

### Quickest

Click the kiosk page and press **F11**. That hides the tabs, address bar and
the Windows taskbar together. Press F11 again to leave.

### Proper kiosk mode

```
scripts\start-kiosk.cmd
```

Opens Edge (or Chrome) with `--kiosk`: no tabs, no address bar, no menu,
nothing a customer can touch. Exit with **Alt+F4**.

Pass a different address if needed:

```
scripts\start-kiosk.cmd http://localhost:4173
```

The script uses a throwaway browser profile under `%TEMP%`, so a previous
session's zoom level, cached error page or "restore pages?" prompt cannot
appear in front of a customer.

It only opens the browser. The servers must already be running.

### Known gap: the platform does not serve the built frontend

In development Vite serves the React app on port 5173 and proxies the API
to 4001. The platform itself serves only the API and the Demo POS pages, so
there is currently no way to run the customer kiosk without the Vite dev
server.

That is fine for a demo on a laptop and wrong for a deployed kiosk, which
should run the built assets from `dist/`. Serving `dist/` from the platform
is outstanding work, not a configuration step.
