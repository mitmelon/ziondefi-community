var general = new General;

let selectedSource = null;
let pollingInterval = null;
let bridgeSources;

let currentSwapConfig = {
    card_id: null,
    source: null,
    asset: null,
    amount: 0,
    quote: null
};

async function initBridgeFlow(id) {
    try {
        const dropdownBtn = document.getElementById('source-dropdown-btn');
        const dropdownMenu = document.getElementById('source-dropdown-menu');
        const searchInput = document.getElementById('source-search');

        if(dropdownBtn && dropdownMenu && searchInput && $('#source-selector-container').length > 0) {
            dropdownBtn.onclick = function (e) {
                e.stopPropagation();
                dropdownMenu.classList.toggle('hidden');
                if (!dropdownMenu.classList.contains('hidden')) searchInput.focus();
            };

            document.addEventListener('click', function (e) {
                if (!e.target.closest('#source-selector-container')) {
                    dropdownMenu.classList.add('hidden');
                }
            });

            console.log("Fetching bridge sources for card", id);

            general.ajaxFormData(null, 'GET', '/home/card/' + id + '/bridge/list', new FormData(), null, null, function (data) {
                if (data.status === 200) {
                    window._bridgeSources = data.sources;
                    renderSourceOptions(data.sources);

                    searchInput.oninput = function (e) {
                        const term = e.target.value.toLowerCase();
                        const filtered = window._bridgeSources.filter(s =>
                            s.network_display_name.toLowerCase().includes(term) ||
                            s.asset.toLowerCase().includes(term)
                        );
                        renderSourceOptions(filtered);
                    };
                }
            }, 'centerLoader');
        }

    } catch (e) { console.error("Failed to load sources", e); }
}

function renderSourceOptions(sources) {
    const container = document.getElementById('source-options-list');
    container.innerHTML = sources.map(s => `
        <div class="source-option group flex items-center gap-3 px-4 py-3 hover:bg-indigo-50/50 cursor-pointer transition-all border-b border-slate-50" 
             data-network="${s.network_name}" data-asset="${s.asset}">
            
            <div class="relative w-8 h-8 shrink-0">
                <img src="${s.logo}" class="w-8 h-8 rounded-full border border-slate-200 shadow-sm" title="${s.network_display_name}">
                <img src="${s.asset_logo}" class="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-white shadow-sm bg-white">
            </div>

            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center">
                    <span class="text-sm font-bold text-slate-800 group-hover:text-indigo-700 transition-colors">${s.asset}</span>
                    <span class="text-[10px] font-medium text-slate-400">Min: ${s.min_amount}</span>
                </div>
                <div class="text-[11px] text-slate-500 truncate">${s.network_display_name}</div>
            </div>
            
            <i class="ph ph-caret-right text-slate-300 group-hover:text-indigo-400 group-hover:translate-x-1 transition-all"></i>
        </div>
    `).join('');
}

document.addEventListener('click', function (e) {
    const option = e.target.closest('.source-option');
    if (option) {
        const network = option.getAttribute('data-network');
        const asset = option.getAttribute('data-asset');
        const source = window._bridgeSources.find(s => s.network_name === network && s.asset === asset);

        if (source) {
            // Update the Display Button (Stripe Style)
            document.getElementById('selected-source-display').innerHTML = `
                <img src="${source.logo}" class="w-5 h-5 rounded-full">
                <span class="text-sm font-semibold text-slate-800">${source.asset} <span class="text-slate-400 font-normal">on</span> ${source.network_display_name}</span>
            `;

            // Hide menu
            document.getElementById('source-dropdown-menu').classList.add('hidden');

            selectedSource = source;
            currentSwapConfig.source = source;
            currentSwapConfig.card_id = ($('#cardDepositModal').data('card-id') || $('#manageCardModal').data('card-id'));
            document.querySelectorAll('.selected-asset-symbol').forEach(el => el.innerText = source.asset);
            document.querySelectorAll('.selected-asset-logo').forEach(el => el.src = source.asset_logo);
            document.querySelectorAll('.selected-asset-logo').forEach(el => el.classList.remove('hidden'));
        }
    }
});

function debounce(func, timeout = 500) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}
const processQuoteFetch = debounce(() => getBridgeQuote());

