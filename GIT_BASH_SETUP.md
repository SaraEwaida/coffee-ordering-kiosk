# Update your existing GitHub repository using Git Bash

Repository: https://github.com/SaraEwaida/coffee-ordering-kiosk

1. **Back up** your old project and any data in `server/data` before overwriting code.
2. Download `coffee-ordering-kiosk-v2.zip` and extract it. The archive contains a folder named `coffee-ordering-kiosk` with all code, images and documentation.
3. In Git Bash, open your EXISTING clone:
   ```bash
   cd /c/Users/User/Desktop/coffee-ordering-kiosk
   git status
   ```
   If you have edited local code, commit or back it up first.
4. Copy the extracted v2 files **into that existing cloned folder**. Keep its `.git` directory intact. Never copy an extracted `.git` directory over it.
5. In Git Bash:
   ```bash
   npm install
   npm run dev
   ```
6. Test http://localhost:5173 and the admin/kitchen views. Local demo staff login: `manager` / `123456` for a fresh development DB. Change this PIN using the instructions in README.
7. Push:
   ```bash
   git add .
   git commit -m "Add SQLite database, audit log, card option and QR receipt"
   git push origin main
   ```

If cloning from scratch, `git clone https://github.com/SaraEwaida/coffee-ordering-kiosk.git` first, then copy the downloaded v2 project contents into that clone. The SQLite database and employee PINs are **not** committed to GitHub.
