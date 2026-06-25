import { stringify } from 'csv-stringify/sync';
import { createChaussServiceClient } from './chauss-service.js';

const DEFAULT_CONCURRENCY = 4;

export const CSV_COLUMNS = [
  'brand',
  'product_id',
  'product_gid',
  'product_handle',
  'product_title',
  'product_type',
  'product_status',
  'variant_id',
  'variant_gid',
  'variant_title',
  'variant_sku',
  'barcode',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'option3_name',
  'option3_value',
  'price_amount',
  'cost_amount',
  'price_currency',
  'compare_at_price',
  'msrp_amount',
  'pack_quantity',
  'cost_per_unit',
  'msrp_per_unit',
  'is_pack',
  'gender',
  'age_group',
  'usage',
  'construction',
  'upper_material',
  'lining_material',
  'insole_material',
  'outsole_material',
  'inventory_item_id',
  'inventory_tracked',
  'inventory_available',
  'inventory_on_hand',
  'inventory_committed',
  'inventory_location_id',
  'inventory_location_name',
  'image_url',
  'product_url',
  'tags',
  'seo_title',
  'seo_description',
  'all_images',
  'metafields_json',
  'updated_at'
];

export async function generateFeedCsv(env = process.env, options = {}) {
  const { csv } = await generateFeed(env, options);
  return csv;
}

export async function generateFeed(env = process.env, options = {}) {
  const rows = await buildFeedRows(env, undefined, options);
  if (rows.length === 0) {
    throw new Error('The configured Chauss Service API returned no product variants.');
  }

  reportProgress(options.onProgress, {
    step: 'Building CSV',
    current: 0,
    total: rows.length,
    message: `Writing ${rows.length} CSV rows.`
  });

  const csv = stringify(rows, {
    header: true,
    columns: CSV_COLUMNS,
    bom: true,
    quoted_string: true
  });

  reportProgress(options.onProgress, {
    step: 'Done',
    current: rows.length,
    total: rows.length,
    message: `Generated ${rows.length} CSV rows.`
  });

  return { csv, rowCount: rows.length, productCount: countUniqueProducts(rows) };
}

export async function buildFeedRows(env = process.env, client, options = {}) {
  const chaussService = client ?? await createChaussServiceClient(env);
  const articleSummaries = normalizeArray(await chaussService.getArticles());

  if (articleSummaries.length === 0) {
    throw new Error('Chauss Service /articles returned no articles.');
  }

  reportProgress(options.onProgress, {
    step: 'Fetching articles',
    current: articleSummaries.length,
    total: articleSummaries.length,
    message: `Fetched ${articleSummaries.length} article references.`
  });

  const stockByBarcode = await fetchStockMap(chaussService, options.onProgress);
  const articleDetails = await mapWithConcurrency(articleSummaries, getConcurrency(env), async (summary, index) => {
    const detailPayload = await chaussService.getArticle(summary.code);
    const detail = normalizeArticleDetail(detailPayload, summary);
    reportProgress(options.onProgress, {
      step: 'Fetching article details',
      current: index + 1,
      total: articleSummaries.length,
      message: `Fetched ${detail.code || summary.code}.`
    });
    return detail;
  });

  return articleDetails.flatMap((article) => articleToRows(article, stockByBarcode, env));
}

export function articleToRows(article, stockByBarcode = new Map(), env = process.env) {
  const assortiments = normalizeArray(article.assortiments);
  if (assortiments.length === 0) {
    return [toCsvRow({ article, assortment: null, stockByBarcode, env })];
  }
  return assortiments.map((assortment) => toCsvRow({ article, assortment, stockByBarcode, env }));
}

