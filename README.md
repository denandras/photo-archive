# Photo Archive

A sleek, infinitely-scrolling photo gallery for [andrasdenes.com](https://andrasdenes.com), built with Next.js (App Router). Photos live in S3 (MinIO, `tb1` bucket) organized by date; only whitelisted photos are published.

## How it works

- **Whitelist-driven publishing**: `public-list.txt` in the S3 bucket (`tb1/media/kepek/Saját képek/public-list.txt`) lists folders/files that are public. One rule per line (`#` comments; a folder rule publishes the whole folder).
- **Manifest pipeline** (`scripts/`): `build_manifest.py` lists whitelisted images, probes 256 KB headers with exiftool (no downloads), caches per (size, etag) into `scripts/.manifest_cache.json`; `split_years.py` writes `public/years/<year>.json` + `public/manifest.index.json`.
- **Frontend**: `src/lib/manifest.ts` loads the index + year files; images are streamed through `/api/media?key=kepek/...` (S3 proxy). Downloading from the browser is intentionally unavailable.

## Run

```bash
npm run build
npx next start -p 3000
```

## Deploy

Pushes to `main` auto-deploy on Vercel (project `photo-archive`, domain `photos.andrasdenes.com`). The media proxy needs `S4_ACCESS_KEY_ID` / `S4_SECRET_ACCESS_KEY` set in the project environment; the S3 endpoint defaults to the public `s3.tb1.denandras.cloud`.
