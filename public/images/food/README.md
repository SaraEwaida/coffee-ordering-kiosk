# Food images

The `.svg` files here are **placeholder illustrations**, drawn for this
repository so the menu is not full of empty boxes. They are not photographs
and are not meant to ship to a client.

## Replacing one with a real photograph

Drop a file with the **same name** beside the drawing:

```
croissant.svg      <- the placeholder
croissant.webp     <- your photograph; this wins automatically
```

Restart the platform and the kiosk uses the photo. No code change and no
configuration: `preferRealPhoto()` in `server/app.js` checks for `.webp`,
`.jpg`, `.jpeg` and `.png` in that order, and falls back to the drawing.

The six coffee photographs already work this way, from `public/images/`.

## Names to use

| File | Item |
|---|---|
| `croissant` | Butter Croissant |
| `manakish` | Za'atar Manakish |
| `muffin` | Chocolate Muffin |
| `sambousek` | Cheese Sambousek |
| `date-cookies` | Date Cookies |
| `nuts` | Mixed Nuts |
| `avocado-toast` | Avocado & Za'atar Toast |
| `yogurt` | Greek Yogurt & Walnuts |
| `energy-balls` | Date & Oat Energy Balls |
| `almond-cake` | Sugar-Free Almond Cake |
| `lemonade` | Fresh Mint Lemonade |

## What to shoot

Roughly 4:3, at least 640×480, lit from the side, plain or wooden background.
`.webp` keeps the kiosk fast; the existing coffee photos are a good reference
for framing.

## Please do not

Take photographs from another café's website or social media. They are that
café's work, and a kiosk being demonstrated to prospective clients is exactly
the wrong place to be showing someone else's pictures. Either photograph the
shop's own food, or buy a stock licence.
