// ==UserScript==
// @name         Chat → AutoSpeak (SAFE v1.10c: Prefix-Strip + 429 Backoff + Stream Stabilizer)
// @namespace    local.tts.safe
// @version      1.10c
// @description  Speak ONLY new assistant replies. Requires prefix by default, strips it before TTS. Adds 429 backoff and waits for message to finish streaming to avoid clipped audio.
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==
(function(){
  'use strict';

  const ENDPOINT = 'http://127.0.0.1:5005/tts';
  const LATEST   = 'http://127.0.0.1:5005/latest';

  // Defaults
  let ENABLED = false;
  let MAX_CHARS = 600;
  let AUTO_CHUNK = true;
  let REQUIRE_PREFIX = 'LAURA: ';
  let RATE_MS = 5000; // safer cadence
  let DEBUG = true;

  // Rate/burst
  let lastSend = 0;
  const seen = new Set();
  const sessionStart = Date.now();
  let postsInWindow = [];
  const MAX_POSTS_PER_MIN = 2;
  const MAX_TOTAL_CHARS_BURST = 900;
  let charsBurstCount = 0;
  let burstTimer = null;

  // Backoff
  const RETRY_429_MAX = 3;
  const RETRY_429_BASE_MS = 4000;

  // Stabilizer (prevents early/partial sends during streaming)
  const STABLE_WAIT_MS = 1200;     // time with no growth before we consider it "done"
  const STABLE_POLL_MS = 300;      // how often to poll for growth
  const STABLE_MAX_MS  = 6000;     // absolute cap to avoid waiting forever
  const MIN_SPEAK_LEN  = 20;       // ignore tiny messages (after prefix strip)

  function dlog(...args){ if(DEBUG) console.log('[AutoSpeak v1.10c]', ...args); }
  function resetBurst(){ charsBurstCount = 0; if (burstTimer){ clearTimeout(burstTimer); burstTimer = null; } }

  function normalizeStart(s){
    return (s || '')
      .replace(/^[\uFEFF\u200B\u200C\u200D\u2060\s*_>*"“”'’\-–—•·]+/u, '')
      .replace(/^[\uFEFF\u200B\u200C\u200D\u2060\s*_>*"“”'’\-–—•·]+/u, '');
  }
  function startsWithPrefix(s, prefix){
    return normalizeStart(s).toLowerCase().startsWith((prefix || '').toLowerCase());
  }

  // UI
  function ui(){
    const css = `#__safe_panel{
        position:fixed; z-index:999999; left:16px; bottom:16px;
        background:#111827; color:#e5e7eb; border:1px solid #334155; border-radius:12px;
        font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto; padding:10px; min-width:360px
      }
      #__safe_panel input[type=number]{width:64px}
      #__safe_panel .row{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}
      #__safe_panel .warn{color:#fbbf24}`;
    const st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);

    const p=document.createElement('div'); p.id='__safe_panel';
    p.innerHTML=`<b>AutoSpeak (SAFE v1.10c)</b>
      <div class="row">
        <label><input id="__safe_on" type="checkbox"> Enable</label>
        <span id="__safe_state" class="warn">(prefix required; stabilized)</span>
      </div>
      <div class="row">
        <label>Max <input id="__safe_max" type="number" min="80" max="1200" value="${MAX_CHARS}"></label>
        <label><input id="__safe_chunk" type="checkbox" checked> Chunk</label>
        <label><input id="__safe_debug" type="checkbox" ${DEBUG?'checked':''}> Debug</label>
      </div>
      <div class="row">
        <label>Prefix <input id="__safe_pref" value="LAURA: " style="width:180px"></label>
      </div>
      <div class="row">
        <button id="__safe_play">▶ Play last</button>
        <button id="__safe_speak_last">Speak last assistant</button>
        <button id="__safe_test_post">Test POST</button>
      </div>
      <div id="__safe_msg" style="opacity:.85;margin-top:6px">Ready. (Disabled)</div>`;
    document.body.appendChild(p);

    const on=p.querySelector('#__safe_on'), max=p.querySelector('#__safe_max'),
          ch=p.querySelector('#__safe_chunk'), pref=p.querySelector('#__safe_pref'),
          dbg=p.querySelector('#__safe_debug'), state=p.querySelector('#__safe_state'),
          msg=p.querySelector('#__safe_msg'), play=p.querySelector('#__safe_play'),
          speakLast=p.querySelector('#__safe_speak_last'), testPost=p.querySelector('#__safe_test_post');

    function updateState(){
      state.textContent = REQUIRE_PREFIX ? '(prefix required; stabilized)' : '(no prefix; stabilized)';
      msg.textContent = ENABLED ? (REQUIRE_PREFIX ? 'Enabled. Waiting for NEW prefixed lines…' : 'Enabled. Waiting for NEW lines…') : 'Disabled.';
    }

    on.onchange   = ()=>{ ENABLED=on.checked; updateState(); dlog('ENABLED:', ENABLED); };
    max.onchange  = ()=>{ MAX_CHARS=parseInt(max.value||600,10); dlog('MAX_CHARS:', MAX_CHARS); };
    ch.onchange   = ()=>{ AUTO_CHUNK=ch.checked; dlog('AUTO_CHUNK:', AUTO_CHUNK); };
    pref.onchange = ()=>{ REQUIRE_PREFIX=pref.value||''; updateState(); dlog('REQUIRE_PREFIX:', JSON.stringify(REQUIRE_PREFIX)); };
    dbg.onchange  = ()=>{ DEBUG = dbg.checked; dlog('DEBUG:', DEBUG); };

    play.onclick      = ()=> fetchLatestAndPlay(msg);
    speakLast.onclick = ()=> { const txt = getLastAssistantText(); if (txt) { postTTS(txt, msg); } else { msg.textContent='No assistant text found.'; } };
    testPost.onclick  = ()=> { postTTS((REQUIRE_PREFIX||'') + 'Panel test post.', msg); };

    updateState();
  }

  // Assistant detection
  function isAssistantContainer(node){
    try {
      if (node.dataset && node.dataset.messageAuthorRole === 'assistant') return true;
      if (node.querySelector && node.querySelector('[data-message-author-role="assistant"]')) return true;
      if (node.matches && node.matches('[data-testid="conversation-turn"]')) {
        if (node.querySelector('[data-message-author-role="assistant"]')) return true;
      }
      if (node.getAttribute && /assistant/i.test(node.getAttribute('data-testid') || '')) return true;
    } catch(_) {}
    return false;
  }
  function getAssistantTextFromNode(node){
    let target = node;
    if (node.querySelector) {
      const inner = node.querySelector('[data-message-author-role="assistant"]');
      if (inner) target = inner;
    }
    const txt = target.innerText ? target.innerText.trim() : '';
    return txt;
  }
  function getAllAssistantNodes(){
    const nodes = new Set();
    document.querySelectorAll('[data-message-author-role="assistant"]').forEach(n=>nodes.add(n.closest('[data-testid="conversation-turn"]') || n));
    document.querySelectorAll('[data-testid="conversation-turn"]').forEach(n=>{
      if (n.querySelector('[data-message-author-role="assistant"]')) nodes.add(n);
    });
    document.querySelectorAll('.markdown, .prose').forEach(n=>nodes.add(n));
    return Array.from(nodes);
  }
  function getLastAssistantText(){
    const nodes = getAllAssistantNodes();
    if (!nodes.length) return '';
    const last = nodes[nodes.length - 1];
    const txt = getAssistantTextFromNode(last);
    dlog('Last assistant length:', txt.length, 'start:', JSON.stringify(txt.slice(0,40)));
    return txt;
  }

  // Player
  function fetchLatestAndPlay(msg){
    msg.textContent='Fetching audio…';
    GM_xmlhttpRequest({
      method:'GET', url:`${LATEST}?t=${Date.now()}`, responseType:'arraybuffer',
      onload:res=>{
        if(res.status===200 && res.response){
          let ct='audio/mpeg';
          try{
            const hdr=res.responseHeaders||'';
            const m=hdr.match(/content-type:\s*([^\r\n;]+)/i);
            if(m && m[1]) ct=m[1].trim();
          }catch(_){}
          const blob=new Blob([res.response],{type:ct});
          const url=URL.createObjectURL(blob);
          let a=document.getElementById('__safe_audio');
          if(!a){ a=document.createElement('audio'); a.id='__safe_audio'; a.controls=true; a.preload='auto'; a.autoplay=true;
            a.style.position='fixed'; a.style.left='16px'; a.style.bottom='60px'; a.style.zIndex=999999; document.body.appendChild(a); }
          a.src=url;
          a.play().then(()=>{ msg.textContent='Playing latest.'; }).catch(()=>{ msg.textContent='Loaded. Click ▶ to play (autoplay blocked).'; });
        } else { msg.textContent='No audio yet.'; }
      },
      onerror:()=>{ msg.textContent='Fetch failed (server?)'; }
    });
  }

  // Limits
  function underRateLimits(len, msg){
    const now = Date.now();
    postsInWindow = postsInWindow.filter(t => now - t < 60_000);
    if (postsInWindow.length >= MAX_POSTS_PER_MIN){
      msg.textContent = 'Rate limit: max 2 posts/min'; dlog('rate blocked'); return false;
    }
    if (!burstTimer) burstTimer = setTimeout(resetBurst, 5000);
    if (charsBurstCount + len > MAX_TOTAL_CHARS_BURST){
      msg.textContent = 'Burst limit reached; wait 5s'; dlog('burst blocked'); return false;
    }
    postsInWindow.push(now);
    charsBurstCount += len;
    return true;
  }

  // 429 backoff send
  function sendPayload(payload, msg, attempt){
    const hdrs = {'Content-Type':'application/json'};
    const pretty = attempt ? ` (retry ${attempt}/${RETRY_429_MAX})` : '';
    msg.textContent = `Sending…${pretty}`;
    dlog('POST /tts', payload, 'attempt', attempt||0);
    GM_xmlhttpRequest({
      method:'POST', url:ENDPOINT, headers:hdrs, data: JSON.stringify(payload),
      onload:(res)=>{
        if (res.status === 429){
          if ((attempt||0) < RETRY_429_MAX){
            const wait = Math.floor(RETRY_429_BASE_MS * Math.pow(2, attempt||0) + Math.random()*1000);
            msg.textContent = `429: Backing off ${wait}ms…`;
            dlog('429 backoff', {attempt: attempt||0, wait});
            setTimeout(()=>sendPayload(payload, msg, (attempt||0)+1), wait);
          } else {
            msg.textContent = '429: Gave up after retries';
            dlog('429 final give-up');
          }
          return;
        }
        if (res.status >= 200 && res.status < 300){
          msg.textContent='Sent. Playing…'; fetchLatestAndPlay(msg);
        } else {
          msg.textContent=`POST failed (${res.status})`;
          dlog('POST failed', res.status, res.responseText);
        }
      },
      onerror:()=>{ msg.textContent='POST failed (server?)'; }
    });
  }

  // Build + send (with prefix strip)
  function postTTS(text, msg){
    if(!text || text.trim().length < 2){ dlog('empty text, skip'); return; }

    if (REQUIRE_PREFIX && !startsWithPrefix(text, REQUIRE_PREFIX)){
      msg.textContent = 'Skipped (prefix required)';
      dlog('prefix mismatch', { need: REQUIRE_PREFIX, got: normalizeStart(text).slice(0,24) });
      return;
    }

    // strip required prefix from spoken text
    let speakText = text;
    if (REQUIRE_PREFIX && startsWithPrefix(text, REQUIRE_PREFIX)) {
      const norm = normalizeStart(text);
      const pref = (REQUIRE_PREFIX || '').toLowerCase();
      if (norm.toLowerCase().startsWith(pref)) {
        speakText = norm.slice(pref.length);
      }
      speakText = speakText.replace(/^\s+/, '');
    }

    if (speakText.length < MIN_SPEAK_LEN){
      dlog('too short after strip; ignoring', speakText);
      return;
    }

    const len = speakText.length;
    if(!underRateLimits(len, msg)) return;

    let payload = { text: speakText.slice(0, MAX_CHARS) };
    if (AUTO_CHUNK && len > MAX_CHARS){ payload = { text: speakText, chunk:true, max_chars: MAX_CHARS }; }

    const now = Date.now();
    if (now - lastSend < RATE_MS){ msg.textContent = 'Rate limited…'; dlog('rate limited'); return; }
    lastSend = now;

    sendPayload(payload, msg, 0);
  }

  // ---- Streaming stabilization ----
  function stabilizeAndSend(node, msg){
    let start = Date.now();
    let lastLen = 0;
    let stableSince = Date.now();

    function poll(){
      const raw = getAssistantTextFromNode(node) || '';
      const norm = normalizeStart(raw);
      const prefOK = !REQUIRE_PREFIX || norm.toLowerCase().startsWith((REQUIRE_PREFIX||'').toLowerCase());

      const currentLen = raw.length;
      if (currentLen > lastLen){
        lastLen = currentLen;
        stableSince = Date.now();
      }

      const noGrowthMs = Date.now() - stableSince;
      const elapsed = Date.now() - start;

      // If we don't even have the prefix yet, keep waiting (up to cap)
      if (!prefOK && elapsed < STABLE_MAX_MS){
        return setTimeout(poll, STABLE_POLL_MS);
      }

      if (noGrowthMs >= STABLE_WAIT_MS || elapsed >= STABLE_MAX_MS){
        dlog('Stabilized or timed out', {noGrowthMs, elapsed, finalLen: currentLen});
        // De-dupe by signature at send time
        const sig = (raw.slice(0,512) + '|' + raw.length);
        if (seen.has(sig)){ dlog('dup/unchanged; skip at stabilized send'); return; }
        seen.add(sig);
        postTTS(raw, msg);
      } else {
        setTimeout(poll, STABLE_POLL_MS);
      }
    }
    poll();
  }

  // Observe
  let changeDebounce = null;
  function handleCandidate(node, msg){
    // Instead of sending immediately, run stabilize polling
    if (!ENABLED) { dlog('disabled; not sending'); return; }
    if(changeDebounce) clearTimeout(changeDebounce);
    changeDebounce = setTimeout(()=> stabilizeAndSend(node, msg), 120);
  }

  function observe(){
    const msg=document.getElementById('__safe_msg');
    const obs=new MutationObserver(muts=>{
      let candidate = null;
      for(const m of muts){
        if(m.type === 'childList'){
          for(const n of m.addedNodes||[]){
            if(n.nodeType!==1) continue;
            if (isAssistantContainer(n) || n.querySelector?.('[data-message-author-role="assistant"]')){
              n.__bornAt = Date.now();
              if (n.__bornAt >= sessionStart) candidate = n;
            }
          }
        } else if (m.type === 'characterData'){
          const el = m.target.parentElement;
          const container = el?.closest?.('[data-testid="conversation-turn"], [data-message-author-role="assistant"], .markdown, .prose');
          if (container) {
            container.__bornAt = container.__bornAt || Date.now();
            if (container.__bornAt >= sessionStart) candidate = container;
          }
        }
      }
      if(candidate){
        handleCandidate(candidate, msg);
      }
    });
    obs.observe(document.body,{childList:true,subtree:true,characterData:true});
    dlog('Observer attached.');
  }

  function init(){ ui(); observe(); dlog('Initialized.'); }
  init();
})();