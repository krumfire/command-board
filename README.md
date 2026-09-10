# Command Board — ICS Incident Management

A field tool for running incident command on structure, wildland, hazmat,
and all-hazard incidents against the FEMA/NIMS ICS model: ICS-201 briefing,
resource status board, org chart, ICS-205 comms plan, rehab tracking, and
ICS-214 activity logs — shared live across every device that opens the site.

## How data sharing works

This app has no backend server of its own. Live shared data comes from a
free **Firebase Firestore** database — every browser that loads the site
reads and writes the same two collections in real time (`src/store.js`).
There is **no login and no access control**: anyone with the URL can view
and edit the board. That's intentional for a crew sharing one link on
scene, but know that going in.

## Offline support

Command Board works with no internet connection, and syncs automatically
once it's restored:

- **The app itself** (the page, its code, icons) is cached by a service
  worker, so it loads even with zero connectivity — as long as this
  device has opened it at least once while online before.
- **Incident data** is cached locally (IndexedDB) by Firestore's built-in
  offline persistence. You can view and edit an incident with no
  connection; your changes queue up locally and sync to the shared board
  the moment the device reconnects — automatically, no action needed.
- A small amber indicator appears in the header ("offline — changes will
  sync when reconnected") whenever the device has no connection, so it's
  clear you're working from cached data rather than the live board.

**Real limits worth knowing, not glossed over:**
- A device needs **one successful online visit** before it can do any of
  this — there's no way to cache data or the app itself before it's ever
  been fetched. First time on a new phone, you need signal at least once.
- While offline, you only see incidents this specific device already
  cached from before — a brand-new incident someone else started on
  another device won't appear until you're back online.
- If two people edit the *same* incident while both are offline (or edit
  faster than sync can catch up), the more recent save wins and the
  other's changes to that save are overwritten — same last-write-wins
  behavior as the online mode, just now also possible across an offline
  gap instead of only within a few seconds.

## PIN protection

The app is gated behind a PIN. The first person to open the freshly
deployed site sets it (there's no default — set it before you share the
URL widely). After that, everyone needs the PIN to get in; each device
remembers the unlock locally until someone taps **Lock** in the header.
**Change PIN** in the header lets you rotate it (requires the current PIN).

Important limitation: this PIN is checked in the browser, not enforced by
Firestore. It stops a leaked link or a wrong guess from casually opening
the board, but it is not a real access-control boundary — someone with
enough technical know-how could still reach the Firestore data directly,
since `firestore.rules` stays open to keep this app server-free. If you
need a PIN that Firestore itself enforces, that requires Firebase
Authentication (e.g. anonymous sign-in gated by a Cloud Function that
checks the PIN before minting a token) — a bigger change; ask if you want
it built.

## One-time setup

### 1. Create a free Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (the free Spark plan is enough).
2. In the project, go to **Build → Firestore Database → Create database**. Start in *production mode* (we'll set rules below) and pick a region close to you.
3. Go to **Project settings → General → Your apps → Add app → Web**. Register the app (no need for Firebase Hosting).
4. Copy the `firebaseConfig` object it gives you.

### 2. Paste your config in
Open `src/firebase.js` and replace the placeholder values with your real
`firebaseConfig` object.

### 3. Apply the security rules
In Firebase Console → Firestore Database → **Rules**, paste the contents of
`firestore.rules` from this repo and publish. This scopes open read/write
access to only the two collections this app uses (`icMeta`, `icIncidents`)
— nothing else in your Firebase project is exposed.

If you want to lock the board down further later (e.g. require a shared
PIN, or add Firebase Authentication), that's a rules + small code change —
ask and it can be added.

### 4. Push this repo to GitHub
```bash
git init
git add .
git commit -m "Command Board"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### 5. Turn on GitHub Pages via Actions
In your GitHub repo: **Settings → Pages → Build and deployment → Source →
GitHub Actions**. The included workflow (`.github/workflows/deploy.yml`)
builds and deploys automatically on every push to `main`. After the first
push, check the **Actions** tab for progress; your live URL will be
`https://<your-username>.github.io/<your-repo>/`.

## Local development
```bash
npm install
npm run dev
```

## Notes
- Print/Export (top right, in the app) generates a printable ICS-201 /
  ICS-205 / ICS-214 packet from the current incident's data.
- Everything else about how the app behaves — tabs, resource status flow,
  forms — is unchanged from the original version; only where the data
  lives has changed.
