// ==UserScript==
// @name         Ultimate Shoutbox Beautifier for TheLounge
// @namespace    http://tampermonkey.net/
// @version      3.0-dev0.5
// @description  Reformats chatbot relay messages to appear as direct user messages
// @author       spindrift
// @match        *://irc.badkitty.zone/*
//
// @connect      aither.cc
// @connect      blutopia.cc
// @connect      hawke.uno
// @connect      lst.gg
// @connect      reelflix.cc
// @connect      seedpool.org
// @connect      upload.cx
//
// @icon         https://thelounge.chat/favicon.ico
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

// This is a reworked version of the original script that adds:
// - Handler architecture: Makes it easier to add new formats
// - Custom decorators: Set a prefix/suffix for bridged usernames
// - DOM metadata: Completely customize appearance with TheLounge theme CSS
// - Regex matcher support: Pair with custom handlers to do almost anything
// - Preview support: Surgical DOM modification preserves link previews and event listeners
// - More handlers: BHD, extensive HUNO support
// - Nick coloring: Bridged usernames get proper TheLounge colors instead of inheriting bot colors
// - Settings UI: Floating modal, decoupled from TheLounge's settings
// - Site mappings: Associate networks/channels with tracker sites for avatar resolution
// - Avatar support: Fetches and caches authenticated user avatars from UNIT3D sites

// CREDITS:
// fulcrum: Original script (https://aither.cc/forums/topics/3874)
// marks: Autocomplete enablement (https://aither.cc/forums/topics/3874/posts/32274)

// INSTALLATION:
// - Install Tampermonkey, Violentmonkey, or inject the script directly
// - Set the @match to the IP or domain you access TheLounge on
// - For avatar support: add @connect entries for each tracker site
// - Core features work without any userscript manager

// TROUBLESHOOTING:
// - Make sure @match is set to your TheLounge domain
// - Try disabling autocomplete (gear icon > Shoutbox Beautifier)
// - Check the browser console for errors
// - When in doubt, simply refresh the page

// CHANGELOG:
// - 1.0 - (spindrift) Initial release
// - 2.0 - (spindrift) Fix link previews, change return structure
// - 2.1 - (spindrift) Sanitize zero-width characters (fixes HUNO Discord handler)
// - 2.2 - (sparrow) Add option to hide join/quit messages, add TheLounge icon
// - 2.3 - (spindrift) Add color matching - bridged usernames get proper TheLounge colors
// - 2.4 - (AnabolicsAnonymous) Update ULCX matchers
// - 2.5 - (spindrift) Add ANT support (thanks JCDenton for initial work)
// - 2.6 - (FortKnox1337) Add RFX support, enable DP and HHD support, fix ANT/BHD support
// - 2.7 - (cmd430) Enable OE+ support, fix config indents, fix non-chat page breakage
// - 3.0 - (spindrift) Avatars, site mappings, floating settings modal, localStorage,
//          data-usb-* attributes, no userscript manager required for core features

// CSS STYLING:
// Custom CSS can be added in TheLounge > Settings > Appearance.
//
// Universal attributes (set on EVERY message):
// - data-usb-network: the network name (e.g., 'ATH', 'ULCX', 'BHD')
// - data-usb-channel: the channel name (e.g., '#General', '#huno')
//
// Bridged-only attribute (set on messages matched by a handler):
// - data-usb-bridged: metadata prefix (e.g., 'SB', or an abbreviated rank)
//
//   Examples:
//   - Italicize all bridged usernames:
//     span[data-usb-bridged] { font-style: italic; }
//
//   - Style all messages from the ATH network:
//     .msg .from span[data-usb-network="ATH"] { color: gold; }
//
//   - Style messages from a specific network AND channel:
//     span[data-usb-network="P2P"][data-usb-channel="#blutopia"] { font-weight: bold; }
//
//   - Customize avatar size:
//     .usb-avatar, .usb-avatar img { width: 28px; height: 28px; }

