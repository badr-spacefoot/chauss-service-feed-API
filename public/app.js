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
  groupProducts: false,
  statusScope: 'ACTIVE',
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
  bindStatusScope();
  bindTimeRange();
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
  normalized.packQuantity = Math.max(1, toNumber(normalized.pack_quantity) || 1);
  normalized.isPack = clean(normalized.is_pack).toLowerCase() === 'true' || normalized.packQuantity > 1;
  normalized.status = clean(normalized.product_status).toUpperCase() || 'UNKNOWN';
  normalized.productType = typeName(normalized);
  normalized.brandName = clean(normalized.brand) || 'Unbranded';
  normalized.genderName = clean(normalized.gender) || 'Unspecified';
  normalized.ageGroup = clean(normalized.age_group) || 'Unspecified';
  normalized.usageName = clean(normalized.usage) || 'Unspecified';
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
  text('activeVariants', INT.format(stats.packVariants));
  text('draftVariants', stats.averageCost ? EURO.format(stats.averageCost) : '-');
  text('totalStock', INT.format(stats.totalStock));
  text('variantsWithStock', INT.format(stats.variantsWithStock));
  text('badEans', stats.averageMsrp ? EURO.format(stats.averageMsrp) : '-');
  text('qualityScore', `${stats.qualityScore}%`);
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
  const lastGenerated = metadata?.generatedAt ? new Date(metadata.generatedAt) : stats.lastUpdated;
  text('lastUpdated', lastGenerated ? `Last CSV update: ${lastGenerated.toLocaleString()}` : 'Last CSV update: unavailable');
  renderCharts(stats);
  state.historySnapshots = normalizeHistory([...state.history, buildCurrentSnapshot(stats, metadata)]);
  state.productHistorySnapshots = normalizeProductHistory([...state.productHistory, buildCurrentProductSnapshot(dashboardRows, metadata)]);
  renderTimeBoundSections();
  renderProductTypes(stats.productTypes);
  renderBrandBreakdown(stats.brands);
  renderRecentUpdates(dashboardRows);
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
    averageCost,
    averageMsrp,
    missing,
    missingStock,
    badEans,
    negativeStockVariants,
    qualityScore,
    productTypes: groupProductTypes(variants),
    brands: groupByDimension(variants, 'brandName', 'brand'),
    usages: groupByDimension(variants, 'usageName', 'usage'),
    priceBuckets: buildPriceBuckets(variants),
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

function buildPriceBuckets(rows) {
  const buckets = [{ label: '0-10', min: 0, max: 10, count: 0 }, { label: '10-25', min: 10, max: 25, count: 0 }, { label: '25-50', min: 25, max: 50, count: 0 }, { label: '50-100', min: 50, max: 100, count: 0 }, { label: '100+', min: 100, max: Infinity, count: 0 }];
  for (const row of rows.filter((item) => item.price > 0)) buckets.find((bucket) => row.price >= bucket.min && row.price < bucket.max).count += 1;
  return buckets;
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
    .filter((product) => product.stock <= 0 || product.negativeVariants > 0 || product.outVariants === product.variants)
    .sort((a, b) => a.stock - b.stock || b.negativeVariants - a.negativeVariants || b.outVariants - a.outVariants)
    .slice(0, 12);
}

function renderCharts(stats) {
  destroyCharts(['status', 'stock', 'prices', 'missing']);
  const colors = ['#376b5d', '#d78f7a', '#6f91a8', '#9f7c54', '#8c9b6f', '#b76f89', '#5f8f86', '#d8b066'];
  const topBrands = stats.brands.slice(0, 8);
  state.charts.status = new Chart(el('statusChart'), { type: 'doughnut', data: { labels: topBrands.map((item) => item.brand), datasets: [{ data: topBrands.map((item) => item.variants), backgroundColor: colors, borderWidth: 0 }] }, options: chartOptions() });
  const topStockTypes = stats.productTypes.slice(0, 8);
  state.charts.stock = new Chart(el('stockTypeChart'), { type: 'bar', data: { labels: topStockTypes.map((item) => item.type), datasets: [{ label: 'Available stock', data: topStockTypes.map((item) => item.stock), backgroundColor: colors }] }, options: chartOptions({ indexAxis: 'y' }) });
  state.charts.prices = new Chart(el('priceChart'), { type: 'bar', data: { labels: stats.priceBuckets.map((bucket) => bucket.label), datasets: [{ label: 'Variants', data: stats.priceBuckets.map((bucket) => bucket.count), backgroundColor: '#6f91a8' }] }, options: chartOptions() });
  const topUsages = stats.usages.slice(0, 8);
  state.charts.missing = new Chart(el('missingChart'), { type: 'bar', data: { labels: topUsages.map((item) => item.usage), datasets: [{ label: 'Variants', data: topUsages.map((item) => item.variants), backgroundColor: colors }] }, options: chartOptions({ indexAxis: 'y' }) });
}

