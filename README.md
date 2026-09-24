# PA Console

The Mac-side operator website for the [iPad PA system](https://github.com/judeliucodex) — a wireless public-address setup between a Mac and an iPad. Hold a button (or the space bar), speak, and your voice plays on the iPad in real time.

## How it works

This repository contains the **operator website** (a static single page) plus the **Node relay server** that powers it.

- `public/` — the console UI: hold-to-talk, mic picker, level meter, live status, and a Wi-Fi switch panel.
- `server.js` — serves the UI and relays microphone audio (24 kHz PCM over WebSocket) to the iPad app. It also exposes `/api/wifi/switch` to change the Mac's Wi-Fi via `networksetup`, and advertises itself over Bonjour as `iPad-PA`.
- `test/` — protocol tests and a tone generator used to exercise the relay.

## Run it on the Mac (the real deployment)

The relay **must run on the Mac** — WebSocket audio and the Wi-Fi API are local-machine features.

```bash
npm install
npm start
```

Then open `http://localhost:8080` on the Mac and connect the iPad app (same Wi-Fi).

## About the Vercel deployment

This repo is deployed to Vercel as a static preview of the console UI only. Vercel cannot host the WebSocket relay or the Mac's Wi-Fi API, so the hosted copy will show "reconnecting…" and hold-to-talk stays unavailable. For actual announcements, run `npm start` on the Mac and use `http://localhost:8080`.

The iPad receiver app lives in a separate local Xcode project and is not part of this repository.
