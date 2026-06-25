const DASHBOARD_VERSION = '2026-06-25-chauss-service-b2b-fields';
const ACTIONS_WORKFLOW_RUNS_URL = 'https://api.github.com/repos/badr-spacefoot/chauss-service-feed-API/actions/workflows/generate-feed.yml/runs?branch=main&per_page=1';
const REQUIRED_FIELDS = ['brand', 'variant_sku', 'barcode', 'option1_value', 'option2_value', 'cost_amount', 'product_type'];
const EURO = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' });
const INT = new Intl.NumberFormat('en-US');
const DAY_MS = 24 * 60 * 60 * 1000;
const state = {
  rows: [],
  filteredRows: [],
  groupedRows: [],
  expandedProducts: new Set(),
  history: [],
  historySnapshots: [],
  productHistory: [],
  productHistorySnapshots: [],
  changes: null,
  charts: {},
  sort: { key: 'stock', direction: 'desc' },
  pageSize: 100,
  groupProducts: true,
  timeRange: { preset: 'last-30-days', customFrom: '', customTo: '' }
};
let feedStatusTimer = null;

const el = (id) => document.getElementById(id);
const text = (id, value) => { const node = el(id); if (node) node.textContent = value; };
const clean = (value) => String(value ?? '').trim();
const isPresent = (value) => clean(value) !== '';
const toNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
const variantKey = (row) => clean(row.variant_id) || clean(row.variant_sku) || `${clean(row.product_id)}:${clean(row.barcode)}`;
const productKey = (row) => clean(row.product_id) || clean(row.product_handle) || clean(row.product_title);
const typeName = (row) => clean(row.product_type) || 'Unclassified';

window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bindFilters();
  bindSorting();
  bindGroupedRows();
  bindCatalogActions();
  bindTimeRange();
  bindHeaderScroll();
  el('refreshButton').addEventListener('click', loadDashboard);
  loadDashboard();
  updateFeedGenerationStatus();
});

