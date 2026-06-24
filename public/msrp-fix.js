const PRICE_QUALITY_VERSION = '2026-06-24-chauss-service-price-quality';
const UI_POLISH_VERSION = '2026-06-06-header-footer-polish';
const WORKFLOW_PAGE_URL = 'https://github.com/badr-spacefoot/chauss-service-feed-api/actions/workflows/generate-feed.yml';
let workflowButtonTimer = null;

function hasValidMsrp(row) {
  return isPresent(row.price_amount) && row.price > 0;
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
  const missing = Object.fromEntries([...REQUIRED_FIELDS, 'barcode', 'seo_title', 'seo_description'].map((field) => [field, variants.filter((row) => !isPresent(row[field])).length]));
  missing.price_amount = variants.filter((row) => !hasValidMsrp(row)).length;
  const badEans = variants.filter((row) => row.eanStatus === 'bad').length;
  const requiredFieldScore = variants.reduce((sum, row) => {
    return sum + REQUIRED_FIELDS.filter((field) => field === 'price_amount' ? hasValidMsrp(row) : isPresent(row[field])).length;
  }, 0);
  const totalRequiredFields = variants.length * REQUIRED_FIELDS.length;
  const qualityScore = totalRequiredFields ? Math.round((requiredFieldScore / totalRequiredFields) * 100) : 0;
  const missingStock = variants.filter((row) => !isPresent(row.inventory_available)).length;
  const lastUpdated = variants.map((row) => row.updatedDate).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  const negativeStockVariants = variants.filter((row) => row.stock < 0).length;
  return {
    totalProducts: products.size,
    totalVariants: variants.length,
    activeVariants,
    draftVariants,
    archivedVariants,
    totalStock,
    variantsWithStock,
    variantsOutOfStock,
    missing,
    missingStock,
    badEans,
    negativeStockVariants,
    qualityScore,
    productTypes: groupProductTypes(variants),
    priceBuckets: buildPriceBuckets(variants),
    stockWatch: buildStockWatch(variants),
    seoWatch: buildSeoWatch(variants),
    lastUpdated
  };
}

function renderCharts(stats) {
  destroyCharts(['status', 'stock', 'prices', 'missing']);
  const colors = ['#376b5d', '#d78f7a', '#6f91a8', '#9f7c54', '#8c9b6f', '#b76f89', '#5f8f86', '#d8b066'];
  state.charts.status = new Chart(el('statusChart'), { type: 'doughnut', data: { labels: ['Active', 'Archived', 'Draft/other'], datasets: [{ data: [stats.activeVariants, stats.archivedVariants, Math.max(0, stats.totalVariants - stats.activeVariants - stats.archivedVariants)], backgroundColor: ['#376b5d', '#b8b6a7', '#d8b066'], borderWidth: 0 }] }, options: chartOptions() });
  const topStockTypes = stats.productTypes.slice(0, 8);
  state.charts.stock = new Chart(el('stockTypeChart'), { type: 'bar', data: { labels: topStockTypes.map((item) => item.type), datasets: [{ label: 'Available stock', data: topStockTypes.map((item) => item.stock), backgroundColor: colors }] }, options: chartOptions({ indexAxis: 'y' }) });
  state.charts.prices = new Chart(el('priceChart'), { type: 'bar', data: { labels: stats.priceBuckets.map((bucket) => bucket.label), datasets: [{ label: 'Variants', data: stats.priceBuckets.map((bucket) => bucket.count), backgroundColor: '#6f91a8' }] }, options: chartOptions() });
  state.charts.missing = new Chart(el('missingChart'), { type: 'bar', data: { labels: ['Missing SKU', 'Missing barcode', 'Missing SEO title', 'Missing SEO desc.', 'Missing stock', 'Missing type'], datasets: [{ label: 'Variants', data: [stats.missing.variant_sku, stats.missing.barcode, stats.missing.seo_title, stats.missing.seo_description, stats.missingStock, stats.missing.product_type], backgroundColor: '#d78f7a' }] }, options: chartOptions() });
}

function renderVariantRow(row) {
  return `<tr><td>${renderThumbnail(row)}</td><td>${escapeHtml(row.variant_sku || '-')}</td><td>${renderBarcode(row)}</td><td class="product-cell"><strong>${renderProductLink(row.product_title || '-', row.product_url)}</strong><span>${escapeHtml(row.product_handle || '')}</span></td><td>${escapeHtml(row.productType)}</td><td><span class="badge ${row.status.toLowerCase()}">${escapeHtml(row.status)}</span></td><td>${hasValidMsrp(row) ? EURO.format(row.price) : '-'}</td><td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td></tr>`;
}

