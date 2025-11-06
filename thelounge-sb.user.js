// ==UserScript==
// @name         Ultimate Shoutbox Beautifier for TheLounge
// @namespace    http://tampermonkey.net/
// @version      3.0-alpha
// @description  Reformats chatbot relay messages to appear as direct user messages; resilient to rerenders/route changes/virtualization
// @author       spindrift
// @match        *://your-thelounge-domain.com/*
// @icon         https://thelounge.chat/favicon.ico
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- CONFIG ----------
  const CONFIG = {
    MATCHERS: [
      'Chatbot',          // ATH
      '%ULCX',            // ULCX
      '@Willie',          // BHD
      '@WALL-E',          // RFX
      'BBot', '@BBot',    // HHD
      '&darkpeers',       // DP
      'Bot',              // LST
      '+Mellos',          // HUNO (Discord)
      /.+?-web/,          // HUNO (Shoutbox)
      '&Sauron',          // ANT
      '+bridgebot',       // OE+
    ],
    USE_AUTOCOMPLETE: true,
    USE_DECORATORS: true,
    REMOVE_JOIN_QUIT: false,
    DECORATOR_L: '(',
    DECORATOR_R: ')',
    METADATA: 'SB',
    SAFETY_SWEEP_MS: 2000, // periodic reconciliation
  };

  // ---------- UTIL / STATE ----------
  // [LSB] Use WeakMap for elements (no leaks) + Map for id-addressable nodes
  const byEl = new WeakMap();          // el -> signature
  const byId = new Map();              // id string -> signature
  const onceWarned = new Set();        // msg key -> we already logged a surgical failure
  const visibleSet = new WeakSet();    // rows currently in viewport

  const digest = (s) => s ? (s.length + '|' + s.charCodeAt(0) + '|' + s.charCodeAt(s.length - 1)) : '0';

  function getMsgKey(el) {
    return el.id || el;
  }
  function getPrevSig(key, el) {
    if (typeof key === 'string') return byId.get(key);
    return byEl.get(el);
  }
  function setSig(key, el, sig) {
    if (typeof key === 'string') byId.set(key, sig);
    else byEl.set(el, sig);
    try { el.dataset.lsbSig = sig; } catch {}
  }

  function alreadyBeautified(el) { return el.dataset.beautified === '1'; }
  function markBeautified(el) { el.dataset.beautified = '1'; }

  // ---------- HANDLERS (merged with 2.7 set) ----------
  // Helper functions available:
  // - removeMatchedPrefix(match): automatically calculates prefix to remove from regex match
  // - removeAllExceptMessage(text, messageText): removes everything before the message text

  function removeMatchedPrefix(match) {
    const fullMatch = match[0];
    const messageText = match[match.length - 1];
    const prefixEnd = fullMatch.lastIndexOf(messageText);
    return fullMatch.substring(0, prefixEnd);
  }
  function removeAllExceptMessage(text, messageText) {
    const messageStart = text.lastIndexOf(messageText);
    return text.substring(0, messageStart);
  }

  const HANDLERS = [
    {
      // Format: [SB] Nickname: Message or [ SB ] (Nickname): Message
      // Used at: BHD, ANT
      enabled: true,
      handler: function (msg) {
        const match = msg.text.match(/^\s?\[\s?SB\s?\]\s+\(?([^):]+)\)?:\s*(.*)$/);
        if (!match) return null;

        return {
          username: match[1],
          modifyContent: true,
          prefixToRemove: removeMatchedPrefix(match),
          metadata: CONFIG.METADATA
        };
      }
    },
    {
      // Format: [Chatbox] Nickname: Message
      // Used at: RFX
      enabled: true,
      handler: function (msg) {
        const match = msg.text.match(/^\[Chatbox\]\s+([^:]+):\s*(.*)$/);
        if (!match) return null;

        return {
          username: match[1],
          modifyContent: true,
          prefixToRemove: removeMatchedPrefix(match),
          metadata: CONFIG.METADATA
        };
      }
    },
    {
      // Format: »Username« Message or »Username (Rank)« Message
      // Used at: HUNO (Discord bridge)
      enabled: true,
      handler: function (msg) {
        const HANDLER_CONFIG = {
          REMOVE_RANK: true,      // Splits out rank from username into metadata
          ABBREVIATE_RANK: true,  // Abbreviates rank (REMOVE_RANK must be set)
          FORCE_ABBREVIATE: false // Always abbreviates rank, even if it's only one word
        };

        // Clean zero-width characters from the text before processing
        const cleanText = msg.text.replace(/[\u200B-\u200D\uFEFF]/g, '');

        // Two-step approach: try « format first, then space format
        let match = cleanText.match(/^»([^«]+)«\s*(.*)$/);
        if (!match) match = cleanText.match(/^»(\S+(?:\s+\([^)]+\))?)\s+(.*)$/);
        if (!match) return null;

        // Abbreviates rank if needed
        function abbreviateRank(rank) {
          const caps = rank.match(/[A-Z]/g);
          if (!caps) return '';
          if (!HANDLER_CONFIG.FORCE_ABBREVIATE && caps.length === 1) return rank;
          return caps.join('');
        }

        let rawUsername = match[1];
        let extractedUsername, metadata = '';

        if (HANDLER_CONFIG.REMOVE_RANK && rawUsername.endsWith(')')) {
          const rankMatch = rawUsername.match(/^(.*)\s+\(([^)]+)\)$/);
          if (rankMatch) {
            extractedUsername = rankMatch[1].trim();
            const rank = rankMatch[2];
            metadata = HANDLER_CONFIG.ABBREVIATE_RANK ? abbreviateRank(rank) : rank;
          } else {
            extractedUsername = rawUsername.trim();
          }
        } else {
          extractedUsername = rawUsername.trim();
        }

        return {
          username: extractedUsername,
          modifyContent: true,
          prefixToRemove: removeMatchedPrefix(match),
          metadata
        };
      }
    },
    {
      // Format: <Username-web> Message
      // Used at: HUNO (Shoutbox bridge)
      enabled: true,
      handler: function (msg) {
        // Only apply this handler for HUNO channels
        if (!msg.chan || !String(msg.chan).startsWith('#huno')) return null;
        if (msg.from && msg.from.endsWith('-web')) {
          // Remove '-web' suffix for HUNO shoutbox users
          return {
            username: msg.from.slice(0, -4),
            modifyContent: false, // Username-only transformation
            metadata: CONFIG.METADATA
          }
        }
        return null;
      }
    },
    {
      // Format: [Nickname] Message or [Nickname]: Message
      // Used at: ATH, DP, ULCX, HHD, LST
      enabled: true,
      handler: function (msg) {
        const match = msg.text.match(/^\[([^\]]+)\](?::\s*|\s+)(.*)$/);
        if (!match) return null;

        return {
          username: match[1],
          modifyContent: true,
          prefixToRemove: removeMatchedPrefix(match),
          metadata: CONFIG.METADATA
        };
      }
    }
  ];

  function runFormatHandlers(msg) {
    for (const fh of HANDLERS) {
      if (!fh.enabled) continue;
      const res = fh.handler(msg);
      if (res) return res;
    }
    return null;
  }

  // ---------- SURGICAL CONTENT EDIT ----------
  function findPrefixTextNodes(contentSpan, prefixText) {
    const walker = document.createTreeWalker(contentSpan, NodeFilter.SHOW_TEXT, null, false);
    let accumulatedText = '';
    const nodesToProcess = [];
    let textNode;
    while (textNode = walker.nextNode()) {
      const nodeText = textNode.textContent;
      nodesToProcess.push({ node: textNode, text: nodeText, accumulatedLength: accumulatedText.length });
      accumulatedText += nodeText;
      if (accumulatedText.length >= prefixText.length) break;
    }
    return { nodesToProcess, accumulatedText };
  }

  function cleanupEmptyNodes(contentSpan) {
    const walker = document.createTreeWalker(contentSpan, NodeFilter.SHOW_TEXT, null, false);
    const emptyTextNodes = [];
    let textNode;
    while (textNode = walker.nextNode()) if (textNode.textContent === '') emptyTextNodes.push(textNode);
    emptyTextNodes.forEach(node => node.remove());
    const emptySpans = contentSpan.querySelectorAll('span:empty');
    emptySpans.forEach(span => {
      const classes = span.className || '';
      const important = ['preview-size', 'toggle-button', 'user', 'irc-fg', 'irc-bg'];
      if (!important.some(cls => classes.includes(cls))) span.remove();
    });
  }

  function removePrefixSurgically(contentSpan, prefixText) {
    const { nodesToProcess, accumulatedText } = findPrefixTextNodes(contentSpan, prefixText);
    const cleanedAccum = accumulatedText.replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (!cleanedAccum.startsWith(prefixText)) {
      return false;
    }
    let cleanedCharsProcessed = 0;
    for (const { node, text } of nodesToProcess) {
      if (cleanedCharsProcessed >= prefixText.length) break;
      const cleanedNodeText = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
      const take = Math.min(cleanedNodeText.length, prefixText.length - cleanedCharsProcessed);
      cleanedCharsProcessed += take;

      if (take === cleanedNodeText.length) {
        node.textContent = '';
      } else {
        let originalCharsToRemove = 0, cleanedCount = 0;
        for (let i = 0; i < text.length && cleanedCount < take; i++) {
          const ch = text[i];
          originalCharsToRemove++;
          if (!/[\u200B-\u200D\uFEFF]/.test(ch)) cleanedCount++;
        }
        node.textContent = text.substring(originalCharsToRemove);
        break;
      }
    }
    cleanupEmptyNodes(contentSpan);
    return true;
  }

  // ---------- STORE / COLOR ----------
  function addUserToAutocomplete(username) {
    try {
      const state = Array.from(document.querySelectorAll('*'))
        .find(e => e.__vue_app__)?.__vue_app__?.config?.globalProperties?.$store?.state;
      if (!state?.activeChannel?.channel?.users) return;
      const users = state.activeChannel.channel.users;
      if (!users.find(u => u.nick === username)) {
        users.push({ nick: username, modes: [], lastMessage: Date.now() });
      }
    } catch (e) {
      console.warn('Could not add user for autocomplete:', e);
    }
  }
  function findUserInUserlist(username) {
    const userlistUsers = document.querySelectorAll('.userlist .user[data-name]');
    for (const userElement of userlistUsers) {
      if (userElement.getAttribute('data-name') === username) return userElement;
    }
    return null;
  }
  function extractColorClass(userElement) {
    const classes = (userElement.className || '').split(' ');
    return classes.find(cls => cls.startsWith('color-')) || null;
  }
  function getUserColor(username) {
    let userElement = findUserInUserlist(username);
    if (!userElement) {
      addUserToAutocomplete(username);
      setTimeout(() => {
        userElement = findUserInUserlist(username);
        if (userElement) return extractColorClass(userElement);
      }, 50);
      return null;
    }
    return extractColorClass(userElement);
  }
  function applyColorToMessage(fromSpan, colorClass) {
    if (!colorClass) return;
    const classes = (fromSpan.className || '').split(' ').filter(Boolean);
    const filtered = classes.filter(cls => !cls.startsWith('color-'));
    filtered.push(colorClass);
    fromSpan.className = filtered.join(' ');
  }

  // ---------- CORE PROCESSOR ----------
  function matcherMatches(username) {
    return CONFIG.MATCHERS.some(p =>
      typeof p === 'string' ? p === username : (p instanceof RegExp && p.test(username))
    );
  }

  function processMessage(messageElement) {
    try {
      // Remove join/quit if configured (CSS is better; this is a fallback)
      if (CONFIG.REMOVE_JOIN_QUIT) {
        if (messageElement.matches?.('div[data-type="condensed"],div[data-type="join"],div[data-type="quit"]')) {
          messageElement.style.display = 'none';
          markBeautified(messageElement);
          return;
        }
      }

      const fromSpan = messageElement.querySelector?.('.from .user');
      const contentSpan = messageElement.querySelector?.('.content');
      const initialUsername = fromSpan?.textContent || '';
      if (!initialUsername || !matcherMatches(initialUsername) || !contentSpan) return;

      // Guard: if we’ve already replaced with the same resulting name/prefix, skip
      if (alreadyBeautified(messageElement) && fromSpan.getAttribute('data-bridged')) return;

      const channel = messageElement.closest?.('[data-current-channel]')?.getAttribute('data-current-channel') || '';

      const parsed = runFormatHandlers({
        text: contentSpan.textContent,
        html: contentSpan.innerHTML,
        from: initialUsername,
        chan: channel
      });
      if (!parsed) return;

      const { username, modifyContent, prefixToRemove, metadata } = parsed;
      const usernameChanged = (username !== initialUsername);

      fromSpan.setAttribute('data-name', username);
      fromSpan.setAttribute('data-bridged', metadata || CONFIG.METADATA);
      fromSpan.setAttribute('data-bridged-channel', channel);

      if (CONFIG.USE_AUTOCOMPLETE) addUserToAutocomplete(username);

      if (usernameChanged) {
        const colorClass = getUserColor(username);
        if (colorClass) {
          applyColorToMessage(fromSpan, colorClass);
        } else {
          setTimeout(() => {
            const retry = getUserColor(username);
            if (retry) applyColorToMessage(fromSpan, retry);
          }, 200);
        }
      }

      fromSpan.textContent = CONFIG.USE_DECORATORS
        ? CONFIG.DECORATOR_L + username + CONFIG.DECORATOR_R
        : username;

      if (modifyContent && prefixToRemove) {
        const ok = removePrefixSurgically(contentSpan, prefixToRemove);
        if (!ok) {
          const key = getMsgKey(messageElement);
          if (!onceWarned.has(key)) {
            console.warn('Surgical prefix removal failed for:', username);
            onceWarned.add(key);
          }
        }
      }

      markBeautified(messageElement);
    } catch (e) {
      console.warn('[LSB] processMessage error:', e);
    }
  }

  // Idempotent wrapper: only process if text/name actually changed
  function processMessageIfNeeded(messageElement) {
    if (!messageElement || messageElement.nodeType !== 1 || !messageElement.classList?.contains('msg')) return;
    const fromSpan = messageElement.querySelector('.from .user');
    const contentSpan = messageElement.querySelector('.content');
    if (!fromSpan || !contentSpan) return;

    const raw = contentSpan.textContent || '';
    const name = fromSpan.textContent || '';
    const sig = digest(raw) + '|' + name;

    const key = getMsgKey(messageElement);
    const prev = getPrevSig(key, messageElement);
    if (prev === sig) return;

    processMessage(messageElement);
    setSig(key, messageElement, sig);
  }

  // ---------- OBSERVERS ----------
  // [LSB] Batch via requestAnimationFrame to avoid layout thrash
  let pending = new Set();
  let rafToken = 0;
  function scheduleFlush() {
    if (rafToken) return;
    rafToken = requestAnimationFrame(() => {
      pending.forEach(el => processMessageIfNeeded(el));
      pending.clear();
      observeVisibilityForAll(); // ensure new rows get viewport hooks
      rafToken = 0;
    });
  }

  const domObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 1) {
            if (n.classList.contains('msg')) pending.add(n);
            const inner = n.querySelectorAll?.('.msg');
            if (inner && inner.length) inner.forEach(el => pending.add(el));
          }
        });
      }
      if (m.type === 'attributes' && m.target.classList?.contains('msg')) {
        pending.add(m.target);
      }
      if (m.type === 'characterData') {
        const msg = m.target.parentElement?.closest?.('.msg');
        if (msg) pending.add(msg);
      }
    }
    scheduleFlush();
  });

  // Recreate IntersectionObserver when chat root changes so root is correct
  let inView = null;
  function makeInViewObserver(rootEl) {
    if (inView) try { inView.disconnect(); } catch {}
    inView = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          visibleSet.add(e.target);
          processMessageIfNeeded(e.target);
        } else {
          try { visibleSet.delete(e.target); } catch {}
        }
      }
    }, { root: rootEl || null, threshold: 0 });
  }

  function observeVisibilityForAll() {
    if (!inView) return;
    document.querySelectorAll('.msg').forEach(el => inView.observe(el));
  }

  // Re-attach observer when #chat is rebuilt (route/view changes)
  let rootObserver = null;
  function attachToChatRoot() {
    const chat = document.querySelector('#chat');
    if (!chat) return false;

    domObserver.disconnect();
    domObserver.observe(chat, {
      childList: true,
      subtree: true,
      characterData: true
    });

    makeInViewObserver(chat);

    document.querySelectorAll('.msg').forEach(processMessageIfNeeded);
    observeVisibilityForAll();
    return true;
  }

  function watchForChatRoot() {
    if (attachToChatRoot()) return;
    if (rootObserver) return;
    rootObserver = new MutationObserver(() => attachToChatRoot());
    rootObserver.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') watchForChatRoot();
  });
  window.addEventListener('focus', watchForChatRoot);

  // Light periodic reconciliation to catch any edge misses
  setInterval(() => {
    const anyVisible = [];
    document.querySelectorAll('.msg').forEach(el => {
      if (visibleSet.has(el)) anyVisible.push(el);
    });
    const target = anyVisible.length ? anyVisible : document.querySelectorAll('.msg');
    target.forEach(processMessageIfNeeded);
  }, CONFIG.SAFETY_SWEEP_MS);

  // ---------- STORE WATCH (channel switches churn DOM) ----------
  (function watchStoreChannel() {
    try {
      const app = Array.from(document.querySelectorAll('*')).find(e => e.__vue_app__)?.__vue_app__;
      const store = app?.config?.globalProperties?.$store;
      if (store?.watch) {
        store.watch(
          s => s.activeChannel?.chan?.name || s.activeChannel?.channel?.name,
          () => {
            requestAnimationFrame(() => {
              watchForChatRoot();
              document.querySelectorAll('.msg').forEach(processMessageIfNeeded);
            });
          }
        );
      }
    } catch { /* no-op */ }
  })();

  // ---------- OPTIONAL GLOBAL CSS FOR JOIN/QUIT ----------
  (function maybeInjectJoinQuitCSS() {
    if (!CONFIG.REMOVE_JOIN_QUIT) return;
    if (document.querySelector('style[data-lsb-joinquit]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-lsb-joinquit', '1');
    style.textContent = `
      div[data-type="join"],
      div[data-type="quit"],
      div[data-type="condensed"] { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  })();

  // ---------- BOOT ----------
  watchForChatRoot(); // will attach when #chat appears
})();
