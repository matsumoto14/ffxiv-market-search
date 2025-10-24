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
    console.log(`[Search] 検索開始: query="${q}", world="${world}", hq=${hq}, minPrice=${minPrice}, maxPrice=${maxPrice}, page=${page}, perPage=${perPage}, sort="${sort}"`);

    // XIVAPI でアイテムID検索
    const itemResult = await searchItemId(q);
    if (!itemResult) {
      console.log(`[Search] アイテムが見つかりませんでした: query="${q}"`);
      return jsonResponse({ error: 'item_not_found', message: `アイテム "${q}" が見つかりませんでした` }, 404);
    }

    console.log(`[Search] アイテム検索完了: id=${itemResult.id}, name="${itemResult.name}"`);

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

    console.log(`[Search] データ処理完了: 全${listings.length}件中${paginatedListings.length}件表示 (page=${page}, perPage=${perPage})`);

    // 日本の各ワールドごとのTop10取得のため、Japan全体のデータを取得
    const japanWorlds = ['Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Ramuh', 'Tonberry', 'Typhon', 'Unicorn',
                         'Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima',
                         'Anima', 'Asura', 'Belias', 'Chocobo', 'Hades', 'Ixion', 'Mandragora', 'Masamune', 'Pandaemonium', 'Shinryu', 'Titan'];

    const worldTop10 = {};
    const historyLast3Months = [];
    try {
      // 過去3か月分のデータを取得するため、大量のentriesを指定（最大値: 10000程度）
      const japanMarketData = await fetchMarketData('Japan', itemResult.id, 10000);
      if (japanMarketData && japanMarketData.recentHistory) {
        console.log(`[Search] Japan全体の取引履歴: ${japanMarketData.recentHistory.length}件取得`);

        // 過去3か月の期間を計算（秒単位のUnixタイムスタンプ）
        const now = Math.floor(Date.now() / 1000);
        const threeMonthsAgo = now - (90 * 24 * 60 * 60); // 90日前

        // 過去3か月分のデータをフィルタリング
        const last3MonthsData = japanMarketData.recentHistory.filter(h => h.timestamp >= threeMonthsAgo);
        console.log(`[Search] 過去3か月分の取引履歴: ${last3MonthsData.length}件`);

        // 過去3か月分のデータを保存（グラフ用）
        historyLast3Months.push(...last3MonthsData.map(h => ({
          price: h.pricePerUnit,
          quantity: h.quantity,
          hq: h.hq,
          timestamp: h.timestamp,
          worldName: h.worldName,
        })));

        // 各ワールドごとに取引履歴を分類してTop10を作成（最新10件を取得）
        japanWorlds.forEach(worldName => {
          const worldHistory = japanMarketData.recentHistory
            .filter(h => h.worldName === worldName)
            .slice(0, 10)  // 最新10件の取引履歴
            .map(h => ({
              price: h.pricePerUnit,
              quantity: h.quantity,
              hq: h.hq,
              timestamp: h.timestamp,
            }));
          if (worldHistory.length > 0) {
            worldTop10[worldName] = worldHistory;
          }
        });
        console.log(`[Search] 各ワールドのTop10取得完了: ${Object.keys(worldTop10).length}ワールド`);
      }
    } catch (error) {
      console.error(`[Search] Japan全体のデータ取得エラー: ${error.message}`);
    }

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
      worldTop10: worldTop10,
      historyLast3Months: historyLast3Months,
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

    console.log(`[Search] 検索完了: query="${q}", 結果${result.total}件, キャッシュ保存完了`);

    return response;

  } catch (error) {
    console.error(`[Search] 検索エラー: query="${q}", error=${error.message}`, error);
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

  console.log(`[XIVAPI] アイテム検索開始: query="${query}", url="${url}"`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'FFXIV-Market-Search/1.0',
        'Accept': 'application/json'
      }
    });

    console.log(`[XIVAPI] レスポンス受信: status=${response.status}, ok=${response.ok}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[XIVAPI] エラー: status=${response.status}, body=${errorText}`);
      throw new Error(`XIVAPI error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log(`[XIVAPI] データ受信: results=${data.results?.length || 0}件`);

    // v2のレスポンス形式: { results: [{ row_id, fields: { Name, ... } }] }
    if (data.results && data.results.length > 0) {
      // 最初のマッチを返す
      const item = data.results[0];
      console.log(`[XIVAPI] アイテム見つかり: id=${item.row_id}, name="${item.fields?.Name}"`);
      return {
        id: item.row_id,
        name: item.fields?.Name || query
      };
    }

    console.log(`[XIVAPI] アイテムが見つかりませんでした: query="${query}"`);
    return null;

  } catch (error) {
    console.error(`[XIVAPI] 例外エラー: query="${query}", error=${error.message}`, error);
    throw error;
  }
}

async function fetchMarketData(world, itemId, entries = 10) {
  // ワールドが指定されていない場合は日本全DCを検索
  const searchWorld = world || 'Japan';
  // entries で取引履歴を取得（デフォルト10件）
  const url = `${UNIVERSALIS_BASE}/${encodeURIComponent(searchWorld)}/${itemId}?entries=${entries}`;

  console.log(`[Universalis] マーケットデータ取得開始: world="${searchWorld}", itemId=${itemId}, url="${url}"`);

  try {
    const response = await fetch(url);
    console.log(`[Universalis] レスポンス受信: status=${response.status}, ok=${response.ok}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Universalis] エラー: status=${response.status}, body=${errorText}`);
      throw new Error(`Universalis error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log(`[Universalis] データ受信: itemName="${data.itemName || data.name}", listings=${data.listings?.length || 0}件, history=${data.recentHistory?.length || 0}件`);

    return {
      itemName: data.itemName || data.name,
      listings: data.listings || [],
      recentHistory: data.recentHistory || [],
      averagePrice: data.averagePrice,
    };

  } catch (error) {
    console.error(`[Universalis] 例外エラー: world="${searchWorld}", itemId=${itemId}, error=${error.message}`, error);
    throw error;
  }
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
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
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

    /* グラフ用スタイル */
    .chart-container {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      margin-top: 16px;
    }

    .chart-wrapper {
      position: relative;
      height: 400px;
      width: 100%;
    }

    @media (max-width: 768px) {
      .chart-wrapper {
        height: 300px;
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
      <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
        <input type="checkbox" id="hqOnly" style="cursor: pointer;">
        <span>HQのみ</span>
      </label>
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
    const hqOnly = document.getElementById('hqOnly');
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

    // HQ絞り込み変更時に再検索
    hqOnly.addEventListener('change', () => {
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
      console.log('[Frontend] アイテム検索開始:', query);

      try {
        const url = \`https://v2.xivapi.com/api/search?sheets=Item&fields=Name,ItemUICategory.Name,Icon&language=ja&query=Name~"\${encodeURIComponent(query)}"&limit=50\`;
        console.log('[Frontend] アイテム検索URL:', url);
        
        const response = await fetch(url);
        console.log('[Frontend] アイテム検索API レスポンス:', response.status, response.ok);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('[Frontend] アイテム検索API エラー:', response.status, errorText);
          throw new Error('Item search API error: ' + response.status + ' - ' + errorText);
        }
        
        const data = await response.json();
        console.log('[Frontend] アイテム検索結果:', data.results?.length || 0, '件');

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
          console.log('[Frontend] アイテム検索完了:', searchResults.length, '件');
          displayItemList();
        } else {
          console.log('[Frontend] アイテム検索結果なし:', query);
          itemList.innerHTML = '<div class="empty-state">該当なし</div>';
          searchResults = [];
        }
      } catch (error) {
        console.error('[Frontend] アイテム検索エラー:', query, error.message, error);
        itemList.innerHTML = '<div class="empty-state">エラーが発生しました</div>';
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
      const hq = hqOnly.checked ? 'true' : 'false';
      const apiUrl = \`/api/search?q=\${encodeURIComponent(selectedItem.name)}&world=\${encodeURIComponent(world)}&hq=\${hq}\`;
      
      console.log('[Frontend] マーケットデータ取得開始:', selectedItem.name, 'world:', world);
      console.log('[Frontend] マーケットデータAPI URL:', apiUrl);

      try {
        const response = await fetch(apiUrl);
        console.log('[Frontend] マーケットデータAPI レスポンス:', response.status, response.ok);
        
        const data = await response.json();

        if (!response.ok) {
          console.error('[Frontend] マーケットデータAPI エラー:', response.status, data);
          content.innerHTML = \`<div class="empty-state">\${data.message || 'エラーが発生しました'}</div>\`;
          return;
        }

        console.log('[Frontend] マーケットデータ受信:', data.listings?.length || 0, '件の出品,', data.recentHistory?.length || 0, '件の履歴');
        displayMarketData(data);
      } catch (error) {
        console.error('[Frontend] マーケットデータ取得エラー:', selectedItem.name, error.message, error);
        content.innerHTML = '<div class="empty-state">通信エラーが発生しました</div>';
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

      // 日本全ワールドTop10取引履歴（DC単位でグルーピング）
      html += \`
        <div class="section">
          <div class="section-title">
            日本全ワールド 過去の取引実績 Top10
            <div style="display: inline-block; margin-left: 16px; font-size: 12px; font-weight: 400;">
              <button onclick="toggleDC('Elemental')" id="btnElemental" style="margin: 0 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--primary); background: var(--primary); color: white; border-radius: 4px;">Elemental</button>
              <button onclick="toggleDC('Gaia')" id="btnGaia" style="margin: 0 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--primary); background: var(--primary); color: white; border-radius: 4px;">Gaia</button>
              <button onclick="toggleDC('Mana')" id="btnMana" style="margin: 0 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--primary); background: var(--primary); color: white; border-radius: 4px;">Mana</button>
            </div>
          </div>
          \${data.worldTop10 && Object.keys(data.worldTop10).length > 0 ? \`
            <div class="table-wrapper">
              <table style="font-size: 11px;">
                <thead>
                  <tr>
                    <th style="width: 50px; text-align: center; position: sticky; left: 0; background: var(--hover-bg); z-index: 10;">順位</th>
                    \${(() => {
                      // DC単位でグルーピング
                      const dcGroups = {
                        'Elemental': ['Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Ramuh', 'Tonberry', 'Typhon', 'Unicorn'],
                        'Gaia': ['Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima'],
                        'Mana': ['Anima', 'Asura', 'Belias', 'Chocobo', 'Hades', 'Ixion', 'Mandragora', 'Masamune', 'Pandaemonium', 'Shinryu', 'Titan']
                      };

                      let headers = '';
                      const dcKeys = Object.keys(dcGroups);
                      dcKeys.forEach((dcName, dcIndex) => {
                        const dcWorlds = dcGroups[dcName].filter(w => data.worldTop10[w]);
                        if (dcWorlds.length > 0) {
                          const isLastDC = dcIndex === dcKeys.length - 1;
                          const borderRight = isLastDC ? '' : 'border-right: 3px solid var(--border);';
                          headers += \`<th colspan="\${dcWorlds.length}" class="dc-header dc-\${dcName}" style="text-align: center; background: var(--selected-bg); font-size: 13px; font-weight: 700; padding: 6px; \${borderRight}">\${dcName}</th>\`;
                        }
                      });
                      return headers;
                    })()}
                  </tr>
                  <tr>
                    <th style="width: 50px; text-align: center; position: sticky; left: 0; background: var(--hover-bg); z-index: 10;"></th>
                    \${(() => {
                      const dcGroups = {
                        'Elemental': ['Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Ramuh', 'Tonberry', 'Typhon', 'Unicorn'],
                        'Gaia': ['Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima'],
                        'Mana': ['Anima', 'Asura', 'Belias', 'Chocobo', 'Hades', 'Ixion', 'Mandragora', 'Masamune', 'Pandaemonium', 'Shinryu', 'Titan']
                      };

                      // 各ワールドの平均価格を計算
                      const worldAverages = {};
                      Object.values(dcGroups).flat().forEach(worldName => {
                        if (data.worldTop10[worldName]) {
                          const prices = data.worldTop10[worldName].map(h => h.price);
                          worldAverages[worldName] = prices.reduce((sum, p) => sum + p, 0) / prices.length;
                        }
                      });

                      // 全体の最高・最低平均価格を取得
                      const avgValues = Object.values(worldAverages);
                      const maxAvg = Math.max(...avgValues);
                      const minAvg = Math.min(...avgValues);

                      // 平均価格に応じて背景色を計算する関数
                      const getBackgroundColor = (avg) => {
                        if (avgValues.length === 1) return '';
                        const ratio = (avg - minAvg) / (maxAvg - minAvg);
                        if (ratio >= 0.5) {
                          // 高い: 赤系（中央より高い）
                          const intensity = ratio * 0.4; // 0 ~ 0.4の範囲
                          return \`rgba(255, 200, 200, \${intensity})\`;
                        } else {
                          // 安い: 青系（中央より低い）
                          const intensity = (1 - ratio) * 0.4; // 0 ~ 0.4の範囲
                          return \`rgba(200, 220, 255, \${intensity})\`;
                        }
                      };

                      let worldHeaders = '';
                      Object.keys(dcGroups).forEach(dcName => {
                        const dcWorlds = dcGroups[dcName].filter(w => data.worldTop10[w]);
                        dcWorlds.forEach((worldName, index) => {
                          const bgColor = worldAverages[worldName] ? getBackgroundColor(worldAverages[worldName]) : '';
                          const isLastInDC = index === dcWorlds.length - 1;
                          const borderRight = isLastInDC ? 'border-right: 3px solid var(--border);' : '';
                          worldHeaders += \`<th class="world-header dc-\${dcName}" style="text-align: center; padding: 4px 2px; min-width: 85px; font-size: 10px; background: \${bgColor}; \${borderRight}">\${escapeHtml(worldName)}</th>\`;
                        });
                      });
                      return worldHeaders;
                    })()}
                  </tr>
                </thead>
                <tbody>
                  \${Array.from({length: 10}, (_, rank) => {
                    const dcGroups = {
                      'Elemental': ['Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Ramuh', 'Tonberry', 'Typhon', 'Unicorn'],
                      'Gaia': ['Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima'],
                      'Mana': ['Anima', 'Asura', 'Belias', 'Chocobo', 'Hades', 'Ixion', 'Mandragora', 'Masamune', 'Pandaemonium', 'Shinryu', 'Titan']
                    };

                    // 各ワールドの平均価格を計算（ヘッダーと同じロジック）
                    const worldAverages = {};
                    Object.values(dcGroups).flat().forEach(worldName => {
                      if (data.worldTop10[worldName]) {
                        const prices = data.worldTop10[worldName].map(h => h.price);
                        worldAverages[worldName] = prices.reduce((sum, p) => sum + p, 0) / prices.length;
                      }
                    });

                    const avgValues = Object.values(worldAverages);
                    const maxAvg = Math.max(...avgValues);
                    const minAvg = Math.min(...avgValues);

                    const getBackgroundColor = (avg) => {
                      if (avgValues.length === 1) return '';
                      const ratio = (avg - minAvg) / (maxAvg - minAvg);
                      if (ratio >= 0.5) {
                        // 高い: 赤系（中央より高い）
                        const intensity = ratio * 0.4; // 0 ~ 0.4の範囲
                        return \`rgba(255, 200, 200, \${intensity})\`;
                      } else {
                        // 安い: 青系（中央より低い）
                        const intensity = (1 - ratio) * 0.4; // 0 ~ 0.4の範囲
                        return \`rgba(200, 220, 255, \${intensity})\`;
                      }
                    };

                    let cells = '';
                    Object.keys(dcGroups).forEach(dcName => {
                      const dcWorlds = dcGroups[dcName].filter(w => data.worldTop10[w]);
                      dcWorlds.forEach((worldName, index) => {
                        const historyList = data.worldTop10[worldName];
                        const item = historyList[rank];
                        const bgColor = worldAverages[worldName] ? getBackgroundColor(worldAverages[worldName]) : '';
                        const isLastInDC = index === dcWorlds.length - 1;
                        const borderRight = isLastInDC ? 'border-right: 3px solid var(--border);' : '';

                        if (!item) {
                          cells += \`<td class="world-cell dc-\${dcName}" style="text-align: center; color: var(--text-muted); padding: 4px 2px; background: \${bgColor}; \${borderRight}">-</td>\`;
                        } else {
                          const date = new Date(item.timestamp * 1000);
                          const dateStr = \`\${date.getMonth() + 1}/\${date.getDate()} \${String(date.getHours()).padStart(2, '0')}:\${String(date.getMinutes()).padStart(2, '0')}\`;

                          cells += \`
                            <td class="world-cell dc-\${dcName}" style="text-align: center; padding: 4px 2px; line-height: 1.4; background: \${bgColor}; \${borderRight}">
                              <div style="font-weight: 700; color: var(--primary); font-size: 11px;">\${item.price.toLocaleString()}</div>
                              <div style="font-size: 9px; color: var(--text-muted);">\${item.quantity}個</div>
                              <div style="font-size: 8px; color: var(--text-muted);">\${dateStr}</div>
                            </td>
                          \`;
                        }
                      });
                    });

                    return \`
                      <tr>
                        <td style="text-align: center; font-weight: 600; position: sticky; left: 0; background: white; z-index: 5;">\${rank + 1}</td>
                        \${cells}
                      </tr>
                    \`;
                  }).join('')}
                </tbody>
              </table>
            </div>
            <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted); text-align: center;">
              ※ 横スクロールで全ワールドを確認できます｜DC単位でグルーピング表示
            </div>
          \` : '<div class="empty-state">取引履歴がありません</div>'}
        </div>
      \`;

      // 過去3か月の価格推移グラフセクション
      if (data.historyLast3Months && data.historyLast3Months.length > 0) {
        html += \`
          <div class="section">
            <div class="section-title">
              過去3か月の価格推移
              <div style="display: inline-block; margin-left: 16px; font-size: 12px; font-weight: 400;">
                <button onclick="updatePriceChart('all')" id="chartBtnAll" style="margin: 0 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--primary); background: var(--primary); color: white; border-radius: 4px;">全体</button>
                <button onclick="updatePriceChart('Elemental')" id="chartBtnElemental" style="margin: 0 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--primary); background: white; color: var(--primary); border-radius: 4px;">Elemental</button>
                <button onclick="updatePriceChart('Gaia')" id="chartBtnGaia" style="margin: 0 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--primary); background: white; color: var(--primary); border-radius: 4px;">Gaia</button>
                <button onclick="updatePriceChart('Mana')" id="chartBtnMana" style="margin: 0 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--primary); background: white; color: var(--primary); border-radius: 4px;">Mana</button>
              </div>
            </div>
            <div class="chart-container">
              <div class="chart-wrapper">
                <canvas id="priceChart"></canvas>
              </div>
            </div>
            <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted); text-align: center;">
              ※ データセンター単位で日別平均価格を表示｜ボタンをクリックしてDCを切り替え
            </div>
          </div>
        \`;
      }

      content.innerHTML = html;

      // グラフを初期化（データがある場合）
      if (data.historyLast3Months && data.historyLast3Months.length > 0) {
        // DOMが更新された後にグラフを初期化
        setTimeout(() => {
          initPriceChart(data);
        }, 100);
      }
    }

    function escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
      return String(text || '').replace(/[&<>"']/g, m => map[m]);
    }

    // DC表示切り替え用の状態管理
    const dcVisibility = {
      'Elemental': true,
      'Gaia': true,
      'Mana': true
    };

    // グラフ関連のグローバル変数
    let priceChartInstance = null;
    let currentMarketData = null;

    function toggleDC(dcName) {
      // 状態を反転
      dcVisibility[dcName] = !dcVisibility[dcName];

      // ボタンのスタイルを更新
      const btn = document.getElementById(\`btn\${dcName}\`);
      if (dcVisibility[dcName]) {
        btn.style.background = 'var(--primary)';
        btn.style.color = 'white';
      } else {
        btn.style.background = 'white';
        btn.style.color = 'var(--primary)';
      }

      // 該当するDCの列を表示/非表示
      const elements = document.querySelectorAll(\`.dc-\${dcName}\`);
      elements.forEach(el => {
        el.style.display = dcVisibility[dcName] ? '' : 'none';
      });
    }

    // グラフ初期化関数
    function initPriceChart(data) {
      currentMarketData = data;

      // 既存のグラフがあれば破棄
      if (priceChartInstance) {
        priceChartInstance.destroy();
      }

      // canvas要素を取得
      const canvas = document.getElementById('priceChart');
      if (!canvas) return;

      // デフォルトは全体表示
      updatePriceChart('all');
    }

    // グラフ更新関数
    function updatePriceChart(dcFilter) {
      if (!currentMarketData || !currentMarketData.historyLast3Months) return;

      const dcGroups = {
        'Elemental': ['Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Ramuh', 'Tonberry', 'Typhon', 'Unicorn'],
        'Gaia': ['Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima'],
        'Mana': ['Anima', 'Asura', 'Belias', 'Chocobo', 'Hades', 'Ixion', 'Mandragora', 'Masamune', 'Pandaemonium', 'Shinryu', 'Titan']
      };

      // ボタンのスタイルを更新
      ['all', 'Elemental', 'Gaia', 'Mana'].forEach(dc => {
        const btnId = dc === 'all' ? 'chartBtnAll' : \`chartBtn\${dc}\`;
        const btn = document.getElementById(btnId);
        if (btn) {
          if (dc === dcFilter) {
            btn.style.background = 'var(--primary)';
            btn.style.color = 'white';
          } else {
            btn.style.background = 'white';
            btn.style.color = 'var(--primary)';
          }
        }
      });

      // データをフィルタリング
      let filteredData = currentMarketData.historyLast3Months;
      if (dcFilter !== 'all') {
        const worldsInDC = dcGroups[dcFilter] || [];
        filteredData = filteredData.filter(h => worldsInDC.includes(h.worldName));
      }

      // 日別にデータを集計
      const dailyData = {};
      filteredData.forEach(h => {
        const date = new Date(h.timestamp * 1000);
        const dateKey = \`\${date.getFullYear()}-\${String(date.getMonth() + 1).padStart(2, '0')}-\${String(date.getDate()).padStart(2, '0')}\`;

        if (!dailyData[dateKey]) {
          dailyData[dateKey] = { prices: [], quantities: [] };
        }
        dailyData[dateKey].prices.push(h.price);
        dailyData[dateKey].quantities.push(h.quantity);
      });

      // 日付順にソート
      const sortedDates = Object.keys(dailyData).sort();

      // グラフデータを生成
      const labels = sortedDates.map(date => {
        const [y, m, d] = date.split('-');
        return \`\${m}/\${d}\`;
      });

      const avgPrices = sortedDates.map(date => {
        const prices = dailyData[date].prices;
        return Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
      });

      const minPrices = sortedDates.map(date => Math.min(...dailyData[date].prices));
      const maxPrices = sortedDates.map(date => Math.max(...dailyData[date].prices));

      // 既存のグラフがあれば破棄
      if (priceChartInstance) {
        priceChartInstance.destroy();
      }

      // グラフを描画
      const canvas = document.getElementById('priceChart');
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      priceChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: '平均価格',
              data: avgPrices,
              borderColor: 'rgb(59, 130, 246)',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              borderWidth: 2,
              pointRadius: 2,
              pointHoverRadius: 5,
              tension: 0.1,
              fill: true
            },
            {
              label: '最低価格',
              data: minPrices,
              borderColor: 'rgb(34, 197, 94)',
              backgroundColor: 'rgba(34, 197, 94, 0.05)',
              borderWidth: 1.5,
              pointRadius: 1,
              pointHoverRadius: 4,
              tension: 0.1,
              borderDash: [5, 5]
            },
            {
              label: '最高価格',
              data: maxPrices,
              borderColor: 'rgb(239, 68, 68)',
              backgroundColor: 'rgba(239, 68, 68, 0.05)',
              borderWidth: 1.5,
              pointRadius: 1,
              pointHoverRadius: 4,
              tension: 0.1,
              borderDash: [5, 5]
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false,
          },
          plugins: {
            legend: {
              display: true,
              position: 'top',
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  return context.dataset.label + ': ' + context.parsed.y.toLocaleString() + ' Gil';
                }
              }
            }
          },
          scales: {
            x: {
              display: true,
              title: {
                display: true,
                text: '日付'
              },
              ticks: {
                maxRotation: 45,
                minRotation: 45
              }
            },
            y: {
              display: true,
              title: {
                display: true,
                text: '価格 (Gil)'
              },
              ticks: {
                callback: function(value) {
                  return value.toLocaleString();
                }
              }
            }
          }
        }
      });
    }
  </script>
</body>
</html>
`;