function renderProductGroup(group) {
  const expanded = state.expandedProducts.has(group.key);
  const validPrices = group.variants.filter(hasValidMsrp).map((row) => row.price);
  const priceMin = validPrices.length ? Math.min(...validPrices) : Infinity;
  const priceMax = validPrices.length ? Math.max(...validPrices) : 0;
  const priceText = priceMin === Infinity ? '-' : priceMin === priceMax ? EURO.format(priceMin) : `${EURO.format(priceMin)} - ${EURO.format(priceMax)}`;
  const childRows = expanded ? group.variants.map((row) => `<tr class="variant-detail-row"><td></td><td>${escapeHtml(row.variant_sku || '-')}</td><td>${renderBarcode(row)}</td><td>${escapeHtml([row.option1_value, row.option2_value, row.option3_value].filter(Boolean).join(' / ') || row.product_title || '-')}</td><td>${escapeHtml(row.productType)}</td><td><span class="badge ${row.status.toLowerCase()}">${escapeHtml(row.status)}</span></td><td>${hasValidMsrp(row) ? EURO.format(row.price) : '-'}</td><td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td></tr>`).join('') : '';
  const missingBarcodes = group.variants.filter((row) => row.eanStatus === 'missing').length;
  const barcodePill = group.badEans
    ? `<span class="ean-pill ean-bad">${INT.format(group.badEans)} bad EAN</span>`
    : missingBarcodes
      ? `<span class="ean-pill ean-missing">${INT.format(missingBarcodes)} missing</span>`
      : '<span class="ean-pill ean-valid">EAN OK</span>';
  return `<tr class="product-group-row"><td>${renderThumbnail(group.first)}</td><td><button class="expand-button" type="button" data-expand-product="${escapeAttribute(group.key)}">${expanded ? 'Hide' : 'Show'} ${INT.format(group.variants.length)}</button></td><td>${barcodePill}</td><td class="product-cell"><strong>${renderProductLink(group.first.product_title || '-', group.first.product_url)}</strong><span>${escapeHtml(group.first.product_handle || '')}</span></td><td>${escapeHtml(group.first.productType)}</td><td><span class="badge ${group.first.status.toLowerCase()}">${escapeHtml(group.first.status)}</span></td><td>${priceText}</td><td><span class="badge ${group.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(group.stock)}</span></td></tr>${childRows}`;
}

window.addEventListener('DOMContentLoaded', () => {
  addUiPolishStyles();
  addSafeWorkflowButton();
  addDashboardFooter();
  refreshSafeWorkflowButton();
});

function addSafeWorkflowButton() {
  const actions = document.querySelector('.hero-actions');
  if (!actions || el('runWorkflowButton')) return;
  const button = document.createElement('button');
  button.id = 'runWorkflowButton';
  button.className = 'button secondary';
  button.type = 'button';
  button.textContent = 'Run workflow';
  button.addEventListener('click', openWorkflowIfReady);
  actions.appendChild(button);
}