(function () {
    'use strict';

    // =====================================================================
    //  CAPABILITY DETECTION
    // =====================================================================

    const HAS_GM_XHR = typeof GM_xmlhttpRequest !== 'undefined';

    // =====================================================================
    //  TRACKER SITE CONFIG TABLE
    // =====================================================================
    //
    // Per-site configuration for UNIT3D integration features.
    // 'default' is used for any site not explicitly listed.
    // {user} is replaced with the username at runtime.
    //
    // To add a new site override, copy the default block and modify.
    // Set a feature to false to disable it for that site.

    const SITE_CONFIG = {
        'default': {
            urlAvatar: '/authenticated-images/user-avatars/{user}',
            urlIcon: '/authenticated-images/user-icons/{user}',
            urlProfile: '/users/{user}',
            faFontPath: '/build/assets/fa-solid-900-6nmD8yp-.woff2',
            featGroupIcon: true,
            featGroupName: true,
            featCustomIcon: true,
            featProfile: true,
        },
        'hawke.uno': {
            urlAvatar: '/files/img/{user}.png',
            urlIcon: false,
            urlProfile: false,
            faFontPath: false,      // HUNO doesn't serve FA Pro to us
            featGroupIcon: false,
            featGroupName: false,
            featCustomIcon: false,
            featProfile: false,
        },
        'blutopia.cc': {
            faFontPath: '/build/assets/fa-solid-900-DTJu368G.woff2',
        },
        'beyond-hd.me': {
            faFontPath: '/fonts/vendor/@fortawesome/fontawesome-pro/webfa-solid-900.woff2',
        },
        'capybarabr.com': {
            faFontPath: '/build/assets/fa-solid-900-Op5g_Mqf.woff2',
        },
        'luminarr.me': {
            faFontPath: '/build/assets/fa-solid-900-DSjGxeID.woff2',
        },
    };

    function getSiteConfig(site) {
        const specific = SITE_CONFIG[site] || {};
        const defaults = SITE_CONFIG['default'];
        return { ...defaults, ...specific };
    }

    function buildSiteUrl(site, template, username) {
        if (!template) return null;
        return `https://${site}${template.replace('{user}', username)}`;
    }

    // =====================================================================
    //  STORAGE (localStorage with usb_ prefix)
    // =====================================================================

    const STORE_PREFIX = 'usb_';

    function storeGet(key) {
        try {
            const raw = localStorage.getItem(STORE_PREFIX + key);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    function storeSet(key, value) {
        try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); }
        catch (e) {
            console.warn(`[USB] localStorage write failed for ${key}:`, e.name);
        }
    }

    function storeDelete(key) {
        localStorage.removeItem(STORE_PREFIX + key);
    }

    function storeKeys(prefix) {
        const full = STORE_PREFIX + (prefix || '');
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(full)) keys.push(k.slice(STORE_PREFIX.length));
        }
        return keys;
    }

    // =====================================================================
    //  INDEXEDDB (for avatar blobs — no quota concerns)
    // =====================================================================

    const IDB_NAME = 'usb_cache';
    const IDB_VERSION = 1;
    const IDB_STORE = 'avatars';
    let idb = null;

    function openIdb() {
        if (idb) return Promise.resolve(idb);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => { idb = req.result; resolve(idb); };
            req.onerror = () => {
                console.warn('[USB] IndexedDB open failed, falling back to in-memory only');
                reject(req.error);
            };
        });
    }

    function idbGet(key) {
        return openIdb().then(db => new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        })).catch(() => null);
    }

    function idbSet(key, value) {
        return openIdb().then(db => new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        })).catch(() => false);
    }

    function idbDelete(key) {
        return openIdb().then(db => new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        })).catch(() => false);
    }

    function idbClear() {
        return openIdb().then(db => new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        })).catch(() => false);
    }

    // =====================================================================
    //  SETTINGS
    // =====================================================================

    const DEFAULT_SETTINGS = {
        USE_AUTOCOMPLETE: true,
        USE_DECORATORS: true,
        USE_AVATARS: false,
        USE_GROUP_ICON: true,
        USE_CUSTOM_ICON: true,
        USE_SPARKLES: true,
        USE_GROUP_COLORS: false,
        REMOVE_JOIN_QUIT: false,
        DECORATOR_L: '(',
        DECORATOR_R: ')',
        METADATA: 'SB',
    };

    function loadSettings() {
        const saved = storeGet('settings');
        return { ...DEFAULT_SETTINGS, ...(saved || {}) };
    }

    function saveSettings(settings) {
        storeSet('settings', settings);
    }

    let CONFIG = loadSettings();

    // =====================================================================
    //  SITE MAPPINGS
    // =====================================================================

    function loadSiteMappings() {
        return storeGet('site_mappings') || {};
    }

    function saveSiteMappings(mappings) {
        storeSet('site_mappings', mappings);
    }

    function resolveSiteForContext(network, channel) {
        if (!network) return null;
        const mappings = loadSiteMappings();
        if (channel) {
            const channelKey = `${network}/${channel}`;
            if (channelKey in mappings) {
                // '__none__' means explicitly no site, even if network has one
                return mappings[channelKey] === '__none__' ? null : mappings[channelKey] || null;
            }
        }
        return mappings[network] || null;
    }

    // Tracked sites: user-maintained list of tracker hostnames for dropdown menus.
    // Unlike the old cookie bridge, these are just labels — authentication is
    // handled automatically by GM_xmlhttpRequest forwarding browser cookies.
    function loadTrackerSites() {
        return storeGet('tracker_sites') || [];
    }

    function saveTrackerSites(sites) {
        storeSet('tracker_sites', sites);
    }

    // =====================================================================
    //  NETWORK/CHANNEL RESOLUTION FROM SIDEBAR
    // =====================================================================

    function getActiveNetworkAndChannel() {
        const active = document.querySelector('.channel-list-item.active');
        if (!active) return null;
        const network = active.closest('.network');
        if (!network) return null;
        const lobby = network.querySelector('.channel-list-item[data-type="lobby"]');
        return {
            network: lobby?.getAttribute('data-name') || null,
            channel: active.getAttribute('data-name') || null,
        };
    }

    function scrapeNetworkTree() {
        const tree = [];
        for (const networkEl of document.querySelectorAll('.network')) {
            const lobby = networkEl.querySelector('.channel-list-item[data-type="lobby"]');
            const name = lobby?.getAttribute('data-name');
            if (!name) continue;
            const channels = [];
            for (const chanEl of networkEl.querySelectorAll('.channel-list-item[data-type="channel"]')) {
                const chanName = chanEl.getAttribute('data-name');
                if (chanName) channels.push(chanName);
            }
            tree.push({ name, channels });
        }
        return tree;
    }

    // =====================================================================
    //  THELOUNGE DETECTION
    // =====================================================================

    function isTheLounge() {
        return document.querySelector('meta[name="application-name"][content="The Lounge"]') !== null;
    }

    function waitForTheLounge() {
        return new Promise((resolve) => {
            if (isTheLounge()) return resolve(true);
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => resolve(isTheLounge()));
            } else {
                resolve(false);
            }
        });
    }

    // =====================================================================
    //  AVATAR CACHE & FETCHING
    // =====================================================================

    const AVATAR_PREFIX = 'av/';
    const AVATAR_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

    // Default avatar: used when a user has no custom avatar set.
    // Returns the site's own profile.png when possible, falls back to a 1x1 transparent pixel.
    const AVATAR_FALLBACK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    function getDefaultAvatar(site) {
        return site ? `https://${site}/img/profile.png` : AVATAR_FALLBACK;
    }

    const avatarUrlCache = new Map();
    const avatarInflight = new Map();

    /**
     * Convert a blob to a data URL for use as img.src.
     * No resizing — IndexedDB has no meaningful quota limits.
     */
    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
        });
    }

    function readAvatarCache(cacheKey) {
        return idbGet(AVATAR_PREFIX + cacheKey).then(entry => {
            if (!entry || !entry.fetchedAt) return null;
            if ((Date.now() - entry.fetchedAt) > AVATAR_TTL) {
                idbDelete(AVATAR_PREFIX + cacheKey);
                return null;
            }
            return entry;
        });
    }

    function writeAvatarCache(cacheKey, dataUrl) {
        return idbSet(AVATAR_PREFIX + cacheKey, { data: dataUrl, fetchedAt: Date.now() });
    }

    function writeAvatarCacheMiss(cacheKey) {
        return idbSet(AVATAR_PREFIX + cacheKey, { data: null, fetchedAt: Date.now() });
    }

    function invalidateAvatar(site, username) {
        const cacheKey = `${site}/${username}`;
        idbDelete(AVATAR_PREFIX + cacheKey);
        avatarUrlCache.delete(cacheKey);
        avatarInflight.delete(cacheKey);
    }

    function clearAvatarCache() {
        idbClear();
        avatarUrlCache.clear();
        avatarInflight.clear();
        // Also clean up any legacy localStorage avatar entries
        for (const key of storeKeys('av_')) storeDelete(key);
    }

    function getAvatar(site, username) {
        const fallback = getDefaultAvatar(site);
        if (!HAS_GM_XHR) return Promise.resolve(fallback);

        const cacheKey = `${site}/${username}`;

        if (avatarUrlCache.has(cacheKey)) return Promise.resolve(avatarUrlCache.get(cacheKey));

        if (avatarInflight.has(cacheKey)) return avatarInflight.get(cacheKey);

        const fetchPromise = readAvatarCache(cacheKey).then(cached => {
            if (cached) {
                const url = cached.data || fallback;
                avatarUrlCache.set(cacheKey, url);
                return url;
            }

            return new Promise((resolve) => {
                const url = buildSiteUrl(site, getSiteConfig(site).urlAvatar, username);
                if (!url) { resolve(fallback); return; }

                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType: 'blob',
                    onload(response) {
                        avatarInflight.delete(cacheKey);
                        if (response.status >= 200 && response.status < 300 && response.response.size > 0) {
                            blobToDataUrl(response.response).then(dataUrl => {
                                writeAvatarCache(cacheKey, dataUrl);
                                avatarUrlCache.set(cacheKey, dataUrl);
                                resolve(dataUrl);
                            }).catch(() => {
                                writeAvatarCacheMiss(cacheKey);
                                avatarUrlCache.set(cacheKey, fallback);
                                resolve(fallback);
                            });
                        } else {
                            writeAvatarCacheMiss(cacheKey);
                            avatarUrlCache.set(cacheKey, fallback);
                            resolve(fallback);
                        }
                    },
                    onerror() {
                        avatarInflight.delete(cacheKey);
                        writeAvatarCacheMiss(cacheKey);
                        avatarUrlCache.set(cacheKey, fallback);
                        resolve(fallback);
                    },
                });
            });
        });

        avatarInflight.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    function injectAvatar(fromDiv, avatarUrl) {
        if (!avatarUrl || fromDiv.querySelector('.usb-avatar')) return;

        const wrapper = document.createElement('span');
        wrapper.className = 'usb-avatar';
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = '';
        img.loading = 'lazy';

        wrapper.appendChild(img);
        fromDiv.insertBefore(wrapper, fromDiv.firstChild);
    }

    /**
     * Inject UNIT3D metadata into a message's .user span.
     * Adds: group icon, data-usb-group attribute, sparkles, custom icon,
     *       and --usb-unit3d-color CSS variable.
     */
    function injectUserMeta(fromSpan, site, meta) {
        if (!meta || fromSpan.hasAttribute('data-usb-group')) return;

        // CSS variable for optional UNIT3D color override
        fromSpan.style.setProperty('--usb-unit3d-color', meta.rankColor);

        // data attribute for CSS targeting
        fromSpan.setAttribute('data-usb-group', meta.rank);

        // Apply group colors class if enabled
        if (CONFIG.USE_GROUP_COLORS) {
            fromSpan.classList.add('usb-unit3d-colors');
        }

        // Group icon — inserted into .from div (after avatar, before .user span)
        // Placed outside .user span to survive Vue re-renders.
        if (CONFIG.USE_GROUP_ICON && meta.iconClasses) {
            const fromDiv = fromSpan.closest('.from');
            if (fromDiv && !fromDiv.querySelector('.usb-group')) {
                const icon = document.createElement('i');
                icon.className = 'usb-group ' + meta.iconClasses;
                icon.title = meta.rank;
                icon.style.setProperty('--usb-unit3d-color', meta.rankColor);

                // Copy the nick's color class so the icon matches the username
                const colorClass = Array.from(fromSpan.classList).find(c => c.startsWith('color-'));
                if (colorClass) icon.classList.add(colorClass);

                // If group colors enabled, override with UNIT3D rank color
                if (CONFIG.USE_GROUP_COLORS) {
                    icon.classList.add('usb-unit3d-colors');
                }

                fromDiv.insertBefore(icon, fromSpan);
            }
        }

        // Sparkles — CSS background on the .user span
        if (CONFIG.USE_SPARKLES && meta.sparkleUrl && site) {
            fromSpan.classList.add('usb-sparkles');
            fromSpan.style.backgroundImage = `url(https://${site}${meta.sparkleUrl})`;
        }
    }

    // Custom icon cache (same pattern as avatars)
    const customIconCache = new Map();
    const customIconInflight = new Map();

    function fetchCustomIcon(site, username) {
        const cacheKey = `${site}/${username}`;
        if (customIconCache.has(cacheKey)) return Promise.resolve(customIconCache.get(cacheKey));
        if (customIconInflight.has(cacheKey)) return customIconInflight.get(cacheKey);
        if (!HAS_GM_XHR) return Promise.resolve(null);

        const url = buildSiteUrl(site, getSiteConfig(site).urlIcon, username);
        if (!url) return Promise.resolve(null);

        const fetchPromise = new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                onload(response) {
                    customIconInflight.delete(cacheKey);
                    if (response.status >= 200 && response.status < 300 && response.response.size > 0) {
                        const reader = new FileReader();
                        reader.onload = () => {
                            customIconCache.set(cacheKey, reader.result);
                            resolve(reader.result);
                        };
                        reader.onerror = () => { customIconCache.set(cacheKey, null); resolve(null); };
                        reader.readAsDataURL(response.response);
                    } else {
                        customIconCache.set(cacheKey, null);
                        resolve(null);
                    }
                },
                onerror() {
                    customIconInflight.delete(cacheKey);
                    customIconCache.set(cacheKey, null);
                    resolve(null);
                },
            });
        });

        customIconInflight.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    function injectCustomIcon(fromSpan, dataUrl) {
        if (!dataUrl || fromSpan.querySelector('.usb-icon')) return;
        const wrapper = document.createElement('span');
        wrapper.className = 'usb-icon';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = 'Custom user icon';
        img.loading = 'lazy';
        wrapper.appendChild(img);
        fromSpan.appendChild(wrapper);
    }

    // =====================================================================
    //  FONTAWESOME ICON SUPPORT
    // =====================================================================
    //
    // Two things are cached permanently in localStorage:
    //   1. FA Pro woff2 font (base64 data URL, ~200KB)
    //   2. FA codepoint map (class→unicode, ~30-50KB JSON)
    //
    // Font fetch order:
    //   1. localStorage cache → done if present
    //   2. Site-specific faFontPath per mapped site
    //   3. Default faFontPath on remaining mapped sites
    //   4. FA 6 Free CDN fallback (Free icons only)
    //
    // Codepoint discovery:
    //   1. localStorage cache → done if present
    //   2. Fetch homepage HTML of each mapped site (in order)
    //   3. Find <link rel="stylesheet"> tags in head-order
    //   4. Fetch each CSS, parse .fa-*::before { content } rules
    //   5. Stop at first CSS with ≥50 FA codepoints, cache the map
    //   Supports both FA 6 (content: "\fXXX") and FA 7 (--fa: "\fXXX")
    //
    // Both caches are permanent — clear via Settings > Maintenance.

    const FA_FONT_KEY = 'fa_font_data';
    const FA_CODEPOINTS_KEY = 'fa_codepoints';
    let faInjected = false;

    /**
     * Inject FA styles into the page.
     * @param {string|null} fontDataUrl  Base64 data URL of Pro font, or null
     * @param {Object|null} codepoints   Map of icon name → unicode char, or null
     */
    function injectFaStyles(fontDataUrl, codepoints) {
        if (faInjected) return;
        faInjected = true;

        const style = document.createElement('style');
        style.id = 'usb-fa-font';
        let css = '';

        if (fontDataUrl) {
            css += `
                @font-face {
                    font-family: "USB FontAwesome";
                    font-style: normal;
                    font-weight: 900;
                    font-display: swap;
                    src: url("${fontDataUrl}") format("woff2");
                }
                i.usb-group.fas,
                i.usb-group.fab,
                i.usb-group.fa,
                i.usb-group.far,
                i.usb-group {
                    font-family: "USB FontAwesome" !important;
                    font-weight: 900 !important;
                    font-style: normal;
                    -webkit-font-smoothing: antialiased;
                    -moz-osx-font-smoothing: grayscale;
                    text-rendering: auto;
                    display: inline-block;
                    line-height: 1;
                    font-variant: normal;
                    color: inherit;
                }
            `;
        } else {
            css += `
                .usb-group {
                    color: inherit;
                    display: inline-block;
                    font-style: normal;
                    line-height: 1;
                }
            `;
        }

        // Inject ::before content rules from our codepoint map
        if (codepoints) {
            for (const [name, hex] of Object.entries(codepoints)) {
                css += `.usb-group.${name}::before{content:"\\${hex}"}\n`;
            }
        }

        style.textContent = css;
        document.head.appendChild(style);

        // If no Pro font AND no codepoints, load FA 6 Free CDN as last resort
        if (!fontDataUrl && !codepoints) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
            link.crossOrigin = 'anonymous';
            document.head.appendChild(link);
        }
    }

    /**
     * Fetch a URL via GM_xmlhttpRequest as a blob, return base64 data URL.
     */
    function gmFetchBlob(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                onload(response) {
                    if (response.status >= 200 && response.status < 300 && response.response.size > 1000) {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => resolve(null);
                        reader.readAsDataURL(response.response);
                    } else {
                        resolve(null);
                    }
                },
                onerror() { resolve(null); },
            });
        });
    }

    /**
     * Fetch a URL via GM_xmlhttpRequest as text.
     */
    function gmFetchText(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload(response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        resolve(null);
                    }
                },
                onerror() { resolve(null); },
            });
        });
    }

    /**
     * Parse FA codepoints from a CSS string.
     * Supports FA 6:  .fa-campfire::before { content: "\f6ba" }
     * Supports FA 7:  .fa-campfire { --fa: "\f6ba" }
     * Returns { "fa-campfire": "f6ba", ... } (hex strings) or null if < 50 found.
     */
    function parseFaCodepoints(cssText) {
        const codepoints = {};
        let count = 0;

        // Helper: extract hex from a content/--fa value (literal unicode or \escape)
        function extractHex(rawValue) {
            if (rawValue.startsWith('\\')) {
                return rawValue.slice(1).toLowerCase();
            }
            if (rawValue.length === 1 || rawValue.length === 2) {
                const cp = rawValue.codePointAt(0);
                if (cp < 0x80) return null; // Skip ASCII like "@"
                return cp.toString(16);
            }
            return null;
        }

        // FA 6: Match entire rule blocks with :before/:after selectors
        // Captures: [selectors] { content: "value" }
        // Then extracts all .fa-name classes from the selector string
        const ruleRe = /((?:[^{}]*\.fa-[a-z0-9-]+::?before[^{]*))\{\s*content:\s*"([^"]+)"/g;
        let m;
        while ((m = ruleRe.exec(cssText)) !== null) {
            const hex = extractHex(m[2]);
            if (!hex) continue;

            // Extract all .fa-name classes from the selector portion
            const nameRe = /\.(fa-[a-z0-9-]+)/g;
            let nameMatch;
            while ((nameMatch = nameRe.exec(m[1])) !== null) {
                if (!codepoints[nameMatch[1]]) {
                    codepoints[nameMatch[1]] = hex;
                    count++;
                }
            }
        }

        // FA 7: .fa-name { --fa: "value" }  (no :before, uses CSS variable)
        const fa7 = /\.(fa-[a-z0-9-]+)\s*\{\s*--fa:\s*"([^"]+)"/g;
        while ((m = fa7.exec(cssText)) !== null) {
            const hex = extractHex(m[2]);
            if (!hex) continue;
            if (!codepoints[m[1]]) {
                codepoints[m[1]] = hex;
                count++;
            }
        }

        // FA Pro has thousands of icons; < 50 means we hit the wrong CSS file
        return count >= 50 ? codepoints : null;
    }

    /**
     * Discover FA codepoints by fetching site CSS files.
     * Fetches homepage HTML, extracts <link> stylesheet URLs in document order,
     * and parses each until one yields FA codepoints.
     */
    async function discoverFaCodepoints(sites) {
        for (const site of sites) {
            const config = getSiteConfig(site);
            if (config.faFontPath === false) continue;

            console.log(`[USB] Discovering FA codepoints from ${site}...`);
            const html = await gmFetchText(`https://${site}`);
            if (!html) continue;

            // Extract all stylesheet URLs in document order
            const cssUrls = [];
            const seen = new Set();
            const linkRe = /<link\b[^>]*>/gi;
            let tag;
            while ((tag = linkRe.exec(html)) !== null) {
                const tagStr = tag[0];
                if (!/rel=["']stylesheet["']/i.test(tagStr)) continue;
                const hrefMatch = tagStr.match(/href=["']([^"']+)["']/);
                if (!hrefMatch) continue;
                let href = hrefMatch[1];
                if (href.startsWith('/')) href = `https://${site}${href}`;
                else if (!href.startsWith('http')) href = `https://${site}/${href}`;
                if (!seen.has(href)) {
                    seen.add(href);
                    cssUrls.push(href);
                }
            }

            for (const cssUrl of cssUrls) {
                const cssText = await gmFetchText(cssUrl);
                if (!cssText) continue;

                const codepoints = parseFaCodepoints(cssText);
                if (codepoints) {
                    const count = Object.keys(codepoints).length;
                    console.log(`[USB] Cached ${count} FA codepoints from ${cssUrl}`);
                    storeSet(FA_CODEPOINTS_KEY, codepoints);
                    return codepoints;
                }
            }
        }
        return null;
    }

    /**
     * Initialize FA font + codepoint support.
     */
    async function ensureFontAwesome() {
        if (faInjected) return;

        // Collect mapped sites
        const mappings = loadSiteMappings();
        const sites = new Set();
        for (const value of Object.values(mappings)) {
            if (value && value !== '__none__') sites.add(value);
        }

        // 1. Check caches
        const cachedFont = storeGet(FA_FONT_KEY);
        const cachedCodepoints = storeGet(FA_CODEPOINTS_KEY);

        if (cachedFont?.dataUrl && cachedCodepoints) {
            injectFaStyles(cachedFont.dataUrl, cachedCodepoints);
            return;
        }

        if (!HAS_GM_XHR || sites.size === 0) {
            injectFaStyles(null, null);
            return;
        }

        // 2. Fetch font (if not cached)
        let fontDataUrl = cachedFont?.dataUrl || null;
        if (!fontDataUrl) {
            const defaultPath = SITE_CONFIG['default'].faFontPath;
            const triedDefaultOn = new Set();

            for (const site of sites) {
                const config = getSiteConfig(site);
                if (config.faFontPath === false) continue;

                fontDataUrl = await gmFetchBlob(`https://${site}${config.faFontPath}`);
                if (fontDataUrl) {
                    storeSet(FA_FONT_KEY, { dataUrl: fontDataUrl });
                    console.log(`[USB] Cached FA Pro font from ${site}`);
                    break;
                }
                if (config.faFontPath === defaultPath) triedDefaultOn.add(site);
            }

            if (!fontDataUrl) {
                for (const site of sites) {
                    if (triedDefaultOn.has(site)) continue;
                    const config = getSiteConfig(site);
                    if (config.faFontPath === false) continue;

                    fontDataUrl = await gmFetchBlob(`https://${site}${defaultPath}`);
                    if (fontDataUrl) {
                        storeSet(FA_FONT_KEY, { dataUrl: fontDataUrl });
                        console.log(`[USB] Cached FA Pro font from ${site} (default path)`);
                        break;
                    }
                }
            }
        }

        // 3. Discover codepoints (if not cached)
        let codepoints = cachedCodepoints || null;
        if (!codepoints) {
            codepoints = await discoverFaCodepoints(sites);
        }

        // 4. Inject whatever we got
        if (!fontDataUrl && !codepoints) {
            console.log('[USB] FA Pro not found, using FA Free CDN');
        }
        injectFaStyles(fontDataUrl, codepoints);
    }
    // =====================================================================
    //
    // Scrapes the "online users" widget from UNIT3D sites to build a
    // local database of rank, rank color, icon class, donor status, etc.
    // Falls back to individual profile page fetches for cache misses.

    const META_PREFIX = 'meta_';
    const META_TTL = 24 * 60 * 60 * 1000; // 24 hours
    const SCRAPE_INTERVAL = 15 * 60 * 1000; // 15 minutes
    const PROFILE_MISS_LIMIT = 5; // max consecutive profile fetches before stopping
    const scrapeTimers = new Map();
    let profileMissCount = 0;

    function readUserMeta(site, username) {
        const entry = storeGet(META_PREFIX + site + '/' + username);
        if (!entry || !entry.fetchedAt) return null;
        if ((Date.now() - entry.fetchedAt) > META_TTL) {
            storeDelete(META_PREFIX + site + '/' + username);
            return null;
        }
        return entry;
    }

    function writeUserMeta(site, username, data) {
        storeSet(META_PREFIX + site + '/' + username, {
            ...data,
            fetchedAt: Date.now()
        });
    }

    /**
     * Parse ALL user-tag links from a full page HTML string.
     * Scans the entire page (online widget, forum posts, uploads, etc.)
     * for user-tag__link anchors and extracts metadata.
     * Returns a Map of username → { rank, rankColor, iconClasses, hasCustomIcon, sparkleUrl }
     */
    function parsePageUsers(html) {
        const users = new Map();

        // Parse ALL user-tag__link anchors across the entire page
        const userPattern = /<a\s+class="user-tag__link(?:\s+user-tag__link--anonymous)?\s+(fa[^"]*?)"\s+href="https?:\/\/[^/]+\/users\/([^"]+)"\s+style="color:\s*([^"]*?)"\s+title="([^"]*?)"/g;
        let match;
        while ((match = userPattern.exec(html)) !== null) {
            const [, iconClasses, username, color, rank] = match;
            // Skip (Anonymous) placeholder users
            if (username === '(Anonymous)' || username === 'Anonymous') continue;
            if (!users.has(username)) {
                users.set(username, {
                    rank,
                    rankColor: color.trim(),
                    iconClasses: iconClasses.trim(),
                    hasCustomIcon: false,
                    sparkleUrl: null,
                });
            }
        }

        // Cross-reference custom icons
        const iconPattern = /authenticated-images\/user-icons\/([a-zA-Z0-9_-]+)/g;
        let iconMatch;
        while ((iconMatch = iconPattern.exec(html)) !== null) {
            const data = users.get(iconMatch[1]);
            if (data) data.hasCustomIcon = true;
        }

        // Cross-reference sparkle/donor backgrounds
        // Captures the actual image path (sparkels.gif, space.gif, etc.)
        const sparklePattern = /background-image:\s*url\((\/img\/[^)]+)\);[^<]*?(?:<[^a]*?)*?<a[^>]*?\/users\/([^"]+)"/g;
        let sparkleMatch;
        while ((sparkleMatch = sparklePattern.exec(html)) !== null) {
            const data = users.get(sparkleMatch[2]);
            if (data) data.sparkleUrl = sparkleMatch[1];
        }

        return users;
    }

    /**
     * Scrape user metadata from a tracker site's homepage and cache the results.
     * Parses ALL user-tags across the entire page (online widget, forum posts, etc.)
     */
    function scrapeSiteUsers(site) {
        if (!HAS_GM_XHR) return Promise.resolve(0);

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://${site}`,
                responseType: 'text',
                onload(response) {
                    if (response.status !== 200) {
                        console.warn(`[USB] Scrape failed for ${site}: HTTP ${response.status}`);
                        resolve(0);
                        return;
                    }
                    const users = parsePageUsers(response.responseText);
                    let count = 0;
                    for (const [username, data] of users) {
                        writeUserMeta(site, username, data);
                        count++;
                    }
                    if (count > 0) {
                        console.log(`[USB] Scraped ${count} users from ${site}`);
                    }
                    profileMissCount = 0; // reset miss counter on successful bulk scrape
                    resolve(count);
                },
                onerror() {
                    console.warn(`[USB] Scrape request failed for ${site}`);
                    resolve(0);
                },
            });
        });
    }

    /**
     * Fetch metadata for a single user from their profile page.
     * Used as a fallback when the user isn't in the online widget cache.
     */
    function scrapeUserProfile(site, username, bypassLimit = false) {
        if (!HAS_GM_XHR) return Promise.resolve(null);

        const config = getSiteConfig(site);
        if (!config.featProfile || !config.urlProfile) return Promise.resolve(null);

        // Rate-limit consecutive profile fetches (unless explicitly bypassed)
        if (!bypassLimit) {
            if (profileMissCount >= PROFILE_MISS_LIMIT) {
                console.warn(`[USB] Profile fetch limit reached (${PROFILE_MISS_LIMIT}), skipping ${username}`);
                return Promise.resolve(null);
            }
            profileMissCount++;
        }

        const url = buildSiteUrl(site, config.urlProfile, username);
        if (!url) return Promise.resolve(null);

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'text',
                onload(response) {
                    if (response.status !== 200) {
                        resolve(null);
                        return;
                    }

                    const html = response.responseText;

                    // Parse the user-tag from their profile page
                    // Same structure as the online widget but only one user
                    const userPattern = /<a\s+class="user-tag__link(?:\s+user-tag__link--anonymous)?\s+(fa[^"]*?)"\s+href="https?:\/\/[^/]+\/users\/[^"]+"\s+style="color:\s*([^"]*?)"\s+title="([^"]*?)"/;
                    const match = html.match(userPattern);

                    if (!match) {
                        resolve(null);
                        return;
                    }

                    const sparkleUrlMatch = html.match(/background-image:\s*url\((\/img\/[^)]+)\)/i);

                    const data = {
                        rank: match[3],
                        rankColor: match[2].trim(),
                        iconClasses: match[1].trim(),
                        hasCustomIcon: /authenticated-images\/user-icons\//i.test(html),
                        sparkleUrl: sparkleUrlMatch ? sparkleUrlMatch[1] : null,
                    };

                    writeUserMeta(site, username, data);
                    resolve(data);
                },
                onerror() { resolve(null); },
            });
        });
    }

    /**
     * Get user metadata: check cache first, then optionally fetch from profile.
     * Returns { rank, rankColor, iconClasses, hasCustomIcon, sparkleUrl } or null.
     */
    function getUserMeta(site, username, fetchOnMiss = true) {
        const cached = readUserMeta(site, username);
        if (cached) return Promise.resolve(cached);
        if (!fetchOnMiss) return Promise.resolve(null);
        return scrapeUserProfile(site, username);
    }

    /**
     * Start periodic scraping for a site.
     */
    function startScrapeSchedule(site) {
        if (scrapeTimers.has(site)) return;
        scrapeSiteUsers(site);
        const timer = setInterval(() => scrapeSiteUsers(site), SCRAPE_INTERVAL);
        scrapeTimers.set(site, timer);
    }

    /**
     * Start scraping for all mapped sites (network or channel level).
     */
    async function initializeMetadataScraping() {
        const mappings = loadSiteMappings();
        const sites = new Set();
        for (const value of Object.values(mappings)) {
            if (value && value !== '__none__') sites.add(value);
        }

        // Run initial scrapes and wait for them to complete
        const initialScrapes = [];
        for (const site of sites) {
            initialScrapes.push(scrapeSiteUsers(site));
        }
        await Promise.all(initialScrapes);

        // Then start periodic scraping
        for (const site of sites) {
            if (!scrapeTimers.has(site)) {
                const timer = setInterval(() => scrapeSiteUsers(site), SCRAPE_INTERVAL);
                scrapeTimers.set(site, timer);
            }
        }
    }

    // =====================================================================
    //  MATCHERS
    // =====================================================================

    const MATCHERS = [
        'Chatbot',          // ATH
        'ULCX',             // ULCX
        'Willie',           // BHD
        'WALL-E',           // RFX
        'BBot',             // HHD
        'darkpeers',        // DP
        'Bot',              // LST
        'Mellos',           // HUNO (Discord)
        /.+?-web/,          // HUNO (Shoutbox) — regex gets raw username
        'Sauron',           // ANT
        'bridgebot',        // OE+
    ];

    function matcherMatches(username) {
        const bare = stripIrcPrefix(username);
        return MATCHERS.some(pattern =>
            typeof pattern === 'string'
                ? pattern === bare
                : pattern instanceof RegExp && pattern.test(username)
        );
    }

    // =====================================================================
    //  FORMAT HANDLERS
    // =====================================================================

    // See earlier versions for full documentation on handler structure.
    // Each handler returns { username, modifyContent, prefixToRemove, metadata } or null.

    function removeMatchedPrefix(match) {
        const fullMatch = match[0];
        const messageText = match[match.length - 1];
        return fullMatch.substring(0, fullMatch.lastIndexOf(messageText));
    }

    function removeAllExceptMessage(text, messageText) {
        return text.substring(0, text.lastIndexOf(messageText));
    }

    const HANDLERS = [
        {
            // [SB] Nickname: Message or [ SB ] (Nickname): Message — BHD, ANT
            enabled: true,
            handler: function (msg) {
                const match = msg.text.match(/^\s?\[\s?SB\s?\]\s+\(?([^):]+)\)?:\s*(.*)$/);
                if (!match) return null;
                return { username: match[1], modifyContent: true, prefixToRemove: removeMatchedPrefix(match), metadata: CONFIG.METADATA };
            }
        },
        {
            // [Chatbox] Nickname: Message — RFX
            enabled: true,
            handler: function (msg) {
                const match = msg.text.match(/^\[Chatbox\]\s+([^:]+):\s*(.*)$/);
                if (!match) return null;
                return { username: match[1], modifyContent: true, prefixToRemove: removeMatchedPrefix(match), metadata: CONFIG.METADATA };
            }
        },
        {
            // »Username« Message or »Username (Rank)« Message — HUNO (Discord)
            enabled: true,
            handler: function (msg) {
                const HANDLER_CONFIG = { REMOVE_RANK: true, ABBREVIATE_RANK: true, FORCE_ABBREVIATE: false };
                const cleanText = msg.text.replace(/[\u200B-\u200D\uFEFF]/g, '');
                let match = cleanText.match(/^»([^«]+)«\s*(.*)$/);
                if (!match) match = cleanText.match(/^»(\S+(?:\s+\([^)]+\))?)\s+(.*)$/);
                if (!match) return null;

                function abbreviateRank(rank) {
                    const caps = rank.match(/[A-Z]/g);
                    if (!caps) return '';
                    if (!HANDLER_CONFIG.FORCE_ABBREVIATE && caps.length === 1) return rank;
                    return caps.join('');
                }

                let rawUsername = match[1], extractedUsername, metadata = '';
                if (HANDLER_CONFIG.REMOVE_RANK && rawUsername.endsWith(')')) {
                    const rankMatch = rawUsername.match(/^(.*)\s+\(([^)]+)\)$/);
                    if (rankMatch) {
                        extractedUsername = rankMatch[1].trim();
                        metadata = HANDLER_CONFIG.ABBREVIATE_RANK ? abbreviateRank(rankMatch[2]) : rankMatch[2];
                    } else { extractedUsername = rawUsername.trim(); }
                } else { extractedUsername = rawUsername.trim(); }

                return { username: extractedUsername, modifyContent: true, prefixToRemove: removeMatchedPrefix(match), metadata };
            }
        },
        {
            // <Username-web> Message — HUNO (Shoutbox)
            enabled: true,
            handler: function (msg) {
                if (!msg.chan.startsWith('#huno')) return null;
                if (msg.from.endsWith('-web')) {
                    return { username: msg.from.slice(0, -4), modifyContent: false, metadata: CONFIG.METADATA };
                }
                return null;
            }
        },
        {
            // [Nickname] Message or [Nickname]: Message — ATH, DP, ULCX, HHD, LST
            enabled: true,
            handler: function (msg) {
                const match = msg.text.match(/^\[([^\]]+)\](?::\s*|\s+)(.*)$/);
                if (!match) return null;
                return { username: match[1], modifyContent: true, prefixToRemove: removeMatchedPrefix(match), metadata: CONFIG.METADATA };
            }
        }
    ];

    function runFormatHandlers(msg) {
        for (const h of HANDLERS) {
            if (!h.enabled) continue;
            const result = h.handler(msg);
            if (result) return result;
        }
        return null;
    }

    // =====================================================================
    //  SURGICAL DOM MODIFICATION
    // =====================================================================

    function findPrefixTextNodes(contentSpan, prefixText) {
        const walker = document.createTreeWalker(contentSpan, NodeFilter.SHOW_TEXT, null, false);
        let accumulatedText = '';
        const nodesToProcess = [];
        let textNode;
        while (textNode = walker.nextNode()) {
            nodesToProcess.push({ node: textNode, text: textNode.textContent, accumulatedLength: accumulatedText.length });
            accumulatedText += textNode.textContent;
            if (accumulatedText.length >= prefixText.length) break;
        }
        return { nodesToProcess, accumulatedText };
    }

    function removePrefixSurgically(contentSpan, prefixText) {
        const { nodesToProcess, accumulatedText } = findPrefixTextNodes(contentSpan, prefixText);
        const cleaned = accumulatedText.replace(/[\u200B-\u200D\uFEFF]/g, '');
        if (!cleaned.startsWith(prefixText)) return false;

        let cleanedCharsProcessed = 0;
        for (const { node, text } of nodesToProcess) {
            if (cleanedCharsProcessed >= prefixText.length) break;
            const cleanedNodeText = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
            const cleanedNodeLength = cleanedNodeText.length;
            const cleanedCharsInThisNode = Math.min(cleanedNodeLength, prefixText.length - cleanedCharsProcessed);
            cleanedCharsProcessed += cleanedCharsInThisNode;

            if (cleanedCharsInThisNode === cleanedNodeLength) {
                node.textContent = '';
            } else {
                let originalCharsToRemove = 0, cleanedCount = 0;
                for (let i = 0; i < text.length && cleanedCount < cleanedCharsInThisNode; i++) {
                    originalCharsToRemove++;
                    if (!/[\u200B-\u200D\uFEFF]/.test(text[i])) cleanedCount++;
                }
                node.textContent = text.substring(originalCharsToRemove);
                break;
            }
        }
        cleanupEmptyNodes(contentSpan);
        return true;
    }

    function cleanupEmptyNodes(contentSpan) {
        const walker = document.createTreeWalker(contentSpan, NodeFilter.SHOW_TEXT, null, false);
        const empty = [];
        let t;
        while (t = walker.nextNode()) { if (t.textContent === '') empty.push(t); }
        empty.forEach(n => n.remove());
        const keep = ['preview-size', 'toggle-button', 'user', 'irc-fg', 'irc-bg'];
        contentSpan.querySelectorAll('span:empty').forEach(span => {
            if (!keep.some(cls => span.className.includes(cls))) span.remove();
        });
    }

    // =====================================================================
    //  COLOR MATCHING & AUTOCOMPLETE
    // =====================================================================

    function addUserToAutocomplete(username) {
        try {
            const state = Array.from(document.querySelectorAll('*'))
                .find(e => e.__vue_app__)
                ?.__vue_app__?.config?.globalProperties?.$store?.state;
            if (!state?.activeChannel?.channel?.users) return;
            const users = state.activeChannel.channel.users;
            if (!users.find(u => u.nick === username)) {
                users.push({ nick: username, modes: [], lastMessage: Date.now() });
            }
        } catch { /* ignore */ }
    }

    function findUserInUserlist(username) {
        for (const el of document.querySelectorAll('.userlist .user[data-name]')) {
            if (el.getAttribute('data-name') === username) return el;
        }
        return null;
    }

    function extractColorClass(el) {
        return el.className.split(' ').find(cls => cls.startsWith('color-')) || null;
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
        const classes = fromSpan.className.split(' ').filter(cls => !cls.startsWith('color-'));
        classes.push(colorClass);
        fromSpan.className = classes.join(' ');
    }

    // =====================================================================
    //  IRC PREFIX STRIPPING
    // =====================================================================

    const IRC_MODE_PREFIXES = /^[~&@%+!]+/;

    function stripIrcPrefix(username) {
        return username.replace(IRC_MODE_PREFIXES, '');
    }

    // =====================================================================
    //  UTILITY
    // =====================================================================

    function escapeHtml(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }

    function timeSince(timestamp) {
        const s = Math.floor((Date.now() - timestamp) / 1000);
        if (s < 60) return 'just now';
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    function showToast(message) {
        const existing = document.querySelector('.usb-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'usb-toast';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 10000;
            background: var(--highlight-bg-color, #333); color: var(--body-color, #fff);
            padding: 10px 16px; border-radius: 4px; font-size: 0.875em;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3); transition: opacity 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2000);
    }

    // =====================================================================
    //  SETTINGS MODAL
    // =====================================================================

    function injectFooterButton() {
        const footer = document.querySelector('#footer');
        if (!footer || footer.querySelector('.usb-settings-btn')) return;

        const wrapper = document.createElement('span');
        wrapper.className = 'tooltipped tooltipped-n tooltipped-no-touch usb-settings-btn';
        wrapper.setAttribute('aria-label', 'Shoutbox Beautifier');
        wrapper.innerHTML = '<button class="icon settings" aria-label="Shoutbox Beautifier"></button>';
        wrapper.querySelector('button').addEventListener('click', (e) => {
            e.preventDefault();
            toggleSettingsModal();
        });

        // Insert before the last child (Help)
        const helpSpan = footer.lastElementChild;
        footer.insertBefore(wrapper, helpSpan);
    }

    function toggleSettingsModal() {
        const existing = document.querySelector('#usb-modal');
        if (existing) { existing.remove(); return; }
        renderSettingsModal();
    }

    function renderSettingsModal() {
        const existing = document.querySelector('#usb-modal');
        if (existing) existing.remove();

        CONFIG = loadSettings();
        const siteMappings = loadSiteMappings();
        const trackerSites = loadTrackerSites();
        const networkTree = scrapeNetworkTree();

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'usb-modal';
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 9999;
            background: rgba(0,0,0,0.5); display: flex;
            align-items: center; justify-content: center;
        `;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        // Modal
        const modal = document.createElement('div');
        modal.style.cssText = `
            background: var(--window-bg-color, #1a1a2e); color: var(--body-color, #ccc);
            border-radius: 8px; padding: 20px; width: 520px; max-width: 90vw;
            max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            font-family: var(--body-font, sans-serif); font-size: 14px;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;';
        const title = document.createElement('h2');
        title.textContent = 'Shoutbox Beautifier';
        title.style.cssText = 'margin: 0; font-size: 18px;';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn';
        closeBtn.textContent = '\u00d7';
        closeBtn.style.cssText = 'font-size: 20px; line-height: 1; padding: 2px 8px;';
        closeBtn.addEventListener('click', () => overlay.remove());
        header.appendChild(title);
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // --- General section ---
        modal.appendChild(makeH3('General'));

        modal.appendChild(makeCheckbox('usb-autocomplete', 'Enable autocomplete for bridged usernames', CONFIG.USE_AUTOCOMPLETE, (v) => { CONFIG.USE_AUTOCOMPLETE = v; saveSettings(CONFIG); }));
        modal.appendChild(makeCheckbox('usb-join-quit', 'Remove join/quit messages', CONFIG.REMOVE_JOIN_QUIT, (v) => { CONFIG.REMOVE_JOIN_QUIT = v; saveSettings(CONFIG); }));

        // --- UNIT3D Integration section ---
        modal.appendChild(makeH3('UNIT3D Integration'));

        const gmNote = HAS_GM_XHR ? '' : ' (requires userscript manager)';
        modal.appendChild(makeCheckbox('usb-avatars', 'Avatars' + gmNote, CONFIG.USE_AVATARS && HAS_GM_XHR, (v) => { CONFIG.USE_AVATARS = v; saveSettings(CONFIG); }, !HAS_GM_XHR));
        modal.appendChild(makeCheckbox('usb-group-icon', 'Group icon' + gmNote, CONFIG.USE_GROUP_ICON && HAS_GM_XHR, (v) => { CONFIG.USE_GROUP_ICON = v; saveSettings(CONFIG); }, !HAS_GM_XHR));
        modal.appendChild(makeCheckbox('usb-custom-icon', 'Custom user icon' + gmNote, CONFIG.USE_CUSTOM_ICON && HAS_GM_XHR, (v) => { CONFIG.USE_CUSTOM_ICON = v; saveSettings(CONFIG); }, !HAS_GM_XHR));
        modal.appendChild(makeCheckbox('usb-sparkles', 'Sparkles (donor effect)' + gmNote, CONFIG.USE_SPARKLES && HAS_GM_XHR, (v) => { CONFIG.USE_SPARKLES = v; saveSettings(CONFIG); }, !HAS_GM_XHR));
        modal.appendChild(makeCheckbox('usb-group-colors', 'Group colors (overrides nick colors)', CONFIG.USE_GROUP_COLORS, (v) => { CONFIG.USE_GROUP_COLORS = v; saveSettings(CONFIG); }));

        // --- Bridged Messages section ---
        modal.appendChild(makeH3('Bridged Messages'));

        modal.appendChild(makeCheckbox('usb-decorators', 'Username decorators', CONFIG.USE_DECORATORS, (v) => { CONFIG.USE_DECORATORS = v; saveSettings(CONFIG); }));

        const decRow = document.createElement('div');
        decRow.style.cssText = 'display: flex; gap: 12px; margin: 8px 0;';
        decRow.appendChild(makeTextInput('Left decorator', CONFIG.DECORATOR_L, '(', (v) => { CONFIG.DECORATOR_L = v; saveSettings(CONFIG); }, '60px'));
        decRow.appendChild(makeTextInput('Right decorator', CONFIG.DECORATOR_R, ')', (v) => { CONFIG.DECORATOR_R = v; saveSettings(CONFIG); }, '60px'));
        decRow.appendChild(makeTextInput('Metadata', CONFIG.METADATA, 'SB', (v) => { CONFIG.METADATA = v; saveSettings(CONFIG); }, '60px'));
        modal.appendChild(decRow);

        // --- Site Mappings section ---
        modal.appendChild(makeH3('Site Mappings'));

        if (!HAS_GM_XHR) {
            const note = document.createElement('p');
            note.textContent = 'Avatar fetching requires a userscript manager (Tampermonkey, Violentmonkey, etc).';
            note.style.cssText = 'opacity: 0.6; font-style: italic; margin: 4px 0;';
            modal.appendChild(note);
        }

        // Tracker sites management
        const sitesLabel = document.createElement('div');
        sitesLabel.style.cssText = 'margin-bottom: 8px;';
        sitesLabel.innerHTML = '<b>Tracker sites</b> <span style="opacity:0.6">(add hostnames, e.g. aither.cc)</span>';
        modal.appendChild(sitesLabel);

        const sitesContainer = document.createElement('div');
        sitesContainer.id = 'usb-sites-list';

        function renderSitesList() {
            sitesContainer.innerHTML = '';
            const sites = loadTrackerSites();
            for (const site of sites) {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 4px;';
                const label = document.createElement('span');
                label.textContent = site;
                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn';
                removeBtn.textContent = '\u00d7';
                removeBtn.style.cssText = 'padding: 0 6px; font-size: 14px; line-height: 1.4;';
                removeBtn.addEventListener('click', () => {
                    const updated = loadTrackerSites().filter(s => s !== site);
                    saveTrackerSites(updated);
                    renderSettingsModal();
                });
                row.appendChild(label);
                row.appendChild(removeBtn);
                sitesContainer.appendChild(row);
            }
        }
        renderSitesList();
        modal.appendChild(sitesContainer);

        const addRow = document.createElement('div');
        addRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 16px;';
        const addInput = document.createElement('input');
        addInput.type = 'text';
        addInput.className = 'input';
        addInput.placeholder = 'aither.cc';
        addInput.style.cssText = 'flex: 1;';
        const addBtn = document.createElement('button');
        addBtn.className = 'btn';
        addBtn.textContent = 'Add';
        addBtn.addEventListener('click', () => {
            const val = addInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            if (!val) return;
            const sites = loadTrackerSites();
            if (!sites.includes(val)) { sites.push(val); saveTrackerSites(sites); }
            addInput.value = '';
            renderSitesList();
            // Re-render the whole modal so mapping dropdowns update
            renderSettingsModal();
        });
        addRow.appendChild(addInput);
        addRow.appendChild(addBtn);
        modal.appendChild(addRow);

        // Network → site mappings
        if (networkTree.length > 0 && loadTrackerSites().length > 0) {
            const mapLabel = document.createElement('div');
            mapLabel.innerHTML = '<b>Network mappings</b>';
            mapLabel.style.cssText = 'margin-bottom: 8px;';
            modal.appendChild(mapLabel);

            for (const net of networkTree) {
                const netRow = document.createElement('div');
                netRow.style.cssText = 'margin-bottom: 8px;';

                const netHeader = document.createElement('div');
                netHeader.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                const expandBtn = document.createElement('button');
                expandBtn.type = 'button';
                expandBtn.className = 'btn';
                expandBtn.textContent = '+';
                expandBtn.style.cssText = 'width: 24px; height: 24px; padding: 0; font-size: 12px; line-height: 1; flex-shrink: 0;';

                const netLabel = document.createElement('b');
                netLabel.textContent = net.name;
                netLabel.style.cssText = 'min-width: 60px;';

                const netSelect = makeSiteDropdown(loadTrackerSites(), siteMappings[net.name] || '', (val) => {
                    const m = loadSiteMappings();
                    if (val) m[net.name] = val; else delete m[net.name];
                    saveSiteMappings(m);
                });

                netHeader.appendChild(expandBtn);
                netHeader.appendChild(netLabel);
                netHeader.appendChild(netSelect);
                netRow.appendChild(netHeader);

                const chanContainer = document.createElement('div');
                chanContainer.style.cssText = 'display: none; margin-left: 32px; margin-top: 4px;';

                for (const chan of net.channels) {
                    const chanRow = document.createElement('div');
                    chanRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 4px;';
                    const chanLabel = document.createElement('span');
                    chanLabel.textContent = chan;
                    chanLabel.style.cssText = 'min-width: 100px; opacity: 0.7;';
                    const channelKey = `${net.name}/${chan}`;
                    const chanSelect = makeSiteDropdown(loadTrackerSites(), siteMappings[channelKey] || '', (val) => {
                        const m = loadSiteMappings();
                        if (val) m[channelKey] = val; else delete m[channelKey];
                        saveSiteMappings(m);
                    }, true);
                    chanRow.appendChild(chanLabel);
                    chanRow.appendChild(chanSelect);
                    chanContainer.appendChild(chanRow);
                }

                expandBtn.addEventListener('click', () => {
                    const hidden = chanContainer.style.display === 'none';
                    chanContainer.style.display = hidden ? 'block' : 'none';
                    expandBtn.textContent = hidden ? '\u2212' : '+';
                });

                netRow.appendChild(chanContainer);
                modal.appendChild(netRow);
            }
        }

        // --- Maintenance ---
        modal.appendChild(makeH3('Maintenance'));

        const maintRow = document.createElement('div');
        maintRow.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';
        const clearCacheBtn = document.createElement('button');
        clearCacheBtn.className = 'btn';
        clearCacheBtn.textContent = 'Clear avatar cache';
        clearCacheBtn.addEventListener('click', () => { clearAvatarCache(); showToast('Avatar cache cleared'); });
        maintRow.appendChild(clearCacheBtn);

        const clearMetaBtn = document.createElement('button');
        clearMetaBtn.className = 'btn';
        clearMetaBtn.textContent = 'Clear metadata cache';
        clearMetaBtn.addEventListener('click', () => {
            for (const key of storeKeys(META_PREFIX)) storeDelete(key);
            showToast('Metadata cache cleared — will repopulate on next scrape');
        });
        maintRow.appendChild(clearMetaBtn);

        const clearFontBtn = document.createElement('button');
        clearFontBtn.className = 'btn';
        clearFontBtn.textContent = 'Clear font cache';
        clearFontBtn.addEventListener('click', () => {
            storeDelete(FA_FONT_KEY);
            storeDelete(FA_CODEPOINTS_KEY);
            faInjected = false;
            const existingStyle = document.querySelector('#usb-fa-font');
            if (existingStyle) existingStyle.remove();
            showToast('Font + codepoint cache cleared — refresh to re-fetch');
        });
        maintRow.appendChild(clearFontBtn);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn';
        resetBtn.textContent = 'Reset all settings';
        resetBtn.addEventListener('click', () => {
            if (!confirm('Reset all USB settings, site mappings, and avatar cache?')) return;
            for (const key of storeKeys('')) storeDelete(key);
            clearAvatarCache();
            CONFIG = loadSettings();
            overlay.remove();
            showToast('All settings reset');
        });
        maintRow.appendChild(resetBtn);
        modal.appendChild(maintRow);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    // Modal helper functions
    function makeH3(text) {
        const h = document.createElement('h3');
        h.textContent = text;
        h.style.cssText = 'margin: 16px 0 8px 0; font-size: 15px; border-bottom: 1px solid var(--body-color-muted, #444); padding-bottom: 4px;';
        return h;
    }

    function makeCheckbox(id, labelText, checked, onChange, disabled) {
        const label = document.createElement('label');
        label.style.cssText = 'display: block; margin: 6px 0; cursor: pointer;' + (disabled ? ' opacity: 0.4; pointer-events: none;' : '');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = checked;
        input.disabled = !!disabled;
        input.addEventListener('change', () => onChange(input.checked));
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + labelText));
        return label;
    }

    function makeTextInput(labelText, value, placeholder, onChange, width) {
        const wrapper = document.createElement('div');
        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.cssText = 'display: block; font-size: 12px; opacity: 0.7; margin-bottom: 2px;';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input';
        input.value = value;
        input.placeholder = placeholder;
        if (width) input.style.width = width;
        input.addEventListener('input', () => onChange(input.value));
        wrapper.appendChild(label);
        wrapper.appendChild(input);
        return wrapper;
    }

    function makeSiteDropdown(sites, currentValue, onChange, includeDefault) {
        const select = document.createElement('select');
        select.className = 'input';
        select.style.cssText = 'flex: 1; max-width: 180px;';

        if (includeDefault) {
            const defOpt = document.createElement('option');
            defOpt.value = '';
            defOpt.textContent = '(network default)';
            select.appendChild(defOpt);
            const noneOpt = document.createElement('option');
            noneOpt.value = '__none__';
            noneOpt.textContent = '(none)';
            if (currentValue === '__none__') noneOpt.selected = true;
            select.appendChild(noneOpt);
        } else {
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '(none)';
            select.appendChild(noneOpt);
        }

        for (const site of sites) {
            const opt = document.createElement('option');
            opt.value = site;
            opt.textContent = site;
            if (site === currentValue) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }

    // =====================================================================
    //  DEFAULT CSS
    // =====================================================================

    function injectDefaultStyles() {
        if (document.querySelector('#usb-styles')) return;
        const style = document.createElement('style');
        style.id = 'usb-styles';
        style.textContent = `
            .usb-avatar {
                display: inline-block;
                vertical-align: middle;
                margin-right: 4px;
                width: 20px;
                height: 20px;
                flex-shrink: 0;
            }
            .usb-avatar img {
                width: 20px;
                height: 20px;
                border-radius: 50%;
                object-fit: cover;
                vertical-align: middle;
                display: block;
            }
            .usb-group {
                vertical-align: middle;
                margin-right: 3px;
            }
            .usb-icon {
                display: inline-block;
                vertical-align: middle;
                margin-left: 3px;
            }
            .usb-icon img {
                height: 16px;
                object-fit: cover;
                vertical-align: middle;
            }
            .usb-sparkles {
                background-repeat: repeat;
                background-size: auto;
                padding: 1px 3px;
                border-radius: 3px;
            }
            .usb-unit3d-colors {
                color: var(--usb-unit3d-color) !important;
            }
        `;
        document.head.appendChild(style);
    }

    // =====================================================================
    //  MESSAGE PROCESSING
    // =====================================================================

    function processExistingMessages() {
        document.querySelectorAll('.msg').forEach(processMessage);
    }

    function processMessage(messageElement) {
        if (CONFIG.REMOVE_JOIN_QUIT) {
            if (messageElement.matches('div[data-type="condensed"],div[data-type="join"],div[data-type="quit"]')) {
                messageElement.style.display = 'none';
                return;
            }
        }

        const fromSpan = messageElement.querySelector('.from .user');
        if (!fromSpan) return;

        const initialUsername = fromSpan.textContent;
        if (!initialUsername) return;

        const context = getActiveNetworkAndChannel();
        const networkName = context?.network || '';
        const channelName = messageElement.closest('[data-current-channel]')?.getAttribute('data-current-channel') || '';

        fromSpan.setAttribute('data-usb-network', networkName);
        fromSpan.setAttribute('data-usb-channel', channelName);

        const mappedSite = resolveSiteForContext(networkName, channelName);

        const isBridged = matcherMatches(initialUsername);
        let resolvedUsername = isBridged ? initialUsername : stripIrcPrefix(initialUsername);

        if (isBridged) {
            const contentSpan = messageElement.querySelector('.content');
            if (!contentSpan) return;

            const parsed = runFormatHandlers({
                text: contentSpan.textContent,
                html: contentSpan.innerHTML,
                from: initialUsername,
                chan: channelName
            });

            if (parsed) {
                const { username, modifyContent, prefixToRemove, metadata } = parsed;
                resolvedUsername = username;
                const usernameChanged = (username !== initialUsername);

                fromSpan.setAttribute('data-name', username);
                fromSpan.setAttribute('data-usb-bridged', metadata);

                if (CONFIG.USE_AUTOCOMPLETE) addUserToAutocomplete(username);

                if (usernameChanged) {
                    const colorClass = getUserColor(username);
                    if (colorClass) {
                        applyColorToMessage(fromSpan, colorClass);
                    } else {
                        setTimeout(() => {
                            const retryColor = getUserColor(username);
                            if (retryColor) applyColorToMessage(fromSpan, retryColor);
                        }, 200);
                    }
                }

                if (CONFIG.USE_DECORATORS) {
                    fromSpan.textContent = CONFIG.DECORATOR_L + username + CONFIG.DECORATOR_R;
                } else {
                    fromSpan.textContent = username;
                }

                if (modifyContent && prefixToRemove) {
                    removePrefixSurgically(contentSpan, prefixToRemove);
                }
            }
        }

        if (CONFIG.USE_AVATARS && mappedSite) {
            const fromDiv = messageElement.querySelector('.from');
            if (fromDiv && !fromDiv.querySelector('.usb-avatar')) {
                // Insert placeholder immediately to reserve space (prevents layout shift)
                const wrapper = document.createElement('span');
                wrapper.className = 'usb-avatar';
                const img = document.createElement('img');
                img.alt = '';
                img.loading = 'lazy';
                wrapper.appendChild(img);
                fromDiv.insertBefore(wrapper, fromDiv.firstChild);

                // Fill in the actual avatar URL async
                getAvatar(mappedSite, resolvedUsername).then(avatarUrl => {
                    if (avatarUrl) img.src = avatarUrl;
                });
            }
        }

        // --- UNIT3D metadata injection (group icon, sparkles, custom icon) ---
        if (mappedSite && (CONFIG.USE_GROUP_ICON || CONFIG.USE_SPARKLES || CONFIG.USE_CUSTOM_ICON || CONFIG.USE_GROUP_COLORS)) {
            if (!fromSpan.hasAttribute('data-usb-group')) {
                // Allow profile fetch for cache misses (rate-limited by PROFILE_MISS_LIMIT)
                getUserMeta(mappedSite, resolvedUsername, true).then(meta => {
                    if (!meta) return;
                    injectUserMeta(fromSpan, mappedSite, meta);

                    // Custom icon (async fetch + inject)
                    if (CONFIG.USE_CUSTOM_ICON && meta.hasCustomIcon) {
                        const siteConfig = getSiteConfig(mappedSite);
                        if (siteConfig.urlIcon && siteConfig.featCustomIcon) {
                            fetchCustomIcon(mappedSite, resolvedUsername).then(dataUrl => {
                                injectCustomIcon(fromSpan, dataUrl);
                            });
                        }
                    }
                });
            }
        }
    }

    // =====================================================================
    //  CONTEXT MENU HOOKS
    // =====================================================================

    let lastContextTarget = null;

    function initializeContextMenuHooks() {
        const captureTarget = (e) => {
            // Capture sidebar items for network/channel context menus
            const sidebarItem = e.target.closest('.channel-list-item, .network');
            // Capture user spans for user context menus
            const userSpan = e.target.closest('.from .user, .user');
            lastContextTarget = sidebarItem || userSpan || e.target;
        };
        document.addEventListener('click', captureTarget, true);
        document.addEventListener('contextmenu', captureTarget, true);

        const menuContainer = document.querySelector('#context-menu-container') || document.body;
        const menuObserver = new MutationObserver(() => {
            const menu = document.querySelector('#context-menu');
            if (!menu || menu.querySelector('.usb-context-item')) return;
            modifyContextMenu(menu);
        });
        menuObserver.observe(menuContainer, { childList: true, subtree: true });
    }

    function modifyContextMenu(menu) {
        // Detect menu type
        const isUserMenu = !!menu.querySelector('.context-menu-user');
        const isNetworkMenu = !!menu.querySelector('.context-menu-network');
        const isChannelMenu = !!menu.querySelector('.context-menu-chan');

        if (isUserMenu) modifyUserContextMenu(menu);
        if (isNetworkMenu) modifyNetworkContextMenu(menu);
        if (isChannelMenu) modifyChannelContextMenu(menu);
    }

    function closeContextMenu(menu) {
        const mc = document.querySelector('#context-menu-container');
        if (mc) mc.classList.remove('open');
        menu.remove();
    }

    function makeContextMenuItem(label, onClick) {
        const item = document.createElement('li');
        item.className = 'context-menu-item usb-context-item';
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick(e);
        });
        return item;
    }

    function makeContextDivider() {
        const divider = document.createElement('li');
        divider.className = 'context-menu-divider usb-context-item';
        divider.setAttribute('role', 'menuitem');
        return divider;
    }

    function modifyUserContextMenu(menu) {
        if (!lastContextTarget) return;

        const context = getActiveNetworkAndChannel();
        if (!context?.network) return;

        const mappedSite = resolveSiteForContext(context.network, context.channel);
        const isBridged = lastContextTarget.hasAttribute('data-usb-bridged');
        let displayUsername;

        if (isBridged && lastContextTarget.hasAttribute('data-name')) {
            displayUsername = lastContextTarget.getAttribute('data-name');
        } else {
            const firstItem = menu.querySelector('.context-menu-user');
            displayUsername = firstItem ? stripIrcPrefix(firstItem.textContent.trim()) : null;
        }

        if (!displayUsername) return;

        if (isBridged) {
            const firstItem = menu.querySelector('.context-menu-user');
            if (firstItem) firstItem.textContent = displayUsername;
        }

        if (!mappedSite) return;

        const siteConfig = getSiteConfig(mappedSite);

        menu.appendChild(makeContextDivider());

        // "Refresh user data"
        menu.appendChild(makeContextMenuItem('Refresh user data', () => {
            invalidateAvatar(mappedSite, displayUsername);
            customIconCache.delete(`${mappedSite}/${displayUsername}`);

            getAvatar(mappedSite, displayUsername).then(avatarUrl => {
                document.querySelectorAll('.from').forEach(fromDiv => {
                    const userSpan = fromDiv.querySelector('.user');
                    if (!userSpan) return;
                    const name = userSpan.getAttribute('data-name') || stripIrcPrefix(userSpan.textContent.replace(/[()]/g, '').trim());
                    if (name !== displayUsername) return;
                    const existing = fromDiv.querySelector('.usb-avatar');
                    if (existing) existing.querySelector('img').src = avatarUrl;
                    else injectAvatar(fromDiv, avatarUrl);
                });
            });

            // Bypass rate limit for manual refresh
            scrapeUserProfile(mappedSite, displayUsername, true).then(meta => {
                if (!meta) return;
                document.querySelectorAll('.from .user').forEach(userSpan => {
                    const name = userSpan.getAttribute('data-name') || stripIrcPrefix(userSpan.textContent.replace(/[()]/g, '').trim());
                    if (name !== displayUsername) return;
                    userSpan.querySelectorAll('.usb-group, .usb-icon').forEach(el => el.remove());
                    const fromDiv = userSpan.closest('.from');
                    if (fromDiv) fromDiv.querySelectorAll('.usb-group').forEach(el => el.remove());
                    userSpan.removeAttribute('data-usb-group');
                    userSpan.classList.remove('usb-sparkles', 'usb-unit3d-colors');
                    userSpan.style.removeProperty('background-image');
                    injectUserMeta(userSpan, mappedSite, meta);
                    if (CONFIG.USE_CUSTOM_ICON && meta.hasCustomIcon && siteConfig.urlIcon && siteConfig.featCustomIcon) {
                        fetchCustomIcon(mappedSite, displayUsername).then(dataUrl => {
                            injectCustomIcon(userSpan, dataUrl);
                        });
                    }
                });
                showToast(`Refreshed data for ${displayUsername}`);
            });

            closeContextMenu(menu);
        }));

        // "Tracker profile"
        if (siteConfig.featProfile && siteConfig.urlProfile) {
            menu.appendChild(makeContextMenuItem('Tracker profile', () => {
                const profileUrl = buildSiteUrl(mappedSite, siteConfig.urlProfile, displayUsername);
                if (profileUrl) window.open(profileUrl, '_blank');
                closeContextMenu(menu);
            }));
        }
    }

    /**
     * Refresh data for all sites mapped to channels under this network.
     */
    function modifyNetworkContextMenu(menu) {
        const networkEl = lastContextTarget?.closest?.('.network');
        const lobby = networkEl?.querySelector('.channel-list-item[data-type="lobby"]');
        const networkName = lobby?.getAttribute('data-name') || null;
        if (!networkName) return;

        const mappings = loadSiteMappings();
        const sites = new Set();
        for (const [key, value] of Object.entries(mappings)) {
            if (!value || value === '__none__') continue;
            if (key === networkName) sites.add(value);
            if (key.startsWith(networkName + '/')) sites.add(value);
        }

        if (sites.size === 0) return;

        menu.appendChild(makeContextDivider());

        // Additive re-scrape (keeps existing cache, adds new data)
        menu.appendChild(makeContextMenuItem('Refresh tracker data', () => {
            const promises = [];
            for (const site of sites) promises.push(scrapeSiteUsers(site));
            Promise.all(promises).then(counts => {
                const total = counts.reduce((a, b) => a + b, 0);
                showToast(`Refreshed ${total} users across ${sites.size} site(s)`);
                processExistingMessages();
            });
            closeContextMenu(menu);
        }));

        // Destructive: wipe cache then re-scrape
        menu.appendChild(makeContextMenuItem('Clear & refresh tracker data', () => {
            for (const site of sites) {
                for (const key of storeKeys(META_PREFIX + site + '/')) storeDelete(key);
            }
            const promises = [];
            for (const site of sites) promises.push(scrapeSiteUsers(site));
            Promise.all(promises).then(counts => {
                const total = counts.reduce((a, b) => a + b, 0);
                showToast(`Cleared & refreshed ${total} users across ${sites.size} site(s)`);
                processExistingMessages();
            });
            closeContextMenu(menu);
        }));
    }

    /**
     * Refresh data for the site mapped to this specific channel.
     */
    function modifyChannelContextMenu(menu) {
        const channelItem = menu.querySelector('.context-menu-chan');
        if (!channelItem) return;
        const channelName = channelItem.textContent.trim();
        if (!channelName) return;

        const networkEl = lastContextTarget?.closest?.('.network');
        const lobby = networkEl?.querySelector('.channel-list-item[data-type="lobby"]');
        const networkName = lobby?.getAttribute('data-name') || null;
        if (!networkName) return;

        const mappedSite = resolveSiteForContext(networkName, channelName);
        if (!mappedSite) return;

        menu.appendChild(makeContextDivider());

        // Additive re-scrape
        menu.appendChild(makeContextMenuItem(`Refresh tracker data (${mappedSite})`, () => {
            scrapeSiteUsers(mappedSite).then(count => {
                showToast(`Refreshed ${count} users from ${mappedSite}`);
                processExistingMessages();
            });
            closeContextMenu(menu);
        }));

        // Destructive: wipe cache then re-scrape
        menu.appendChild(makeContextMenuItem(`Clear & refresh (${mappedSite})`, () => {
            for (const key of storeKeys(META_PREFIX + mappedSite + '/')) storeDelete(key);
            scrapeSiteUsers(mappedSite).then(count => {
                showToast(`Cleared & refreshed ${count} users from ${mappedSite}`);
                processExistingMessages();
            });
            closeContextMenu(menu);
        }));
    }

    // =====================================================================
    //  OBSERVER & INITIALIZATION
    // =====================================================================

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && node.classList.contains('msg')) {
                    processMessage(node);
                }
            });
        });
    });

    function initializeObserver() {
        const chatContainer = document.querySelector('#chat');
        if (chatContainer) {
            observer.observe(chatContainer, { childList: true, subtree: true });
            processExistingMessages();
        } else {
            setTimeout(initializeObserver, 1000);
        }
    }

    function tryInjectFooterButton() {
        if (document.querySelector('#footer')) {
            injectFooterButton();
        }
        const footerObserver = new MutationObserver(() => injectFooterButton());
        const app = document.querySelector('#app') || document.body;
        footerObserver.observe(app, { childList: true, subtree: true });
    }

    async function initializeRouterMonitor() {
        const router = Array.from(document.querySelectorAll('*'))
            .find(e => e.__vue_app__)
            ?.__vue_app__?.config?.globalProperties?.$router;

        if (router == null) {
            return setTimeout(initializeRouterMonitor, 1000);
        }
        await router.isReady();

        router.afterEach((newRoute, oldRoute) => {
            if (oldRoute.name === 'RoutedChat' || newRoute.name !== 'RoutedChat') return;
            initializeObserver();
        });
    }

    // =====================================================================
    //  ENTRYPOINT
    // =====================================================================

    async function main() {
        const isLounge = await waitForTheLounge();
        if (!isLounge) return;

        // Open IndexedDB early (avatar cache lives here)
        openIdb().catch(() => {});

        injectDefaultStyles();
        initializeRouterMonitor();
        tryInjectFooterButton();
        initializeContextMenuHooks();

        // Load FA font and metadata in parallel, wait for both before processing messages
        await Promise.all([
            ensureFontAwesome(),
            initializeMetadataScraping(),
        ]);

        // Now process messages (font + metadata cache are warm)
        initializeObserver();
    }

    main();

})();