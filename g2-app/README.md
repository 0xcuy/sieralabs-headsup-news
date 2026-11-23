# Heads Up News — G2 app

Even Hub app for the Heads Up News digest. One story on screen at a time;
ring-scroll the action list, tap to run it (next story / save to Telegram);
double-tap exits. Fetches the digest from the backend (`API_BASE` in
`src/main.ts`).

```bash
npm install
npm run dev       # vite on :5173
npm run simulate  # Even Hub simulator
npm run pack      # -> out.ehpk
```

The companion WebView (`index.html` + DOM mirror in `src/main.ts`) shows
the same story in a plain browser, so the app is demoable without glasses.