function buildCurrentSnapshot(stats, metadata) {
  return { generatedAt: metadata?.generatedAt || new Date().toISOString(), productCount: stats.totalProducts, variantCount: stats.totalVariants, activeVariants: stats.activeVariants, draftVariants: stats.draftVariants, totalStock: stats.totalStock, variantsWithStock: stats.variantsWithStock, variantsOutOfStock: stats.variantsOutOfStock, qualityScore: stats.qualityScore, badEans: stats.badEans, rowCount: metadata?.rowCount ?? stats.totalVariants };
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
    byDate.set(date.toISOString().slice(0, 10), { generatedAt: date.toISOString(), productCount: toNumber(snapshot.productCount), variantCount: toNumber(snapshot.variantCount ?? snapshot.rowCount), totalStock: toNumber(snapshot.totalStock), qualityScore: toNumber(snapshot.qualityScore), badEans: toNumber(snapshot.badEans), rowCount: toNumber(snapshot.rowCount) });
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
  text('deltaQuality', formatDelta(latest?.qualityScore, first?.qualityScore, '%'));
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
  state.charts.history = new Chart(el('historyChart'), { type: 'line', data: { labels: snapshots.map((snapshot) => shortDate(snapshot.generatedAt)), datasets: [{ label: 'Variants', data: snapshots.map((snapshot) => snapshot.variantCount), borderColor: '#6f91a8', backgroundColor: '#6f91a8', tension: 0.3, yAxisID: 'y' }, { label: 'Stock', data: snapshots.map((snapshot) => snapshot.totalStock), borderColor: '#376b5d', backgroundColor: '#376b5d', tension: 0.3, yAxisID: 'y' }, { label: 'Quality %', data: snapshots.map((snapshot) => snapshot.qualityScore), borderColor: '#d78f7a', backgroundColor: '#d78f7a', tension: 0.3, yAxisID: 'quality' }] }, options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, quality: { beginAtZero: true, max: 100, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (value) => `${value}%` } } } } });
}

function renderHistoryTable(snapshots) {
  const rows = snapshots.slice(-10).reverse().map((snapshot) => `<tr><td>${shortDate(snapshot.generatedAt)}</td><td>${INT.format(snapshot.productCount)}</td><td>${INT.format(snapshot.variantCount)}</td><td>${INT.format(snapshot.totalStock)}</td><td>${INT.format(snapshot.qualityScore)}%</td></tr>`).join('');
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

function renderRecentUpdates(rows) {
  const recent = uniqueRows(rows, variantKey).filter((row) => row.updatedDate).sort((a, b) => b.updatedDate - a.updatedDate).slice(0, 10);
  el('recentUpdatesBody').innerHTML = recent.map((row) => `<tr><td>${row.updatedDate.toLocaleString()}</td><td>${escapeHtml(row.variant_sku || '-')}</td><td>${escapeHtml(row.brandName)}</td><td>${renderProductLink(row.product_title || '-', row.product_url)}</td><td>${INT.format(row.stock)}</td></tr>`).join('') || '<tr><td colspan="5">No update dates found.</td></tr>';
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
  ['searchInput', 'brandFilter', 'stockFilter', 'typeFilter', 'eanFilter', 'genderFilter', 'ageFilter', 'usageFilter', 'packFilter'].forEach((id) => el(id).addEventListener('input', applyFilters));
  el('pageSizeSelect').addEventListener('input', () => { const value = el('pageSizeSelect').value; state.pageSize = value === 'all' ? Infinity : toNumber(value); renderCatalogueTable(); });
  el('groupProductsToggle').addEventListener('change', (event) => { state.groupProducts = event.target.checked; state.expandedProducts.clear(); applyFilters(); });
}

function bindStatusScope() {
  document.querySelectorAll('[data-status-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      state.statusScope = button.dataset.statusScope;
      state.expandedProducts.clear();
      document.querySelectorAll('[data-status-scope]').forEach((item) => item.classList.toggle('active', item === button));
      renderDashboard({ generatedAt: getLatestSnapshotDate()?.toISOString() || new Date().toISOString() });
    });
  });
}

