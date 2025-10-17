// Cloudflare Worker for FFXIV Market Search
// Single file serving both frontend and API

const DEFAULT_WORLD = 'Elemental'; // デフォルトワールド
const CACHE_TTL = 60; // キャッシュTTL（秒）
const XIVAPI_BASE = 'https://xivapi.com';
const UNIVERSALIS_BASE = 'https://universalis.app/api/v2';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  // API endpoint
  if (url.pathname === '/api/search') {
    return handleSearch(url);
  }

  // Serve frontend
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return new Response(HTML_CONTENT, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=3600',
      }
    });
  }

  return new Response('Not Found', { status: 404 });
}

async function handleSearch(url) {
  const params = url.searchParams;
  const q = params.get('q')?.trim();
  const world = params.get('world')?.trim() || DEFAULT_WORLD;
  const hq = params.get('hq') === 'true';
  const minPrice = parseInt(params.get('min_price') || '0', 10);
  const maxPrice = parseInt(params.get('max_price') || '999999999', 10);
  const page = parseInt(params.get('page') || '1', 10);
  const perPage = parseInt(params.get('per_page') || '20', 10);
  const sort = params.get('sort') || 'price_asc';

  if (!q) {
    return jsonResponse({ error: 'query_required', message: 'パラメータ q は必須です' }, 400);
  }

  // キャッシュキー生成
  const cacheKey = `search:${q.toLowerCase()}:${world}:${hq}:${minPrice}:${maxPrice}:${page}:${perPage}:${sort}`;
  const cache = caches.default;
  const cacheUrl = new URL(url);
  cacheUrl.pathname = `/cache/${cacheKey}`;

  // キャッシュチェック
  let cached = await cache.match(cacheUrl);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set('X-Cache', 'HIT');
    return response;
  }

  try {
    // XIVAPI でアイテムID検索
    const itemId = await searchItemId(q);
    if (!itemId) {
      return jsonResponse({ error: 'item_not_found', message: `アイテム "${q}" が見つかりませんでした` }, 404);
    }

    // Universalis でマーケット情報取得
    const marketData = await fetchMarketData(world, itemId);

    // データ整形
    const listings = (marketData.listings || [])
      .filter(l => {
        if (hq && !l.hq) return false;
        if (l.pricePerUnit < minPrice || l.pricePerUnit > maxPrice) return false;
        return true;
      })
      .sort((a, b) => {
        if (sort === 'price_asc') return a.pricePerUnit - b.pricePerUnit;
        if (sort === 'price_desc') return b.pricePerUnit - a.pricePerUnit;
        if (sort === 'recent') return b.lastReviewTime - a.lastReviewTime;
        return 0;
      });

    const start = (page - 1) * perPage;
    const paginatedListings = listings.slice(start, start + perPage);

    const result = {
      query: q,
      world,
      itemId,
      itemName: marketData.itemName || q,
      total: listings.length,
      page,
      perPage,
      listings: paginatedListings.map(l => ({
        price: l.pricePerUnit,
        quantity: l.quantity,
        hq: l.hq,
        total: l.total,
        retainerName: l.retainerName,
        lastReviewTime: l.lastReviewTime,
      })),
      cheapest: paginatedListings.length > 0 ? paginatedListings[0].pricePerUnit : null,
      averagePrice: marketData.averagePrice || null,
      timestamp: Date.now(),
    };

    const response = jsonResponse(result, 200);
    response.headers.set('X-Cache', 'MISS');

    // キャッシュ保存
    const cacheResponse = response.clone();
    cacheResponse.headers.set('Cache-Control', `max-age=${CACHE_TTL}`);
    await cache.put(cacheUrl, cacheResponse);

    return response;

  } catch (error) {
    console.error('Search error:', error);
    return jsonResponse({
      error: 'upstream_error',
      message: 'データ取得中にエラーが発生しました',
      detail: error.message
    }, 500);
  }
}

