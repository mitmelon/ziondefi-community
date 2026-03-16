/**
 * ZionDefi — Wallet Connector
 * Zero external dependencies. Works with any injected Starknet wallet.
 *
 */

(function () {

    var CHAIN_ID          = 'SN_SEPOLIA';
    var API_ENDPOINT      = '/login/wallet';
    var STARKNET_VERSION  = 'v5';

    var KNOWN_WALLETS = [
        {
            id:          'argentX',
            windowKey:   'starknet_argentX',
            name:        'Argent X',
            description: 'Browser extension',
            icon:        '/public/home/ui/images/wallets/argentx.webp',
            installUrl:  'https://chrome.google.com/webstore/detail/argent-x/dlcobpjiigpikoobohmabehhmhfoodbb',
            mobileDeepLink: function (url) {
                return 'https://argent.link/browse?url=' + encodeURIComponent(url.replace(/^https?:\/\//, ''));
            }
        },
        {
            id:          'braavos',
            windowKey:   'starknet_braavos',
            name:        'Braavos',
            description: 'Browser extension',
            icon:        '/public/home/ui/images/wallets/braavos.webp',
            installUrl:  'https://chrome.google.com/webstore/detail/braavos-smart-wallet/jnlgamecbpmbajjfhmmmlhejkemejdma',
            mobileDeepLink: function (url) {
                return 'braavos://dapp/' + url.replace(/^https?:\/\//, '');
            }
        },
        {
            id:          'argentMobile',
            windowKey:   null,
            name:        'Argent Mobile',
            description: 'iOS & Android',
            icon:        '/public/home/ui/images/wallets/argentx.webp',
            installUrl:  null,
            mobileOnly:  true,
            mobileDeepLink: function (url) {
                return 'https://argent.link/browse?url=' + encodeURIComponent(url.replace(/^https?:\/\//, ''));
            }
        }
    ];

    function isMobile() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }

    function isFileProtocol() {
        return window.location.protocol === 'file:';
    }

    function pollWindow(key, maxTries, waitMs) {
        return new Promise(function (resolve) {
            var tries = 0;
            function check() {
                if (window[key] !== undefined && window[key] !== null) {
                    return resolve(window[key]);
                }
                tries++;
                if (tries >= maxTries) return resolve(null);
                setTimeout(check, waitMs);
            }
            check();
        });
    }

    function qs(id) { return document.getElementById(id); }

    function addSectionLabel(container, text) {
        var p = document.createElement('p');
        p.className = 'section-label';
        p.textContent = text;
        container.appendChild(p);
    }

    function iconWrapHTML(iconSrc, name) {
        var fallback = '<i class="ph-bold ph-wallet wallet-icon-fallback"></i>';
        if (!iconSrc) {
            return '<div class="wallet-icon-wrap">' + fallback + '</div>';
        }
        return '<div class="wallet-icon-wrap">'
            + '<img src="' + iconSrc + '">'
            + '</div>';
    }

    function openDrawer() {
        var backdrop = qs('wallet-backdrop');
        var drawer   = qs('wallet-drawer');
        if (!backdrop || !drawer) return;

        backdrop.classList.add('visible');
        document.body.style.overflow = 'hidden';

        if (isMobile()) {
            drawer.classList.remove('open-desktop');
            drawer.classList.add('open-mobile');
        } else {
            drawer.classList.remove('open-mobile');
            drawer.classList.add('open-desktop');
        }

        populateWallets();
    }

    function closeDrawer() {
        var backdrop = qs('wallet-backdrop');
        var drawer   = qs('wallet-drawer');
        if (!backdrop || !drawer) return;

        backdrop.classList.remove('visible');
        drawer.classList.remove('open-mobile', 'open-desktop');
        document.body.style.overflow = '';
    }
    
    async function populateWallets() {
        var list     = qs('wallet-list');
        var subtitle = qs('drawer-subtitle');
        if (!list) return;

        list.innerHTML = '<div class="loading-state">'
            + '<span class="spinner spinner-md"></span>'
            + '<span>Scanning for wallets…</span>'
            + '</div>';

        // file:// warning
        if (isFileProtocol()) {
            list.innerHTML = '';
            var warn = document.createElement('div');
            warn.className = 'warn-banner';
            warn.innerHTML = '<i class="ph-bold ph-warning"></i>'
                + '<span><strong>Heads up:</strong> Wallet extensions cannot inject into '
                + '<code>file://</code> pages. Serve over HTTP for detection to work.<br>'
                + 'Run: <code>npx serve .</code> or <code>python3 -m http.server 3000</code></span>';
            list.appendChild(warn);
            renderNotInstalled(list);
            return;
        }

        if (isMobile()) {
            if (subtitle) subtitle.textContent = 'Open your mobile wallet to connect';
            list.innerHTML = '';
            renderMobile(list);
            return;
        }

        // Poll each known wallet key — 6 attempts × 250 ms = 1.5 s max
        var installed = [];

        var polls = KNOWN_WALLETS
            .filter(function (w) { return w.windowKey && !w.mobileOnly; })
            .map(function (w) {
                return pollWindow(w.windowKey, 6, 250).then(function (obj) {
                    if (obj) installed.push(Object.assign({}, w, { walletObj: obj }));
                });
            });

        await Promise.all(polls);

        // Also check window.starknet generic fallback
        if (window.starknet) {
            var alreadyCaptured = installed.some(function (w) {
                return w.walletObj === window.starknet;
            });
            if (!alreadyCaptured) {
                var genericId  = (window.starknet.id || '').toLowerCase();
                var matchKnown = KNOWN_WALLETS.find(function (w) {
                    return w.id.toLowerCase() === genericId;
                });
                installed.push(Object.assign(
                    {},
                    matchKnown || {
                        id:          genericId || 'starknet',
                        name:        window.starknet.name || 'Starknet Wallet',
                        description: 'Detected via window.starknet',
                        icon:        window.starknet.icon || ''
                    },
                    { walletObj: window.starknet }
                ));
            }
        }

        list.innerHTML = '';

        if (subtitle) {
            subtitle.textContent = installed.length
                ? installed.length + ' wallet' + (installed.length > 1 ? 's' : '') + ' detected'
                : 'No wallets installed';
        }

        if (installed.length > 0) {
            addSectionLabel(list, 'Installed');
            installed.forEach(function (w, i) {
                list.appendChild(buildInstalledRow(w, i));
            });
        }

        var installedIds = new Set(installed.map(function (w) { return w.id; }));
        var notInstalled = KNOWN_WALLETS.filter(function (w) {
            return !w.mobileOnly && !installedIds.has(w.id);
        });

        if (notInstalled.length > 0) {
            addSectionLabel(list, installed.length > 0 ? 'Get a Wallet' : 'Available Wallets');
            notInstalled.forEach(function (w, i) {
                list.appendChild(buildInstallRow(w, installed.length + i));
            });
        }

        if (installed.length === 0 && notInstalled.length === 0) {
            list.innerHTML = '<div class="state-box">'
                + '<i class="ph-bold ph-wallet" style="font-size:24px;color:#d1d5db;"></i>'
                + '<p class="state-box-title">No wallets found</p>'
                + '<p class="state-box-sub">Install ArgentX or Braavos to get started.</p>'
                + '<div class="state-box-links">'
                + '<a href="https://www.argent.xyz/argent-x/" target="_blank" rel="noopener" class="state-box-link">Get Argent X</a>'
                + '<a href="https://braavos.app/" target="_blank" rel="noopener" class="state-box-link">Get Braavos</a>'
                + '</div></div>';
        }
    }

    function renderNotInstalled(list) {
        var wallets = KNOWN_WALLETS.filter(function (w) { return !w.mobileOnly; });
        addSectionLabel(list, 'Available Wallets');
        wallets.forEach(function (w, i) { list.appendChild(buildInstallRow(w, i)); });
    }

    /* ─────────────────────────────────────────────
       ROW BUILDERS
    ───────────────────────────────────────────── */
    function buildInstalledRow(wallet, index) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wallet-row row-in';
        btn.style.animationDelay = (index * 0.07) + 's';
        btn.innerHTML = '<div class="wallet-row-left">'
            + iconWrapHTML(wallet.icon, wallet.name)
            + '<div>'
            + '<span class="wallet-name">' + wallet.name + '</span>'
            + '<span class="wallet-desc">' + wallet.description + '</span>'
            + '</div></div>'
            + '<span class="badge-ready">Ready</span>';
        btn.addEventListener('click', function () { connectAndSign(wallet, btn); });
        return btn;
    }

    function buildInstallRow(wallet, index) {
        var a = document.createElement('a');
        a.href   = wallet.installUrl || '#';
        a.target = '_blank';
        a.rel    = 'noopener noreferrer';
        a.className = 'wallet-row not-installed row-in';
        a.style.animationDelay = (index * 0.07) + 's';
        a.innerHTML = '<div class="wallet-row-left">'
            + iconWrapHTML(wallet.icon, wallet.name)
            + '<div>'
            + '<span class="wallet-name">' + wallet.name + '</span>'
            + '<span class="wallet-desc">Not installed · Click to install</span>'
            + '</div></div>'
            + '<i class="ph-bold ph-arrow-square-out row-arrow"></i>';
        return a;
    }

    function buildMobileRow(wallet, index) {
        var a = document.createElement('a');
        a.href  = wallet.mobileDeepLink(window.location.href);
        a.className = 'wallet-row row-in';
        a.style.animationDelay = (index * 0.07) + 's';
        a.innerHTML = '<div class="wallet-row-left">'
            + iconWrapHTML(wallet.icon, wallet.name)
            + '<div>'
            + '<span class="wallet-name">' + wallet.name + '</span>'
            + '<span class="wallet-desc">' + (wallet.description || 'Tap to open') + '</span>'
            + '</div></div>'
            + '<i class="ph-bold ph-arrow-square-out row-arrow"></i>';
        return a;
    }

    function renderMobile(list) {
        addSectionLabel(list, 'Mobile Wallets');
        KNOWN_WALLETS.forEach(function (w, i) { list.appendChild(buildMobileRow(w, i)); });
    }

    /* ─────────────────────────────────────────────
       CONNECT + SIGN
       Mirrors the reference implementation exactly:
       1. walletObj.enable()
       2. check isConnected
       3. walletObj.account.signMessage(typedData)
    ───────────────────────────────────────────── */
    async function connectAndSign(wallet, btn) {
        var originalHTML = btn.innerHTML;

        btn.classList.add('disabled');
        btn.innerHTML = '<div class="row-connecting">'
            + '<span class="spinner spinner-sm"></span>'
            + '<span>Connecting…</span>'
            + '</div>';

        try {
            var walletObj = wallet.walletObj;

            showStatus('connecting');

            // 1. Enable — triggers wallet popup to approve connection
            await walletObj.enable({ starknetVersion: STARKNET_VERSION });

            if (!walletObj.isConnected) {
                throw new Error('Connection rejected. Please approve the connection in your wallet.');
            }

            var address = walletObj.selectedAddress
                || (walletObj.account && walletObj.account.address);

            if (!address) {
                throw new Error('No account address returned. Please unlock your wallet and try again.');
            }

            // 2. Build typed-data sign-in payload
            showStatus('signing');

            var nonce = Date.now();
            var typedData = {
                domain: {
                    name:    'ZionDefi',
                    chainId: CHAIN_ID,
                    version: '1'
                },
                types: {
                    StarkNetDomain: [
                        { name: 'name',    type: 'shortstring' },
                        { name: 'chainId', type: 'shortstring' },
                        { name: 'version', type: 'shortstring' }
                    ],
                    Message: [
                        { name: 'content',   type: 'shortstring' },
                        { name: 'timestamp', type: 'felt' }
                    ]
                },
                primaryType: 'Message',
                message: {
                    content:   'Sign in to ZionDefi',
                    timestamp: nonce.toString()
                }
            };

            // 3. Sign via account.signMessage — same as reference
            var signer = walletObj.account;

            if (!signer || typeof signer.signMessage !== 'function') {
                throw new Error('Wallet signer not available. Please ensure your wallet is unlocked.');
            }

            var signature = await signer.signMessage(typedData);

            // 4. Submit to backend
            showStatus('verifying');
            var result = await submitToBackend({
                address:   address,
                walletId:  walletObj.id || wallet.id,
                signature: signature,
                typedData: typedData
            });

            // 5. Success
            showStatus('success');
            setTimeout(function () {
                window.location.href = (result && result.redirect) ? result.redirect : '/home';
            }, 1300);

        } catch (err) {
            console.error('[ZionDefi wallet]', err);
            hideStatus();

            btn.classList.remove('disabled');
            btn.innerHTML = originalHTML;

            showError(err.message || 'Something went wrong. Please try again.');
        }
    }

    /* ─────────────────────────────────────────────
       BACKEND SUBMISSION
    ───────────────────────────────────────────── */
    async function submitToBackend(payload) {
        var body = new FormData();
        body.append('address',   payload.address);
        body.append('wallet_id', payload.walletId);
        body.append('signature', JSON.stringify(payload.signature));
        body.append('typedData', JSON.stringify(payload.typedData));

        var csrf = document.querySelector('input[name="_csrf"]');
        if (csrf) body.append('_csrf', csrf.value);

        var turnstile = document.querySelector('[name="cf-turnstile-response"]');
        if (turnstile) body.append('cf-turnstile-response', turnstile.value);

        var res = await fetch(API_ENDPOINT, { method: 'POST', body: body, headers: { 'x-requested-with': 'XMLHttpRequest' } });
        if (!res.ok) {
            var data = await res.json().catch(function () { return {}; });
            throw new Error(data.error || data.message || 'Server returned ' + res.status);
        }
        return res.json();
    }

    /* ─────────────────────────────────────────────
       STATUS MODAL
    ───────────────────────────────────────────── */
    var STATUS = {
        connecting: {
            icon:   '<span class="spinner spinner-md"></span>',
            title:  'Connecting…',
            sub:    'Opening your wallet. Please wait.',
            cancel: true
        },
        signing: {
            icon:   '<span class="spinner spinner-md"></span>',
            title:  'Approve in your wallet',
            sub:    'Sign the authentication request inside your wallet app.',
            cancel: true
        },
        verifying: {
            icon:   '<span class="spinner spinner-md spinner-grn"></span>',
            title:  'Verifying…',
            sub:    'Confirming your identity with the server.',
            cancel: false
        },
        success: {
            icon:   '<div class="status-success-icon"><i class="ph-bold ph-check"></i></div>',
            title:  'Signed in!',
            sub:    'Redirecting to your dashboard…',
            cancel: false
        }
    };

    function showStatus(state) {
        var s       = STATUS[state];
        var overlay = qs('status-overlay');
        if (!overlay) return;

        var iconWrap = qs('s-icon-wrap');
        var title    = qs('s-title');
        var sub      = qs('s-sub');
        var cancel   = qs('s-cancel');

        if (iconWrap) iconWrap.innerHTML    = s.icon;
        if (title)    title.textContent     = s.title;
        if (sub)      sub.textContent       = s.sub;
        if (cancel)   cancel.style.display  = s.cancel ? 'inline-block' : 'none';

        overlay.classList.add('visible');
    }

    function hideStatus() {
        var overlay = qs('status-overlay');
        if (overlay) overlay.classList.remove('visible');
    }

    /* ─────────────────────────────────────────────
       ERROR BANNER
    ───────────────────────────────────────────── */
    function showError(message) {
        var list = qs('wallet-list');
        if (!list) return;

        var old = list.querySelector('.error-banner');
        if (old) old.remove();

        var el = document.createElement('div');
        el.className = 'error-banner';
        el.innerHTML = '<i class="ph-bold ph-warning"></i><span>' + message + '</span>';
        list.insertBefore(el, list.firstChild);

        setTimeout(function () { if (el.parentNode) el.remove(); }, 7000);
    }

    /* ─────────────────────────────────────────────
       BIND EVENTS
    ───────────────────────────────────────────── */
    document.addEventListener('DOMContentLoaded', function () {
        var openBtn   = qs('open-wallet-btn');
        var backdrop  = qs('wallet-backdrop');
        var closeBtn  = qs('drawer-close-btn');
        var cancelBtn = qs('s-cancel');

        if (openBtn)   openBtn.addEventListener('click', openDrawer);
        if (backdrop)  backdrop.addEventListener('click', closeDrawer);
        if (closeBtn)  closeBtn.addEventListener('click', closeDrawer);
        if (cancelBtn) cancelBtn.addEventListener('click', hideStatus);

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeDrawer();
        });
    });

})();