function bindSorting() {
  document.querySelectorAll('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      const sameKey = state.sort.key === key;
      state.sort = { key, direction: sameKey && state.sort.direction === 'asc' ? 'desc' : 'asc' };
      applyFilters();
    });
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
    const matchesPack = !pack || (pack === 'pack' ? row.isPack : !row.isPack);
    return matchesSearch && matchesBrand && matchesStock && matchesType && matchesEan && matchesGender && matchesAge && matchesUsage && matchesPack;
  });
  state.groupedRows = buildProductGroups(state.filteredRows);
  renderCatalogueTable();
  updateSortButtons();
}

function renderCatalogueTable() {
  if (state.groupProducts) renderGroupedProductTable();
  else renderVariantTable();
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
  el('variantsBody').innerHTML = visible.map(renderVariantRow).join('') || '<tr><td colspan="12">No variants match the selected filters.</td></tr>';
}

function renderGroupedProductTable() {
  const limit = Number.isFinite(state.pageSize) ? state.pageSize : state.groupedRows.length;
  const visible = state.groupedRows.slice(0, limit);
  text('filterSummary', `Showing ${INT.format(visible.length)} of ${INT.format(state.groupedRows.length)} matching products. Click a product row to see sizes and EANs.`);
  el('variantsBody').innerHTML = visible.map(renderProductGroup).join('') || '<tr><td colspan="12">No products match the selected filters.</td></tr>';
}

function renderVariantRow(row) {
  return `<tr><td>${escapeHtml(row.variant_sku || '-')}</td><td>${renderBarcode(row)}</td><td>${escapeHtml(row.brandName)}</td><td class="product-cell"><strong>${renderProductLink(row.product_title || '-', row.product_url)}</strong><span>${escapeHtml([row.genderName, row.ageGroup].filter((item) => item && item !== 'Unspecified').join(' / '))}</span></td><td>${escapeHtml(row.option1_value || '-')}</td><td>${escapeHtml(row.option2_value || '-')}</td><td>${escapeHtml(row.productType)}</td><td>${escapeHtml(row.usageName)}</td><td>${row.cost ? EURO.format(row.cost) : '-'}</td><td>${row.msrp ? EURO.format(row.msrp) : '-'}</td><td>${renderPack(row)}</td><td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td></tr>`;
}

function renderProductGroup(group) {
  const expanded = state.expandedProducts.has(group.key);
  const priceText = group.priceMin === Infinity ? '-' : group.priceMin === group.priceMax ? EURO.format(group.priceMin) : `${EURO.format(group.priceMin)} - ${EURO.format(group.priceMax)}`;
  const msrpText = group.msrpMin === Infinity ? '-' : group.msrpMin === group.msrpMax ? EURO.format(group.msrpMin) : `${EURO.format(group.msrpMin)} - ${EURO.format(group.msrpMax)}`;
  const childRows = expanded ? group.variants.map(renderVariantRow).join('') : '';
  return `<tr class="product-group-row"><td><button class="expand-button" type="button" data-expand-product="${escapeAttribute(group.key)}">${expanded ? 'Hide' : 'Show'} ${INT.format(group.variants.length)}</button></td><td>${group.badEans ? `<span class="ean-pill ean-bad">${INT.format(group.badEans)} bad EAN</span>` : '<span class="ean-pill ean-valid">EAN OK</span>'}</td><td>${escapeHtml(group.first.brandName)}</td><td class="product-cell"><strong>${renderProductLink(group.first.product_title || '-', group.first.product_url)}</strong><span>${escapeHtml(group.first.product_handle || '')}</span></td><td>-</td><td>-</td><td>${escapeHtml(group.first.productType)}</td><td>${escapeHtml(group.first.usageName)}</td><td>${priceText}</td><td>${msrpText}</td><td>${group.packs ? `${INT.format(group.packs)} packs` : '-'}</td><td><span class="badge ${group.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(group.stock)}</span></td></tr>${childRows}`;
}

function renderPack(row) {
  if (!row.isPack) return '-';
  return `<span class="badge attention">${INT.format(row.packQuantity)}x</span>`;
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
  ['totalProducts', 'totalVariants', 'activeVariants', 'draftVariants', 'totalStock', 'variantsWithStock', 'badEans', 'qualityScore', 'missingBarcode', 'badEansDetail', 'missingSeoTitle', 'missingSeoDescription', 'missingImage', 'missingPrice', 'missingStock', 'negativeStock', 'outOfStockDetail', 'missingProductType', 'deltaProducts', 'deltaVariants', 'deltaStock', 'deltaQuality'].forEach((id) => text(id, '-'));
  text('lastUpdated', 'Last CSV update: unavailable');
  text('scopeSummary', 'No feed data available.');
  text('timeRangeSummary', 'No snapshots available.');
  el('stockWatchBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('brandBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('productTypesBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('recentUpdatesBody').innerHTML = '<tr><td colspan="5">No data available.</td></tr>';
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