async function searchItemId(query) {
  const apiKey = typeof XIVAPI_KEY !== 'undefined' ? XIVAPI_KEY : '';
  const url = `${XIVAPI_BASE}/search?indexes=item&string=${encodeURIComponent(query)}&limit=1${apiKey ? `&private_key=${apiKey}` : ''}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`XIVAPI error: ${response.status}`);

  const data = await response.json();
  return data.Results?.[0]?.ID || null;
}

async function fetchMarketData(world, itemId) {
  const url = `${UNIVERSALIS_BASE}/${encodeURIComponent(world)}/${itemId}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Universalis error: ${response.status}`);

  const data = await response.json();
  return {
    itemName: data.itemName || data.name,
    listings: data.listings || [],
    averagePrice: data.averagePrice,
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// HTML Content (embedded)
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FFXIV マーケット検索</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    :root {
      --primary: #3b82f6;
      --primary-dark: #2563eb;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --error: #ef4444;
      --success: #10b981;
      --warning: #f59e0b;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 16px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    h1 {
      font-size: 1.75rem;
      margin-bottom: 24px;
      text-align: center;
    }

    .search-form {
      background: var(--card-bg);
      padding: 24px;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 24px;
    }

    .form-group {
      margin-bottom: 16px;
    }

    label {
      display: block;
      font-weight: 600;
      margin-bottom: 6px;
      font-size: 0.9rem;
    }

    input, select, button {
      width: 100%;
      padding: 12px 14px;
      font-size: 1rem;
      border: 2px solid var(--border);
      border-radius: 8px;
      transition: border-color 0.2s;
    }

    input:focus, select:focus {
      outline: none;
      border-color: var(--primary);
    }

    .form-row {
      display: grid;
      gap: 12px;
      grid-template-columns: 1fr;
    }

    @media (min-width: 640px) {
      .form-row {
        grid-template-columns: 1fr 1fr;
      }
      .form-row-3 {
        grid-template-columns: 1fr 1fr 1fr;
      }
    }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .checkbox-group input[type="checkbox"] {
      width: auto;
      margin: 0;
    }

    button {
      background: var(--primary);
      color: white;
      border: none;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
      transition: background 0.2s;
    }

    button:hover {
      background: var(--primary-dark);
    }

    button:disabled {
      background: var(--text-muted);
      cursor: not-allowed;
    }

    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .badge-cache { background: #dbeafe; color: #1e40af; }
    .badge-fresh { background: #d1fae5; color: #065f46; }
    .badge-hq { background: #fef3c7; color: #92400e; }

    .results {
      display: grid;
      gap: 16px;
      grid-template-columns: 1fr;
    }

    @media (min-width: 768px) {
      .results {
        grid-template-columns: 1fr 1fr;
      }
    }

    .card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      border: 1px solid var(--border);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .card-title {
      font-size: 1.1rem;
      font-weight: 600;
    }

    .price {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--primary);
      margin: 8px 0;
    }

    .card-meta {
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-bottom: 12px;
    }

    .detail-btn {
      padding: 8px 16px;
      font-size: 0.9rem;
      width: auto;
      margin-top: 8px;
    }

    .loading, .error, .empty {
      text-align: center;
      padding: 48px 24px;
      background: var(--card-bg);
      border-radius: 12px;
    }

    .loading {
      color: var(--text-muted);
    }

    .error {
      color: var(--error);
    }

    .skeleton {
      background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%);
      background-size: 200% 100%;
      animation: loading 1.5s infinite;
      border-radius: 8px;
      height: 20px;
      margin-bottom: 12px;
    }

    @keyframes loading {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.6);
      z-index: 1000;
      padding: 16px;
      overflow-y: auto;
    }

    .modal.active {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .modal-content {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 24px;
      max-width: 600px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      position: relative;
    }

    .modal-close {
      position: absolute;
      top: 16px;
      right: 16px;
      background: transparent;
      color: var(--text-muted);
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      width: auto;
      padding: 4px 12px;
    }

    .listing-item {
      border-bottom: 1px solid var(--border);
      padding: 12px 0;
    }

    .listing-item:last-child {
      border-bottom: none;
    }

    .relative-time {
      color: var(--text-muted);
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>FFXIV マーケット検索</h1>

    <form class="search-form" id="searchForm" role="search">
      <div class="form-group">
        <label for="query">アイテム名</label>
        <input
          type="text"
          id="query"
          name="query"
          placeholder="例: Megapotion"
          required
          aria-required="true"
        >
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="world">ワールド</label>
          <input
            type="text"
            id="world"
            name="world"
            placeholder="未指定（デフォルト: Elemental）"
            list="worldList"
          >
          <datalist id="worldList">
            <option value="Elemental">
            <option value="Gaia">
            <option value="Mana">
            <option value="Meteor">
            <option value="Carbuncle">
            <option value="Tonberry">
            <option value="Kujata">
          </datalist>
        </div>

        <div class="form-group">
          <label for="sort">並び順</label>
          <select id="sort" name="sort">
            <option value="price_asc">価格が安い順</option>
            <option value="price_desc">価格が高い順</option>
            <option value="recent">最近の更新順</option>
          </select>
        </div>
      </div>

      <div class="form-row form-row-3">
        <div class="form-group">
          <label for="minPrice">最低価格</label>
          <input type="number" id="minPrice" name="minPrice" placeholder="0">
        </div>

        <div class="form-group">
          <label for="maxPrice">最高価格</label>
          <input type="number" id="maxPrice" name="maxPrice" placeholder="無制限">
        </div>

        <div class="form-group">
          <label class="checkbox-group">
            <input type="checkbox" id="hq" name="hq">
            <span>HQ のみ</span>
          </label>
        </div>
      </div>

      <button type="submit" id="searchBtn">検索</button>
    </form>

    <div id="results" role="region" aria-live="polite"></div>
  </div>

  <div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal-content">
      <button class="modal-close" aria-label="閉じる">&times;</button>
      <h2 id="modalTitle">出品詳細</h2>
      <div id="modalBody"></div>
    </div>
  </div>

  <script>
    const form = document.getElementById('searchForm');
    const resultsDiv = document.getElementById('results');
    const modal = document.getElementById('modal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    let currentData = null;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await performSearch();
    });

    // キーボードでモーダルを閉じる
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        closeModal();
      }
    });

    // 背景クリックでモーダルを閉じる
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    async function performSearch() {
      const formData = new FormData(form);
      const query = formData.get('query')?.trim();

      if (!query) {
        showError('アイテム名を入力してください');
        return;
      }

      const params = new URLSearchParams({
        q: query,
        world: formData.get('world') || '',
        hq: document.getElementById('hq').checked,
        min_price: formData.get('minPrice') || '',
        max_price: formData.get('maxPrice') || '',
        sort: formData.get('sort') || 'price_asc',
      });

      showLoading();

      try {
        const response = await fetch(\`/api/search?\${params}\`);
        const data = await response.json();

        if (!response.ok) {
          showError(data.message || 'エラーが発生しました');
          return;
        }

        currentData = data;
        const cacheStatus = response.headers.get('X-Cache');
        displayResults(data, cacheStatus);
      } catch (error) {
        showError('通信エラーが発生しました');
      }
    }

    function showLoading() {
      resultsDiv.innerHTML = \`
        <div class="loading">
          <div class="skeleton"></div>
          <div class="skeleton" style="width: 80%; margin: 0 auto 12px;"></div>
          <div class="skeleton" style="width: 60%; margin: 0 auto;"></div>
          <p style="margin-top: 16px;">検索中...</p>
        </div>
      \`;
    }

    function showError(message) {
      resultsDiv.innerHTML = \`
        <div class="error">
          <h3>⚠️ エラー</h3>
          <p>\${escapeHtml(message)}</p>
        </div>
      \`;
    }

    function displayResults(data, cacheStatus) {
      if (!data.listings || data.listings.length === 0) {
        resultsDiv.innerHTML = \`
          <div class="empty">
            <h3>該当なし</h3>
            <p>「\${escapeHtml(data.query)}」の検索結果が見つかりませんでした</p>
            <p style="color: var(--text-muted); margin-top: 8px;">
              フィルタ条件を変更してみてください
            </p>
          </div>
        \`;
        return;
      }

      const cacheLabel = cacheStatus === 'HIT'
        ? '<span class="status-badge badge-cache">キャッシュ</span>'
        : '<span class="status-badge badge-fresh">最新取得</span>';

      let html = \`
        <div style="margin-bottom: 16px; text-align: center;">
          \${cacheLabel}
          <p style="color: var(--text-muted); font-size: 0.9rem;">
            \${data.total} 件の出品 | \${escapeHtml(data.itemName)} @ \${escapeHtml(data.world)}
          </p>
        </div>
        <div class="results">
      \`;

      data.listings.forEach((listing, idx) => {
        const relativeTime = formatRelativeTime(listing.lastReviewTime);
        html += \`
          <div class="card">
            <div class="card-header">
              <div class="card-title">\${escapeHtml(data.itemName)}</div>
              \${listing.hq ? '<span class="status-badge badge-hq">HQ</span>' : ''}
            </div>
            <div class="price">\${listing.price.toLocaleString()} Gil</div>
            <div class="card-meta">
              在庫: \${listing.quantity} 個 | 合計: \${listing.total.toLocaleString()} Gil
            </div>
            <div class="relative-time">\${relativeTime}</div>
            <button class="detail-btn" onclick="showDetails(\${idx})">詳細を見る</button>
          </div>
        \`;
      });

      html += '</div>';
      resultsDiv.innerHTML = html;
    }

    function showDetails(index) {
      if (!currentData || !currentData.listings[index]) return;

      const listing = currentData.listings[index];
      modalTitle.textContent = \`\${currentData.itemName} の出品詳細\`;

      modalBody.innerHTML = \`
        <div class="listing-item">
          <p><strong>価格:</strong> \${listing.price.toLocaleString()} Gil</p>
          <p><strong>数量:</strong> \${listing.quantity}</p>
          <p><strong>合計:</strong> \${listing.total.toLocaleString()} Gil</p>
          <p><strong>品質:</strong> \${listing.hq ? 'HQ' : 'NQ'}</p>
          <p><strong>リテイナー:</strong> \${escapeHtml(listing.retainerName || '不明')}</p>
          <p class="relative-time">最終確認: \${formatRelativeTime(listing.lastReviewTime)}</p>
        </div>
      \`;

      // 周辺の出品も表示（上位3件）
      const nearby = currentData.listings.slice(0, 3).filter((_, i) => i !== index);
      if (nearby.length > 0) {
        modalBody.innerHTML += '<h3 style="margin-top: 20px; margin-bottom: 12px;">他の出品</h3>';
        nearby.forEach(l => {
          modalBody.innerHTML += \`
            <div class="listing-item">
              <p><strong>\${l.price.toLocaleString()} Gil</strong> × \${l.quantity} \${l.hq ? '(HQ)' : ''}</p>
              <p class="relative-time">\${formatRelativeTime(l.lastReviewTime)}</p>
            </div>
          \`;
        });
      }

      modal.classList.add('active');
    }

    function closeModal() {
      modal.classList.remove('active');
    }

    function formatRelativeTime(timestamp) {
      const now = Date.now();
      const diff = Math.floor((now - timestamp) / 1000);

      if (diff < 60) return \`\${diff}秒前\`;
      if (diff < 3600) return \`\${Math.floor(diff / 60)}分前\`;
      if (diff < 86400) return \`\${Math.floor(diff / 3600)}時間前\`;
      return \`\${Math.floor(diff / 86400)}日前\`;
    }

    function escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
      return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    // モーダル閉じるボタン
    document.querySelector('.modal-close').addEventListener('click', closeModal);
  </script>
</body>
</html>
`;