async function getBridgeQuote() {
    const { source, amount } = currentSwapConfig;
    if (!amount || amount <= 0 || !source) return;

    const quoteDetails = document.getElementById('quote-details');
    const receiveEl = document.getElementById('quote-receive-amount');
    const feeEl = document.getElementById('quote-fee');
    const submitBtn = document.getElementById('mc_deposit_ok'); // To enable submission

    try {
        var button = $('#quote-receive-amount').html();
        var formData = new FormData();
        formData.append('card_id', currentSwapConfig.card_id);
        formData.append('source_network', source.network_name);
        formData.append('source_token', source.asset);
        formData.append('amount', amount);

        general.ajaxFormData('#quote-receive-amount', 'POST', '/home/card/bridge/quote', formData, '#quote-receive-amount', button, function (data) {
            if (data.status === 200) {
                const actualQuote = data.quote && data.quote.quote ? data.quote.quote : data.quote;
                if (!actualQuote || actualQuote.receive_amount === undefined) {
                    console.error("Failed to parse quote structure. actualQuote:", actualQuote);
                    receiveEl.innerHTML = `<span class="text-rose-500">Parse Error</span>`;
                    feeEl.innerText = '---';
                    return;
                }

                quoteDetails.classList.remove('hidden');

                const destSymbol = actualQuote.destination_token ? actualQuote.destination_token.symbol : 'STRK';

                const receiveFormatted = parseFloat(actualQuote.receive_amount).toFixed(4);
                receiveEl.innerHTML = `~ ${receiveFormatted} <span class="text-xs text-slate-500">${destSymbol}</span>`;

                const feeUsd = parseFloat(actualQuote.total_fee_in_usd).toFixed(2);
                feeEl.innerText = `$${feeUsd}`;

                currentSwapConfig.quote = actualQuote;
                const submitBtn = document.getElementById('mc_deposit_ok');
                if (submitBtn) submitBtn.disabled = false;

            } else {
                receiveEl.innerHTML = `<span class="text-rose-500">Unavailable</span>`;
                feeEl.innerText = '---';
                const submitBtn = document.getElementById('mc_deposit_ok');
                if (submitBtn) submitBtn.disabled = true;
            }
        }, 'centerLoader');
    } catch (e) {
        console.error("Quote error:", e);
    }
}

$(document).on("click", ".startBridgeDeposit", function (e) {
    e.preventDefault();
    confirmModalController({
        title: window.__CARD_LANG.bridge_title_warning, message: window.__CARD_LANG.bridge_desc_warning, confirmText: window.__CARD_LANG.bridge_title_warning_confirm, cancelText: window.__CARD_LANG.cancel_title
    }).then(function (confirmed) {
        if (confirmed) {

            const source_address = document.getElementById('source-address').value.trim();

            if (!source_address) {
                gToast.error(window.__CARD_LANG.source_address_required);
                return;
            }

            if (!currentSwapConfig.quote || !currentSwapConfig.source.network_name || !currentSwapConfig.source.asset || !currentSwapConfig.amount) {
                gToast.error(window.__CARD_LANG.invalid_bridge_config);
                return;
            }

            var formData = new FormData();
            formData.append('card_id', currentSwapConfig.card_id);
            formData.append('source_network', currentSwapConfig.source.network_name);
            formData.append('source_token', currentSwapConfig.source.asset);
            formData.append('amount', currentSwapConfig.amount);
            formData.append('source_address', source_address);
            var button = $('.startBridgeDeposit').html();
            general.ajaxFormData('.startBridgeDeposit', 'POST', '/home/card/bridge/start', formData, '.startBridgeDeposit', button, function (data) {
                if (data.status === 200) {
                    if (typeof gToast !== 'undefined') gToast.success(data.message);
                    document.getElementById('bridgeDepositPanel').innerHTML = data.html;

                    const poller = createPoller({
                        url: '/home/card/bridge/' + data.bridge.reference_id + '/status', handler: async (d) => {

                            const status = d.payment.status; // e.g., "user_transfer_pending", "completed"

                            if (status === 'completed') {
                                document.getElementById('card-loader').innerHTML = '<i class="ph-bold ph-check-circle text-emerald-500 text-4xl"></i>';

                                document.getElementById('card-deployed').textContent = window.__CARD_LANG.bridge_payment_received || 'Payment Received';
                                document.getElementById('card-description').textContent = window.__CARD_LANG.bridge_payment_received_desc || 'We have received your payment. Your card is now funded!';
                                return true; // Stops the poller
                            } else if (status === 'failed' || status === 'expired' || status === 'cancelled' || status === 'refunded') {
                                document.getElementById('card-loader').innerHTML = '<i class="ph-bold ph-warning-circle text-red-600 text-4xl"></i>';
                                document.getElementById('card-deployed').textContent = window.__CARD_LANG.bridge_payment_failed || 'Payment Failed';
                                document.getElementById('card-description').textContent = window.__CARD_LANG.bridge_payment_failed_desc ||'The swap failed or expired. Any sent funds have been refunded.';
                                return true; // Stops the poller
                            } else if (status === 'ls_transfer_pending') {
                                document.getElementById('card-deployed').textContent = window.__CARD_LANG.bridge_payment_pending || 'Bridging in progress...';
                                document.getElementById('card-description').textContent = window.__CARD_LANG.bridge_payment_pending_desc || 'Payment detected! Sending funds to your ZionDefi card...';
                                return false; // Keep polling
                            }
                            // Default state: 'user_transfer_pending' or 'user_transfer_delayed'
                            document.getElementById('card-description').textContent = window.__CARD_LANG.bridge_payment_waiting || 'Waiting for payment confirmation...';
                            return false; // Keep polling
                        }
                    });

                    poller.start();
                }

            }, 'themeLoader');
        };
    });
});

