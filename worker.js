// Cloudflare Worker for FFXIV Market Search
// Single file serving both frontend and API

const DEFAULT_WORLD = 'Elemental'; // デフォルトワールド
const CACHE_TTL = 60; // キャッシュTTL（秒）
const XIVAPI_BASE = 'https://v2.xivapi.com/api'; // XIVAPI v2
const UNIVERSALIS_BASE = 'https://universalis.app/api/v2';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};

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

  // Font file serving
  if (url.pathname === '/FFXIV_Lodestone_SSF.woff') {
    // フォントファイルはbase64エンコードして埋め込むか、外部URLを使用
    // ここでは簡易的にリダイレクト
    return new Response('Font not available in dev mode', { status: 404 });
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
  const worldParam = params.get('world')?.trim();
  const world = worldParam || ''; // 空の場合は全検索（Universalis側で処理）
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
    const itemResult = await searchItemId(q);
    if (!itemResult) {
      return jsonResponse({ error: 'item_not_found', message: `アイテム "${q}" が見つかりませんでした` }, 404);
    }

    // Universalis でマーケット情報取得
    const marketData = await fetchMarketData(world, itemResult.id);

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
      itemId: itemResult.id,
      itemName: marketData.itemName || itemResult.name,
      total: listings.length,
      page,
      perPage,
      listings: paginatedListings.map(l => ({
        price: l.pricePerUnit,
        quantity: l.quantity,
        hq: l.hq,
        total: l.total,
        retainerName: l.retainerName,
        worldName: l.worldName,
        lastReviewTime: l.lastReviewTime,
      })),
      recentHistory: (marketData.recentHistory || []).slice(0, 10).map(h => ({
        price: h.pricePerUnit,
        quantity: h.quantity,
        hq: h.hq,
        buyerName: h.buyerName,
        worldName: h.worldName,
        timestamp: h.timestamp,
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
  // XIVAPI v2のキーワード検索を使用
  // Name~"keyword" で部分一致検索
  const searchQuery = `Name~"${query}"`;
  const url = `${XIVAPI_BASE}/search?sheets=Item&fields=Name,ItemUICategory.Name,Icon&language=ja&query=${encodeURIComponent(searchQuery)}&limit=10`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'FFXIV-Market-Search/1.0',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`XIVAPI error: ${response.status}`);
  }

  const data = await response.json();

  // v2のレスポンス形式: { results: [{ row_id, fields: { Name, ... } }] }
  if (data.results && data.results.length > 0) {
    // 最初のマッチを返す
    const item = data.results[0];
    return {
      id: item.row_id,
      name: item.fields?.Name || query
    };
  }

  return null;
}

async function fetchMarketData(world, itemId) {
  // ワールドが指定されていない場合は日本全DCを検索
  const searchWorld = world || 'Japan';
  // entries=10 で取引履歴を10件取得
  const url = `${UNIVERSALIS_BASE}/${encodeURIComponent(searchWorld)}/${itemId}?entries=10`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Universalis error: ${response.status}`);

  const data = await response.json();
  return {
    itemName: data.itemName || data.name,
    listings: data.listings || [],
    recentHistory: data.recentHistory || [],
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
      --primary-hover: #2563eb;
      --bg: #f8fafc;
      --sidebar-bg: #ffffff;
      --text: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --hover-bg: #f1f5f9;
      --selected-bg: #dbeafe;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .header {
      background: var(--sidebar-bg);
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    h1 {
      font-size: 1.5rem;
      margin: 0;
    }

    .header-right {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .header-right select {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 14px;
      background: white;
      cursor: pointer;
      min-width: 150px;
    }

    .header-right select:focus {
      outline: none;
      border-color: var(--primary);
    }

    .header-right label {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .main-container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .sidebar {
      width: 320px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .search-box {
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }

    .search-box input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 14px;
    }

    .search-box input:focus {
      outline: none;
      border-color: var(--primary);
    }


    .item-list {
      flex: 1;
      overflow-y: auto;
    }

    .item {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.15s;
    }

    .item:hover {
      background: var(--hover-bg);
    }

    .item.selected {
      background: var(--selected-bg);
      border-left: 3px solid var(--primary);
    }

    .item-name {
      font-weight: 500;
      margin-bottom: 4px;
    }

    .item-meta {
      font-size: 12px;
      color: var(--text-muted);
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .content-header {
      margin-bottom: 24px;
    }

    .content-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .content-meta {
      color: var(--text-muted);
      font-size: 14px;
    }

    .section {
      margin-bottom: 32px;
    }

    .section-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid var(--border);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }

    th {
      background: var(--hover-bg);
      padding: 12px;
      text-align: left;
      font-weight: 600;
      font-size: 13px;
      border-bottom: 2px solid var(--border);
    }

    td {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover {
      background: var(--hover-bg);
    }

    .price {
      font-weight: 600;
      color: var(--primary);
    }

    .badge-hq {
      display: inline-block;
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: white;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 3px;
      vertical-align: middle;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
    }

    .loading {
      text-align: center;
      padding: 24px;
      color: var(--text-muted);
    }

    .table-wrapper {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    /* モバイル対応 */
    @media (max-width: 768px) {
      .header {
        flex-direction: column;
        gap: 12px;
        align-items: stretch;
      }

      h1 {
        font-size: 1.25rem;
      }

      .header-right {
        flex-direction: column;
        gap: 8px;
      }

      .header-right select {
        width: 100%;
      }

      .main-container {
        flex-direction: column;
      }

      .sidebar {
        width: 100%;
        max-height: 40vh;
        border-right: none;
        border-bottom: 1px solid var(--border);
      }

      .content {
        padding: 16px;
      }

      .content-title {
        font-size: 1.1rem;
      }

      .section-title {
        font-size: 1rem;
      }

      table {
        font-size: 12px;
      }

      th, td {
        padding: 8px 6px;
      }

      .item {
        padding: 10px 12px;
      }
    }

    @media (max-width: 480px) {
      .header {
        padding: 12px 16px;
      }

      .content {
        padding: 12px;
      }

      h1 {
        font-size: 1.1rem;
      }

      table {
        font-size: 11px;
      }

      th, td {
        padding: 6px 4px;
      }

      .badge-hq {
        font-size: 10px;
        padding: 1px 4px;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>FFXIV マーケット検索</h1>
    <div class="header-right">
      <label>データセンター:</label>
      <select id="dcSelect">
        <option value="">全エリア</option>
      </select>
      <label>ワールド:</label>
      <select id="worldSelect">
        <option value="">全ワールド</option>
      </select>
    </div>
  </div>

  <div class="main-container">
    <div class="sidebar">
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="アイテム名で検索..." />
      </div>
      <div class="item-list" id="itemList">
        <div class="empty-state">アイテムを検索してください</div>
      </div>
    </div>

    <div class="content" id="content">
      <div class="empty-state">
        左側のリストからアイテムを選択してください
      </div>
    </div>
  </div>

  <script>
    let searchResults = [];
    let selectedItem = null;
    let debounceTimer = null;
    let worldData = { dataCenters: [], worlds: [] };

    const searchInput = document.getElementById('searchInput');
    const dcSelect = document.getElementById('dcSelect');
    const worldSelect = document.getElementById('worldSelect');
    const itemList = document.getElementById('itemList');
    const content = document.getElementById('content');

    // 初期化：ワールド/DCデータを取得
    (async function init() {
      try {
        const response = await fetch('https://v2.xivapi.com/api/sheet/World?fields=Name,DataCenter.Name,Region,IsPublic&language=ja&limit=400');
        const data = await response.json();

        // IsPublic=trueのワールドのみ抽出
        const publicWorlds = data.rows
          .filter(r => r.fields.IsPublic === true)
          .map(r => ({
            name: r.fields.Name,
            dc: r.fields.DataCenter.fields.Name
          }));

        // データセンターリストを作成（重複除去）
        const dcSet = new Set(publicWorlds.map(w => w.dc));
        worldData.dataCenters = Array.from(dcSet).sort();
        worldData.worlds = publicWorlds;

        // データセンタープルダウンを設定
        worldData.dataCenters.forEach(dc => {
          const option = document.createElement('option');
          option.value = dc;
          option.textContent = dc;
          dcSelect.appendChild(option);
        });

      } catch (error) {
        console.error('Failed to load world data:', error);
      }
    })();

    // データセンター選択時にワールドを絞り込み
    dcSelect.addEventListener('change', () => {
      const selectedDC = dcSelect.value;
      worldSelect.innerHTML = '<option value="">全ワールド</option>';

      if (selectedDC) {
        const filteredWorlds = worldData.worlds.filter(w => w.dc === selectedDC);
        filteredWorlds.forEach(w => {
          const option = document.createElement('option');
          option.value = w.name;
          option.textContent = w.name;
          worldSelect.appendChild(option);
        });
      } else {
        // 全エリア選択時は全ワールド表示
        worldData.worlds.forEach(w => {
          const option = document.createElement('option');
          option.value = w.name;
          option.textContent = \`\${w.name} (\${w.dc})\`;
          worldSelect.appendChild(option);
        });
      }

      // 選択中のアイテムがあれば再検索
      if (selectedItem) {
        loadMarketData();
      }
    });

    // ワールド選択時に再検索
    worldSelect.addEventListener('change', () => {
      if (selectedItem) {
        loadMarketData();
      }
    });

    // 検索入力のデバウンス
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const query = searchInput.value.trim();
        if (query.length >= 2) {
          searchItems(query);
        } else {
          itemList.innerHTML = '<div class="empty-state">2文字以上入力してください</div>';
          searchResults = [];
        }
      }, 300);
    });

    // アイテム検索
    async function searchItems(query) {
      itemList.innerHTML = '<div class="loading">検索中...</div>';

      try {
        const url = \`https://v2.xivapi.com/api/search?sheets=Item&fields=Name,ItemUICategory.Name,Icon&language=ja&query=Name~"\${encodeURIComponent(query)}"&limit=50\`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.results && data.results.length > 0) {
          searchResults = data.results.map(r => {
            // Icon.id から URL を生成
            let iconUrl = '';
            if (r.fields.Icon && r.fields.Icon.id) {
              const iconId = r.fields.Icon.id;
              const folder = String(Math.floor(iconId / 1000) * 1000).padStart(6, '0');
              const file = String(iconId).padStart(6, '0');
              iconUrl = \`https://xivapi.com/i/\${folder}/\${file}.png\`;
            }

            return {
              id: r.row_id,
              name: r.fields.Name,
              category: r.fields.ItemUICategory?.Name || '不明',
              iconUrl: iconUrl
            };
          });
          displayItemList();
        } else {
          itemList.innerHTML = '<div class="empty-state">該当なし</div>';
          searchResults = [];
        }
      } catch (error) {
        itemList.innerHTML = '<div class="empty-state">エラーが発生しました</div>';
        console.error('Search error:', error);
      }
    }

    // アイテムリスト表示
    function displayItemList() {
      itemList.innerHTML = searchResults.map((item, idx) => {
        return \`
          <div class="item \${selectedItem && selectedItem.id === item.id ? 'selected' : ''}" onclick="selectItem(\${idx})">
            <div style="display: flex; align-items: center; gap: 8px;">
              \${item.iconUrl ? \`<img src="\${item.iconUrl}" alt="" style="width: 32px; height: 32px; flex-shrink: 0;">\` : ''}
              <div style="flex: 1; min-width: 0;">
                <div class="item-name">\${escapeHtml(item.name)}</div>
                <div class="item-meta">\${escapeHtml(item.category)}</div>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    // アイテム選択
    async function selectItem(index) {
      selectedItem = searchResults[index];
      displayItemList();
      await loadMarketData();
    }

    // マーケットデータ取得
    async function loadMarketData() {
      if (!selectedItem) return;

      content.innerHTML = '<div class="loading">マーケットデータ読み込み中...</div>';

      // ワールドが選択されている場合はワールド名、データセンターのみの場合はDC名を使用
      const world = worldSelect.value.trim() || dcSelect.value.trim() || '';

      try {
        const response = await fetch(\`/api/search?q=\${encodeURIComponent(selectedItem.name)}&world=\${encodeURIComponent(world)}\`);
        const data = await response.json();

        if (!response.ok) {
          content.innerHTML = \`<div class="empty-state">\${data.message || 'エラーが発生しました'}</div>\`;
          return;
        }

        displayMarketData(data);
      } catch (error) {
        content.innerHTML = '<div class="empty-state">通信エラーが発生しました</div>';
        console.error('Market data error:', error);
      }
    }

    // マーケットデータ表示
    function displayMarketData(data) {
      const listings = data.listings || [];
      const recentSales = data.recentHistory || [];

      // 現在選択されているDC/ワールド情報を取得
      const selectedDC = dcSelect.options[dcSelect.selectedIndex].text;
      const selectedWorld = worldSelect.options[worldSelect.selectedIndex].text;

      let locationInfo = '';
      if (worldSelect.value) {
        // ワールドが選択されている場合
        const worldObj = worldData.worlds.find(w => w.name === worldSelect.value);
        locationInfo = worldObj ? \`\${worldObj.dc} - \${worldObj.name}\` : selectedWorld;
      } else if (dcSelect.value) {
        // DCのみ選択されている場合
        locationInfo = \`\${selectedDC} (全ワールド)\`;
      } else {
        // 何も選択されていない場合
        locationInfo = '全エリア';
      }

      let html = \`
        <div class="content-header">
          <div class="content-title">\${escapeHtml(data.itemName)}</div>
          <div class="content-meta">
            検索エリア: \${escapeHtml(locationInfo)} | 出品数: \${listings.length}件
          </div>
        </div>
      \`;

      // 出品Top10
      html += \`
        <div class="section">
          <div class="section-title">現在の出品 Top10</div>
          \${listings.length > 0 ? \`
            <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>ワールド</th>
                  <th>価格</th>
                  <th>数量</th>
                  <th>品質</th>
                  <th>合計</th>
                  <th>リテイナー</th>
                </tr>
              </thead>
              <tbody>
                \${listings.slice(0, 10).map(l => {
                  // ワールド名からDCを取得
                  const worldObj = worldData.worlds.find(w => w.name === l.worldName);
                  const dcName = worldObj ? worldObj.dc : '';
                  const worldDisplay = dcName ? \`\${dcName} - \${l.worldName}\` : l.worldName;

                  return \`
                    <tr>
                      <td>\${escapeHtml(worldDisplay || '-')}</td>
                      <td>\${l.price.toLocaleString()} Gil</td>
                      <td>\${l.quantity}</td>
                      <td>\${l.hq ? '<span class="badge-hq">HQ</span>' : ''}</td>
                      <td class="price">\${l.total.toLocaleString()} Gil</td>
                      <td>\${escapeHtml(l.retainerName || '-')}</td>
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            </table>
            </div>
          \` : '<div class="empty-state">出品がありません</div>'}
        </div>
      \`;

      // 取引履歴Top10
      html += \`
        <div class="section">
          <div class="section-title">過去の取引実績 Top10</div>
          \${recentSales.length > 0 ? \`
            <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>ワールド</th>
                  <th>品質</th>
                  <th>金額</th>
                  <th>個数</th>
                  <th>購入者</th>
                  <th>購入日</th>
                </tr>
              </thead>
              <tbody>
                \${recentSales.map(h => {
                  // ワールド名からDCを取得
                  const worldObj = worldData.worlds.find(w => w.name === h.worldName);
                  const dcName = worldObj ? worldObj.dc : '';
                  const worldDisplay = dcName ? \`\${dcName} - \${h.worldName}\` : h.worldName;

                  // タイムスタンプをフォーマット
                  const date = new Date(h.timestamp * 1000);
                  const dateStr = \`\${date.getMonth() + 1}/\${date.getDate()} \${String(date.getHours()).padStart(2, '0')}:\${String(date.getMinutes()).padStart(2, '0')}\`;

                  return \`
                    <tr>
                      <td>\${escapeHtml(worldDisplay || '-')}</td>
                      <td>\${h.hq ? '<span class="badge-hq">HQ</span>' : ''}</td>
                      <td>\${h.price.toLocaleString()} Gil</td>
                      <td>\${h.quantity}</td>
                      <td>\${escapeHtml(h.buyerName || '-')}</td>
                      <td>\${dateStr}</td>
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            </table>
            </div>
          \` : '<div class="empty-state">取引履歴がありません</div>'}
        </div>
      \`;

      content.innerHTML = html;
    }

    function escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
      return String(text || '').replace(/[&<>"']/g, m => map[m]);
    }
  </script>
</body>
</html>
`;