function toCsvRow({ article, assortment, stockByBarcode, env }) {
  const barcode = clean(assortment?.codebarre);
  const stock = barcode && stockByBarcode.has(barcode) ? stockByBarcode.get(barcode) : assortment?.stock ?? article.stock ?? '';
  const productId = clean(article.code);
  const color = clean(assortment?.couleur);
  const size = clean(assortment?.taille);
  const variantTitle = [color, size].filter(Boolean).join(' / ');
  const costAmount = toNumberOrBlank(assortment?.pu_ht);
  const msrpAmount = toNumberOrBlank(article.pvc_ttc);
  const packQuantity = getPackQuantity(assortment);
  const isPack = packQuantity > 1;
  const audience = normalizeAudience(article.rayon);
  const imageUrl = normalizeImageUrl(assortment?.photo);

  return {
    brand: clean(article.marque) || env.FEED_BRAND || 'Chauss Service',
    product_id: productId,
    product_gid: '',
    product_handle: productId.toLowerCase(),
    product_title: clean(article.nom),
    product_type: clean(article.type) || clean(article.rayon) || 'Unclassified',
    product_status: 'ACTIVE',
    variant_id: barcode || [productId, color, size].filter(Boolean).join('-'),
    variant_gid: '',
    variant_title: variantTitle,
    variant_sku: productId,
    barcode,
    option1_name: color ? 'Couleur' : '',
    option1_value: color,
    option2_name: size ? 'Pointure' : '',
    option2_value: size,
    option3_name: '',
    option3_value: '',
    price_amount: formatNumber(costAmount),
    cost_amount: formatNumber(costAmount),
    price_currency: env.FEED_CURRENCY || 'EUR',
    compare_at_price: formatNumber(msrpAmount),
    msrp_amount: formatNumber(msrpAmount),
    pack_quantity: packQuantity ? String(packQuantity) : '',
    cost_per_unit: formatNumber(isPack && costAmount !== '' ? costAmount / packQuantity : costAmount),
    msrp_per_unit: formatNumber(msrpAmount),
    is_pack: isPack ? 'true' : 'false',
    gender: audience.gender,
    age_group: audience.ageGroup,
    usage: clean(article.usage),
    construction: clean(article.construction),
    upper_material: clean(article.matieres?.tige),
    lining_material: clean(article.matieres?.doublure),
    insole_material: clean(article.matieres?.premiere),
    outsole_material: clean(article.matieres?.semelle),
    inventory_item_id: barcode,
    inventory_tracked: barcode ? true : '',
    inventory_available: formatNumber(stock),
    inventory_on_hand: formatNumber(stock),
    inventory_committed: '',
    inventory_location_id: '',
    inventory_location_name: '',
    image_url: imageUrl,
    product_url: '',
    tags: [article.rayon, article.usage, article.construction].map(clean).filter(Boolean).join(', '),
    seo_title: clean(article.nom),
    seo_description: buildSeoDescription(article),
    all_images: imageUrl,
    metafields_json: JSON.stringify(buildMetafields(article, assortment)),
    updated_at: new Date().toISOString()
  };
}

async function fetchStockMap(client, onProgress) {
  try {
    const stocks = normalizeArray(await client.getStocks());
    reportProgress(onProgress, {
      step: 'Fetching stocks',
      current: stocks.length,
      total: stocks.length,
      message: `Fetched ${stocks.length} stock rows.`
    });
    return new Map(stocks.map((item) => [clean(item.code), Number(item.stock)]).filter(([code, stock]) => code && Number.isFinite(stock)));
  } catch (error) {
    reportProgress(onProgress, {
      step: 'Fetching stocks',
      current: 0,
      total: 0,
      message: `Stock endpoint unavailable, using article detail stock: ${error.message}`
    });
    return new Map();
  }
}

function normalizeArticleDetail(payload, summary) {
  const article = Array.isArray(payload) ? payload[0] : payload;
  return { ...summary, ...article };
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function getConcurrency(env) {
  const parsed = Number(env.CHAUSS_SERVICE_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CONCURRENCY;
}

function buildSeoDescription(article) {
  return [article.marque, article.nom, article.type, article.rayon, article.usage].map(clean).filter(Boolean).join(' - ');
}

function buildMetafields(article, assortment) {
  return {
    construction: clean(article.construction),
    rayon: clean(article.rayon),
    usage: clean(article.usage),
    matieres: article.matieres ?? {},
    talon: article.talon ?? {},
    pvc_ttc: article.pvc_ttc ?? '',
    qte_colis: assortment?.qteColis ?? '',
    photo: normalizeImageUrl(assortment?.photo)
  };
}

function normalizeImageUrl(value) {
  const url = clean(value);
  if (!url) return '';
  try {
    return new URL(url).href;
  } catch (_error) {
    return url;
  }
}

function normalizeAudience(rayon) {
  const value = clean(rayon).toLowerCase();
  if (!value) return { gender: '', ageGroup: '' };
  if (value.includes('enfant') || value.includes('kid')) return { gender: '', ageGroup: 'Kids' };
  if (value.includes('bebe') || value.includes('bébé') || value.includes('baby')) return { gender: '', ageGroup: 'Baby' };
  if (value.includes('femme') || value.includes('women')) return { gender: 'Women', ageGroup: 'Adult' };
  if (value.includes('homme') || value.includes('men')) return { gender: 'Men', ageGroup: 'Adult' };
  if (value.includes('mixte') || value.includes('unisex')) return { gender: 'Unisex', ageGroup: 'Adult' };
  return { gender: clean(rayon), ageGroup: '' };
}

function getPackQuantity(assortment) {
  const qteColis = toNumberOrBlank(assortment?.qteColis);
  if (qteColis !== '' && qteColis > 1) return qteColis;

  const size = clean(assortment?.taille).toUpperCase();
  const packMatch = size.match(/^H(\d+)(?:L)?$/);
  if (packMatch) return Number(packMatch[1]);

  return 1;
}

function reportProgress(onProgress, progress) {
  if (typeof onProgress === 'function') {
    onProgress(progress);
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

function formatNumber(value) {
  if (value === '' || value == null) return '';
  const parsed = toNumberOrBlank(value);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function toNumberOrBlank(value) {
  if (value === '' || value == null) return '';
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : '';
}

function countUniqueProducts(rows) {
  return new Set(rows.map((row) => row.product_id).filter(Boolean)).size;
}