$(document).on('click', '.copy-address-btn', function () {
    const targetSelector = $(this).data('target');
    const textToCopy = $(targetSelector).text().trim();
    const btn = $(this);
    const icon = btn.find('i');

    navigator.clipboard.writeText(textToCopy).then(() => {
        icon.removeClass('ph-copy').addClass('ph-check text-emerald-600');
        btn.addClass('bg-emerald-50 border-emerald-100');

        setTimeout(() => {
            icon.removeClass('ph-check text-emerald-600').addClass('ph-copy');
            btn.removeClass('bg-emerald-50 border-emerald-100');
        }, 2000);
    });
});


$(document).on('click', '.dismiss-banner-btn', function () {
    var target = $(this).data('target');
    if (target) $('#' + target).slideUp(200, function () { $(this).remove(); });
});

$(document).on('click', '#copy-card-address-btn', function () {
    var addr = $(this).data('address');
    if (!addr) return;
    var $icon = $('#copy-card-icon');
    navigator.clipboard.writeText(addr).then(function () {
        $icon.removeClass('ph-copy').addClass('ph-check');
        if (typeof gToast !== 'undefined') gToast.success('Address copied!');
        setTimeout(function () {
            $icon.removeClass('ph-check').addClass('ph-copy');
        }, 2000);
    }).catch(function () {
        if (typeof gToast !== 'undefined') gToast.error('Failed to copy');
    });
});


$(document).on('click', '.enable-zara-btn', function (e) {
    e.preventDefault();
    var cardId = $(this).closest('.manageCardModal').data('card-id');
    var formData = new FormData();
    formData.append('card_id', cardId);
    var button = $('.enable-zara-btn').html();
    general.ajaxFormData('.enable-zara-btn', 'POST', '/home/card/enable-zara', formData, '.enable-zara-btn', button, function (data) {
        if (data.status === 200) {
            //open modal
            $('#modalScreen').html(data.modalHtml);
            modalController(data.modalId, { bgClose: false, keyboard: false })
            .then(modal => {
                modal.show();
                modal.setSize('full');
            })
        }

    }, 'themeLoader');
});

var _zaraPage = 1;
var _zaraLoading = false;
var _zaraHasMore = true;

function _zaraLogStatusClass(status) {
    var map = { info: 'bg-slate-100 text-slate-500', success: 'bg-emerald-50 text-emerald-600', warning: 'bg-amber-50 text-amber-600', error: 'bg-red-50 text-red-500' };
    return map[status] || map.info;
}
function _zaraLogIcon(status) {
    var map = { info: 'ph-info', success: 'ph-check-circle', warning: 'ph-warning', error: 'ph-warning-diamond' };
    return map[status] || map.info;
}

