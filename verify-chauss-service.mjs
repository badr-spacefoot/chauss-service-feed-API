import dotenv from 'dotenv';
import { createChaussServiceClient, validateChaussServiceEnv } from './src/chauss-service.js';

dotenv.config();

try {
  validateChaussServiceEnv(process.env);
  const client = await createChaussServiceClient(process.env);
  const articles = await client.getArticles();
  const firstArticle = Array.isArray(articles) ? articles[0] : null;

  if (!firstArticle?.code) {
    throw new Error('Chauss Service connection worked, but /articles returned no article code.');
  }

  const detailPayload = await client.getArticle(firstArticle.code);
  const detail = Array.isArray(detailPayload) ? detailPayload[0] : detailPayload;

  if (!detail?.code) {
    throw new Error(`Chauss Service returned no detail for ${firstArticle.code}.`);
  }

  console.log('Chauss Service product access verified.');
  console.log(`First article: ${detail.nom || firstArticle.nom || '-'} (${detail.code})`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
