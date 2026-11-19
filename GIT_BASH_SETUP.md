# Push this project to GitHub using VS Code 1.147 + Git Bash

Repository: https://github.com/SaraEwaida/coffee-ordering-kiosk.git

## 1. Clone your repository
In VS Code, open Terminal → New Terminal, choose **Git Bash**, then:

```bash
cd "/c/Users/YOUR_WINDOWS_USERNAME/Documents"
git clone https://github.com/SaraEwaida/coffee-ordering-kiosk.git
cd coffee-ordering-kiosk
```

Replace `YOUR_WINDOWS_USERNAME` with your own Windows username, or use any folder you prefer. If you already cloned it, open that existing folder instead and run `git pull` before copying changes.

## 2. Copy the project files
Extract the downloaded ZIP and copy its **contents** (`src`, `public`, `shared`, `server`, `package.json`, etc.) into your freshly cloned `coffee-ordering-kiosk` folder.

Do **not** replace or delete the clone's hidden `.git` folder.

## 3. Install and run

```bash
npm install
npm run dev
```

Customer: http://localhost:5173
Kitchen: http://localhost:5173/?view=kitchen
Admin: http://localhost:5173/?view=admin

Node.js 22 or newer is required.

## 4. Upload your changes
Run these commands inside the cloned `coffee-ordering-kiosk` folder:

```bash
git status
git add .
git commit -m "Add complete coffee kiosk pages and photos"
git push origin main
```

If Git says there is nothing to commit, your files are already committed. If the branch is not `main`, check `git branch --show-current` and push the appropriate branch.