function addDashboardFooter() {
  const shell = document.querySelector('.page-shell');
  if (!shell || document.querySelector('.site-footer')) return;
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <p class="footer-copy">&copy; ${new Date().getFullYear()} Badr Eddine BELGHARBI. All rights reserved.</p>
    <nav class="footer-links" aria-label="Contact links">
      <a href="https://www.linkedin.com/in/badreddinebelgharbi" target="_blank" rel="noopener" aria-label="LinkedIn profile">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4.98 3.5C4.98 4.88 3.86 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5ZM.35 8.1h4.3V23H.35V8.1Zm7.15 0h4.12v2.03h.06c.57-1.08 1.98-2.22 4.07-2.22C20.1 7.91 21 10.78 21 14.5V23h-4.3v-7.54c0-1.8-.03-4.11-2.5-4.11-2.51 0-2.9 1.96-2.9 3.98V23H7.5V8.1Z"/></svg>
        <span>LinkedIn</span>
      </a>
      <a href="mailto:badreddine.belgharbi@spacefoot.com" aria-label="Email Badr Eddine BELGHARBI">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h15A2.5 2.5 0 0 1 22 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-13Zm2.5-.5a.5.5 0 0 0-.5.5v.56l8 5.2 8-5.2V5.5a.5.5 0 0 0-.5-.5h-15ZM20 8.45l-7.46 4.85a1 1 0 0 1-1.08 0L4 8.45V18.5a.5.5 0 0 0 .5.5h15a.5.5 0 0 0 .5-.5V8.45Z"/></svg>
        <span>badreddine.belgharbi@spacefoot.com</span>
      </a>
    </nav>`;
  shell.appendChild(footer);
}

function addUiPolishStyles() {
  if (document.getElementById('uiPolishStyles')) return;
  const style = document.createElement('style');
  style.id = 'uiPolishStyles';
  style.textContent = `
    @media (min-width: 721px) {
      .hero { align-items: stretch; min-height: 300px; }
      .hero-copy { display: flex; flex-direction: column; justify-content: center; }
      .hero-actions { align-content: center; align-self: stretch; display: grid; grid-template-columns: repeat(3, max-content); justify-content: end; margin-left: auto; min-width: min(100%, 470px); }
      .hero-actions .button { align-items: center; justify-content: center; min-height: 46px; white-space: nowrap; }
      #runWorkflowButton { grid-column: 2 / 4; justify-self: end; }
    }
    .button.disabled, .button:disabled { cursor: not-allowed; opacity: .62; transform: none; }
    .button:disabled:hover { box-shadow: none; transform: none; }
    .site-footer { align-items: center; color: var(--muted); display: flex; gap: 18px; justify-content: space-between; margin-top: 28px; padding: 20px 4px 4px; }
    .footer-copy { font-size: .9rem; font-weight: 700; margin: 0; }
    .footer-links { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
    .footer-links a { align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; color: var(--link); display: inline-flex; font-size: .88rem; font-weight: 900; gap: 8px; padding: 9px 12px; text-decoration: none; }
    .footer-links a:hover { border-color: var(--primary); transform: translateY(-1px); }
    .footer-links svg { fill: currentColor; height: 17px; width: 17px; }
    @media (max-width: 720px) {
      .site-footer { align-items: flex-start; flex-direction: column; }
      .footer-links { justify-content: flex-start; width: 100%; }
      .footer-links a { max-width: 100%; }
      .footer-links span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }
  `;
  document.head.appendChild(style);
}

async function openWorkflowIfReady() {
  setRunWorkflowButton('Checking...', true);
  try {
    const run = await getLatestWorkflowRunSafe();
    if (run && isActiveRun(run)) {
      setFeedStatus('Feed generation already in progress', `Started: ${formatDateTime(run.run_started_at || run.created_at)}`, 'running');
      setRunWorkflowButton('Workload running', true);
      scheduleSafeWorkflowButtonRefresh(30000);
      return;
    }
    window.open(WORKFLOW_PAGE_URL, '_blank', 'noopener');
    setRunWorkflowButton('Open GitHub Actions', false);
  } catch (error) {
    showAlert(error.message || 'Could not check GitHub Actions status.', true);
    setRunWorkflowButton('Open GitHub Actions', false);
  }
}

async function refreshSafeWorkflowButton() {
  const button = el('runWorkflowButton');
  if (!button) return;
  try {
    const run = await getLatestWorkflowRunSafe();
    if (run && isActiveRun(run)) {
      setRunWorkflowButton('Workload running', true);
      scheduleSafeWorkflowButtonRefresh(30000);
      return;
    }
    setRunWorkflowButton('Run workflow', false);
  } catch (_error) {
    setRunWorkflowButton('Open GitHub Actions', false);
  }
}

async function getLatestWorkflowRunSafe() {
  const response = await fetch(`${ACTIONS_WORKFLOW_RUNS_URL}&ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub Actions returned ${response.status}`);
  return (await response.json()).workflow_runs?.[0] || null;
}

function setRunWorkflowButton(label, disabled) {
  const button = el('runWorkflowButton');
  if (!button) return;
  button.textContent = label;
  button.disabled = disabled;
  button.classList.toggle('disabled', disabled);
}

function scheduleSafeWorkflowButtonRefresh(delay) {
  window.clearTimeout(workflowButtonTimer);
  workflowButtonTimer = window.setTimeout(refreshSafeWorkflowButton, delay);
}
