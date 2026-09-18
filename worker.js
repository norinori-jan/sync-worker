export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Item-Id, X-Mime-Type, X-File-Name, X-Updated-At',
      'Access-Control-Expose-Headers':
        'X-Item-Id, X-Mime-Type, X-File-Name, X-Updated-At',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Bearer トークン検証
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    // SECRET_TOKEN または AUTH_TOKEN のいずれかと一致すれば許可
    const validToken = env.SECRET_TOKEN || env.AUTH_TOKEN;
    if (validToken && token !== validToken) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    /* ─────────────────────────────
       添付ファイル個別同期
       ルート: /attachments/<appName>/<attId>
       KVキー: attachments:<appName>:<attId>
       バイナリはbase64化せず生のBlobのまま保存/返却する。
       メタデータ（itemId/mimeType/ファイル名/更新日時）はKVのmetadataと
       リクエスト/レスポンスのカスタムヘッダーで運ぶ。
    ───────────────────────────── */
    if (pathParts[0] === 'attachments') {
      const appName = pathParts[1];
      const attId = pathParts[2];

      if (!appName) {
        return new Response(JSON.stringify({ error: 'appName is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const prefix = `attachments:${appName}:`;

      // 一覧取得（attIdなし）：差分同期のためのメタデータ一覧のみ返す
      if (request.method === 'GET' && !attId) {
        const list = [];
        let cursor;
        do {
          const page = await env.SYNC_KV.list({ prefix, cursor });
          for (const key of page.keys) {
            const meta = key.metadata || {};
            list.push({
              id: key.name.slice(prefix.length),
              itemId: meta.itemId || null,
              mimeType: meta.mimeType || 'application/octet-stream',
              name: meta.name || '',
              updatedAt: meta.updatedAt || 0
            });
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);

        return new Response(JSON.stringify({ attachments: list }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 個別バイナリ取得
      if (request.method === 'GET' && attId) {
        const key = prefix + attId;
        const result = await env.SYNC_KV.getWithMetadata(key, 'arrayBuffer');
        if (!result || !result.value) {
          return new Response(JSON.stringify({ error: 'Not Found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        const meta = result.metadata || {};
        return new Response(result.value, {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': meta.mimeType || 'application/octet-stream',
            'X-Item-Id': meta.itemId || '',
            'X-Mime-Type': meta.mimeType || '',
            'X-File-Name': encodeURIComponent(meta.name || ''),
            'X-Updated-At': String(meta.updatedAt || 0)
          }
        });
      }

      // 個別バイナリ保存
      if (request.method === 'PUT' && attId) {
        const body = await request.arrayBuffer();
        const meta = {
          itemId: request.headers.get('X-Item-Id') || '',
          mimeType: request.headers.get('X-Mime-Type') || 'application/octet-stream',
          name: decodeURIComponent(request.headers.get('X-File-Name') || ''),
          updatedAt: Number(request.headers.get('X-Updated-At')) || Date.now()
        };
        await env.SYNC_KV.put(prefix + attId, body, { metadata: meta });
        return new Response(JSON.stringify({ status: 'ok', updatedAt: meta.updatedAt }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 個別削除
      if (request.method === 'DELETE' && attId) {
        await env.SYNC_KV.delete(prefix + attId);
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    /* ─────────────────────────────
       既存: アイテム本体の同期（変更なし）
    ───────────────────────────── */
    const appName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : 'flow-mind';

    // 1. データ取得 (GET)
    // cloud-sync.js は { timestamp, data } という形のJSONを期待している。
    // KVには { timestamp, data } の形でそのまま保存しているので、そのまま返す。
    if (request.method === 'GET') {
      const stored = await env.SYNC_KV.get(appName);
      if (!stored) {
        // データが無い場合は404を返す。cloud-sync.js側はこれをnull扱いする。
        return new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      return new Response(stored, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. データ保存 (PUT)
    // クライアント(cloud-sync.js)が送ってくるボディは { data: dataObj } という形。
    // ここでtimestampを付与し、{ timestamp, data } という形でKVに保存する。
    if (request.method === 'PUT') {
      try {
        const body = await request.json();
        const timestamp = Date.now();
        const record = { timestamp, data: body.data };
        await env.SYNC_KV.put(appName, JSON.stringify(record));
        return new Response(JSON.stringify({ status: 'ok', timestamp }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};