function initTheme() {
  const saved = localStorage.getItem('dashboard-theme') || 'light';
  setTheme(saved === 'dark' ? 'dark' : 'light');
  el('themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('dashboard-theme', theme);
  text('themeToggle', theme === 'dark' ? 'Light mode' : 'Dark mode');
}

async function updateFeedGenerationStatus() {
  try {
    const response = await fetch(`${ACTIONS_WORKFLOW_RUNS_URL}&ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub Actions returned ${response.status}`);
    const run = (await response.json()).workflow_runs?.[0];
    if (!run) {
      setFeedStatus('Feed status unavailable', 'No workflow run found yet.', 'pending');
      scheduleFeedStatusRefresh(120000);
      return;
    }
    if (isActiveRun(run)) {
      const activeStep = await getCurrentWorkflowStep(run.jobs_url);
      setFeedStatus('Feed generation in progress', activeStep ? `Current step: ${activeStep}` : `Started: ${formatDateTime(run.run_started_at || run.created_at)}`, 'running');
      scheduleFeedStatusRefresh(30000);
      return;
    }
    if (run.conclusion === 'success') {
      setFeedStatus('Feed ready', `Last workflow success: ${formatDateTime(run.updated_at)}`, 'success');
      scheduleFeedStatusRefresh(120000);
      return;
    }
    setFeedStatus('Last generation needs attention', `${describeConclusion(run.conclusion)}: ${formatDateTime(run.updated_at)}`, 'error');
    scheduleFeedStatusRefresh(120000);
  } catch (error) {
    setFeedStatus('Feed status unavailable', error.message || 'Could not read GitHub Actions status.', 'pending');
    scheduleFeedStatusRefresh(120000);
  }
}

async function getCurrentWorkflowStep(jobsUrl) {
  if (!jobsUrl) return '';
  try {
    const response = await fetch(`${jobsUrl}${jobsUrl.includes('?') ? '&' : '?'}ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return '';
    const job = (await response.json()).jobs?.find((item) => item.status === 'in_progress');
    const step = job?.steps?.find((item) => item.status === 'in_progress') || job?.steps?.find((item) => item.status === 'queued' || item.status === 'pending');
    return step?.name || job?.name || '';
  } catch (_error) {
    return '';
  }
}

function setFeedStatus(label, detail, status) {
  const container = el('feedStatus');
  if (!container) return;
  container.className = `feed-status ${status}`;
  text('feedStatusLabel', label);
  text('feedStatusDetail', detail);
}

function scheduleFeedStatusRefresh(delay) {
  window.clearTimeout(feedStatusTimer);
  feedStatusTimer = window.setTimeout(updateFeedGenerationStatus, delay);
}

function isActiveRun(run) {
  return ['queued', 'pending', 'waiting', 'requested', 'in_progress'].includes(run.status);
}

function describeConclusion(conclusion) {
  return conclusion ? conclusion.replace(/_/g, ' ') : 'Unknown status';
}

async function loadDashboard() {
  showAlert('', false);
  try {
    ensureLibraries();
    const [metadata, csvText, history, changes, productHistory] = await Promise.all([loadMetadata(), loadCsvText(), loadHistory(), loadChanges(), loadProductHistory()]);
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: 'greedy' });
    if (parsed.errors?.length) throw new Error(`CSV parsing failed: ${parsed.errors[0].message}`);
    state.rows = parsed.data.map(normalizeRow).filter((row) => variantKey(row));
    state.history = history;
    state.changes = changes;
    state.productHistory = productHistory;
    if (state.rows.length === 0) throw new Error('feed.csv was loaded, but it did not contain any variants.');
    renderDashboard(metadata);
  } catch (error) {
    renderEmptyState();
    showAlert(error.message || 'Could not load feed.csv. Run the GitHub Actions workflow to generate the feed.', true);
  }
}

function ensureLibraries() {
  if (!window.Papa) throw new Error('PapaParse could not be loaded from the CDN.');
  if (!window.Chart) throw new Error('Chart.js could not be loaded from the CDN.');
}

async function loadMetadata() {
  try {
    const response = await fetch(`feed-meta.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    return response.ok ? response.json() : null;
  } catch (_error) {
    return null;
  }
}

async function loadHistory() {
  try {
    const response = await fetch(`feed-history.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    const payload = response.ok ? await response.json() : null;
    return Array.isArray(payload?.snapshots) ? payload.snapshots : [];
  } catch (_error) {
    return [];
  }
}

async function loadChanges() {
  try {
    const response = await fetch(`feed-changes.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    return response.ok ? response.json() : null;
  } catch (_error) {
    return null;
  }
}

async function loadProductHistory() {
  try {
    const response = await fetch(`product-snapshots-history.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    const payload = response.ok ? await response.json() : null;
    return Array.isArray(payload?.snapshots) ? payload.snapshots : [];
  } catch (_error) {
    return [];
  }
}

async function loadCsvText() {
  const response = await fetch(`feed.csv?ts=${Date.now()}`, { headers: { Accept: 'text/csv' } });
  if (!response.ok) throw new Error('feed.csv is not available yet. Run the GitHub Actions workflow first.');
  return response.text();
}

function normalizeRow(row) {
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, clean(value)]));
  normalized.stock = toNumber(normalized.inventory_available);
  normalized.cost = toNumber(normalized.cost_amount || normalized.price_amount);
  normalized.price = normalized.cost;
  normalized.msrp = toNumber(normalized.msrp_amount || normalized.compare_at_price);
  normalized.costPerUnit = toNumber(normalized.cost_per_unit) || normalized.cost;
  normalized.msrpPerUnit = toNumber(normalized.msrp_per_unit) || normalized.msrp;
  normalized.packQuantity = Math.max(1, toNumber(normalized.pack_quantity) || 1);
  normalized.isPack = clean(normalized.is_pack).toLowerCase() === 'true' || normalized.packQuantity > 1;
  normalized.status = clean(normalized.product_status).toUpperCase() || 'UNKNOWN';
  normalized.productType = typeName(normalized);
  normalized.brandName = clean(normalized.brand) || 'Unbranded';
  normalized.genderName = clean(normalized.gender) || 'Unspecified';
  normalized.ageGroup = clean(normalized.age_group) || 'Unspecified';
  normalized.audienceName = normalized.ageGroup === 'Kids' || normalized.ageGroup === 'Baby' ? normalized.ageGroup : normalized.genderName;
  normalized.usageName = clean(normalized.usage) || 'Unspecified';
  normalized.pricingStatus = getPricingStatus(normalized);
  normalized.normalizedBarcode = normalizeBarcode(normalized.barcode);
  normalized.eanStatus = getEanStatus(normalized.barcode);
  normalized.updatedDate = normalized.updated_at ? new Date(normalized.updated_at) : null;
  if (Number.isNaN(normalized.updatedDate?.valueOf())) normalized.updatedDate = null;
  return normalized;
}

function renderDashboard(metadata) {
  const dashboardRows = state.rows;
  const stats = calculateStats(dashboardRows);
  const allStats = calculateStats(state.rows);
  text('scopeSummary', `${INT.format(stats.totalProducts)} permanent products and ${INT.format(stats.totalVariants)} sellable variants. Full feed: ${INT.format(allStats.totalProducts)} products and ${INT.format(allStats.totalVariants)} variants.`);
  text('totalProducts', INT.format(stats.totalProducts));
  text('totalVariants', INT.format(stats.totalVariants));
  text('totalStock', INT.format(stats.totalStock));
  text('outOfStockVariants', INT.format(stats.variantsOutOfStock));
  text('fullyOutProducts', INT.format(stats.fullyOutProducts));
  text('pricingAlertsCount', INT.format(stats.pricingAlerts.length));
  text('packVariants', INT.format(stats.packVariants));
  text('readyForImport', `${stats.readyForImport}%`);
  text('missingBarcode', INT.format(stats.missing.barcode));
  text('badEansDetail', INT.format(stats.badEans));
  text('missingImage', INT.format(stats.missing.option2_value));
  text('missingPrice', INT.format(stats.missing.cost_amount));
  text('missingStock', INT.format(stats.missingStock));
  text('outOfStockDetail', INT.format(stats.variantsOutOfStock));
  text('missingProductType', INT.format(stats.missing.product_type));
  text('missingSeoTitle', INT.format(stats.missing.brand));
  text('missingSeoDescription', INT.format(stats.missing.option1_value));
  text('negativeStock', INT.format(stats.negativeStockVariants));
  text('costAboveMsrp', INT.format(stats.costAboveMsrp));
  text('missingMsrp', INT.format(stats.missingMsrp));
  const lastGenerated = metadata?.generatedAt ? new Date(metadata.generatedAt) : stats.lastUpdated;
  text('lastUpdated', lastGenerated ? `Last CSV update: ${lastGenerated.toLocaleString()}` : 'Last CSV update: unavailable');
  renderCharts(stats);
  state.historySnapshots = normalizeHistory([...state.history, buildCurrentSnapshot(stats, metadata)]);
  state.productHistorySnapshots = normalizeProductHistory([...state.productHistory, buildCurrentProductSnapshot(dashboardRows, metadata)]);
  renderTimeBoundSections();
  renderProductTypes(stats.productTypes);
  renderBrandBreakdown(stats.brands);
  renderAudienceBreakdown(stats.audiences);
  renderPricingAlerts(stats.pricingAlerts);
  renderStockWatch(stats.stockWatch);
  populateFilters(dashboardRows);
  applyFilters();
}

function calculateStats(rows) {
  const variants = uniqueRows(rows, variantKey);
  const products = new Set(rows.map(productKey).filter(Boolean));
  const activeVariants = variants.filter((row) => row.status === 'ACTIVE').length;
  const draftVariants = variants.filter((row) => row.status === 'DRAFT').length;
  const archivedVariants = variants.filter((row) => row.status === 'ARCHIVED').length;
  const totalStock = variants.reduce((sum, row) => sum + row.stock, 0);
  const variantsWithStock = variants.filter((row) => row.stock > 0).length;
  const variantsOutOfStock = variants.length - variantsWithStock;
  const missing = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, variants.filter((row) => !isPresent(row[field])).length]));
  const badEans = variants.filter((row) => row.eanStatus === 'bad').length;
  const validRequiredFields = variants.reduce((sum, row) => sum + REQUIRED_FIELDS.filter((field) => isPresent(row[field])).length, 0);
  const totalRequiredFields = variants.length * REQUIRED_FIELDS.length;
  const qualityScore = totalRequiredFields ? Math.round((validRequiredFields / totalRequiredFields) * 100) : 0;
  const missingStock = variants.filter((row) => !isPresent(row.inventory_available)).length;
  const negativeStockVariants = variants.filter((row) => row.stock < 0).length;
  const packVariants = variants.filter((row) => row.isPack).length;
  const fullyOutProducts = countFullyOutProducts(variants);
  const costAboveMsrp = variants.filter((row) => row.costPerUnit > 0 && row.msrpPerUnit > 0 && row.costPerUnit > row.msrpPerUnit).length;
  const missingMsrp = variants.filter((row) => row.msrpPerUnit <= 0).length;
  const pricingAlerts = buildPricingAlerts(variants);
  const importReadyVariants = variants.filter(isImportReady).length;
  const readyForImport = variants.length ? Math.round((importReadyVariants / variants.length) * 100) : 0;
  const costRows = variants.filter((row) => row.cost > 0);
  const msrpRows = variants.filter((row) => row.msrp > 0);
  const averageCost = costRows.length ? costRows.reduce((sum, row) => sum + row.cost, 0) / costRows.length : 0;
  const averageMsrp = msrpRows.length ? msrpRows.reduce((sum, row) => sum + row.msrp, 0) / msrpRows.length : 0;
  const lastUpdated = variants.map((row) => row.updatedDate).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  return {
    totalProducts: products.size,
    totalVariants: variants.length,
    activeVariants,
    draftVariants,
    archivedVariants,
    totalStock,
    variantsWithStock,
    variantsOutOfStock,
    packVariants,
    fullyOutProducts,
    costAboveMsrp,
    missingMsrp,
    pricingAlerts,
    readyForImport,
    averageCost,
    averageMsrp,
    missing,
    missingStock,
    badEans,
    negativeStockVariants,
    qualityScore,
    productTypes: groupProductTypes(variants),
    brands: groupByDimension(variants, 'brandName', 'brand'),
    audiences: groupByDimension(variants, 'audienceName', 'audience'),
    usages: groupByDimension(variants, 'usageName', 'usage'),
    pricingGroups: groupByDimension(variants, 'pricingStatus', 'status'),
    stockWatch: buildStockWatch(variants),
    lastUpdated
  };
}

function getScopedRows(rows) {
  return rows;
}

function scopeLabel() {
  return 'All variants';
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

function groupProductTypes(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.productType;
    const entry = groups.get(key) ?? { type: key, variants: 0, stock: 0, priceSum: 0, priced: 0 };
    entry.variants += 1;
    entry.stock += row.stock;
    if (row.price > 0) { entry.priceSum += row.price; entry.priced += 1; }
    groups.set(key, entry);
  }
  return [...groups.values()].map((entry) => ({ ...entry, averagePrice: entry.priced ? entry.priceSum / entry.priced : 0 })).sort((a, b) => b.variants - a.variants || b.stock - a.stock);
}

function groupByDimension(rows, key, labelKey) {
  const groups = new Map();
  for (const row of rows) {
    const label = clean(row[key]) || 'Unspecified';
    const entry = groups.get(label) ?? { [labelKey]: label, variants: 0, stock: 0, priceSum: 0, priced: 0 };
    entry.variants += 1;
    entry.stock += row.stock;
    if (row.cost > 0) { entry.priceSum += row.cost; entry.priced += 1; }
    groups.set(label, entry);
  }
  return [...groups.values()]
    .map((entry) => ({ ...entry, averagePrice: entry.priced ? entry.priceSum / entry.priced : 0 }))
    .sort((a, b) => b.variants - a.variants || b.stock - a.stock);
}

function countFullyOutProducts(rows) {
  const products = new Map();
  for (const row of rows) {
    const key = productKey(row);
    if (!key) continue;
    const entry = products.get(key) ?? { variants: 0, out: 0 };
    entry.variants += 1;
    if (row.stock <= 0) entry.out += 1;
    products.set(key, entry);
  }
  return [...products.values()].filter((product) => product.variants > 0 && product.variants === product.out).length;
}

function buildPricingAlerts(rows) {
  return rows
    .filter((row) => row.pricingStatus !== 'Ready')
    .sort((a, b) => pricingSeverity(b) - pricingSeverity(a) || (b.costPerUnit - b.msrpPerUnit) - (a.costPerUnit - a.msrpPerUnit))
    .slice(0, 20);
}

function pricingSeverity(row) {
  if (row.pricingStatus === 'Cost above MSRP') return 3;
  if (row.pricingStatus === 'Missing price') return 2;
  return 1;
}

function isImportReady(row) {
  return REQUIRED_FIELDS.every((field) => isPresent(row[field]))
    && row.eanStatus === 'valid'
    && isPresent(row.inventory_available)
    && row.msrpPerUnit > 0
    && row.pricingStatus === 'Ready';
}

function buildStockWatch(rows) {
  const products = new Map();
  for (const row of rows) {
    const key = productKey(row);
    if (!key) continue;
    const product = products.get(key) ?? { title: row.product_title, url: row.product_url, brand: row.brandName, productType: row.productType, stock: 0, variants: 0, negativeVariants: 0, outVariants: 0 };
    product.stock += row.stock;
    product.variants += 1;
    if (row.stock < 0) product.negativeVariants += 1;
    if (row.stock <= 0) product.outVariants += 1;
    products.set(key, product);
  }
  return [...products.values()]
    .filter((product) => product.outVariants > 0 || product.stock <= 0 || product.negativeVariants > 0)
    .sort((a, b) => b.outVariants - a.outVariants || a.stock - b.stock || b.negativeVariants - a.negativeVariants)
    .slice(0, 12);
}

function renderCharts(stats) {
  destroyCharts(['status', 'stock', 'prices', 'missing']);
  const colors = ['#376b5d', '#d78f7a', '#6f91a8', '#9f7c54', '#8c9b6f', '#b76f89', '#5f8f86', '#d8b066'];
  const topBrands = stats.brands.slice(0, 8);
  state.charts.status = new Chart(el('statusChart'), { type: 'doughnut', data: { labels: topBrands.map((item) => item.brand), datasets: [{ data: topBrands.map((item) => item.variants), backgroundColor: colors, borderWidth: 0 }] }, options: chartOptions() });
  const topStockTypes = stats.productTypes.slice(0, 8);
  state.charts.stock = new Chart(el('stockTypeChart'), { type: 'bar', data: { labels: topStockTypes.map((item) => item.type), datasets: [{ label: 'Available stock', data: topStockTypes.map((item) => item.stock), backgroundColor: colors }] }, options: chartOptions({ indexAxis: 'y' }) });
  const pricingGroups = stats.pricingGroups.slice(0, 8);
  state.charts.prices = new Chart(el('priceChart'), { type: 'doughnut', data: { labels: pricingGroups.map((item) => item.status), datasets: [{ data: pricingGroups.map((item) => item.variants), backgroundColor: ['#376b5d', '#d78f7a', '#b9544a', '#d8b066'], borderWidth: 0 }] }, options: chartOptions() });
  const topUsages = stats.usages.slice(0, 8);
  state.charts.missing = new Chart(el('missingChart'), { type: 'bar', data: { labels: topUsages.map((item) => item.usage), datasets: [{ label: 'Variants', data: topUsages.map((item) => item.variants), backgroundColor: colors }] }, options: chartOptions({ indexAxis: 'y' }) });
}

function buildCurrentSnapshot(stats, metadata) {
  return { generatedAt: metadata?.generatedAt || new Date().toISOString(), productCount: stats.totalProducts, variantCount: stats.totalVariants, activeVariants: stats.activeVariants, draftVariants: stats.draftVariants, totalStock: stats.totalStock, variantsWithStock: stats.variantsWithStock, variantsOutOfStock: stats.variantsOutOfStock, readyForImport: stats.readyForImport, qualityScore: stats.readyForImport, badEans: stats.badEans, rowCount: metadata?.rowCount ?? stats.totalVariants };
}

function buildCurrentProductSnapshot(rows, metadata) {
  const products = new Map();
  for (const row of uniqueRows(rows, variantKey)) {
    const id = productKey(row);
    if (!id) continue;
    const product = products.get(id) ?? { id, title: row.product_title, handle: row.product_handle, productType: row.productType, productUrl: row.product_url, stock: 0, variantCount: 0 };
    product.stock += row.stock;
    product.variantCount += 1;
    if (!product.productUrl && row.product_url) product.productUrl = row.product_url;
    products.set(id, product);
  }
  return { generatedAt: metadata?.generatedAt || new Date().toISOString(), products: [...products.values()] };
}

function normalizeHistory(snapshots) {
  const byDate = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot?.generatedAt) continue;
    const date = new Date(snapshot.generatedAt);
    if (Number.isNaN(date.valueOf())) continue;
    const readyForImport = toNumber(snapshot.readyForImport ?? snapshot.qualityScore);
    byDate.set(date.toISOString().slice(0, 10), { generatedAt: date.toISOString(), productCount: toNumber(snapshot.productCount), variantCount: toNumber(snapshot.variantCount ?? snapshot.rowCount), totalStock: toNumber(snapshot.totalStock), readyForImport, qualityScore: readyForImport, badEans: toNumber(snapshot.badEans), rowCount: toNumber(snapshot.rowCount) });
  }
  return [...byDate.values()].sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt)).slice(-60);
}

function normalizeProductHistory(snapshots) {
  const byDate = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot?.generatedAt || !Array.isArray(snapshot.products)) continue;
    const date = new Date(snapshot.generatedAt);
    if (Number.isNaN(date.valueOf())) continue;
    byDate.set(date.toISOString().slice(0, 10), {
      generatedAt: date.toISOString(),
      products: snapshot.products.filter((product) => clean(product.id)).map((product) => ({
        id: clean(product.id),
        title: clean(product.title),
        handle: clean(product.handle),
        productType: clean(product.productType) || 'Unclassified',
        productUrl: clean(product.productUrl),
        stock: toNumber(product.stock),
        variantCount: toNumber(product.variantCount)
      }))
    });
  }
  return [...byDate.values()].sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt)).slice(-180);
}

function bindTimeRange() {
  const preset = el('timeRangePreset');
  const customControls = el('customRangeControls');
  if (!preset || !customControls) return;
  preset.addEventListener('input', () => {
    state.timeRange.preset = preset.value;
    customControls.hidden = preset.value !== 'custom';
    if (preset.value !== 'custom') renderTimeBoundSections();
  });
  el('applyCustomRange').addEventListener('click', () => {
    state.timeRange.customFrom = el('customRangeFrom').value;
    state.timeRange.customTo = el('customRangeTo').value;
    renderTimeBoundSections();
  });
  el('resetCustomRange').addEventListener('click', () => {
    state.timeRange = { preset: 'last-30-days', customFrom: '', customTo: '' };
    preset.value = state.timeRange.preset;
    el('customRangeFrom').value = '';
    el('customRangeTo').value = '';
    customControls.hidden = true;
    renderTimeBoundSections();
  });
}

function renderTimeBoundSections() {
  const bounds = getSelectedTimeRange();
  const historySnapshots = filterSnapshots(state.historySnapshots, bounds);
  const latest = historySnapshots.at(-1);
  const first = historySnapshots.length > 1 ? historySnapshots[0] : null;
  text('deltaProducts', formatDelta(latest?.productCount, first?.productCount));
  text('deltaVariants', formatDelta(latest?.variantCount, first?.variantCount));
  text('deltaStock', formatDelta(latest?.totalStock, first?.totalStock));
  text('deltaQuality', formatDelta(latest?.readyForImport, first?.readyForImport, '%'));
  renderHistoryChart(historySnapshots);
  renderHistoryTable(historySnapshots);
  renderMovementForRange(bounds);
  updateTimeRangeSummary(bounds, historySnapshots);
}

function getSelectedTimeRange() {
  const anchor = getLatestSnapshotDate() || new Date();
  const preset = state.timeRange.preset;
  if (preset === 'custom') return getCustomRange(anchor);
  if (preset === 'last-24-hours') return { label: 'Last 24 hours', from: new Date(anchor.getTime() - DAY_MS), to: anchor };
  if (preset.startsWith('last-')) {
    const days = toNumber(preset.match(/^last-(\d+)-days$/)?.[1]);
    return { label: labelForPreset(preset), from: startOfDay(addDays(anchor, -(days - 1))), to: endOfDay(anchor) };
  }
  if (preset === 'today') return { label: 'Today', from: startOfDay(anchor), to: endOfDay(anchor) };
  if (preset === 'yesterday') return { label: 'Yesterday', from: startOfDay(addDays(anchor, -1)), to: endOfDay(addDays(anchor, -1)) };
  if (preset === 'this-week') return { label: 'This week', from: startOfWeek(anchor), to: endOfDay(anchor) };
  if (preset === 'previous-week') {
    const thisWeek = startOfWeek(anchor);
    const previousWeek = addDays(thisWeek, -7);
    return { label: 'Previous week', from: previousWeek, to: endOfDay(addDays(previousWeek, 6)) };
  }
  if (preset === 'this-month') return { label: 'This month', from: new Date(anchor.getFullYear(), anchor.getMonth(), 1), to: endOfDay(anchor) };
  if (preset === 'previous-month') return { label: 'Previous month', from: new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1), to: endOfDay(new Date(anchor.getFullYear(), anchor.getMonth(), 0)) };
  if (preset === 'month-to-date') return { label: 'Month to date', from: new Date(anchor.getFullYear(), anchor.getMonth(), 1), to: anchor };
  if (preset === 'quarter-to-date') return { label: 'Quarter to date', from: startOfQuarter(anchor), to: anchor };
  if (preset === 'this-quarter') return { label: 'This quarter', from: startOfQuarter(anchor), to: endOfDay(anchor) };
  if (preset === 'previous-quarter') {
    const quarterStart = startOfQuarter(anchor);
    const previousStart = new Date(quarterStart.getFullYear(), quarterStart.getMonth() - 3, 1);
    return { label: 'Previous quarter', from: previousStart, to: endOfDay(new Date(quarterStart.getFullYear(), quarterStart.getMonth(), 0)) };
  }
  return { label: 'Last 30 days', from: startOfDay(addDays(anchor, -29)), to: endOfDay(anchor) };
}

function getCustomRange(anchor) {
  const from = parseDateInput(state.timeRange.customFrom) || getEarliestSnapshotDate() || startOfDay(addDays(anchor, -29));
  const to = parseDateInput(state.timeRange.customTo, true) || endOfDay(anchor);
  return { label: 'Selected range', from, to };
}

function renderMovementForRange(bounds) {
  const endpoints = getProductRangeEndpoints(bounds);
  if (!endpoints) {
    renderLegacyChanges();
    return;
  }
  const { start, end } = endpoints;
  const startProducts = new Map(start.products.map((product) => [product.id, product]));
  const endProducts = new Map(end.products.map((product) => [product.id, product]));
  const snapshotsInRange = filterSnapshots(state.productHistorySnapshots, bounds);
  const firstSeenDates = buildFirstSeenDates(snapshotsInRange);
  const newProducts = [...endProducts.values()]
    .filter((product) => !startProducts.has(product.id))
    .map((product) => ({ ...product, firstSeenAt: firstSeenDates.get(product.id) || end.generatedAt }))
    .sort((a, b) => new Date(a.firstSeenAt) - new Date(b.firstSeenAt) || b.stock - a.stock)
    .slice(0, 12);
  const stockDrops = [...endProducts.values()]
    .map((product) => {
      const previous = startProducts.get(product.id);
      if (!previous) return null;
      const delta = product.stock - previous.stock;
      if (delta >= 0) return null;
      return { ...product, previousStock: previous.stock, currentStock: product.stock, delta };
    })
    .filter(Boolean)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 12);
  renderNewProducts(newProducts);
  renderStockMovers(stockDrops);
}

function renderLegacyChanges() {
  const newProducts = Array.isArray(state.changes?.newProducts) ? state.changes.newProducts : [];
  const stockDrops = Array.isArray(state.changes?.stockDrops) ? state.changes.stockDrops : [];
  renderNewProducts(newProducts.map((item) => ({ ...item, firstSeenAt: item.firstSeenAt || state.changes?.generatedAt })));
  renderStockMovers(stockDrops);
}

function renderNewProducts(newProducts) {
  el('newProductsBody').innerHTML = newProducts.slice(0, 12).map((item) => `<tr><td>${renderProductLink(item.title || item.handle || '-', item.productUrl)}</td><td>${escapeHtml(item.productType || '-')}</td><td>${shortDate(item.firstSeenAt)}</td><td>${INT.format(item.stock || 0)}</td></tr>`).join('') || '<tr><td colspan="4">No newly added products detected in this range.</td></tr>';
}

function renderStockMovers(stockDrops) {
  el('stockMoversBody').innerHTML = stockDrops.slice(0, 12).map((item) => `<tr><td>${renderProductLink(item.title || item.handle || '-', item.productUrl)}</td><td>${INT.format(item.previousStock || 0)}</td><td>${INT.format(item.currentStock || 0)}</td><td><span class="badge stock-out">${INT.format(item.delta || 0)}</span></td></tr>`).join('') || '<tr><td colspan="4">No stock decreases detected in this range.</td></tr>';
}

function getProductRangeEndpoints(bounds) {
  if (state.productHistorySnapshots.length < 2) return null;
  const snapshots = filterSnapshots(state.productHistorySnapshots, bounds);
  if (snapshots.length >= 2) return { start: snapshots[0], end: snapshots.at(-1) };
  const beforeEnd = state.productHistorySnapshots.filter((snapshot) => new Date(snapshot.generatedAt) <= bounds.to);
  const end = beforeEnd.at(-1);
  if (!end) return null;
  const start = beforeEnd.find((snapshot) => new Date(snapshot.generatedAt) >= bounds.from) || beforeEnd[0];
  if (!start || start.generatedAt === end.generatedAt) return null;
  return { start, end };
}

function buildFirstSeenDates(snapshots) {
  const seen = new Map();
  for (const snapshot of snapshots) {
    for (const product of snapshot.products) {
      if (!seen.has(product.id)) seen.set(product.id, snapshot.generatedAt);
    }
  }
  return seen;
}

function filterSnapshots(snapshots, bounds) {
  return snapshots.filter((snapshot) => {
    const date = new Date(snapshot.generatedAt);
    return !Number.isNaN(date.valueOf()) && date >= bounds.from && date <= bounds.to;
  });
}

function updateTimeRangeSummary(bounds, visibleHistory) {
  const availableStart = getEarliestSnapshotDate();
  const availableEnd = getLatestSnapshotDate();
  const visibleText = visibleHistory.length ? `${INT.format(visibleHistory.length)} recovery snapshots in range` : 'No recovery snapshots in range';
  const movementText = state.productHistorySnapshots.length >= 2 ? `${INT.format(state.productHistorySnapshots.length)} product snapshots available` : 'Product movement will expand after the next feed run';
  const availableText = availableStart && availableEnd ? `Available: ${formatDateOnly(availableStart)} - ${formatDateOnly(availableEnd)}` : 'Available snapshots: none yet';
  text('timeRangeSummary', `${bounds.label}: ${formatDateOnly(bounds.from)} - ${formatDateOnly(bounds.to)}. ${availableText}. ${visibleText}; ${movementText}.`);
}

function getLatestSnapshotDate() {
  const dates = [...state.historySnapshots, ...state.productHistorySnapshots].map((snapshot) => new Date(snapshot.generatedAt)).filter((date) => !Number.isNaN(date.valueOf()));
  return dates.sort((a, b) => b - a)[0] ?? null;
}

function getEarliestSnapshotDate() {
  const dates = [...state.historySnapshots, ...state.productHistorySnapshots].map((snapshot) => new Date(snapshot.generatedAt)).filter((date) => !Number.isNaN(date.valueOf()));
  return dates.sort((a, b) => a - b)[0] ?? null;
}

function labelForPreset(preset) {
  return preset.replace(/^last-/, 'Last ').replace(/-/g, ' ');
}

function renderHistoryChart(snapshots) {
  destroyCharts(['history']);
  if (snapshots.length === 0) { el('historyBody').innerHTML = '<tr><td colspan="5">No history available yet.</td></tr>'; return; }
  state.charts.history = new Chart(el('historyChart'), { type: 'line', data: { labels: snapshots.map((snapshot) => shortDate(snapshot.generatedAt)), datasets: [{ label: 'Variants', data: snapshots.map((snapshot) => snapshot.variantCount), borderColor: '#6f91a8', backgroundColor: '#6f91a8', tension: 0.3, yAxisID: 'y' }, { label: 'Stock', data: snapshots.map((snapshot) => snapshot.totalStock), borderColor: '#376b5d', backgroundColor: '#376b5d', tension: 0.3, yAxisID: 'y' }, { label: 'Ready %', data: snapshots.map((snapshot) => snapshot.readyForImport), borderColor: '#d78f7a', backgroundColor: '#d78f7a', tension: 0.3, yAxisID: 'quality' }] }, options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, quality: { beginAtZero: true, max: 100, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (value) => `${value}%` } } } } });
}

function renderHistoryTable(snapshots) {
  const rows = snapshots.slice(-10).reverse().map((snapshot) => `<tr><td>${shortDate(snapshot.generatedAt)}</td><td>${INT.format(snapshot.productCount)}</td><td>${INT.format(snapshot.variantCount)}</td><td>${INT.format(snapshot.totalStock)}</td><td>${INT.format(snapshot.readyForImport)}%</td></tr>`).join('');
  el('historyBody').innerHTML = rows || '<tr><td colspan="5">No history available yet.</td></tr>';
}

function chartOptions(extra = {}) { return { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: extra.indexAxis ? undefined : { y: { beginAtZero: true, ticks: { precision: 0 } } }, ...extra }; }
function destroyCharts(keys = Object.keys(state.charts)) { keys.forEach((key) => { state.charts[key]?.destroy(); delete state.charts[key]; }); }

function renderProductTypes(productTypes) {
  const rows = productTypes.slice(0, 12).map((item) => `<tr><td>${escapeHtml(item.type)}</td><td>${INT.format(item.variants)}</td><td>${INT.format(item.stock)}</td><td>${item.averagePrice ? EURO.format(item.averagePrice) : '-'}</td></tr>`).join('');
  el('productTypesBody').innerHTML = rows || '<tr><td colspan="4">No product types found.</td></tr>';
}

function renderBrandBreakdown(brands) {
  const rows = brands.slice(0, 12).map((item) => `<tr><td>${escapeHtml(item.brand)}</td><td>${INT.format(item.variants)}</td><td>${INT.format(item.stock)}</td><td>${item.averagePrice ? EURO.format(item.averagePrice) : '-'}</td></tr>`).join('');
  el('brandBody').innerHTML = rows || '<tr><td colspan="4">No brands found.</td></tr>';
}

function renderAudienceBreakdown(audiences) {
  const rows = audiences.slice(0, 12).map((item) => `<tr><td>${escapeHtml(item.audience)}</td><td>${INT.format(item.variants)}</td><td>${INT.format(item.stock)}</td><td>${item.averagePrice ? EURO.format(item.averagePrice) : '-'}</td></tr>`).join('');
  el('audienceBody').innerHTML = rows || '<tr><td colspan="4">No audience data found.</td></tr>';
}

function renderPricingAlerts(rows) {
  el('pricingAlertsBody').innerHTML = rows.map((row) => `<tr><td>${escapeHtml(row.variant_sku || '-')}</td><td class="product-cell"><strong>${escapeHtml(row.product_title || '-')}</strong><span>${escapeHtml([row.option1_value, row.option2_value].filter(Boolean).join(' / '))}</span></td><td>${row.costPerUnit ? EURO.format(row.costPerUnit) : '-'}</td><td>${row.msrpPerUnit ? EURO.format(row.msrpPerUnit) : '-'}</td><td><span class="badge attention">${escapeHtml(row.pricingStatus)}</span></td></tr>`).join('') || '<tr><td colspan="5">No pricing alerts.</td></tr>';
}

function renderStockWatch(items) {
  el('stockWatchBody').innerHTML = items.map((item) => `<tr><td>${renderProductLink(item.title || '-', item.url)}</td><td>${escapeHtml(item.brand || '-')}</td><td><span class="badge ${item.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(item.stock)}</span></td><td>${INT.format(item.outVariants)} / ${INT.format(item.variants)}</td></tr>`).join('') || '<tr><td colspan="4">No stock anomaly for this scope.</td></tr>';
}

function populateFilters(rows) {
  setOptions(el('brandFilter'), [...new Set(rows.map((row) => row.brandName).filter(Boolean))].sort(), 'All brands');
  setOptions(el('typeFilter'), [...new Set(rows.map((row) => row.productType).filter(Boolean))].sort(), 'All product types');
  setOptions(el('genderFilter'), [...new Set(rows.map((row) => row.genderName).filter(Boolean))].sort(), 'All genders');
  setOptions(el('ageFilter'), [...new Set(rows.map((row) => row.ageGroup).filter(Boolean))].sort(), 'All ages');
  setOptions(el('usageFilter'), [...new Set(rows.map((row) => row.usageName).filter(Boolean))].sort(), 'All usages');
}

function setOptions(select, options, firstLabel) {
  const current = select.value;
  select.innerHTML = `<option value="">${firstLabel}</option>${options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}`;
  select.value = options.includes(current) ? current : '';
}

function bindFilters() {
  ['searchInput', 'brandFilter', 'stockFilter', 'typeFilter', 'eanFilter', 'genderFilter', 'ageFilter', 'usageFilter', 'pricingFilter', 'packFilter'].forEach((id) => el(id).addEventListener('input', applyFilters));
  el('pageSizeSelect').addEventListener('input', () => { const value = el('pageSizeSelect').value; state.pageSize = value === 'all' ? Infinity : toNumber(value); renderCatalogueTable(); });
  el('groupProductsToggle').addEventListener('change', (event) => { state.groupProducts = event.target.checked; state.expandedProducts.clear(); applyFilters(); });
}

function bindCatalogActions() {
  el('clearFiltersButton').addEventListener('click', clearCatalogFilters);
  el('exportFilteredButton').addEventListener('click', exportFilteredCsv);
  el('activeFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter-key]');
    if (!button) return;
    clearFilter(button.dataset.filterKey);
  });
}

function bindHeaderScroll() {
  let ticking = false;
  const update = () => {
    document.body.classList.toggle('dashboard-scrolled', window.scrollY > 32);
    ticking = false;
  };
  const request = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  };
  window.addEventListener('scroll', request, { passive: true });
  update();
}

function bindSorting() {
  document.querySelector('.catalog-table thead').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sort]');
    if (!button) return;
    const key = button.dataset.sort;
    const sameKey = state.sort.key === key;
    state.sort = { key, direction: sameKey && state.sort.direction === 'asc' ? 'desc' : 'asc' };
    applyFilters();
  });
}