function _zaraActionLabel(action) {
    return action.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function _renderZaraLog(item) {
    var actionLabel = _zaraActionLabel(item.action || item.event_type);
    var summary = item.summary || '';

    var iconHtml = '<div class="w-8 h-8 rounded-full flex items-center justify-center bg-slate-100 text-slate-500">' +
                    '<i class="ph-bold ph-bell text-base"></i>' +
                   '</div>';

    return '<div class="px-4 py-3 border-b border-slate-100">' +
        '<div class="flex items-center justify-between mb-1">' +
            '<div class="flex items-center gap-3">' +
                iconHtml +
                '<div class="text-sm font-semibold text-slate-800">' + actionLabel + '</div>' +
            '</div>' +
            '<div class="text-[10px] text-slate-400">' + item.created_at + '</div>' +
        '</div>' +
        '<div class="text-[13px] text-slate-600">' + summary + '</div>' +
    '</div>';
}

function _loadZaraLogs(page) {
    if (_zaraLoading || !_zaraHasMore) return;
    _zaraLoading = true;
    $('#zara-log-loader').removeClass('hidden');

    var formData = new FormData();
    formData.append('page', page);
    formData.append('limit', 20);

     general.ajaxFormData(null, 'POST', '/home/zara/logs', formData, null, null, function (data) {
        _zaraLoading = false;
        $('#zara-log-loader').addClass('hidden');
        if (data.status !== 200){
             $('#zara-log-loader').addClass('hidden');
             return;
        }

        var items = data.data || [];
        var meta  = data.meta || {};
        _zaraHasMore = meta.has_more || false;

        if (items.length === 0 && page === 1) {
            $('#zara-log-empty').removeClass('hidden');
            return;
        }
        $('#zara-log-empty').addClass('hidden');
        var sentinel = document.getElementById('zara-log-sentinel');
        var html = items.map(_renderZaraLog).join('');
        if (sentinel) {
            sentinel.insertAdjacentHTML('beforebegin', html);
        } else {
            $('#zara-log-feed').append(html);
        }

        if (meta.total_results) {
            $('#zara-log-count-badge').html('<span class="w-1 h-1 bg-violet-500 rounded-full animate-pulse inline-block"></span> ' + meta.total_results);
        }
    })

}

function _initZaraFeed() {
    var sentinel = document.getElementById('zara-log-sentinel');
    if (!sentinel) return;

    _loadZaraLogs(1);

    var observer = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && _zaraHasMore && !_zaraLoading) {
            _zaraPage++;
            _loadZaraLogs(_zaraPage);
        }
    }, { root: document.getElementById('zara-log-feed'), threshold: 0.1 });

    observer.observe(sentinel);
}


