(function () {
    // --- 1. CARD FLIP LOGIC ---
    window.flipCard = function (cardId) {
        const inner = document.getElementById(`card-inner-${cardId}`);
        if (inner) {
            if (inner.style.transform === 'rotateY(180deg)') {
                inner.style.transform = 'rotateY(0deg)';
            } else {
                inner.style.transform = 'rotateY(180deg)';
            }
        }
    };
    // --- 2. SLIDER LOGIC (Your code integrated) ---
    function initCardSlider() {
        const container = document.getElementById('cards-scroll-container');
        const prevBtn = document.getElementById('card-prev-btn');
        const nextBtn = document.getElementById('card-next-btn');
        const indicatorsContainer = document.getElementById('cards-indicators');

        if (!container || !prevBtn || !nextBtn) return;

        const items = Array.from(container.querySelectorAll('.card-item'));
        if (items.length === 0) return;

        // Scroll Logic
        function scrollToItem(index) {
            const item = items[index];
            if (item) {
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
        }

        prevBtn.addEventListener('click', (e) => {
            e.preventDefault();
            container.scrollBy({ left: -container.offsetWidth, behavior: 'smooth' });
        });

        nextBtn.addEventListener('click', (e) => {
            e.preventDefault();
            container.scrollBy({ left: container.offsetWidth, behavior: 'smooth' });
        });

        // Observer (Optional: Disable buttons at ends)
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    // Logic to highlight dots if needed
                }
            });
        }, { root: container, threshold: 0.6 });

        items.forEach(item => observer.observe(item));
    }

    document.addEventListener('DOMContentLoaded', initCardSlider);
    document.addEventListener('turbo:load', initCardSlider);
})();