function bindGroupedRows() {
  el('variantsBody').addEventListener('click', (event) => {
    const button = event.target.closest('[data-expand-product]');
    if (!button) return;
    const key = button.dataset.expandProduct;
    if (state.expandedProducts.has(key)) state.expandedProducts.delete(key);
    else state.expandedProducts.add(key);
    renderCatalogueTable();
  });
}

function applyFilters() {
  const search = clean(el('searchInput').value).toLowerCase();
  const brand = el('brandFilter').value;
  const stock = el('stockFilter').value;
  const type = el('typeFilter').value;
  const ean = el('eanFilter').value;
  const gender = el('genderFilter').value;
  const age = el('ageFilter').value;
  const usage = el('usageFilter').value;
  const pricing = el('pricingFilter').value;
  const pack = el('packFilter').value;
  const variants = uniqueRows(getScopedRows(state.rows), variantKey);
  state.filteredRows = variants.filter((row) => {
    const matchesSearch = !search || [row.variant_sku, row.product_title, row.barcode, row.productType, row.brandName, row.option1_value, row.option2_value, row.usageName].some((value) => clean(value).toLowerCase().includes(search));
    const matchesBrand = !brand || row.brandName === brand;
    const matchesStock = !stock || (stock === 'in' ? row.stock > 0 : row.stock <= 0);
    const matchesType = !type || row.productType === type;
    const matchesEan = !ean || row.eanStatus === ean;
    const matchesGender = !gender || row.genderName === gender;
    const matchesAge = !age || row.ageGroup === age;
    const matchesUsage = !usage || row.usageName === usage;
    const matchesPricing = !pricing || matchesPricingFilter(row, pricing);
    const matchesPack = !pack || (pack === 'pack' ? row.isPack : !row.isPack);
    return matchesSearch && matchesBrand && matchesStock && matchesType && matchesEan && matchesGender && matchesAge && matchesUsage && matchesPricing && matchesPack;
  });
  state.groupedRows = buildProductGroups(state.filteredRows);
  renderActiveFilters(state.filteredRows.length);
  renderCatalogueTable();
  updateSortButtonsStable();
}

