export const DEEPSEEK_SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';

const usableKey = value => typeof value === 'string' && value.trim() !== '******' ? value.trim() : '';

function officialUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

// Upgrade only the former official default. Explicit gateway paths stay intact.
export function normalizeDeepSeekSearchUrl(value) {
  const url = officialUrl(value);
  return url && /^\/(?:v1\/)?responses\/?$/.test(url.pathname) ? DEEPSEEK_SEARCH_URL : value;
}

export function migrateDeepSeekSearch(config) {
  const source = config?.webSearch?.deepseek;
  if (source?.baseUrl) source.baseUrl = normalizeDeepSeekSearchUrl(source.baseUrl);
  return config;
}

function officialModelUrl(value) {
  const url = officialUrl(value);
  return Boolean(url && /^\/(?:v1\/?)?$/.test(url.pathname));
}

export function isOfficialDeepSeekSearch(value) {
  const url = officialUrl(normalizeDeepSeekSearchUrl(value || DEEPSEEK_SEARCH_URL));
  return Boolean(url && ['/', '/v1/tools/search', '/v1/tools/search/'].includes(url.pathname));
}

// Resolve on every use, without copying a model credential into persisted search
// settings. Names and model IDs never establish ownership of a vendor's key.
export function resolveDeepSeekSearchCredential(config = {}, env = process.env) {
  const source = config?.webSearch?.deepseek ?? {}, own = usableKey(source.apiKey);
  if (own) return { apiKey: own, source: 'custom', name: '' };
  if (!isOfficialDeepSeekSearch(source.baseUrl)) return { apiKey: '', source: 'none', name: '' };

  const api = config.api ?? {}, id = api.provider;
  const owners = id && Array.isArray(config.providers) ? config.providers.filter(item => item?.id === id) : [];
  const owner = owners.length === 1 ? owners[0] : null;
  const ownerUrl = owner?.baseURL ?? owner?.baseUrl;
  const validOwner = !id || (owner && officialModelUrl(ownerUrl)
    && (!owner.baseUrl || !owner.baseURL || officialModelUrl(owner.baseUrl) && officialModelUrl(owner.baseURL)));
  if (validOwner && officialModelUrl(api.baseUrl || ownerUrl)) {
    const key = id ? usableKey(config.dshProviderKeys?.[id]) || usableKey(owner.apiKey)
      || usableKey(owner.apiKeyFrom && env[owner.apiKeyFrom]) : usableKey(api.apiKey);
    if (key) return { apiKey: key, source: 'model', name: String(owner?.displayName || owner?.name || 'DeepSeek').slice(0, 100) };
  }
  const key = usableKey(env.DEEPSEEK_API_KEY);
  return { apiKey: key, source: key ? 'environment' : 'none', name: '' };
}

export function deepSeekSearchView(config) {
  const credential = resolveDeepSeekSearchCredential(config);
  return { id: 'deepseek', hasApiKey: Boolean(credential.apiKey),
    hasOwnApiKey: Boolean(usableKey(config?.webSearch?.deepseek?.apiKey)),
    canInheritModelKey: isOfficialDeepSeekSearch(config?.webSearch?.deepseek?.baseUrl),
    keySource: credential.source, keySourceName: credential.name };
}

// Only the bundled web-tools binding receives its effective search credential;
// it does not receive the model catalog or other model/account credentials.
export function deepSeekSearchSettings(config) {
  const ws = structuredClone(config?.webSearch);
  if (ws && typeof ws === 'object' && !Array.isArray(ws)) {
    ws.deepseek = { ...ws.deepseek, apiKey: resolveDeepSeekSearchCredential(config).apiKey };
  }
  return ws;
}