// ═══════════════════════════════════════════════════════
// CREATE-CARD MODAL — FormStepper controller + logic
// ═══════════════════════════════════════════════════════
window.initCreateCardModal = function () {
    var modal = document.getElementById('createCardModal');
    var form = document.getElementById('createCardForm');
    if (!modal || !form) return;

    var TOTAL_STEPS = 6;

    // locale strings injected by EJS
    var L = window.__CARD_LANG || {};

    // ── cached DOM refs ──
    var $ = function (id) { return document.getElementById(id); };
    var el = {
        owner: $('cc_owner'),
        pin: $('cc_pin'),
        pinConfirm: $('cc_pin_confirm'),
        pinMatchErr: $('cc_pin_match_err'),
        pinPubDisplay: $('cc_pin_pubkey_display'),
        genPinBtn: $('cc_gen_pin_btn'),
        maxTx: $('cc_max_tx'),
        dailySpend: $('cc_daily_spend'),
        dailyTxLimit: $('cc_daily_tx_limit'),
        slippage: $('cc_slippage'),
        transferDelay: $('cc_transfer_delay'),
        progressBar: $('ccProgressBar'),
        progressLabel: $('ccProgressLabel'),
        previewLast4: $('ccPreviewLast4'),
        // summary
        sumOwner: $('cc_sum_owner'),
        sumWalletType: $('cc_sum_wallet_type'),
        sumPin: $('cc_sum_pin'),
        sumCurrencies: $('cc_sum_currencies'),
        sumMode: $('cc_sum_mode'),
        sumSlippage: $('cc_sum_slippage'),
    };

    // state — restore from localStorage if user navigated away
    var STORAGE_KEY = 'zion_create_card';
    var savedState = {};
    try { savedState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { }
    var derivedPinPublicKey = savedState.pin_public_key || '';

    // ── helpers ──
    function short(addr) { return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '—'; }

    function getOwnerAddress() {
        return el.owner ? el.owner.value.trim() : '';
    }

    function getWalletChoice() {
        return 'existing';
    }

    function getSelectedCurrencies() {
        return Array.from(form.querySelectorAll('input[name="currencies"]:checked')).map(function (i) { return i.value; });
    }

    function getPaymentMode() {
        var r = form.querySelector('input[name="payment_mode"]:checked');
        return r ? r.value : 'MerchantTokenOnly';
    }

    function parseMoney(v) { return v ? v.replace(/[^0-9.]/g, '') : '0'; }

    // ── update sidebar progress ──
    function updateProgress(step) {
        var pct = Math.round((step / TOTAL_STEPS) * 100);
        if (el.progressBar) el.progressBar.style.width = pct + '%';
        if (el.progressLabel) el.progressLabel.textContent = (L.step_of || 'Step {step} of {total}').replace('{step}', step).replace('{total}', TOTAL_STEPS);
    }

    // ── populate review summary ──
    var CURRENCY_META = {
        ETH: { icon: 'Ξ', color: 'bg-slate-700 text-white' },
        STRK: { icon: 'S', color: 'bg-purple-600 text-white' },
        USDC: { icon: '$', color: 'bg-green-600 text-white' },
        USDT: { icon: '₮', color: 'bg-emerald-600 text-white' },
        DAI: { icon: 'D', color: 'bg-yellow-500 text-white' },
        WBTC: { icon: '₿', color: 'bg-orange-500 text-white' },
        LORDS: { icon: 'L', color: 'bg-blue-600 text-white' },
        WSTETH: { icon: 'wΞ', color: 'bg-teal-600 text-white' },
    };

    function populateSummary() {
        var addr = getOwnerAddress();
        if (el.sumOwner) el.sumOwner.textContent = addr || '—';

        if (el.sumWalletType) {
            el.sumWalletType.innerHTML =
                '<i class="ph-bold ph-wallet text-sm"></i> ' + (L.wallet_type_existing || 'Existing');
        }

        if (el.sumPin) el.sumPin.textContent = derivedPinPublicKey ? short(derivedPinPublicKey) : '—';

        // currencies as pill badges
        if (el.sumCurrencies) {
            var currencies = getSelectedCurrencies();
            if (currencies.length === 0) {
                el.sumCurrencies.innerHTML = '<span class="text-xs text-slate-400">' + (L.none_selected || 'None selected') + '</span>';
            } else {
                el.sumCurrencies.innerHTML = currencies.map(function (c) {
                    var meta = CURRENCY_META[c] || { icon: c[0], color: 'bg-slate-500 text-white' };
                    return '<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ' + meta.color + ' shadow-sm">' +
                        '<span class="text-[10px] font-bold opacity-80">' + meta.icon + '</span>' + c + '</span>';
                }).join('');
            }
        }

        // delays
        var DELAY_LABELS = {
            '0': L.delays_instant || 'Instant',
            '300': L.delays_5m || '5 min',
            '900': L.delays_15m || '15 min',
            '1800': L.delays_30m || '30 min',
            '3600': L.delays_1h || '1 hour',
            '7200': L.delays_2h || '2 hours',
            '21600': L.delays_6h || '6 hours',
            '43200': L.delays_12h || '12 hours',
            '86400': L.delays_24h || '24 hours',
            '172800': L.delays_48h || '48 hours',
            '604800': L.delays_7d || '7 days',
        };

        // payment mode
        var mode = getPaymentMode();
        var isMerchant = mode === 'MerchantTokenOnly';
        if (el.sumMode) el.sumMode.textContent = isMerchant ? (L.payment_merchant_token || 'Merchant Token') : (L.payment_any_token || 'Any Token');
        var modeIcon = document.getElementById('cc_sum_mode_icon');
        if (modeIcon) modeIcon.className = 'ph-bold ' + (isMerchant ? 'ph-storefront text-slate-600' : 'ph-swap text-slate-600');

        // limits — split into separate elements
        var sumMaxTx = document.getElementById('cc_sum_max_tx');
        var sumDaily = document.getElementById('cc_sum_daily_spend');
        if (sumMaxTx) sumMaxTx.textContent = '$' + (el.maxTx.value || '0');
        if (sumDaily) sumDaily.textContent = '$' + (el.dailySpend.value || '0');
        if (el.sumSlippage) el.sumSlippage.textContent = (el.slippage.value || '0') + ' bps';

        var sumTransferDelay = document.getElementById('cc_sum_transfer_delay');
      
        var tdVal = el.transferDelay ? el.transferDelay.value : '86400';
        if (sumTransferDelay) sumTransferDelay.textContent = DELAY_LABELS[tdVal] || tdVal + 's';
    }

    // ── per-step validation ──
    function clearFieldError(elem) {
        if (!elem) return;
        elem.classList.remove('cc-field-error');
        var msg = elem.parentNode ? elem.parentNode.querySelector('.cc-field-error-msg') : null;
        if (msg) msg.remove();
    }

    function markFieldError(elem, message) {
        if (!elem) return;
        elem.classList.add('cc-field-error');
        // remove old message if any
        var parent = elem.parentNode;
        if (parent) {
            var old = parent.querySelector('.cc-field-error-msg');
            if (old) old.remove();
            var span = document.createElement('span');
            span.className = 'cc-field-error-msg';
            span.innerHTML = '<i class="ph-bold ph-warning-circle"></i> ' + (message || 'Required');
            parent.appendChild(span);
        }
        // auto-clear on interact
        var handler = function () {
            clearFieldError(elem);
            elem.removeEventListener('focus', handler);
            elem.removeEventListener('input', handler);
            elem.removeEventListener('change', handler);
        };
        elem.addEventListener('focus', handler);
        elem.addEventListener('input', handler);
        elem.addEventListener('change', handler);
    }

    function validateStep(step) {
        switch (step) {
            case 1:
                if (!el.owner || !el.owner.value.trim()) {
                    var walletList = form.querySelector('#cc_wallet_list');
                    if (walletList) shake(walletList);
                    if (typeof gToast !== 'undefined') gToast.error(L.err_wallet_required || 'Please select a wallet.');
                    return false;
                }
                return true;
            case 2:
                if (!el.pin.value) {
                    markFieldError(el.pin, L.err_enter_pin || 'Enter a PIN');
                    shake(el.pin);
                    return false;
                }
                if (el.pin.value !== el.pinConfirm.value) {
                    el.pinMatchErr.classList.remove('hidden');
                    markFieldError(el.pinConfirm, L.err_pin_mismatch || 'PINs do not match');
                    shake(el.pinConfirm);
                    return false;
                }
                el.pinMatchErr.classList.add('hidden');
                if (!derivedPinPublicKey) {
                    // attempt auto-derive one more time
                    tryAutoDerivePinKey();
                    if (!derivedPinPublicKey) {
                        if (!getOwnerAddress()) {
                            gToast.error(L.err_set_wallet_first || 'Go back to Step 1 and set your wallet address first.');
                        } else {
                            markFieldError(el.pinConfirm, L.err_key_derivation_failed || 'Key derivation failed');
                            shake(el.pinConfirm);
                        }
                        return false;
                    }
                }
                return true;
            case 3:
                if (getSelectedCurrencies().length === 0) {
                    var grid = form.querySelector('input[name="currencies"]');
                    var gridEl = grid ? grid.closest('.grid') : null;
                    if (gridEl) {
                        shake(gridEl);
                        // add error below grid
                        var parent = gridEl.parentNode;
                        if (parent && !parent.querySelector('.cc-field-error-msg')) {
                            var span = document.createElement('span');
                            span.className = 'cc-field-error-msg';
                            span.innerHTML = '<i class="ph-bold ph-warning-circle"></i> ' + (L.err_select_currency || 'Select at least one currency');
                            parent.appendChild(span);
                            // auto-remove on next currency change
                            form.querySelectorAll('input[name="currencies"]').forEach(function (cb) {
                                cb.addEventListener('change', function onceClear() {
                                    if (span.parentNode) span.remove();
                                    cb.removeEventListener('change', onceClear);
                                }, { once: true });
                            });
                        }
                    }
                    return false;
                }
                return true;
            case 4:
                return true;
            case 5:
                return true;
            default:
                return true;
        }
    }

    // quick shake animation on invalid field
    function shake(elem) {
        if (!elem) return;
        elem.classList.add('animate__animated', 'animate__headShake');
        elem.addEventListener('animationend', function handler() {
            elem.classList.remove('animate__animated', 'animate__headShake');
            elem.removeEventListener('animationend', handler);
        });
        if (elem.focus) elem.focus();
    }



    // ── wallet list selection ──
    (function () {
        // Auto-select first wallet on init
        var firstItem = form.querySelector('.cc-wallet-item');
        if (firstItem && el.owner) {
            el.owner.value = firstItem.getAttribute('data-address') || '';
        }

        // Click to select
        form.addEventListener('click', function (e) {
            var item = e.target.closest('.cc-wallet-item');
            if (!item) return;

            // Update hidden owner field
            if (el.owner) el.owner.value = item.getAttribute('data-address') || '';

            // Update visual state on all items
            form.querySelectorAll('.cc-wallet-item').forEach(function (btn) {
                var isSelected = btn === item;
                btn.classList.toggle('border-slate-800', isSelected);
                btn.classList.toggle('bg-slate-50', isSelected);
                btn.classList.toggle('border-slate-200', !isSelected);
                var check = btn.querySelector('.cc-wallet-check');
                var checkIcon = btn.querySelector('.cc-wallet-check i');
                if (check) {
                    check.classList.toggle('border-slate-800', isSelected);
                    check.classList.toggle('bg-slate-800', isSelected);
                    check.classList.toggle('border-slate-300', !isSelected);
                }
                if (checkIcon) checkIcon.classList.toggle('hidden', !isSelected);
            });
        });
    })();



    // ── copy buttons ──
    form.querySelectorAll('[data-copy]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var targetId = btn.getAttribute('data-copy');
            var target = document.getElementById(targetId);
            if (!target) return;
            var text = target.textContent;
            if (!text || text === '\u2014') return;
            navigator.clipboard.writeText(text).then(function () {
                var orig = btn.innerHTML;
                btn.innerHTML = '<i class="ph ph-check"></i> ' + (L.copied || 'Copied');
                setTimeout(function () { btn.innerHTML = orig; }, 1500);
            });
        });
    });

    // ── init FormStepper (defined in util.js) ──
    // Submit logic and validation are handled in the btnNext click wrapper below.
    var stepper = new FormStepper({
        container: '#createCardForm',
        stepSelector: '.cc-step',
        stepItemSelector: '[data-step-item]',
        btnNext: '#cc_btn_next',
        btnPrev: '#cc_btn_prev',
        activeClass: 'text-slate-800',
        inactiveClass: 'text-slate-400',
        lastStepBtnText: L.btn_create || 'Create Card',
        nextBtnText: L.btn_next || 'Next',
        onStepChange: function (step) {
            updateProgress(step);
            saveToStorage();
            if (step === TOTAL_STEPS) populateSummary();
        },
    });

    // Inject validation into the Next button by replacing its click handler.
    // util.js FormStepper wires btnNext.click in _bindEvents during construction.
    // We clone the button to strip that listener, then add our validated wrapper.
    var btnNext = document.getElementById('cc_btn_next');
    if (btnNext) {
        var btnNextClone = btnNext.cloneNode(true);
        btnNext.parentNode.replaceChild(btnNextClone, btnNext);
        btnNextClone.addEventListener('click', function () {
            if (!validateStep(stepper.currentStep)) return;
            if (stepper.currentStep < stepper.steps.length) {
                stepper.next();
            } else {
                // last step — trigger submit
                var data = saveToStorage();
                var formData = new FormData();

                formData.append('owner', data.owner || '');
                formData.append('wallet_choice', data.wallet_choice || 'existing');
                formData.append('pin_public_key', data.pin_public_key || '');
                formData.append('currencies', JSON.stringify(data.currencies || []));
                formData.append('payment_mode', data.payment_mode || 'MerchantTokenOnly');
                formData.append('max_transaction_amount', data.max_transaction_amount || '0');
                formData.append('daily_spend_limit', data.daily_spend_limit || '0');
                formData.append('daily_transaction_limit', String(data.daily_transaction_limit || 50));
                formData.append('slippage_tolerance_bps', String(data.slippage_tolerance_bps || 50));
                formData.append('transfer_delay', String(data.transfer_delay));

                var csrfInput = document.querySelector('input[name="_csrf"]');
                if (csrfInput) formData.append('_csrf', csrfInput.value);

                var button = btnNextClone.innerHTML;

                general.ajaxFormData('.cc_btn_next', 'POST', '/home/card/create', formData, '.cc_btn_next', button, function (res) {
                    if (res.status === 200) {
                        document.querySelector('.major-screen').innerHTML = res.cardHtml;
                        const poller = createPoller({ url: '/home/card/' + res.card_id, handler: async (d) => {
                            if (d.card.status === 'active') {
                                document.getElementById('card-loader').innerHTML = '<i class="ph-bold ph-check-circle text-emerald-500 text-4xl"></i>';
                                document.getElementById('card-deployed').textContent = L.card_deployed || 'Card is active!';
                                document.getElementById('card-status').innerHTML = '<span id="cc_contract_badge" class="inline-flex items-center gap-2 bg-green-50 border border-green-100 text-green-700 rounded-full px-3 py-1 text-sm font-mono"><a href="' + d.card.explorer_url + '" target="_blank" class="hover:underline">View Onchain</a></span>';
                                document.getElementById('card-description').textContent = L.card_deployed_desc || 'Your card is now active and ready to use.';
                                return true;
                            } else if (d.card.status === 'failed') {
                                document.getElementById('card-loader').innerHTML = '<i class="ph-bold ph-warning-circle text-red-600 text-4xl"></i>';
                                document.getElementById('card-deployed').textContent = L.card_deployed_failed || 'Deployment Failed';
                                document.getElementById('card-status').innerHTML = '';
                                document.getElementById('card-description').textContent = L.card_deploy_failed_desc || 'Card deployment failed.';
                                return true;
                            }
                            document.getElementById('card-description').textContent = L.card_undeployed_desc || 'Still deploying. This can take a few minutes. Please wait...';
                            return false;
                        }});
                        setTimeout(function () {
                            gToast.success(res.message || (L.card_queued || 'Card deployment sent to queue. It will be ready soon.'));
                            localStorage.removeItem(STORAGE_KEY);
                        }, 3000);
                        poller.start();
                    }
                }, 'centerLoader');
            }
        });
    }

    // ── checkbox toggle visual ──
    form.querySelectorAll('input[name="currencies"]').forEach(function (cb) {
        cb.addEventListener('change', function () {
            var label = cb.closest('label');
            var tick = label ? label.querySelector('.cc-tick') : null;
            var icon = label ? label.querySelector('.ph-check') : null;
            if (cb.checked) {
                if (tick) { tick.classList.add('border-slate-800', 'bg-slate-800'); tick.classList.remove('border-slate-200'); }
                if (icon) icon.classList.remove('hidden');
            } else {
                if (tick) { tick.classList.remove('border-slate-800', 'bg-slate-800'); tick.classList.add('border-slate-200'); }
                if (icon) icon.classList.add('hidden');
            }
        });
    });

    // ── money input formatting ──
    if (typeof formatMoneyInput === 'function') {
        formatMoneyInput('money-input', 2);
    }

    // ── slippage: integers only ──
    if (el.slippage) {
        el.slippage.addEventListener('input', function () {
            this.value = this.value.replace(/[^0-9]/g, '');
        });
        el.slippage.addEventListener('keydown', function (e) {
            if (e.key === '.') e.preventDefault();
        });
    }

    // ── PIN auto-derivation (derive automatically when both PINs match) ──
    function tryAutoDerivePinKey() {
        var pin = el.pin ? el.pin.value : '';
        var conf = el.pinConfirm ? el.pinConfirm.value : '';
        var owner = getOwnerAddress();

        // reset state first
        derivedPinPublicKey = '';
        if (el.pinPubDisplay) {
            el.pinPubDisplay.textContent = '—';
            el.pinPubDisplay.classList.remove('text-slate-700');
        }
        if (el.pinMatchErr) el.pinMatchErr.classList.add('hidden');

        // need both fields filled
        if (!pin || !conf) return;

        // check match
        if (pin !== conf) {
            if (el.pinMatchErr) el.pinMatchErr.classList.remove('hidden');
            return;
        }

        // need owner address
        if (!owner) return;
        try {
            if (window.ZionCrypto && ZionCrypto.Pin) {
                var keys = ZionCrypto.Pin.deriveKeys(pin, owner);
                derivedPinPublicKey = keys.publicKey;
            } else {
                throw new Error(L.err_crypto_not_loaded || 'Crypto libs not loaded');
            }
            if (el.pinPubDisplay) {
                el.pinPubDisplay.textContent = derivedPinPublicKey;
                el.pinPubDisplay.classList.add('text-slate-700');
            }
        } catch (err) {
            console.error('PIN derivation error', err);
        }
    }

    // listen on both PIN fields
    [el.pin, el.pinConfirm].forEach(function (inp) {
        if (!inp) return;
        inp.addEventListener('input', tryAutoDerivePinKey);
    });

    // ── save step data to localStorage ──
    function saveToStorage() {
        var data = {
            wallet_choice: 'existing',
            owner: getOwnerAddress(),
            pin_public_key: derivedPinPublicKey,
            currencies: getSelectedCurrencies(),
            payment_mode: getPaymentMode(),
            max_transaction_amount: parseMoney(el.maxTx.value),
            daily_spend_limit: parseMoney(el.dailySpend.value),
            daily_transaction_limit: parseInt(el.dailyTxLimit.value) || 50,
            slippage_tolerance_bps: parseInt(el.slippage.value) || 50,
            transfer_delay: parseInt(el.transferDelay ? el.transferDelay.value : '86400') || 0
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return data;
    }

    // ── open / close ──
    modal.querySelectorAll('[data-modal-close]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            modal.classList.add('hidden');
            document.body.classList.remove('overflow-hidden');
        });
    });

    window.openCreateCardModal = function () {
        modal.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        stepper.reset();
        updateProgress(1);
    };
};