function renderCatalogueTable() {
  renderCatalogHeader();
  if (state.groupProducts) renderGroupedProductTable();
  else renderVariantTable();
}

function renderCatalogHeader() {
  const table = document.querySelector('.catalog-table table');
  const head = document.querySelector('.catalog-table thead');
  table.classList.toggle('grouped-catalog', state.groupProducts);
  if (state.groupProducts) {
    head.innerHTML = '<tr><th><button class="sort-button" type="button" data-sort="variant_sku">Variants</button></th><th><button class="sort-button" type="button" data-sort="product_title">Product</button></th><th><button class="sort-button" type="button" data-sort="brand">Brand</button></th><th><button class="sort-button" type="button" data-sort="productType">Type / Usage</button></th><th><button class="sort-button" type="button" data-sort="option1_value">Colors</button></th><th><button class="sort-button" type="button" data-sort="cost">Pricing</button></th><th><button class="sort-button" type="button" data-sort="stock">Stock</button></th></tr>';
    return;
  }
  head.innerHTML = '<tr><th><button class="sort-button" type="button" data-sort="variant_sku">SKU</button></th><th><button class="sort-button" type="button" data-sort="barcode">Barcode</button></th><th><button class="sort-button" type="button" data-sort="brand">Brand</button></th><th><button class="sort-button" type="button" data-sort="product_title">Product</button></th><th><button class="sort-button" type="button" data-sort="option1_value">Color</button></th><th><button class="sort-button" type="button" data-sort="option2_value">Size</button></th><th><button class="sort-button" type="button" data-sort="productType">Type</button></th><th><button class="sort-button" type="button" data-sort="usage">Usage</button></th><th><button class="sort-button" type="button" data-sort="cost">Cost</button></th><th><button class="sort-button" type="button" data-sort="msrp">MSRP</button></th><th><button class="sort-button" type="button" data-sort="packQuantity">Pack</button></th><th><button class="sort-button" type="button" data-sort="stock">Stock</button></th></tr>';
}

function buildProductGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = productKey(row) || variantKey(row);
    const entry = groups.get(key) ?? { key, first: row, variants: [], stock: 0, priceMin: Infinity, priceMax: 0, msrpMin: Infinity, msrpMax: 0, badEans: 0, packs: 0 };
    entry.variants.push(row);
    entry.stock += row.stock;
    if (row.cost > 0) { entry.priceMin = Math.min(entry.priceMin, row.cost); entry.priceMax = Math.max(entry.priceMax, row.cost); }
    if (row.msrp > 0) { entry.msrpMin = Math.min(entry.msrpMin, row.msrp); entry.msrpMax = Math.max(entry.msrpMax, row.msrp); }
    if (row.isPack) entry.packs += 1;
    if (row.eanStatus === 'bad') entry.badEans += 1;
    groups.set(key, entry);
  }
  return sortProductGroups([...groups.values()]);
}

function sortProductGroups(groups) {
  const { key, direction } = state.sort;
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...groups].sort((a, b) => compareSortValue(groupSortValue(a, key), groupSortValue(b, key)) * multiplier);
}

function groupSortValue(group, key) {
  if (key === 'stock') return group.stock;
  if (key === 'cost') return group.priceMin === Infinity ? 0 : group.priceMin;
  if (key === 'msrp') return group.msrpMin === Infinity ? 0 : group.msrpMin;
  if (key === 'packQuantity') return group.packs;
  if (key === 'productType') return group.first.productType;
  if (key === 'brand') return group.first.brandName;
  if (key === 'option1_value') return [...new Set(group.variants.map((row) => clean(row.option1_value)).filter(Boolean))].join(' ');
  if (key === 'barcode') return group.badEans;
  if (key === 'variant_sku') return group.variants.length;
  return clean(group.first.product_title).toLowerCase();
}

