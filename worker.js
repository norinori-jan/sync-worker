export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
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
       AI 中継: POST /ai
       端末にAPIキーを入れなくて済むように、キーはこのWorkerのsecretだけに置く。
       認証トークンが設定されていないWorkerでは使えない（誰でも呼べてしまうため）。
    ───────────────────────────── */
    if (pathParts[0] === 'ai') {
      return handleAI(request, env, corsHeaders, validToken);
    }

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

/* ─────────────────────────────
   AI 中継の本体
   入力 : { provider:'claude'|'gemini'|'openai', model, maxTokens?, prompt }
   出力 : { text, provider, model }
   キー : env.ANTHROPIC_API_KEY / env.GEMINI_API_KEY / env.OPENAI_API_KEY（wrangler secret put で登録）
   上限 : 1日 env.AI_DAILY_LIMIT 回（既定 300。日本時間の日付で数える）
   プロンプトの中身はログに出さない。
───────────────────────────── */
async function handleAI(request, env, corsHeaders, validToken) {
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
  const scrub = t => String(t || '')
    .replace(/(sk-|AIza|ghp_|github_pat_)[A-Za-z0-9_\-*.]+/g, '…')
    .replace(/\s+/g, ' ').slice(0, 200);

  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  if (!validToken) return json({ error: 'AI中継は、認証トークンを設定したWorkerでだけ使えます' }, 503);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'JSONを読めませんでした' }, 400); }
  const provider = body && body.provider;
  const model = String((body && body.model) || '');
  const prompt = body && body.prompt;
  if (!['claude', 'gemini', 'openai'].includes(provider)) return json({ error: 'provider が正しくありません' }, 400);
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(model)) return json({ error: 'model が正しくありません' }, 400);
  if (typeof prompt !== 'string' || !prompt.trim()) return json({ error: 'prompt がありません' }, 400);
  if (prompt.length > 60000) return json({ error: 'prompt が長すぎます（60000文字まで）' }, 413);
  let maxTokens = body.maxTokens === undefined || body.maxTokens === null ? null : Math.floor(Number(body.maxTokens));
  if (maxTokens !== null) {
    if (!Number.isFinite(maxTokens)) maxTokens = 1000;
    maxTokens = Math.min(4000, Math.max(1, maxTokens));
  }

  const keyName = { claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' }[provider];
  const apiKey = env[keyName];
  if (!apiKey) return json({ error: provider + ' のAPIキーがWorkerに登録されていません（' + keyName + '）' }, 503);

  // 1日の上限（日本時間の日付）。KVの読み書きは原子的ではないので、目安として使う。
  const limit = Math.max(1, Number(env.AI_DAILY_LIMIT) || 300);
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const usageKey = 'ai-usage:' + day;
  let used = 0;
  try { used = Number(await env.SYNC_KV.get(usageKey)) || 0; } catch (_) {}
  if (used >= limit) return json({ error: '今日のAI呼び出し上限（' + limit + '回）に達しました' }, 429);
  try { await env.SYNC_KV.put(usageKey, String(used + 1), { expirationTtl: 172800 }); } catch (_) {}

  let req;
  if (provider === 'claude') {
    req = ['https://api.anthropic.com/v1/messages', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: maxTokens || 1000, messages: [{ role: 'user', content: prompt }] }
    }];
  } else if (provider === 'gemini') {
    const b = { contents: [{ parts: [{ text: prompt }] }] };
    if (maxTokens) b.generationConfig = { maxOutputTokens: maxTokens };
    req = ['https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      headers: { 'x-goog-api-key': apiKey },
      body: b
    }];
  } else {
    req = ['https://api.openai.com/v1/chat/completions', {
      headers: { Authorization: 'Bearer ' + apiKey },
      body: { model, max_completion_tokens: maxTokens || 1000, messages: [{ role: 'user', content: prompt }] }
    }];
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 80000);
  let res;
  try {
    res = await fetch(req[0], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...req[1].headers },
      body: JSON.stringify(req[1].body),
      signal: ctl.signal
    });
  } catch (e) {
    return json({ error: e && e.name === 'AbortError' ? 'AIの応答が80秒ありませんでした' : 'AIに接続できませんでした' }, e && e.name === 'AbortError' ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }

  let d = null;
  try { d = await res.json(); } catch (_) {}
  if (!res.ok) {
    const e = d && (d.error !== undefined ? d.error : d.message);
    const msg = scrub((e && e.message) || (typeof e === 'string' ? e : ''));
    // 提供元の認証エラー（キーの誤り・失効）や障害は、こちらの認証エラーと区別できるよう 502 にする
    const status = (res.status === 401 || res.status === 403 || res.status >= 500) ? 502 : res.status;
    return json({ error: provider + ' ' + res.status + (msg ? '：' + msg : '') }, status);
  }

  let text = '';
  if (provider === 'claude') {
    text = Array.isArray(d && d.content) ? d.content.map(c => (c && c.text) || '').join('') : '';
  } else if (provider === 'gemini') {
    const parts = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
    text = Array.isArray(parts) ? parts.map(p => (p && p.text) || '').join('') : '';
  } else {
    text = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  }
  return json({ text, provider, model }, 200);
}
