import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFeed } from '../src/feed.js';

dotenv.config();

const REQUIRED_FIELDS = ['brand', 'variant_sku', 'barcode', 'option1_value', 'option2_value', 'cost_amount', 'product_type'];
const outputDir = path.resolve('public');
const feedPath = path.join(outputDir, 'feed.csv');
const metadataPath = path.join(outputDir, 'feed-meta.json');
const historyPath = path.join(outputDir, 'feed-history.json');
const snapshotPath = path.join(outputDir, 'product-snapshot.json');
const snapshotHistoryPath = path.join(outputDir, 'product-snapshots-history.json');
const changesPath = path.join(outputDir, 'feed-changes.json');
const SNAPSHOT_HISTORY_DAYS = 180;

try {
  const generatedAt = new Date();
  const { csv, rowCount, productCount } = await generateFeed(process.env, {
    onProgress: ({ step, current, total, message }) => {
      const count = total ? `${current}/${total}` : `${current}`;
      console.log(`[${step}] ${count} ${message ?? ''}`.trim());
    }
  });

  const records = parseCsvRecords(csv);
  const stats = calculateStats(records);
  const snapshot = buildProductSnapshot(records, generatedAt.toISOString());
  const previousSnapshot = await loadPublishedJson('product-snapshot.json');
  const changes = buildChanges(snapshot, previousSnapshot, generatedAt.toISOString());
  const productSnapshotHistory = await buildProductSnapshotHistory(snapshot, previousSnapshot);
  const history = await buildHistory({
    generatedAt: generatedAt.toISOString(),
    productCount: stats.productCount || productCount,
    variantCount: stats.variantCount || rowCount,
    activeVariants: stats.activeVariants,
    draftVariants: stats.draftVariants,
    totalStock: stats.totalStock,
    variantsWithStock: stats.variantsWithStock,
    variantsOutOfStock: stats.variantsOutOfStock,
    qualityScore: stats.qualityScore,
    badEans: stats.badEans,
    missing: stats.missing,
    rowCount
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(feedPath, csv, 'utf8');
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        generatedAt: generatedAt.toISOString(),
        productCount,
        rowCount,
        file: 'feed.csv',
        historyFile: 'feed-history.json',
        changesFile: 'feed-changes.json',
        productSnapshotFile: 'product-snapshot.json',
        productSnapshotHistoryFile: 'product-snapshots-history.json'
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(snapshotHistoryPath, `${JSON.stringify(productSnapshotHistory, null, 2)}\n`, 'utf8');
  await writeFile(changesPath, `${JSON.stringify(changes, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${feedPath}`);
  console.log(`Wrote ${metadataPath}`);
  console.log(`Wrote ${historyPath}`);
  console.log(`Wrote ${snapshotPath}`);
  console.log(`Wrote ${snapshotHistoryPath}`);
  console.log(`Wrote ${changesPath}`);
  console.log(`Generated ${rowCount} CSV rows for ${productCount} products.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

function calculateStats(rows) {
  const variants = uniqueRows(rows, variantKey);
  const products = new Set(rows.map(productKey).filter(Boolean));
  const activeVariants = variants.filter((row) => clean(row.product_status).toUpperCase() === 'ACTIVE').length;
  const draftVariants = variants.filter((row) => clean(row.product_status).toUpperCase() === 'DRAFT').length;
  const totalStock = variants.reduce((sum, row) => sum + toNumber(row.inventory_available), 0);
  const variantsWithStock = variants.filter((row) => toNumber(row.inventory_available) > 0).length;
  const variantsOutOfStock = variants.length - variantsWithStock;
  const missing = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, variants.filter((row) => !isPresent(row[field])).length]));
  const badEans = variants.filter((row) => getEanStatus(row.barcode) === 'bad').length;
  const validRequiredFields = variants.reduce((sum, row) => sum + REQUIRED_FIELDS.filter((field) => isPresent(row[field])).length, 0);
  const validEans = variants.filter((row) => getEanStatus(row.barcode) === 'valid').length;
  const totalRequiredFields = variants.length * (REQUIRED_FIELDS.length + 1);
  const qualityScore = totalRequiredFields ? Math.round(((validRequiredFields + validEans) / totalRequiredFields) * 100) : 0;

  return {
    productCount: products.size,
    variantCount: variants.length,
    activeVariants,
    draftVariants,
    totalStock,
    variantsWithStock,
    variantsOutOfStock,
    missing,
    badEans,
    qualityScore
  };
}

function buildProductSnapshot(rows, generatedAt) {
  const products = new Map();
  const variants = uniqueRows(rows, variantKey);

  for (const row of variants) {
    const id = productKey(row);
    if (!id) continue;
    const product = products.get(id) ?? {
      id,
      title: clean(row.product_title),
      handle: clean(row.product_handle),
      productType: clean(row.product_type) || 'Unclassified',
      status: clean(row.product_status).toUpperCase() || 'UNKNOWN',
      imageUrl: clean(row.image_url),
      productUrl: clean(row.product_url),
      stock: 0,
      variantCount: 0,
      skus: []
    };
    product.stock += toNumber(row.inventory_available);
    product.variantCount += 1;
    if (clean(row.variant_sku)) product.skus.push(clean(row.variant_sku));
    if (!product.imageUrl && clean(row.image_url)) product.imageUrl = clean(row.image_url);
    if (!product.productUrl && clean(row.product_url)) product.productUrl = clean(row.product_url);
    products.set(id, product);
  }

  return {
    generatedAt,
    products: [...products.values()].sort((a, b) => a.title.localeCompare(b.title)).map((product) => ({
      ...product,
      skus: product.skus.slice(0, 12)
    }))
  };
}

function buildChanges(currentSnapshot, previousSnapshot, generatedAt) {
  const currentProducts = new Map((currentSnapshot?.products ?? []).map((product) => [product.id, product]));
  const previousProducts = new Map((previousSnapshot?.products ?? []).map((product) => [product.id, product]));
  const hasPrevious = previousProducts.size > 0;

  const newProducts = hasPrevious
    ? [...currentProducts.values()]
        .filter((product) => !previousProducts.has(product.id))
        .sort((a, b) => b.stock - a.stock || b.variantCount - a.variantCount)
        .slice(0, 100)
    : [];

  const removedProducts = hasPrevious
    ? [...previousProducts.values()]
        .filter((product) => !currentProducts.has(product.id))
        .sort((a, b) => a.title.localeCompare(b.title))
        .slice(0, 100)
    : [];

  const stockDrops = hasPrevious
    ? [...currentProducts.values()]
        .map((product) => {
          const previous = previousProducts.get(product.id);
          if (!previous) return null;
          const delta = product.stock - toNumber(previous.stock);
          if (delta >= 0) return null;
          return {
            id: product.id,
            title: product.title,
            handle: product.handle,
            productType: product.productType,
            productUrl: product.productUrl,
            previousStock: toNumber(previous.stock),
            currentStock: product.stock,
            delta
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.delta - b.delta)
        .slice(0, 100)
    : [];

  const stockIncreases = hasPrevious
    ? [...currentProducts.values()]
        .map((product) => {
          const previous = previousProducts.get(product.id);
          if (!previous) return null;
          const delta = product.stock - toNumber(previous.stock);
          if (delta <= 0) return null;
          return {
            id: product.id,
            title: product.title,
            handle: product.handle,
            productType: product.productType,
            productUrl: product.productUrl,
            previousStock: toNumber(previous.stock),
            currentStock: product.stock,
            delta
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 100)
    : [];

  return {
    generatedAt,
    previousGeneratedAt: previousSnapshot?.generatedAt ?? null,
    hasPrevious,
    newProducts,
    removedProducts,
    stockDrops,
    stockIncreases
  };
}

async function buildProductSnapshotHistory(currentSnapshot, previousSnapshot) {
  const previousHistory = await loadPublishedJson('product-snapshots-history.json');
  const existingSnapshots = Array.isArray(previousHistory?.snapshots) ? previousHistory.snapshots : [];
  const snapshots = [...existingSnapshots];

  if (previousSnapshot?.generatedAt) snapshots.push(previousSnapshot);
  snapshots.push(currentSnapshot);

  const byDay = new Map();
  for (const snapshot of snapshots) {
    const normalized = normalizeProductSnapshot(snapshot);
    if (!normalized) continue;
    byDay.set(normalized.generatedAt.slice(0, 10), normalized);
  }

  return {
    updatedAt: currentSnapshot.generatedAt,
    retentionDays: SNAPSHOT_HISTORY_DAYS,
    snapshots: [...byDay.values()]
      .sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt))
      .slice(-SNAPSHOT_HISTORY_DAYS)
  };
}

function normalizeProductSnapshot(snapshot) {
  if (!snapshot?.generatedAt || !Array.isArray(snapshot.products)) return null;
  const generatedAt = new Date(snapshot.generatedAt);
  if (Number.isNaN(generatedAt.valueOf())) return null;

  return {
    generatedAt: generatedAt.toISOString(),
    products: snapshot.products
      .filter((product) => clean(product.id))
      .map((product) => ({
        id: clean(product.id),
        title: clean(product.title),
        handle: clean(product.handle),
        productType: clean(product.productType) || 'Unclassified',
        status: clean(product.status).toUpperCase() || 'UNKNOWN',
        imageUrl: clean(product.imageUrl),
        productUrl: clean(product.productUrl),
        stock: toNumber(product.stock),
        variantCount: toNumber(product.variantCount),
        skus: Array.isArray(product.skus) ? product.skus.map(clean).filter(Boolean).slice(0, 12) : []
      }))
  };
}

async function buildHistory(snapshot) {
  const previous = await loadPublishedJson('feed-history.json');
  const snapshots = Array.isArray(previous?.snapshots) ? previous.snapshots : [];
  const byDay = new Map();

  for (const item of [...snapshots, snapshot]) {
    if (!item?.generatedAt) continue;
    const date = new Date(item.generatedAt);
    if (Number.isNaN(date.valueOf())) continue;
    byDay.set(date.toISOString().slice(0, 10), { ...item, generatedAt: date.toISOString() });
  }

  return {
    updatedAt: snapshot.generatedAt,
    snapshots: [...byDay.values()]
      .sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt))
      .slice(-180)
  };
}

async function loadPublishedJson(fileName) {
  const baseUrl = getPublishedBaseUrl();
  if (!baseUrl || typeof fetch !== 'function') return null;

  try {
    const response = await fetch(`${baseUrl}/${fileName}?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return response.json();
  } catch (error) {
    console.log(`No published ${fileName} loaded: ${error.message}`);
    return null;
  }
}

function getPublishedBaseUrl() {
  if (process.env.FEED_PAGES_BASE_URL) return process.env.FEED_PAGES_BASE_URL.replace(/\/$/, '');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes('/')) return null;
  const [owner, repo] = repository.split('/');
  return `https://${owner}.github.io/${repo}`;
}

function parseCsvRecords(csv) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const input = String(csv ?? '').replace(/^\uFEFF/, '');

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => clean(header)) ?? [];
  return rows
    .filter((values) => values.some((value) => clean(value)))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function uniqueRows(rows, keyFn) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyFn(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function variantKey(row) {
  return clean(row.variant_id) || clean(row.variant_sku) || `${clean(row.product_id)}:${clean(row.barcode)}`;
}

function productKey(row) {
  return clean(row.product_id) || clean(row.product_handle) || clean(row.product_title);
}

function getEanStatus(value) {
  const barcode = normalizeBarcode(value);
  if (!barcode) return 'missing';
  return isValidEan(barcode) ? 'valid' : 'bad';
}

function normalizeBarcode(value) {
  return clean(value).replace(/[\s-]/g, '');
}

function isValidEan(value) {
  if (!/^\d{8}$|^\d{13}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checkDigit = digits.pop();
  const sum = digits.reduce((total, digit, index) => {
    const weight = value.length === 13 ? (index % 2 === 0 ? 1 : 3) : (index % 2 === 0 ? 3 : 1);
    return total + digit * weight;
  }, 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function clean(value) {
  return String(value ?? '').trim();
}

function isPresent(value) {
  return clean(value) !== '';
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}