function sortRows(rows) {
  const { key, direction } = state.sort;
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => compareSortValue(sortValue(a, key), sortValue(b, key)) * multiplier);
}

function sortValue(row, key) {
  if (key === 'cost' || key === 'stock' || key === 'msrp' || key === 'packQuantity') return row[key];
  if (key === 'productType') return row.productType;
  if (key === 'brand') return row.brandName;
  if (key === 'usage') return row.usageName;
  return clean(row[key]).toLowerCase();
}

function compareSortValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return (a || 0) - (b || 0);
  return String(a).localeCompare(String(b));
}

function updateSortButtons() {
  document.querySelectorAll('[data-sort]').forEach((button) => {
    const active = button.dataset.sort === state.sort.key;
    button.classList.toggle('active', active);
    button.textContent = `${button.textContent.replace(/ [↑↓]$/, '')}${active ? (state.sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}`;
  });
}

function renderVariantTable() {
  const sortedRows = sortRows(state.filteredRows);
  const limit = Number.isFinite(state.pageSize) ? state.pageSize : sortedRows.length;
  const visible = sortedRows.slice(0, limit);
  text('filterSummary', `Showing ${INT.format(visible.length)} of ${INT.format(sortedRows.length)} matching variants${sortedRows.length > visible.length ? ` (first ${INT.format(limit)} shown)` : ''}.`);
  text('resultCount', `${INT.format(sortedRows.length)} variants`);
  el('variantsBody').innerHTML = visible.map(renderVariantRow).join('') || '<tr><td colspan="12">No variants match the selected filters.</td></tr>';
}

