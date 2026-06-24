import assert from 'node:assert/strict';
import test from 'node:test';
import { getBaseUrl, validateChaussServiceEnv } from '../src/chauss-service.js';
import { articleToRows, buildFeedRows } from '../src/feed.js';

const ENV = {
  CHAUSS_SERVICE_API_KEY: 'replace-with-api-key',
  CHAUSS_SERVICE_BASE_URL: 'https://www.chauss-service.fr/api/v1'
};

test('validates the documented Chauss Service API environment shape', () => {
  assert.doesNotThrow(() => validateChaussServiceEnv(ENV));
});

test('defaults to the Chauss Service v1 base URL', () => {
  assert.equal(getBaseUrl({}), 'https://www.chauss-service.fr/api/v1');
});

test('requires a Chauss Service API key', () => {
  assert.throws(() => validateChaussServiceEnv({}), /CHAUSS_SERVICE_API_KEY/);
});

test('maps Chauss Service article assortiments to dashboard CSV rows', () => {
  const rows = articleToRows({
    marque: 'Altex',
    code: 'CH01234',
    nom: 'FREELANDER',
    pvc_ttc: 115,
    construction: 'Injecte',
    type: 'Boots / Bottines',
    rayon: 'Mixte',
    usage: 'Outdoor',
    stock: 11,
    matieres: { tige: 'Cuir gras' },
    talon: { type: '' },
    assortiments: [
      { codebarre: '3612345678912', couleur: 'MARRON', taille: '36', stock: 11, pu_ht: 54.9, qteColis: 0 }
    ]
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].brand, 'Altex');
  assert.equal(rows[0].product_id, 'CH01234');
  assert.equal(rows[0].product_title, 'FREELANDER');
  assert.equal(rows[0].variant_sku, 'CH01234-MARRON-36');
  assert.equal(rows[0].barcode, '3612345678912');
  assert.equal(rows[0].price_amount, '54.9');
  assert.equal(rows[0].compare_at_price, '115');
  assert.equal(rows[0].inventory_available, '11');
});

test('uses /stocks values when they are available', async () => {
  const rows = await buildFeedRows(ENV, {
    getArticles: async () => [{ code: 'CH00055', nom: 'NALA' }],
    getStocks: async () => [{ code: '3665599521984', stock: 7 }],
    getArticle: async () => ({
      marque: 'Chauss Service',
      code: 'CH00055',
      nom: 'NALA',
      type: 'Sandales',
      assortiments: [{ codebarre: '3665599521984', couleur: 'TAUPE', taille: '37', stock: 2, pu_ht: 13.41 }]
    })
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].inventory_available, '7');
});