function _fillDashboardStats(data) {
    var balances = data.balances || {};
    var stakes   = data.stakes   || {};
    var stats    = data.stats    || {};

    var totalUsd = parseFloat(balances.totalUsd || 0);
    var $widget = $('#card-balance-widget');
    if ($widget.length) {
        $widget.html(totalUsd > 0
            ? '<span class="text-white">$' + totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span>'
            : '<span class="text-slate-500 text-xs">$0.00</span>');
    }

    var stakedUsd = parseFloat(stakes.total_staked_usd || 0);
    var $staked = $('#stat-total-staked');
    $staked.html(stakedUsd > 0
        ? '$' + stakedUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : '<span class="text-slate-300 text-base">$0.00</span>');

    var yieldUsd = parseFloat(stakes.total_yield_usd || 0);
    var $yield = $('#stat-total-yield');
    $yield.html(yieldUsd > 0
        ? '<span class="text-emerald-500">$' + yieldUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span>'
        : '<span class="text-slate-300 text-base">$0.00</span>');
   
    var $badge = $('#zara-status-badge');
    if (stats.agent_active) {
        $badge.html('<span class="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse inline-block"></span> Active')
            .removeClass('bg-slate-100 text-slate-500')
            .addClass('bg-violet-50 text-violet-600');
    } else {
        $badge.html('<span class="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block"></span> Inactive')
            .removeClass('bg-violet-50 text-violet-600')
            .addClass('bg-slate-100 text-slate-500');
    }

    var assetList = balances.balances || [];
    var $strip    = $('#assets-staked-strip');
    if (assetList.length > 0) {
        var chips = assetList.map(function (a) {
            var usd = parseFloat(a.amountUsd || a.balance_usd || 0).toFixed(2);
            var amt = parseFloat(a.amount || a.balance_human || a.balance || 0).toFixed(4);
            var sym = a.token || a.symbol || a.currency || '?';
            return '<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 transition-colors duration-200 text-slate-600 text-xs font-medium">' +
                '<span class="font-bold">' + sym + '</span>' +
                '<span class="text-slate-400">' + amt + '</span>' +
                '<span class="text-slate-300">\u00b7</span>' +
                '<span>$' + usd + '</span>' +
                '</span>';
        }).join('');
        $strip.html(chips);
        $('#assets-total-label').text('$' + totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    } else {
        $strip.html('<span class="text-xs text-slate-400">No assets on card yet</span>');
    }

    var positions = stakes.positions || [];
    var $stakeList = $('#staking-positions-list');
    if ($stakeList.length && positions.length > 0) {
        var rows = positions.map(function (p) {
            var m = p.metadata || {};
            var staked = parseFloat(m.staked_amount || 0).toFixed(4);
            var stakedUsdPos = parseFloat(m.staked_amount_usd || 0).toFixed(2);
            var yield_ = parseFloat(m.yield_earned || 0).toFixed(4);
            var pool = (m.pool_address || '').slice(0, 10) + '...';
            var token = (m.token_address || '').slice(0, 6).toUpperCase();
            var lastAction = m.last_action || 'staked';
            return '<div class="flex items-center justify-between py-2 border-b border-slate-100 last:border-0 text-xs">' +
                '<div class="flex flex-col"><span class="font-medium text-slate-700">' + token + '</span><span class="text-slate-400">' + pool + '</span></div>' +
                '<div class="text-right"><div class="font-medium text-slate-700">' + staked + ' <span class="text-slate-400">($' + stakedUsdPos + ')</span></div>' +
                '<div class="text-emerald-500">+' + yield_ + ' yield</div></div>' +
                '</div>';
        }).join('');
        $stakeList.html(rows);
    }
}

$(window).on('load', function () {

    if ($('.home-page').length > 0) {
        general.ajaxFormData(null, 'GET', '/home/homeview', new FormData(), null, null, function (data) {
            if (data.status === 200) {
                _fillDashboardStats(data);
            }
        }, 'themeLoader');

        const transactionRenderer = (tx) => {
            const isSuccess = tx.status === 'succeeded' || tx.status === 'success' || tx.status === 'completed';
            const isPending = tx.status === 'pending';
            const color = isSuccess ? 'emerald' : isPending ? 'amber' : 'rose';
            const icon = (tx.type === 'deposit' || tx.type === 'receive') ? 'ph-arrow-down-left' : 'ph-arrow-up-right';
            const date = tx.created_at ? new Date(tx.created_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
            const amount = parseFloat(tx.amount || 0).toFixed(2);
            const ref = tx._id ? tx._id.toString().slice(-6).toUpperCase() : '——';
            const typeLabel = tx.type ? (tx.type.charAt(0).toUpperCase() + tx.type.slice(1)) : 'Transfer';

            return `<tr class="hover:bg-slate-50/70 transition-colors duration-150 cursor-pointer group">
                <td class="pl-5 py-3.5 font-mono text-[11px] text-slate-400 whitespace-nowrap">#${ref}</td>
                <td class="px-4 py-3.5">
                    <div class="flex items-center gap-2.5">
                        <div class="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0">
                            <i class="ph-bold ${icon} text-xs"></i>
                        </div>
                        <span class="font-semibold text-slate-800 text-xs">${typeLabel}</span>
                    </div>
                </td>
                <td class="hidden md:table-cell px-4 py-3.5 text-slate-400 text-xs whitespace-nowrap">${date}</td>
                <td class="px-4 py-3.5">
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-${color}-50 border border-${color}-100 text-${color}-700 text-[10px] font-semibold capitalize">${tx.status || '—'}</span>
                </td>
                <td class="pr-5 py-3.5 text-right font-bold text-slate-900 text-sm whitespace-nowrap">$${amount}</td>
            </tr>`;
        };

        window.paginationController({
            url: '/home/transactions',
            tableId: 'txn-table-body',
            renderer: transactionRenderer,
            limit: 8
        }).then(function () {
            console.log('Transactions loaded');
        });

        _initZaraFeed();

    }

    (function () {
        var cb    = document.getElementById('go-live-toggle');
        var track = document.getElementById('mode-toggle-track');
        if (!cb || !track) return;

        var _busy = false;
        track.addEventListener('click', function () {
            if (_busy) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        });

        cb.addEventListener('change', function () {
            if (_busy) return;
            _busy = true;

            var isLive  = cb.checked;
            var $label  = $('#live-text');

            // Optimistic UI
            track.classList.toggle('is-live', isLive);
            $label.text(isLive ? 'Live' : 'Test')
                  .toggleClass('text-green-600', isLive)
                  .toggleClass('text-zinc-500',  !isLive);

            var formData = new FormData();
            formData.append('live', isLive);

            general.ajaxFormData(null, 'POST', '/home/live', formData, null, null, function (data) {
                _busy = false;
                if (data.status === 200) {
                    if (typeof gToast !== 'undefined') {
                        gToast.success(isLive ? 'You are now LIVE!' : 'Switched to Test Mode');
                    }
                } else {
                    cb.checked = !isLive;
                    track.classList.toggle('is-live', !isLive);
                    $label.text(!isLive ? 'Live' : 'Test')
                          .toggleClass('text-green-600', !isLive)
                          .toggleClass('text-zinc-500',  isLive);
                }
            }, 'themeLoader');
        });
    })();
    (function () {
        function bindDropdown(triggerId, menuId) {
            var trigger = document.getElementById(triggerId);
            var menu    = document.getElementById(menuId);
            if (!trigger || !menu) return;
            trigger.addEventListener('click', function (e) {
                e.stopPropagation();
                menu.classList.toggle('dropdown-active');
            });
            document.addEventListener('click', function (e) {
                if (!menu.contains(e.target) && !trigger.contains(e.target)) {
                    menu.classList.remove('dropdown-active');
                }
            });
        }
        bindDropdown('user-menu-trigger', 'user-dropdown');
        bindDropdown('openNotification',  'notif-dropdown');
    })();

    $(document).on("click", ".create-card-btn", function (e) {
        e.preventDefault();
        var cardId = $(this).data('card-id');
        var action = $(this).data('action');
        currentSwapConfig = {};

        if (action === 'redeploy') {
            var formData = new FormData();
            formData.append('card_id', cardId);
            var csrfInput = document.querySelector('input[name="_csrf"]');
            if (csrfInput) formData.append('_csrf', csrfInput.value);
            var button = $(this).html();

            general.ajaxFormData('#' + this.id, 'POST', '/home/card/redeploy', formData, '#' + this.id, button, function (data) {
                if (data.status === 200) {
                    var L = window.__CARD_LANG || {};
                    var spinnerSvg = '<svg class="animate-spin w-8 h-8 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';
                    var overlayHtml = '<div id="zion-deploy-overlay" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate__animated animate__fadeIn">' +
                        '<div class="max-w-md w-full bg-white rounded-2xl shadow-2xl border border-slate-100 p-8 text-center mx-4">' +
                        '<div class="flex flex-col items-center gap-4">' +
                        '<div class="w-16 h-16 rounded-full bg-slate-50 flex items-center justify-center" id="card-loader">' + spinnerSvg + '</div>' +
                        '<h2 class="text-xl font-bold text-slate-800" id="card-deployed">' + (L.card_deploying || 'Redeploying card…') + '</h2>' +
                        '<p class="text-sm text-slate-500" id="card-description">' + (L.card_deploying_desc || 'This can take a few minutes. Please wait.') + '</p>' +
                        '<div id="card-status"><span class="text-xs text-slate-400">' + (L.card_deploying_working || 'Workers are processing your request…') + '</span></div>' +
                        '</div></div></div>';
                    document.body.insertAdjacentHTML('beforeend', overlayHtml);

                    var poller = createPoller({
                        url: '/home/card/' + (data.card_id || cardId),
                        handler: async function (d) {
                            var status = d && d.card && d.card.status;
                            if (status === 'active') {
                                document.getElementById('card-loader').innerHTML = '<i class="ph-bold ph-check-circle text-emerald-500 text-4xl"></i>';
                                document.getElementById('card-deployed').textContent = L.card_deployed || 'Card is active!';
                                document.getElementById('card-description').textContent = L.card_deployed_desc || 'Your card is now active and ready to use.';
                                document.getElementById('card-status').innerHTML = d.card.explorer_url
                                    ? '<a href="' + d.card.explorer_url + '" target="_blank" class="inline-flex items-center gap-2 bg-green-50 border border-green-100 text-green-700 rounded-full px-4 py-1.5 text-sm font-mono hover:underline">View Onchain</a>'
                                    : '';
                                setTimeout(function () {
                                    var overlay = document.getElementById('zion-deploy-overlay');
                                    if (overlay) overlay.remove();
                                    general.reload();
                                }, 3000);
                                return true;
                            } else if (status === 'failed') {
                                document.getElementById('card-loader').innerHTML = '<i class="ph-bold ph-warning-circle text-red-600 text-4xl"></i>';
                                document.getElementById('card-deployed').textContent = L.card_deployed_failed || 'Deployment Failed';
                                document.getElementById('card-description').textContent = (d.card.deploy_error || L.card_deploy_failed_desc || 'Card deployment failed. Please try again.').slice(0, 120);
                                document.getElementById('card-status').innerHTML = '<button onclick="document.getElementById(\'zion-deploy-overlay\').remove()" class="mt-2 px-4 py-2 bg-slate-800 text-white text-sm rounded-lg hover:bg-slate-700 transition">Close</button>';
                                return true;
                            }
                            document.getElementById('card-description').textContent = L.card_undeployed_desc || 'Still deploying…';
                            return false;
                        }
                    });
                    poller.start();
                } else {
                    if (typeof gToast !== 'undefined') gToast.error(data.message || data.error || 'Redeploy failed.');
                }
            }, 'centerLoader');
            return;
        }

        // All other actions — open modal
        var formData = new FormData();
        formData.append('card_id', cardId);
        formData.append('action', action);
        var button = $(this).html();

        general.ajaxFormData('#' + this.id, 'POST', '/home/card/modal', formData, '#' + this.id, button, function (data) {
            if (data.status === 200) {
                $('#modalScreen').html(data.modalHtml);
                modalController(data.modalId, { bgClose: false, keyboard: false })
                    .then(modal => {
                        modal.show();
                        modal.setSize('full');
                    })

                    if(cardId !== undefined && cardId !== null && cardId !== '' && cardId !== 'none') {
                        console.log("Initializing bridge flow for card ID:", cardId);
                        initBridgeFlow(cardId);
                      
                        if(document.getElementById('bridge-amount')) {
                            document.getElementById('bridge-amount').addEventListener('input', (e) => {
                                currentSwapConfig.amount = e.target.value;
                                processQuoteFetch();
                            });
                        }
                        
                    }
            }
        }, 'centerLoader');
    });

    $(document).on("click", ".card-freeze-btn", function (e) {
        e.preventDefault();
        var cardId = $(this).closest('#manageCardModal').data('card-id');
        confirmModalController({
            title: window.__CARD_LANG.freeze_title, message: window.__CARD_LANG.freeze_desc, confirmText: window.__CARD_LANG.freeze_title, cancelText: window.__CARD_LANG.cancel_title
        }).then(function (confirmed) {
            if (confirmed) {
                var formData = new FormData();
                formData.append('card_id', cardId);
                var button = $('.card-freeze-btn').html();
                general.ajaxFormData('.card-freeze-btn', 'POST', '/home/card/freeze', formData, '.card-freeze-btn', button, function (data) {
                    if (data.status === 200) {
                        if (typeof gToast !== 'undefined') gToast.success(data.message);

                        setTimeout(function () { general.reload(); }, 4000);
                    }

                }, 'themeLoader');
            };
        });
    });

    $(document).on("click", ".deposit-btn", function (e) {
        e.preventDefault();
        var cardId = $(this).closest('.manageCardModal').data('card-id');
        var formData = new FormData();
        formData.append('card_id', cardId);
        var button = $('.deposit-btn').html();
        general.ajaxFormData('.deposit-btn', 'POST', '/home/card/deposit', formData, '.deposit-btn', button, function (data) {
            if (data.status === 200) {
                //open modal
                $('#modalScreen').html(data.modalHtml);
                modalController(data.modalId, { bgClose: false, keyboard: false })
                .then(modal => {
                    modal.show();
                    modal.setSize('full');
                })
            }

        }, 'themeLoader'); 
    });
});