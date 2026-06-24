const QUALITY_DRILLDOWN_VERSION = '2026-06-06-quality-drilldown-export';
const QUALITY_FILTERS = {
  missingBarcode: { label: 'Missing barcode', file: 'missing-barcode', test: (row) => !isPresent(row.barcode) },
  badEansDetail: { label: 'Bad EAN barcode', file: 'bad-ean-barcode', test: (row) => row.eanStatus === 'bad' },
  missingImage: { label: 'Missing image', file: 'missing-image', test: (row) => !isPresent(row.image_url) },
  missingPrice: { label: 'Missing price', file: 'missing-price', test: (row) => typeof hasValidMsrp === 'function' ? !hasValidMsrp(row) : !isPresent(row.price_amount) || row.price <= 0 },
  missingStock: { label: 'Missing stock value', file: 'missing-stock-value', test: (row) => !isPresent(row.inventory_available) },
  outOfStockDetail: { label: 'Out of stock variants', file: 'out-of-stock-variants', test: (row) => isPresent(row.inventory_available) && row.stock <= 0 },
  missingProductType: { label: 'Missing product type', file: 'missing-product-type', test: (row) => !isPresent(row.product_type) }
};

state.qualityFilter = '';

window.addEventListener('DOMContentLoaded', () => {
  addQualityDrilldownStyles();
  bindQualityDrilldowns();
  addCatalogExportControls();
});

function bindQualityDrilldowns() {
  Object.entries(QUALITY_FILTERS).forEach(([id, config]) => {
    const metric = el(id)?.closest('div');
    if (!metric) return;
    metric.classList.add('quality-action');
    metric.setAttribute('role', 'button');
    metric.setAttribute('tabindex', '0');
    metric.setAttribute('title', `Filter catalog by ${config.label}`);
    metric.dataset.qualityFilter = id;
    metric.addEventListener('click', () => activateQualityFilter(id));
    metric.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateQualityFilter(id);
      }
    });
  });
}

function activateQualityFilter(id) {
  state.qualityFilter = id;
  state.pageSize = 100;
  setValue('searchInput', '');
  setValue('statusFilter', '');
  setValue('stockFilter', '');
  setValue('typeFilter', '');
  setValue('eanFilter', '');
  setValue('pageSizeSelect', '100');
  applyFilters();
  document.querySelector('.catalog-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setValue(id, value) {
  const node = el(id);
  if (node) node.value = value;
}

function addCatalogExportControls() {
  const modeRow = document.querySelector('.catalog-mode-row');
  if (!modeRow || el('exportCatalogButton')) return;
  const summary = document.createElement('div');
  summary.id = 'activeQualityFilter';
  summary.className = 'active-quality-filter';
  summary.hidden = true;
  modeRow.appendChild(summary);
  const exportButton = document.createElement('button');
  exportButton.id = 'exportCatalogButton';
  exportButton.className = 'export-button';
  exportButton.type = 'button';
  exportButton.textContent = 'Export CSV';
  exportButton.addEventListener('click', exportFilteredCatalogCsv);
  modeRow.appendChild(exportButton);
}

function applyFilters() {
  const search = clean(el('searchInput').value).toLowerCase();
  const status = el('statusFilter').value;
  const stock = el('stockFilter').value;
  const type = el('typeFilter').value;
  const ean = el('eanFilter').value;
  const qualityConfig = state.qualityFilter ? QUALITY_FILTERS[state.qualityFilter] : null;
  const variants = uniqueRows(state.rows, variantKey);
  state.filteredRows = variants.filter((row) => {
    const matchesSearch = !search || [row.variant_sku, row.product_title, row.barcode, row.productType].some((value) => clean(value).toLowerCase().includes(search));
    const matchesStatus = !status || row.status === status;
    const matchesStock = !stock || (stock === 'in' ? row.stock > 0 : row.stock <= 0);
    const matchesType = !type || row.productType === type;
    const matchesEan = !ean || row.eanStatus === ean;
    const matchesQuality = !qualityConfig || qualityConfig.test(row);
    return matchesSearch && matchesStatus && matchesStock && matchesType && matchesEan && matchesQuality;
  });
  state.groupedRows = buildProductGroups(state.filteredRows);
  renderCatalogueTable();
  updateSortButtons();
  updateQualityDrilldownUi();
}

function updateQualityDrilldownUi() {
  const active = state.qualityFilter ? QUALITY_FILTERS[state.qualityFilter] : null;
  document.querySelectorAll('.quality-action').forEach((node) => node.classList.toggle('active', node.dataset.qualityFilter === state.qualityFilter));
  const chip = el('activeQualityFilter');
  if (!chip) return;
  if (!active) {
    chip.hidden = true;
    chip.innerHTML = '';
    return;
  }
  chip.hidden = false;
  chip.innerHTML = `<span>${escapeHtml(active.label)}</span><button type="button" aria-label="Clear quality filter">Clear</button>`;
  chip.querySelector('button').addEventListener('click', () => {
    state.qualityFilter = '';
    applyFilters();
  });
}

function exportFilteredCatalogCsv() {
  const rows = sortRows(state.filteredRows);
  if (!rows.length) {
    showAlert('No catalog rows to export with the current filters.', true);
    return;
  }
  const columns = ['product_id', 'product_title', 'product_handle', 'product_url', 'variant_id', 'variant_sku', 'barcode', 'eanStatus', 'price_amount', 'inventory_available', 'product_status', 'product_type', 'image_url', 'updated_at'];
  const csv = [columns.join(',')].concat(rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))).join('\n');
  const filterName = state.qualityFilter ? QUALITY_FILTERS[state.qualityFilter].file : 'filtered-catalog';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `chauss-service-${filterName}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const textValue = clean(value);
  return /[",\n\r]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
}

function addQualityDrilldownStyles() {
  if (document.getElementById('qualityDrilldownStyles')) return;
  const style = document.createElement('style');
  style.id = 'qualityDrilldownStyles';
  style.textContent = `
    .quality-action { cursor: pointer; transition: border-color .15s ease, transform .15s ease, background .15s ease; }
    .quality-action:hover, .quality-action.active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, var(--surface-soft)); transform: translateY(-1px); }
    .quality-action:focus-visible { outline: 3px solid color-mix(in srgb, var(--primary) 35%, transparent); outline-offset: 2px; }
    .catalog-mode-row { flex-wrap: wrap; }
    .active-quality-filter { align-items: center; background: color-mix(in srgb, var(--primary) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--border)); border-radius: 999px; color: var(--ink); display: inline-flex; font-size: .82rem; font-weight: 900; gap: 8px; padding: 8px 10px; }
    .active-quality-filter button, .export-button { border: 0; border-radius: 999px; cursor: pointer; font: inherit; font-weight: 900; }
    .active-quality-filter button { background: transparent; color: var(--primary); padding: 0 2px; }
    .export-button { background: var(--primary); color: #fff; margin-left: auto; padding: 10px 14px; }
    .export-button:hover { background: var(--primary-strong); }
    @media (max-width: 720px) { .export-button { margin-left: 0; width: 100%; } .active-quality-filter { width: 100%; justify-content: space-between; } }
  `;
  document.head.appendChild(style);
}
