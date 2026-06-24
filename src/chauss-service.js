const DEFAULT_BASE_URL = 'https://www.chauss-service.fr/api/v1';
const DEFAULT_MAX_RETRIES = 3;
const MIN_RETRY_DELAY_MS = 1000;

export function validateChaussServiceEnv(env = process.env) {
  const missing = [];
  if (!getApiKey(env)) missing.push('CHAUSS_SERVICE_API_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing required Chauss Service environment variable(s): ${missing.join(', ')}`);
  }

  const baseUrl = getBaseUrl(env);
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch (_error) {
    throw new Error('CHAUSS_SERVICE_BASE_URL must be a valid HTTP(S) URL.');
  }
}

export function getBaseUrl(env = process.env) {
  return (env.CHAUSS_SERVICE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

export function getApiKey(env = process.env) {
  return env.CHAUSS_SERVICE_API_KEY || env.CHAUSS_API_KEY || '';
}

export async function createChaussServiceClient(env = process.env) {
  validateChaussServiceEnv(env);

  const baseUrl = getBaseUrl(env);
  const apiKey = getApiKey(env);

  async function get(path, options = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let attempt = 0;
    let lastError;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: {
            Accept: 'application/json',
            'X-API-Key': apiKey
          }
        });

        const bodyText = await response.text();
        const payload = parseJson(bodyText, response.status, path);

        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          await sleep(parseRetryAfter(response.headers.get('retry-after')) ?? backoffMs(attempt));
          attempt += 1;
          continue;
        }

        if (!response.ok) {
          throw new Error(`Chauss Service HTTP error ${response.status} on ${path}: ${summarizePayload(payload)}`);
        }

        if (payload?.success === false) {
          throw new Error(`Chauss Service API error on ${path}: ${summarizePayload(payload)}`);
        }

        return payload?.data ?? payload;
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || isNonRetryable(error)) break;
        await sleep(backoffMs(attempt));
        attempt += 1;
      }
    }

    throw lastError ?? new Error(`Chauss Service request failed on ${path}.`);
  }

  return {
    baseUrl,
    getArticles: () => get('/articles'),
    getArticle: (reference) => get(`/articles/${encodeURIComponent(reference)}`),
    getStocks: () => get('/stocks')
  };
}

function parseJson(bodyText, status, path) {
  try {
    return bodyText ? JSON.parse(bodyText) : {};
  } catch (_error) {
    throw new Error(`Chauss Service returned non-JSON response with status ${status} on ${path}: ${bodyText.slice(0, 200)}`);
  }
}

function summarizePayload(payload) {
  if (payload?.error?.message) return `${payload.error.code ?? 'ERROR'}: ${payload.error.message}`;
  if (payload?.message) return payload.message;
  return JSON.stringify(payload).slice(0, 500);
}

function isNonRetryable(error) {
  return /HTTP error 4\d\d/.test(error?.message ?? '');
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(MIN_RETRY_DELAY_MS, seconds * 1000);
  return undefined;
}

function backoffMs(attempt) {
  return MIN_RETRY_DELAY_MS * 2 ** attempt;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
