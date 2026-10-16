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
       声のメモの預かり箱: /inbox
       iPhone のショートカットが話した文を POST /inbox で預け、quick-ref が起動時に
       GET /inbox で受け取り、メモにしたあと POST /inbox/ack で消す。
       認証トークンが設定されていないWorkerでは使えない（誰でも書き込めてしまうため）。
    ───────────────────────────── */
    if (pathParts[0] === 'inbox') {
      return handleInbox(request, env, corsHeaders, validToken, pathParts[1]);
    }

    /* ─────────────────────────────
       音声の文字起こし: POST /transcribe（Gemini が音声を直接読む。OpenAI は不要）
    ───────────────────────────── */
    if (pathParts[0] === 'transcribe') {
      return handleTranscribe(request, env, corsHeaders, validToken);
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

/* ─────────────────────────────
   預かり箱（声のメモ・表・フロー）
   POST /inbox      {"text":"…","kind":"memo|table|flow","title":"…","tags":["…"]} を預ける（kind省略=memo。text/plainも可）
                    KV: inbox:<id>（90日で自動削除）。種類は KV の metadata にも持つ
   GET  /inbox      kind省略=memoだけ。?kind=table / ?kind=flow で種類ごと。古い順に最大40件
   POST /inbox/ack  {"ids":[…]} 受け取り済みを消す（最大40件。idは種類をまたいで一意）
───────────────────────────── */
async function handleInbox(request, env, corsHeaders, validToken, sub) {
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
  if (!validToken) return json({ error: '預かり箱は、認証トークンを設定したWorkerでだけ使えます' }, 503);
  const PREFIX = 'inbox:', MAX_TEXT = 8000, MAX_PENDING = 200, BATCH = 40, TTL = 60 * 60 * 24 * 90;
  const KINDS = ['memo', 'table', 'flow'];
  const validId = x => typeof x === 'string' && /^in[a-z0-9]{6,24}$/.test(x);
  const kindOf = v => (v && KINDS.includes(v.kind)) ? v.kind : 'memo';   // 古い記録（kindなし）はmemo
  const cleanTags = t => (Array.isArray(t) ? t : []).filter(x => typeof x === 'string').map(x => x.trim().slice(0, 30)).filter(Boolean).slice(0, 10);

  if (request.method === 'GET' && !sub) {
    const want = new URL(request.url).searchParams.get('kind') || 'memo';
    if (!KINDS.includes(want)) return json({ error: 'kind は memo / table / flow のどれかです' }, 400);
    const page = await env.SYNC_KV.list({ prefix: PREFIX, limit: 1000 });
    const names = (page.keys || []).filter(k => kindOf(k.metadata) === want).slice(0, BATCH);
    const items = [];
    for (const k of names) {
      let v = null;
      try { v = JSON.parse(await env.SYNC_KV.get(k.name)); } catch (_) {}
      if (v && validId(v.id) && typeof v.text === 'string') {
        const it = { id: v.id, text: v.text, createdAt: v.createdAt || 0, kind: kindOf(v) };
        if (typeof v.title === 'string' && v.title) it.title = v.title;
        if (Array.isArray(v.tags) && v.tags.length) it.tags = v.tags;
        items.push(it);
      }
    }
    items.sort((a, b) => a.createdAt - b.createdAt);
    return json({ items, more: names.length >= BATCH || page.list_complete === false }, 200);
  }

  if (request.method === 'POST' && sub === 'ack') {
    let b; try { b = await request.json(); } catch (_) { return json({ error: 'JSONを読めませんでした' }, 400); }
    const ids = (Array.isArray(b && b.ids) ? b.ids : []).filter(validId).slice(0, BATCH);
    for (const id of ids) await env.SYNC_KV.delete(PREFIX + id);
    return json({ ok: true, removed: ids.length }, 200);
  }

  if (request.method === 'POST' && !sub) {
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    let text = '', kind = 'memo', title = '', tags = [];
    if (ct.includes('application/json')) {
      let b; try { b = await request.json(); } catch (_) { return json({ error: 'JSONを読めませんでした' }, 400); }
      text = typeof (b && b.text) === 'string' ? b.text : '';
      if (b && b.kind != null) {
        if (!KINDS.includes(b.kind)) return json({ error: 'kind は memo / table / flow のどれかです' }, 400);
        kind = b.kind;
      }
      title = typeof (b && b.title) === 'string' ? b.title.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
      tags = cleanTags(b && b.tags);
    } else {
      try { text = await request.text(); } catch (_) {}
    }
    text = text.replace(/\r\n?/g, '\n').trim();
    if (!text) return json({ error: '本文が空です' }, 400);
    if (text.length > MAX_TEXT) return json({ error: '長すぎます（' + MAX_TEXT + '文字まで）' }, 413);
    const pending = await env.SYNC_KV.list({ prefix: PREFIX, limit: 1000 });
    const same = (pending.keys || []).filter(k => kindOf(k.metadata) === kind).length;
    if (same >= MAX_PENDING) return json({ error: '未受け取りが多すぎます。受け取り側のアプリを開いてください' }, 429);
    const now = Date.now();
    const id = 'in' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = { id, text, createdAt: now };
    if (kind !== 'memo') rec.kind = kind;
    if (title) rec.title = title;
    if (tags.length) rec.tags = tags;
    await env.SYNC_KV.put(PREFIX + id, JSON.stringify(rec), { expirationTtl: TTL, metadata: { kind } });
    return json({ ok: true, id, kind }, 200);
  }

  return json({ error: 'Method Not Allowed' }, 405);
}

/* ─────────────────────────────
   音声の文字起こし
   POST /transcribe  {"data":"<base64>","mimeType":"audio/wav","mode":"clean"|"verbatim","model":"…"}
   → {"text":"…"}。音声は保存しない。ログにも出さない。
   1日の上限は /ai と共通（AI_DAILY_LIMIT）。音声は約10MB（base64で14MB）まで。
───────────────────────────── */
async function handleTranscribe(request, env, corsHeaders, validToken) {
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
  const scrub = t => String(t || '')
    .replace(/(sk-|AIza|ghp_|github_pat_)[A-Za-z0-9_\-*.]+/g, '…')
    .replace(/\s+/g, ' ').slice(0, 200);
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  if (!validToken) return json({ error: '文字起こしは、認証トークンを設定したWorkerでだけ使えます' }, 503);
  const MAX_B64 = 14 * 1024 * 1024;
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len && len > MAX_B64 + 4096) return json({ error: '音声が大きすぎます（約10MBまで）' }, 413);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'JSONを読めませんでした' }, 400); }
  const data = body && body.data;
  const mime = String((body && body.mimeType) || '').toLowerCase().split(';')[0].trim();
  const model = String((body && body.model) || 'gemini-3.5-flash-lite');
  const mode = body && body.mode === 'verbatim' ? 'verbatim' : 'clean';
  const ALLOWED = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm'];
  if (typeof data !== 'string' || !data) return json({ error: '音声(data)がありません' }, 400);
  if (data.length > MAX_B64) return json({ error: '音声が大きすぎます（約10MBまで）' }, 413);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 2000))) return json({ error: '音声はbase64で送ってください' }, 400);
  if (!ALLOWED.includes(mime)) return json({ error: 'mimeType が正しくありません' }, 400);
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(model)) return json({ error: 'model が正しくありません' }, 400);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'gemini のAPIキーがWorkerに登録されていません（GEMINI_API_KEY）' }, 503);

  const limit = Math.max(1, Number(env.AI_DAILY_LIMIT) || 300);
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const usageKey = 'ai-usage:' + day;
  let used = 0;
  try { used = Number(await env.SYNC_KV.get(usageKey)) || 0; } catch (_) {}
  if (used >= limit) return json({ error: '今日のAI呼び出し上限（' + limit + '回）に達しました' }, 429);
  try { await env.SYNC_KV.put(usageKey, String(used + 1), { expirationTtl: 172800 }); } catch (_) {}

  const instruction = mode === 'verbatim'
    ? 'この音声を日本語で、聞こえたとおりに文字起こしして、本文だけを返してください。前置きや説明は付けません。聞き取れない所は［聞き取れず］と書きます。'
    : 'この音声を日本語で文字起こしして、本文だけを返してください。前置きや説明は付けません。「えー」「あのー」などの言いよどみと、言い直しの前の部分は除き、句読点と改行を付けて読みやすくします。内容は変えず、言っていないことは足しません。聞き取れない所は［聞き取れず］と書きます。';
  let res, d = null;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: instruction }, { inlineData: { mimeType: mime, data: data.replace(/\s+/g, '') } }] }] })
    });
  } catch (_) { return json({ error: 'Gemini に接続できませんでした' }, 502); }
  try { d = await res.json(); } catch (_) {}
  if (!res.ok) {
    const e = d && d.error;
    const msg = scrub((e && e.message) || '');
    const status = (res.status === 401 || res.status === 403 || res.status >= 500) ? 502 : res.status;
    return json({ error: 'gemini ' + res.status + (msg ? '：' + msg : '') }, status);
  }
  const parts = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map(p => (p && p.text) || '').join('').trim() : '';
  if (!text) return json({ error: '文字を取り出せませんでした（無音か、形式が未対応の可能性があります）' }, 422);
  return json({ text, model }, 200);
}