function matchesPricingFilter(row, pricing) {
  if (pricing === 'ready') return row.pricingStatus === 'Ready';
  if (pricing === 'alert') return row.pricingStatus !== 'Ready';
  if (pricing === 'cost-above-msrp') return row.pricingStatus === 'Cost above MSRP';
  if (pricing === 'missing-price') return row.pricingStatus === 'Missing price';
  return true;
}

function renderGroupedProductTable() {
  const limit = Number.isFinite(state.pageSize) ? state.pageSize : state.groupedRows.length;
  const visible = state.groupedRows.slice(0, limit);
  text('filterSummary', `Showing ${INT.format(visible.length)} of ${INT.format(state.groupedRows.length)} matching products. Open a product to inspect sizes, EANs, pack rows, and stock.`);
  text('resultCount', `${INT.format(state.groupedRows.length)} products / ${INT.format(state.filteredRows.length)} variants`);
  el('variantsBody').innerHTML = visible.map(renderProductGroup).join('') || '<tr><td colspan="7">No products match the selected filters.</td></tr>';
}

function renderVariantRow(row) {
  return `<tr><td>${escapeHtml(row.variant_sku || '-')}</td><td>${renderBarcode(row)}</td><td>${escapeHtml(row.brandName)}</td><td class="product-cell"><strong>${renderProductLink(row.product_title || '-', row.product_url)}</strong><span>${escapeHtml([row.genderName, row.ageGroup].filter((item) => item && item !== 'Unspecified').join(' / '))}</span></td><td>${escapeHtml(row.option1_value || '-')}</td><td>${escapeHtml(row.option2_value || '-')}</td><td>${escapeHtml(row.productType)}</td><td>${escapeHtml(row.usageName)}</td><td>${row.cost ? EURO.format(row.cost) : '-'}</td><td>${row.msrp ? EURO.format(row.msrp) : '-'}</td><td>${renderPack(row)}</td><td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td></tr>`;
}

function renderProductGroup(group) {
  const expanded = state.expandedProducts.has(group.key);
  const priceText = group.priceMin === Infinity ? '-' : group.priceMin === group.priceMax ? EURO.format(group.priceMin) : `${EURO.format(group.priceMin)} - ${EURO.format(group.priceMax)}`;
  const msrpText = group.msrpMin === Infinity ? '-' : group.msrpMin === group.msrpMax ? EURO.format(group.msrpMin) : `${EURO.format(group.msrpMin)} - ${EURO.format(group.msrpMax)}`;
  const detailRow = expanded ? renderProductDrawer(group) : '';
  const colors = [...new Set(group.variants.map((row) => row.option1_value).filter(Boolean))];
  const alertCount = group.variants.filter((row) => row.eanStatus !== 'valid' || row.pricingStatus !== 'Ready' || row.stock <= 0).length;
  return `<tr class="product-group-row ${expanded ? 'expanded' : ''}"><td><button class="expand-button" type="button" data-expand-product="${escapeAttribute(group.key)}">${expanded ? 'Hide' : 'Show'} ${INT.format(group.variants.length)}</button>${alertCount ? `<span class="compact-alert">${INT.format(alertCount)} alerts</span>` : ''}</td><td class="product-cell"><strong>${renderProductLink(group.first.product_title || '-', group.first.product_url)}</strong><span>${escapeHtml([group.first.product_id, group.first.genderName, group.first.ageGroup].filter((item) => item && item !== 'Unspecified').join(' / '))}</span></td><td>${escapeHtml(group.first.brandName)}</td><td class="stacked-cell"><strong>${escapeHtml(group.first.productType)}</strong><span>${escapeHtml(group.first.usageName)}</span></td><td>${renderColorSwatches(colors)}</td><td class="price-stack"><span>Cost ${priceText}</span><span>MSRP ${msrpText}</span>${group.packs ? `<em>${INT.format(group.packs)} pack row${group.packs > 1 ? 's' : ''}</em>` : ''}</td><td><span class="badge ${group.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(group.stock)}</span></td></tr>${detailRow}`;
}

function renderProductDrawer(group) {
  const variants = [...group.variants].sort((a, b) => compareSortValue(a.option1_value, b.option1_value) || compareSortValue(a.option2_value, b.option2_value));
  const colors = [...new Set(variants.map((row) => row.option1_value).filter(Boolean))];
  const issueCount = variants.filter((row) => row.pricingStatus !== 'Ready' || row.eanStatus !== 'valid' || row.stock <= 0).length;
  const summary = [
    ['SKU', group.first.variant_sku || group.first.product_id || '-'],
    ['Colors', colors.join(', ') || '-'],
    ['Cost', group.priceMin === Infinity ? '-' : group.priceMin === group.priceMax ? EURO.format(group.priceMin) : `${EURO.format(group.priceMin)} - ${EURO.format(group.priceMax)}`],
    ['MSRP', group.msrpMin === Infinity ? '-' : group.msrpMin === group.msrpMax ? EURO.format(group.msrpMin) : `${EURO.format(group.msrpMin)} - ${EURO.format(group.msrpMax)}`],
    ['Packs', group.packs ? INT.format(group.packs) : '-'],
    ['Alerts', issueCount ? INT.format(issueCount) : '-']
  ];
  const rows = variants.map((row) => `<tr><td><strong>${escapeHtml(row.option2_value || '-')}</strong>${colors.length > 1 ? `<span>${escapeHtml(row.option1_value || '-')}</span>` : ''}</td><td>${row.eanStatus === 'valid' ? escapeHtml(row.barcode) : renderBarcode(row)}</td><td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td><td>${row.isPack ? `<span class="badge attention">${INT.format(row.packQuantity)}x</span>` : '-'}</td><td><span class="badge ${row.pricingStatus === 'Ready' ? 'active' : 'attention'}">${escapeHtml(row.pricingStatus)}</span></td></tr>`).join('');
  return `<tr class="variant-detail-row"><td colspan="7"><div class="product-drawer compact-drawer"><div class="drawer-summary">${summary.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div><div class="size-matrix"><table><thead><tr><th>Size</th><th>EAN</th><th>Stock</th><th>Pack</th><th>Pricing</th></tr></thead><tbody>${rows}</tbody></table></div></div></td></tr>`;
}

function renderColorSwatches(colors) {
  if (!colors.length) return '-';
  const visible = colors.slice(0, 3).map((color) => `<span>${escapeHtml(color)}</span>`).join('');
  const extra = colors.length > 3 ? `<em>+${INT.format(colors.length - 3)}</em>` : '';
  return `<div class="color-list">${visible}${extra}</div>`;
}

function renderPack(row) {
  if (!row.isPack) return '-';
  return `<span class="badge attention">${INT.format(row.packQuantity)}x</span>`;
}

function getPricingStatus(row) {
  if (row.costPerUnit <= 0 || row.msrpPerUnit <= 0) return 'Missing price';
  if (row.costPerUnit > row.msrpPerUnit) return 'Cost above MSRP';
  return 'Ready';
}

