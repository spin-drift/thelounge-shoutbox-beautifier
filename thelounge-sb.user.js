// ==UserScript==
// @name         Ultimate Shoutbox Beautifier for TheLounge
// @namespace    http://tampermonkey.net/
// @version      3.0-dev0.3
// @description  Reformats chatbot relay messages to appear as direct user messages
// @author       spindrift
// @match        *://your-thelounge-domain.com/*
//
// @connect      aither.cc
//
// @icon         https://thelounge.chat/favicon.ico
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

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
            featGroupIcon: true,
            featGroupName: true,
            featCustomIcon: true,
            featProfile: true,
            featOnlineWidget: true,
        },
        'hawke.uno': {
            urlAvatar: '/files/img/{user}.png',
            urlIcon: false,
            urlProfile: false,     // HUNO profiles use unpredictable IDs
            featGroupIcon: false,   // No online users widget to scrape
            featGroupName: false,
            featCustomIcon: false,
            featProfile: false,
            featOnlineWidget: false,
        },
    };

    function getSiteConfig(site) {
        return SITE_CONFIG[site] || SITE_CONFIG['default'];
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
        catch { /* quota exceeded, silently fail */ }
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

    const AVATAR_PREFIX = 'av_';
    const AVATAR_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
    const AVATAR_MAX_ENTRIES = 5000;
    const AVATAR_THUMB_SIZE = 48;

    // Default avatar (UNIT3D profile.png) used when a user has no avatar set
    const DEFAULT_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAMAAABHPGVmAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAC+lBMVEVCQkJBQUE+P0A4Ojw1ODs0Njk7PD5BQkJDQ0MyNDgrLC45OTlKSUdYVE5cVk9GRkUrLjM7PD17c2eckYG3qpjKuqPXw63p1rrp1LbgyqjkyaLWwaLDro6yoISUh3NxaF0vNDg+Pj7ArZHe07n/6sz/+93//+L//d//9tn/7bv/6rn/8r//+MPx1qvZxZ5qY1lEREM2NjY/Pz/OwKv+7c7/9Nj/8dP/7dH/7tP/687/4bf/37D/4LL/4rT/77312q7Gs5M8Oz0vMDFTUE68tJ7/89X/+Nn/4bP/5ralmIQxMjTn2r/ey6JdWVJAQECNgnT/3rLq062Hemr/7ND/37H+3rB1bmL158rpzKLazbPTu5c/QED/7dKXhG+cjnk8PDz24sb/8NVNTEj/5LrFpILu3cP50KP+zp3et4/658z71qj2ypz0xZb7y5vwxJj3zJ71xpr1xpf1x5n4yZr2yJr93LL0xpj0xJaijHT+37H61Kf/0qG2mn3/1qPJp4T92qz/1aLh0bf+3K750qX2x5r/4bH82Kr4zqD/79T95cj2yJ70wpX2yZ/gzrH/9Mn/8sb/6MX/5b3/573/5Lz/5r7/6cn/58H/+Mz/5b7/0J+ulXr/6sH/6L/7zJz94rn/7cL/8tfjuI//6MD94Ln1yJzQror93bT2xpjex6bPrIj+zZz+1KF+eHH23LP/5LH9y5rxx5w9PT1jY2OTk5PHwrv937L4x5eIjJBWVlZaWlqcnJy8vLzDxsrOyMD43bPwxpzQx7y5ubmNjY2Wlpe/v7/ExMTCwsK5u77/47HEvbaJiYm+vr69vb2+vr3u17X6yJboxaK7vb7Hx8e7u7vLy8u2ub7+3bDjxKW4vMDAwMDMzMy6urrdzrj4x5i2trZsbGyrq6vQ0NDU1NS6vL7W1tbZ2dnT09Onp6fe3t7R0dHOzs7MxbrIv7fi4uLS0tLJycnewqi5uruAgIDUybm8vLuioqJ9fX394LKysrL73rN4eHjl5eWkpKT////gB6GOAAAAAWJLR0T9SwmT6QAAAAd0SU1FB+IKFQAuCcj0Hq0AAAd8SURBVGje7dh7XFPnGQfwhEAGJDSR1krtOoITEKwtiZRgTdyMrdFsthWEXqSmkk47o0IOqVqdU4uBXpGQ1KKIVm21N2kTqAXS1gK5jZzWEmAl2AkhEBIYYXZd3dj+2AkhcHI9x5PkP3/5Fz6fz3Oe57zveV8c7nZuByn4KEJ0jPNHIP4iIkAsMS4+nkROuAP6JVCI8dSYqLDXMI9KTrzzrvl3L1iQdM/Chff+8r5fJeNoRHwYiRQSMXnRrxenpqWlL0ldkpGZmbH0/sxlD9z3IJEQpnKy8HRG4vLs1PSHcphQclc8vJIFhZ25KuM3v01eHROWXkRx1jzy6NpHc5muuBEo3HWZ7PVkXhhmIIqX/Lt0t+CJOOtZ+vsN1MdC7njM49mpK5iBENYTqzbmReNDNnLW5jMDI6xNqwoKo0NrSNyGJ1OZzGAIi5Xx1AZabAgGnfJ0eg4Swl36TBQhCzOymbM+rYiJhEDKszzsbYEe1kNMZGRT5rI1mF+XKML6tHwUCNT8LYTNGBH+mue2MtEgrHULi4lYkbytuegQ7rrC1Vh3j/k+HfGPcAUrn0/BtrpsJv9hCRqEyy7Ytv2FLGyLCyHxjygq4XI37RDu3LX7QWyLfsydOVsRETZ3R0mpCCgT52FbW3iL1uYgIGz2i9v27AUAoGz7PozI/HRmcIT90v5SJwHlwJ9omBDq8rRgCJfN2iHcK3IZwME/Y0LwvKAIm32oZM9MGVAOP48JmVd8JDUgwma/XH5UJAIiibA3lR+dqyIiiIRbMdeMSCEVlaU7ASCSyCuLy0XeZYQd2frqa68DQMSRN3beRnxDLH5zbW5RxJF7qrKLciOOHBNUL/YuJvyIVFBTnV9UFGFEKpDJ38qGM2FvPIRIpTWy44thrQkvErX63irpdGTSV1fMtia8SBb1mbelUjdTnZ8bFMG4M+Joi6rkbqVGUPsWsygwIj6BcY+PO1l3SjobQc3x6bfGP1JW/yy2rxVC4ek6KSwyWfWKolz/yK7dyfOwfaYWbzwj9Yigtjr/Hb/I9rMUbMcgPGFRndxTkQnk2X6R+n1Yr3RWF3ojEHPu/Lu++2JZWTLW8wmR8sAZmbdy6sVSX6T+PQpWBDrEV3kb0nMXfJGLB/MImE+mBMr7VTJkZM/hDygE7Ad5WuKxOmTkw8pkKvbbgixi3F1vy5GQsoMnaaFce8XGJGysQkI+eqGYEMK1B1RLTGKN54T5IPW7k0O7wHGuYFvOnJIFQYQn8kK/vIuibqk7FxgpO5EXHfo9ZCyRevLY8UCI+KN9tHmxuNAV2oZlZ2rl/hBR6YGzd9CycGFA4hKeynh4VoEhInH94bMJ0WEwcCTOx5caCi6clsu9EWGJ+JNPC6n8UAUGX6FsbDotYa184rPztbVyuXwWEQqFgOhy5fzPm/mKUO5TFXRGS6vqiy+/kkDH3YKCikPnZYJTF44eFYvFJSWAuBQALl/5+ou29mYFKQVjLxh0hbJDrdHqmi7pXXdnFZXCbfvLS0pKdondE3zlL2qtpq2zmU/H3/qQxeJ4JGWHVmMAQd033+pnbiBY+8Wv7wVgM3z1O7ALBNXG7s4WOumWtxI+Xdmh6VGDULp6FzTMXnT8tRyAn62vft/n/BOVqf9aezOJfyubioKfouxQ9ZtU4HR6f5BI5q5sDlUCF92lXP7b8j7X34CanuudLSl8BsoHxac/NjBoHjJ2d8/8v6rpMwnsCo1VIbw48y1x9UqTBXRHY2xrhHrDQNPueIZycHhk2Go2GrpdpXTpkvQeN3Ws/cK9e6Yr+b4PnIthegRISCPgbPfAqG3E7ox1TAu6itGNw0pxRvDSAVdr/t4FesRgvNaOMAJ4EkSMTFjtrlgdPVqVuyue945s9svbRKVX7+4DvaN1jgBdEXAE+HzlqHVi2Gx3x2E1T6qdz8yiSmrwZriHPvyHpQv0DTQC7dAq4L8MOqXDbhu2e8ThMGtAiLnxTVKD3ktpeBPUgf5i0GjafmSQ/D6qNddtww67dxzWfg00Z5auI3oPRa//wWIBA8Rgmmwl+1EU5Dab2e4vVsekqRtU9f7zUgPMuDTe+xMYOKqef1F81zN+q80eKFa70fAT2Nt0RMKe7gy3gXVE3QcGj/Fnnz0gpXlyJCACPbMxDWjp1Y0n3dRL9JKbSeM3dAgGqPk32XsHoHeODNmDxOHoMalu6Lq+Trr5n6Rxi86CZIAm05R3V3iDNnvwOBzQOHfrLOPjupmVAOl5NdK9OtKsRkKg1piN0BKg04HoMjmK91zH6Mr+YTuyAq00KhVKA2pKi+fz4vwYvCVz49yvRauYDAOezyu+fcKBBrE7hsbUKBW1Zorn8bpzWv9rRxfHmAltKfZODnzRVzBGJ8KP9DeS4G8Kv/i6LfzIZCsOvhbTm00j4UeMo2T4ykJvMUYCGWyGzzBnYHg4/Ij2egt8hnkDtqEIIAYlHOFMoZ3gW0HUkx5vI+fnSCCgeYoDOyCQGm2RQMam6HNfLSn8xolIIJOdirl1mJ81arOizJBZa1CjTE9nCgwht2qvoYyqbfR/aDPY6fqY+D/BIp/IcAkLLAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAxOC0xMC0yMVQwMDo0NjowOSswMDowMPRWBckAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMTgtMTAtMjFUMDA6NDY6MDkrMDA6MDCFC711AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAABJRU5ErkJggg==';

    const avatarUrlCache = new Map();
    const avatarInflight = new Map();

    function thumbnailize(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = AVATAR_THUMB_SIZE;
                    canvas.height = AVATAR_THUMB_SIZE;
                    const ctx = canvas.getContext('2d');
                    const srcSize = Math.min(img.width, img.height);
                    const sx = (img.width - srcSize) / 2;
                    const sy = (img.height - srcSize) / 2;
                    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, AVATAR_THUMB_SIZE, AVATAR_THUMB_SIZE);
                    let dataUrl = canvas.toDataURL('image/webp', 0.75);
                    if (!dataUrl.startsWith('data:image/webp')) {
                        dataUrl = canvas.toDataURL('image/jpeg', 0.75);
                    }
                    resolve(dataUrl);
                };
                img.onerror = () => reject(new Error('Thumbnail failed'));
                img.src = reader.result;
            };
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
        });
    }

    function readAvatarCache(cacheKey) {
        const entry = storeGet(AVATAR_PREFIX + cacheKey);
        if (!entry || !entry.fetchedAt) return null;
        if ((Date.now() - entry.fetchedAt) > AVATAR_TTL) {
            storeDelete(AVATAR_PREFIX + cacheKey);
            return null;
        }
        return entry;
    }

    function writeAvatarCache(cacheKey, dataUrl) {
        storeSet(AVATAR_PREFIX + cacheKey, { data: dataUrl, fetchedAt: Date.now() });
        evictAvatarCacheIfNeeded();
    }

    function writeAvatarCacheMiss(cacheKey) {
        storeSet(AVATAR_PREFIX + cacheKey, { data: null, fetchedAt: Date.now() });
    }

    function evictAvatarCacheIfNeeded() {
        const allKeys = storeKeys(AVATAR_PREFIX);
        if (allKeys.length <= AVATAR_MAX_ENTRIES) return;
        const entries = allKeys.map(key => {
            const entry = storeGet(key);
            return { key, fetchedAt: entry?.fetchedAt || 0 };
        });
        entries.sort((a, b) => a.fetchedAt - b.fetchedAt);
        const toDelete = entries.length - AVATAR_MAX_ENTRIES;
        for (let i = 0; i < toDelete; i++) storeDelete(entries[i].key);
    }

    function invalidateAvatar(site, username) {
        const cacheKey = `${site}/${username}`;
        storeDelete(AVATAR_PREFIX + cacheKey);
        avatarUrlCache.delete(cacheKey);
        avatarInflight.delete(cacheKey);
    }

    function clearAvatarCache() {
        for (const key of storeKeys(AVATAR_PREFIX)) storeDelete(key);
        avatarUrlCache.clear();
        avatarInflight.clear();
    }

    function getAvatar(site, username) {
        if (!HAS_GM_XHR) return Promise.resolve(DEFAULT_AVATAR);

        const cacheKey = `${site}/${username}`;

        if (avatarUrlCache.has(cacheKey)) return Promise.resolve(avatarUrlCache.get(cacheKey));

        const cached = readAvatarCache(cacheKey);
        if (cached) {
            const url = cached.data || DEFAULT_AVATAR;
            avatarUrlCache.set(cacheKey, url);
            return Promise.resolve(url);
        }

        if (avatarInflight.has(cacheKey)) return avatarInflight.get(cacheKey);

        const fetchPromise = new Promise((resolve) => {
            const url = buildSiteUrl(site, getSiteConfig(site).urlAvatar, username);
            if (!url) { resolve(DEFAULT_AVATAR); return; }

            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                onload(response) {
                    avatarInflight.delete(cacheKey);
                    if (response.status >= 200 && response.status < 300 && response.response.size > 0) {
                        thumbnailize(response.response).then(dataUrl => {
                            writeAvatarCache(cacheKey, dataUrl);
                            avatarUrlCache.set(cacheKey, dataUrl);
                            resolve(dataUrl);
                        }).catch(() => {
                            writeAvatarCacheMiss(cacheKey);
                            avatarUrlCache.set(cacheKey, DEFAULT_AVATAR);
                            resolve(DEFAULT_AVATAR);
                        });
                    } else {
                        writeAvatarCacheMiss(cacheKey);
                        avatarUrlCache.set(cacheKey, DEFAULT_AVATAR);
                        resolve(DEFAULT_AVATAR);
                    }
                },
                onerror() {
                    avatarInflight.delete(cacheKey);
                    writeAvatarCacheMiss(cacheKey);
                    avatarUrlCache.set(cacheKey, DEFAULT_AVATAR);
                    resolve(DEFAULT_AVATAR);
                },
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
                ensureFontAwesome();
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
        if (CONFIG.USE_SPARKLES && meta.isSparkly && site) {
            fromSpan.classList.add('usb-sparkles');
            fromSpan.style.backgroundImage = `url(https://${site}/img/sparkels.gif)`;
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
    // TheLounge bundles FA Solid font but not the full CSS.
    // We inject the FA 6 Free CDN stylesheet to get all icon classes
    // working, including brands. This is manager-agnostic (no @require).

    let faLoaded = false;

    function ensureFontAwesome() {
        if (faLoaded) return;
        faLoaded = true;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
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
     * Parse the online users widget from a full page HTML string.
     * Returns a Map of username → { rank, rankColor, iconClasses, hasCustomIcon, isSparkly }
     */
    function parseOnlineUsersWidget(html) {
        const users = new Map();

        // Check widget exists (case-insensitive)
        if (!/users\s+online/i.test(html)) return users;

        // Parse user-tag__link anchors
        const userPattern = /<a\s+class="user-tag__link(?:\s+user-tag__link--anonymous)?\s+(fa[^"]*?)"\s+href="https?:\/\/[^/]+\/users\/([^"]+)"\s+style="color:\s*([^"]*?)"\s+title="([^"]*?)"/g;
        let match;
        while ((match = userPattern.exec(html)) !== null) {
            const [, iconClasses, username, color, rank] = match;
            if (!users.has(username)) {
                users.set(username, {
                    rank,
                    rankColor: color.trim(),
                    iconClasses: iconClasses.trim(),
                    hasCustomIcon: false,
                    isSparkly: false,
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

        // Cross-reference sparkly (donor) backgrounds
        // The sparkle background is on the parent span, so we look for it before the <a>
        const sparklePattern = /background-image:\s*url\(\/img\/sparkels\.gif\);[^<]*?(?:<[^a]*?)*?<a[^>]*?\/users\/([^"]+)"/g;
        let sparkleMatch;
        while ((sparkleMatch = sparklePattern.exec(html)) !== null) {
            const data = users.get(sparkleMatch[1]);
            if (data) data.isSparkly = true;
        }

        return users;
    }

    /**
     * Scrape online users from a tracker site and cache the results.
     */
    function scrapeOnlineUsers(site) {
        if (!HAS_GM_XHR) return Promise.resolve(0);

        const config = getSiteConfig(site);
        if (!config.featOnlineWidget) return Promise.resolve(0);

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
                    const users = parseOnlineUsersWidget(response.responseText);
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
    function scrapeUserProfile(site, username) {
        if (!HAS_GM_XHR) return Promise.resolve(null);

        const config = getSiteConfig(site);
        if (!config.featProfile || !config.urlProfile) return Promise.resolve(null);

        // Rate-limit consecutive profile fetches
        if (profileMissCount >= PROFILE_MISS_LIMIT) {
            console.warn(`[USB] Profile fetch limit reached (${PROFILE_MISS_LIMIT}), skipping ${username}`);
            return Promise.resolve(null);
        }
        profileMissCount++;

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

                    const data = {
                        rank: match[3],
                        rankColor: match[2].trim(),
                        iconClasses: match[1].trim(),
                        hasCustomIcon: /authenticated-images\/user-icons\//i.test(html),
                        isSparkly: /background-image:\s*url\(\/img\/sparkels\.gif\)/i.test(html),
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
     * Returns { rank, rankColor, iconClasses, hasCustomIcon, isSparkly } or null.
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
        // Initial scrape
        scrapeOnlineUsers(site);
        // Repeat every SCRAPE_INTERVAL
        const timer = setInterval(() => scrapeOnlineUsers(site), SCRAPE_INTERVAL);
        scrapeTimers.set(site, timer);
    }

    /**
     * Start scraping for all mapped sites.
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
            const config = getSiteConfig(site);
            if (config.featOnlineWidget) {
                initialScrapes.push(scrapeOnlineUsers(site));
            }
        }
        await Promise.all(initialScrapes);

        // Then start periodic scraping
        for (const site of sites) {
            const config = getSiteConfig(site);
            if (config.featOnlineWidget && !scrapeTimers.has(site)) {
                const timer = setInterval(() => scrapeOnlineUsers(site), SCRAPE_INTERVAL);
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
            }
            .usb-avatar img {
                width: 20px;
                height: 20px;
                border-radius: 50%;
                object-fit: cover;
                vertical-align: middle;
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
                width: 16px;
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
                getAvatar(mappedSite, resolvedUsername).then(avatarUrl => {
                    injectAvatar(fromDiv, avatarUrl);
                });
            }
        }

        // --- UNIT3D metadata injection (group icon, sparkles, custom icon) ---
        if (mappedSite && (CONFIG.USE_GROUP_ICON || CONFIG.USE_SPARKLES || CONFIG.USE_CUSTOM_ICON || CONFIG.USE_GROUP_COLORS)) {
            if (!fromSpan.hasAttribute('data-usb-group')) {
                // Don't trigger profile fetches from message processing — rely on periodic scrape.
                // Profile fetches are only triggered by explicit "Refresh user data" context menu.
                getUserMeta(mappedSite, resolvedUsername, false).then(meta => {
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
            const userSpan = e.target.closest('.from .user, .user');
            lastContextTarget = userSpan || null;
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

        // Only add USB context items if a site is mapped
        if (!mappedSite) return;

        const siteConfig = getSiteConfig(mappedSite);

        const divider = document.createElement('li');
        divider.className = 'context-menu-divider usb-context-item';
        divider.setAttribute('role', 'menuitem');
        menu.appendChild(divider);

        // "Refresh user data" — invalidates avatar + metadata, re-fetches from profile
        const refreshItem = document.createElement('li');
        refreshItem.className = 'context-menu-item usb-context-item';
        refreshItem.setAttribute('role', 'menuitem');
        refreshItem.textContent = 'Refresh user data';
        refreshItem.addEventListener('click', (e) => {
            e.stopPropagation();

            // Invalidate avatar cache
            invalidateAvatar(mappedSite, displayUsername);

            // Invalidate metadata cache
            storeDelete(META_PREFIX + mappedSite + '/' + displayUsername);

            // Invalidate custom icon cache
            customIconCache.delete(`${mappedSite}/${displayUsername}`);

            // Re-fetch avatar
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

            // Re-fetch metadata from profile page
            scrapeUserProfile(mappedSite, displayUsername).then(meta => {
                if (!meta) return;
                document.querySelectorAll('.from .user').forEach(userSpan => {
                    const name = userSpan.getAttribute('data-name') || stripIrcPrefix(userSpan.textContent.replace(/[()]/g, '').trim());
                    if (name !== displayUsername) return;
                    // Clear existing injected elements
                    userSpan.querySelectorAll('.usb-group, .usb-icon').forEach(el => el.remove());
                    userSpan.removeAttribute('data-usb-group');
                    userSpan.classList.remove('usb-sparkles', 'usb-unit3d-colors');
                    userSpan.style.removeProperty('background-image');
                    // Re-inject
                    injectUserMeta(userSpan, mappedSite, meta);
                    if (CONFIG.USE_CUSTOM_ICON && meta.hasCustomIcon && siteConfig.urlIcon && siteConfig.featCustomIcon) {
                        fetchCustomIcon(mappedSite, displayUsername).then(dataUrl => {
                            injectCustomIcon(userSpan, dataUrl);
                        });
                    }
                });
                showToast(`Refreshed data for ${displayUsername}`);
            });

            const mc = document.querySelector('#context-menu-container');
            if (mc) mc.classList.remove('open');
            menu.remove();
        });
        menu.appendChild(refreshItem);

        // "Tracker profile" — link to user's profile on the tracker
        if (siteConfig.featProfile && siteConfig.urlProfile) {
            const profileItem = document.createElement('li');
            profileItem.className = 'context-menu-item usb-context-item';
            profileItem.setAttribute('role', 'menuitem');
            profileItem.textContent = 'Tracker profile';
            profileItem.addEventListener('click', (e) => {
                e.stopPropagation();
                const profileUrl = buildSiteUrl(mappedSite, siteConfig.urlProfile, displayUsername);
                if (profileUrl) window.open(profileUrl, '_blank');
                const mc = document.querySelector('#context-menu-container');
                if (mc) mc.classList.remove('open');
                menu.remove();
            });
            menu.appendChild(profileItem);
        }
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

        injectDefaultStyles();
        initializeRouterMonitor();
        tryInjectFooterButton();
        initializeContextMenuHooks();

        // Start metadata scraping first, wait for initial scrape to populate cache
        await initializeMetadataScraping();

        // Now process messages (metadata cache is warm)
        initializeObserver();
    }

    main();

})();