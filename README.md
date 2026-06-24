# Chauss Service API Feed

This repository publishes a Chauss Service B2B product feed as a static `feed.csv` file through GitHub Pages. A GitHub Actions workflow reads the Chauss Service API, writes `public/feed.csv`, writes dashboard metadata/history files, and deploys the `public/` folder to Pages.

## What It Provides

- `feed.csv` with product, assortment, EAN, price, stock, material, and category columns.
- A GitHub Pages dashboard for feed quality, stock, price distribution, product movement, and searchable variants.
- GitHub Actions workflow that can run manually, on schedule, or after feed code changes.

## Required GitHub Secrets

Add these in **Settings -> Secrets and variables -> Actions**:

| Name | Required | Notes |
| --- | --- | --- |
| `CHAUSS_SERVICE_API_KEY` | Yes | API key sent as the `X-API-Key` header |
| `CHAUSS_SERVICE_BASE_URL` | No | Defaults to `https://www.chauss-service.fr/api/v1` |
| `CHAUSS_SERVICE_CONCURRENCY` | No | Defaults to `4`; lower it if the API rate-limits detail requests |

Only the API key should be treated as private. Generated `feed.csv` and dashboard files are public when deployed to GitHub Pages.

## Local Usage

```bash
npm install
cp .env.example .env
npm run verify
npm run generate
```

The generator writes:

```text
public/feed.csv
public/feed-meta.json
public/feed-history.json
public/feed-changes.json
public/product-snapshot.json
public/product-snapshots-history.json
```

Serve `public/` locally or open it through a static server to preview the dashboard.

## Deploy

1. Create the GitHub repository.
2. Add the GitHub Actions secrets listed above.
3. Enable GitHub Pages with **GitHub Actions** as the source.
4. Run **Actions -> Generate Chauss Service feed -> Run workflow**.

## API Mapping

The feed uses:

- `GET /articles` for the article reference list.
- `GET /articles/{reference}` for article details and assortiments.
- `GET /stocks` as an optional stock override by barcode.

Chauss Service assortiments become dashboard variants. The variant barcode comes from `codebarre`, color from `couleur`, size from `taille`, B2B price from `pu_ht`, MSRP from `pvc_ttc`, and available stock from `/stocks` when present, otherwise from the article detail.