function renderActiveFilters(matchCount = state.filteredRows.length) {
  const filters = activeFilterItems();
  if (!filters.length) {
    el('activeFilters').innerHTML = `<span class="filter-empty">${INT.format(matchCount)} matching variants - no filters active</span>`;
  } else {
    el('activeFilters').innerHTML = filters.map((filter) => `
      <span class="filter-chip">
        <span>${escapeHtml(filter.label)}</span>
        ${escapeHtml(filter.value)}
        <button type="button" aria-label="Remove ${escapeAttribute(filter.label)} filter" data-filter-key="${escapeAttribute(filter.key)}">x</button>
      </span>
    `).join('');
  }
  el('clearFiltersButton').disabled = filters.length === 0;
  el('exportFilteredButton').disabled = matchCount === 0;
}

function activeFilterItems() {
  const stockLabels = { in: 'In stock', out: 'Out of stock' };
  const eanLabels = { valid: 'Valid EAN', bad: 'Bad EAN', missing: 'Missing barcode' };
  const pricingLabels = { ready: 'Ready', alert: 'Alerts only', 'cost-above-msrp': 'Cost above MSRP', 'missing-price': 'Missing price' };
  const packLabels = { pack: 'Packs only', single: 'Singles only' };
  return [
    clean(el('searchInput').value) && { key: 'search', label: 'Search', value: clean(el('searchInput').value) },
    el('brandFilter').value && { key: 'brand', label: 'Brand', value: el('brandFilter').value },
    el('stockFilter').value && { key: 'stock', label: 'Stock', value: stockLabels[el('stockFilter').value] || el('stockFilter').value },
    el('eanFilter').value && { key: 'ean', label: 'EAN', value: eanLabels[el('eanFilter').value] || el('eanFilter').value },
    el('typeFilter').value && { key: 'type', label: 'Type', value: el('typeFilter').value },
    el('genderFilter').value && { key: 'gender', label: 'Gender', value: el('genderFilter').value },
    el('ageFilter').value && { key: 'age', label: 'Age', value: el('ageFilter').value },
    el('usageFilter').value && { key: 'usage', label: 'Usage', value: el('usageFilter').value },
    el('pricingFilter').value && { key: 'pricing', label: 'Pricing', value: pricingLabels[el('pricingFilter').value] || el('pricingFilter').value },
    el('packFilter').value && { key: 'pack', label: 'Pack', value: packLabels[el('packFilter').value] || el('packFilter').value }
  ].filter(Boolean);
}

function clearFilter(key) {
  const fields = {
    search: 'searchInput',
    brand: 'brandFilter',
    stock: 'stockFilter',
    ean: 'eanFilter',
    type: 'typeFilter',
    gender: 'genderFilter',
    age: 'ageFilter',
    usage: 'usageFilter',
    pricing: 'pricingFilter',
    pack: 'packFilter'
  };
  const id = fields[key];
  if (id) el(id).value = '';
  applyFilters();
}

function clearCatalogFilters() {
  ['searchInput', 'brandFilter', 'stockFilter', 'eanFilter', 'typeFilter', 'genderFilter', 'ageFilter', 'usageFilter', 'pricingFilter', 'packFilter'].forEach((id) => { el(id).value = ''; });
  applyFilters();
}

function exportFilteredCsv() {
  const rows = sortRows(state.filteredRows);
  if (!rows.length) return;
  const headers = ['variant_sku', 'product_id', 'barcode', 'brand', 'product_title', 'color', 'size', 'product_type', 'usage', 'gender', 'age_group', 'cost_amount', 'compare_at_price', 'pack_quantity', 'inventory_available', 'pricing_status'];
  const lines = [
    headers.join(','),
    ...rows.map((row) => [
      row.variant_sku,
      row.product_id,
      row.barcode,
      row.brandName,
      row.product_title,
      row.option1_value,
      row.option2_value,
      row.productType,
      row.usageName,
      row.genderName,
      row.ageGroup,
      row.cost,
      row.msrp,
      row.packQuantity,
      row.stock,
      row.pricingStatus
    ].map(csvCell).join(','))
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `chauss-service-filtered-feed-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const textValue = String(value ?? '');
  if (/[",\n]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
  return textValue;
}

function updateSortButtonsStable() {
  document.querySelectorAll('[data-sort]').forEach((button) => {
    if (!button.dataset.label) button.dataset.label = button.textContent.trim();
    const active = button.dataset.sort === state.sort.key;
    button.classList.toggle('active', active);
    button.classList.toggle('asc', active && state.sort.direction === 'asc');
    button.classList.toggle('desc', active && state.sort.direction === 'desc');
    button.setAttribute('aria-sort', active ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    button.textContent = button.dataset.label;
  });
}

function renderProductLink(label, url) {
  const safeLabel = escapeHtml(label || '-');
  const safeUrl = clean(url);
  if (!safeUrl) return safeLabel;
  return `<a class="product-link" href="${escapeAttribute(safeUrl)}" target="_blank" rel="noopener">${safeLabel}</a>`;
}

function renderBarcode(row) {
  if (row.eanStatus === 'missing') return '<span class="ean-pill ean-missing">Missing</span>';
  const badgeClass = row.eanStatus === 'valid' ? 'ean-valid' : 'ean-bad';
  const label = row.eanStatus === 'valid' ? 'Valid EAN' : 'Bad EAN';
  return `<span>${escapeHtml(row.barcode)}</span><span class="ean-pill ${badgeClass}">${label}</span>`;
}

function getEanStatus(value) { const barcode = normalizeBarcode(value); if (!barcode) return 'missing'; return isValidEan(barcode) ? 'valid' : 'bad'; }
function normalizeBarcode(value) { return clean(value).replace(/[\s-]/g, ''); }
function isValidEan(value) {
  if (!/^\d{8}$|^\d{13}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checkDigit = digits.pop();
  const sum = digits.reduce((total, digit, index) => total + digit * (value.length === 13 ? (index % 2 === 0 ? 1 : 3) : (index % 2 === 0 ? 3 : 1)), 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function renderEmptyState() {
  ['totalProducts', 'totalVariants', 'totalStock', 'outOfStockVariants', 'fullyOutProducts', 'pricingAlertsCount', 'packVariants', 'readyForImport', 'missingBarcode', 'badEansDetail', 'missingSeoTitle', 'missingSeoDescription', 'missingImage', 'missingPrice', 'missingStock', 'negativeStock', 'outOfStockDetail', 'missingProductType', 'costAboveMsrp', 'missingMsrp', 'deltaProducts', 'deltaVariants', 'deltaStock', 'deltaQuality'].forEach((id) => text(id, '-'));
  text('lastUpdated', 'Last CSV update: unavailable');
  text('scopeSummary', 'No feed data available.');
  text('resultCount', '0 variants');
  text('timeRangeSummary', 'No snapshots available.');
  el('activeFilters').innerHTML = '<span class="filter-empty">0 matching variants - no filters active</span>';
  el('clearFiltersButton').disabled = true;
  el('exportFilteredButton').disabled = true;
  el('stockWatchBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('brandBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('pricingAlertsBody').innerHTML = '<tr><td colspan="5">No data available.</td></tr>';
  el('audienceBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('productTypesBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('newProductsBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('stockMoversBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('variantsBody').innerHTML = '<tr><td colspan="12">No data available.</td></tr>';
  el('historyBody').innerHTML = '<tr><td colspan="5">No history available.</td></tr>';
  destroyCharts();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const offset = (start.getDay() + 6) % 7;
  return addDays(start, -offset);
}

function startOfQuarter(date) {
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1);
}

function parseDateInput(value, end = false) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.valueOf())) return null;
  return end ? endOfDay(date) : startOfDay(date);
}

function formatDelta(current, previous, suffix = '') { if (current == null || previous == null) return '-'; const delta = current - previous; return `${delta > 0 ? '+' : ''}${INT.format(delta)}${suffix}`; }
function shortDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '-' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function formatDateOnly(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '-' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'unknown time' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function showAlert(message, visible) { const alert = el('alert'); alert.textContent = message; alert.hidden = !visible; }
function escapeHtml(value) { return clean(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
