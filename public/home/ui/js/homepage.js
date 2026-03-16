/*
* homepage.js - Handles website homepage interactions and functionalities.
* Copyright (C) 2021-2026 Manomite Limited
* Author:  Manomite Team
* Website: https://manomitech.com
*/

var general = new General;
const BASE = general.getBase();
general.secure_token(BASE + 'src/Addons/general.php', 'anchorKey');

//a function for generating secured 8 digit uuid
function generateSecuredUUID() {
    const array = new Uint8Array(8);
    window.crypto.getRandomValues(array);
    return Array.from(array, dec => ('0' + dec.toString(16)).substr(-2)).join('');
}


function updateProductCount(selector) {
    const productCount = document.querySelectorAll(selector).length;
    return productCount;
}

(function () {
    /**
     * Dialog Controller - A wrapper for ManomiteDialog
     * Supports: confirm, alert, delete, prompt, success, error, warning
     * 
     * @param {string} type - Dialog type: 'confirm', 'alert', 'delete', 'prompt', 'success', 'error', 'warning'
     * @param {object} options - Dialog options
     * @returns {Promise} - Resolves with user response
     */
    window.dialogController = function (type = 'confirm', options = {}) {
        return new Promise((resolve, reject) => {
            const showDialog = () => {
                try {
                    const dialog = window.ManomiteDialog;
                    
                    switch (type) {
                        case 'confirm':
                            dialog.confirm({
                                theme: options.theme || 'white',
                                title: options.title || 'Confirm Action',
                                message: options.message || 'Are you sure you want to proceed?',
                                confirmText: options.confirmText || options.yesText || 'Confirm',
                                cancelText: options.cancelText || options.noText || 'Cancel',
                                icon: options.icon || 'question',
                                showCloseButton: options.showCloseButton !== false,
                                overlayClose: options.overlayClose !== false,
                                escapeClose: options.escapeClose !== false
                            }).then(resolve).catch(reject);
                            break;
                            
                        case 'delete':
                            dialog.delete({
                                theme: options.theme || 'danger',
                                title: options.title || 'Delete Confirmation',
                                message: options.message || 'Are you sure you want to delete this? This action cannot be undone.',
                                confirmText: options.confirmText || 'Delete',
                                cancelText: options.cancelText || 'Cancel',
                                showCloseButton: options.showCloseButton !== false,
                                overlayClose: options.overlayClose !== false,
                                escapeClose: options.escapeClose !== false
                            }).then(resolve).catch(reject);
                            break;
                            
                        case 'alert':
                            dialog.alert({
                                theme: options.theme || 'white',
                                title: options.title || '',
                                message: options.message || '',
                                buttonText: options.buttonText || 'OK',
                                icon: options.icon || 'info'
                            }).then(resolve).catch(reject);
                            break;
                            
                        case 'prompt':
                            dialog.prompt({
                                theme: options.theme || 'white',
                                title: options.title || 'Enter Value',
                                message: options.message || '',
                                label: options.label || '',
                                placeholder: options.placeholder || '',
                                value: options.value || '',
                                inputType: options.inputType || 'text',
                                inputAttrs: options.inputAttrs || {},
                                confirmText: options.confirmText || 'Submit',
                                cancelText: options.cancelText || 'Cancel',
                                showCloseButton: options.showCloseButton !== false
                            }).then(resolve).catch(reject);
                            break;
                            
                        case 'success':
                            dialog.success({
                                title: options.title || 'Success',
                                message: options.message || 'Operation completed successfully.',
                                buttonText: options.buttonText || 'OK'
                            }).then(resolve).catch(reject);
                            break;
                            
                        case 'error':
                            dialog.error({
                                title: options.title || 'Error',
                                message: options.message || 'An error occurred.',
                                buttonText: options.buttonText || 'OK'
                            }).then(resolve).catch(reject);
                            break;
                            
                        case 'warning':
                            dialog.warning({
                                title: options.title || 'Warning',
                                message: options.message || 'Please be careful.',
                                buttonText: options.buttonText || 'OK'
                            }).then(resolve).catch(reject);
                            break;
                            
                        default:
                            dialog.confirm(options).then(resolve).catch(reject);
                    }
                } catch (error) {
                    console.error('Error showing dialog:', error);
                    reject(error);
                }
            };

            // Check if ManomiteDialog is already loaded
            if (window.ManomiteDialog) {
                showDialog();
                return;
            }

            // Load the confirm component if not already loaded
            loadjs([BASE + "asset/script/js/components/confirm.js"], {
                async: true,
                success: function () {
                    setTimeout(() => {
                        if (!window.ManomiteDialog) {
                            reject(new Error('ManomiteDialog not available after loading script'));
                            return;
                        }
                        showDialog();
                    }, 50);
                },
                error: function () {
                    console.error('Failed to load ManomiteDialog script');
                    reject(new Error('Failed to load ManomiteDialog script'));
                }
            });
        });
    };

    // Shortcut functions for convenience
    window.confirmDialog = (message, options = {}) => window.dialogController('confirm', { message, ...options });
    window.deleteDialog = (message, options = {}) => window.dialogController('delete', { message, ...options });
    window.alertDialog = (message, options = {}) => window.dialogController('alert', { message, ...options });
    window.promptDialog = (message, options = {}) => window.dialogController('prompt', { message, ...options });
    window.successDialog = (message, options = {}) => window.dialogController('success', { message, ...options });
    window.errorDialog = (message, options = {}) => window.dialogController('error', { message, ...options });
    window.warningDialog = (message, options = {}) => window.dialogController('warning', { message, ...options });
    
    // Keep backward compatibility
    window.confirmController = (options = {}) => window.dialogController('confirm', options);
})();

(function () {
    /**
     * Initiates a Paystack inline payment and returns a promise.
     * @param {object} options - Configuration for the payment.
     * @param {string} options.key - Your Paystack public key (e.g., 'pk_test_xxxxxxxxxx').
     * @param {string} options.email - The customer's email address.
     * @param {number} options.amount - The amount in the lowest currency unit (e.g., kobo for NGN).
     * @param {string} [options.ref] - A unique transaction reference. A unique one is generated if not provided.
     * @param {string} [options.currency='NGN'] - The transaction currency (e.g., 'NGN', 'GHS', 'USD').
     * @param {function} [options.onSuccess] - Optional callback function to execute on successful payment.
     * @returns {Promise<object>} A promise that resolves with the transaction response on success or rejects on failure/closure.
     */
    window.paystackInlineController = function (options = {}) {
        // --- Basic Validation ---
        if (!options.key || !options.email || !options.amount) {
            const errorMsg = 'Paystack options require a valid `key`, `email`, and `amount`.';
            console.error(errorMsg);
            // Return a rejected promise for invalid initial data
            return Promise.reject(new Error(errorMsg));
        }

        return new Promise((resolve, reject) => {
            // --- Function to Initialize Payment ---
            const initPayment = () => {
                try {
                    const handler = PaystackPop.setup({
                        key: options.key,
                        email: options.email,
                        amount: options.amount,
                        currency: options.currency || 'NGN',
                        // Generate a unique reference if not provided
                        ref: options.ref || 'PS_' + Date.now(),
                        // Callback executed on successful payment
                        callback: function (response) {
                            // Invoke the onSuccess callback if provided
                            if (typeof options.onSuccess === 'function') {
                                options.onSuccess(response);
                            }
                            // Resolve the promise with the successful transaction response
                            resolve(response);
                        },
                        // Callback executed when the user closes the modal
                        onClose: function () {
                            // Reject the promise
                            reject(new Error('Payment closed.'));
                        },
                    });
                    // Open the Paystack payment iframe
                    handler.openIframe();
                } catch (error) {
                    reject(error);
                }
            };

            if (typeof PaystackPop !== 'undefined') {
                initPayment();
            } else {
                const script = document.createElement('script');
                script.src = 'https://js.paystack.co/v1/inline.js';
                script.async = true;

                // On successful script load, initialize the payment
                script.onload = () => {
                    initPayment();
                };

                // On script load failure, reject the promise
                script.onerror = () => {
                    const loadError = new Error('Failed to load the Paystack inline script.');
                    reject(loadError);
                };

                document.head.appendChild(script);
            }
        });
    };
})();

var cartSubTotal = 0;
var cartTotal = 0;
var tax = 0;
var totalItems = 0;

$(window).on('load', function () {

    if ($('.load-3-media').length) {

        var formData = new FormData();
        var button = $('.load-3-media').html();
        formData.append('request', 'load_recent_media');
        formData.append('fingerprint', radar._Tracker().deviceFingerPrint);

        general.ajaxFormData('.load-3-media', 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '.load-3-media', button, function (data) {
            $('.load-3-media').html(data.media);
        }, 'centerLoader');
    }

    if ($('.load-all-course-menu').length) {
        if (storage.get('courses_productOrderId') == null || storage.get('courses_productOrderId') == 'undefined' || storage.get('courses_productOrderId') == '') {
            storage.set('courses_productOrderId', generateSecuredUUID());
        }

        $('.generateOrderId').html(storage.get('courses_productOrderId'));
        $('.submitCart').attr('id', 'cartProcessor_'+storage.get('courses_productOrderId'));
        $('.submitCart').attr('category', 'courses');

        var formData = new FormData();
        var button = $('.load-all-course-menu').html();
        formData.append('request', 'load_course_menu');
        formData.append('cardOrderId', storage.get('courses_productOrderId'));
        formData.append('fingerprint', radar._Tracker().deviceFingerPrint);

        general.ajaxFormData('.load-all-course-menu', 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '.load-all-course-menu', button, function (data) {
            $('.load-all-course-menu').append(data.category);
            $('#orderHistoryTab').html(data.allCarts);

            if (data.allCarts == '') {
                $('.countHistoryOrder').text("Order History (0)");
            } else {
                const historyOrderTabCount = updateProductCount('.orderHistoryTab');
                $('.countHistoryOrder').text("Order History (" + historyOrderTabCount + ")");

                totalItems += historyOrderTabCount;
                $('.totalCart').text(totalItems);
            }

            storage.set('courses_cartSubTotal', data.cartSubTotal);
            storage.set('courses_cartTotal', data.cartTotal);
            storage.set('courses_tax', data.tax);

            $('.subTotalAmount').text('₦' + parseFloat(data.cartSubTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            $('.taxAmount').text('₦' + parseFloat(data.tax).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            $('.totalAmount').text('₦' + parseFloat(data.cartTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

        }, 'centerLoader');
    }

    if ($('.load-courses').length) {

        var formData = new FormData();
        var button = $('.load-courses').html();
        formData.append('request', 'load_category_courses');
        formData.append('category', 'all');
        formData.append('fingerprint', radar._Tracker().deviceFingerPrint);
        storage.set('selectedCategory', 'courses');
        storage.set('categoryId', 'all');

        general.ajaxFormData('.load-courses', 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '.load-courses', button, function (data) {
            $('.load-courses').html(data.products);
            if (data.pagination != '' && data.pagination != undefined) {
                $('.paginationInfo').html(data.pagination.info);
                $('.paginationData').html(data.pagination.html);
            }
        }, 'pageLoader');
    }

    $(document).on('click', '.pos-menu [data-filter]', function (e) {
        e.preventDefault();
        var targetType = $(this).attr('data-filter');
        var category = $(this).attr('category');

        $(this).addClass('active');
        $('.pos-menu [data-filter]').not(this).removeClass('active');
        if (targetType == 'all') {
            $('.pos-content [data-type]').removeClass('d-none');
        } else {
            $('.pos-content [data-type="' + targetType + '"]').removeClass('d-none');
            $('.pos-content [data-type]').not('.pos-content [data-type="' + targetType + '"]').addClass('d-none');
        }

        var formData = new FormData();
        var button = $('.category-' + this.id).html();
        formData.append('request', 'load_category_' + category);
        formData.append('category', this.id);
        formData.append('fingerprint', radar._Tracker().deviceFingerPrint);
        storage.set('selectedCategory', category);
        storage.set('categoryId', this.id);

        general.ajaxFormData('.category-' + this.id, 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '.category-' + this.id, button, function (data) {
            $('.all-product-list').html(data.products);

            if (data.pagination != '' && data.pagination != undefined) {
                $('.paginationInfo').html(data.pagination.info);
                $('.paginationData').html(data.pagination.html);
            }
        }, 'themeLoader')
    });

    $(document).on("click", ".marketplace_pagination", function (e) {
        e.preventDefault();
        var id = this.id;
        var button = $('#' + id).html();

        var formData = new FormData();
        formData.append('request', 'load_category_' + storage.get('selectedCategory'));
        formData.append('category', storage.get('categoryId'));
        formData.append('fingerprint', radar._Tracker().deviceFingerPrint);
        formData.append('page', id.replace('page-', ''));

        general.ajaxFormData('#' + id, 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '#' + id, button, function (data) {
            $('.all-product-list').html(data.products);
            if (data.pagination != '' && data.pagination != undefined) {
                $('.paginationInfo').html(data.pagination.info);
                $('.paginationData').html(data.pagination.html);
            }
        }, 'themeLoader');
    });

    $(document).on("click", ".pos-product", function (e) {
        e.preventDefault();

        var $btn = $(this);
        var courseId = $btn.attr('id').replace('product-', '');
        var category = $btn.attr('category');
        var button = $btn.html();

        var formData = new FormData();
        formData.append('fingerprint', radar._Tracker().deviceFingerPrint);
        formData.append('request', 'product_' + category);
        formData.append('product_id', courseId);

        general.ajaxFormData('#' + this.id, 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '#' + this.id, button, function (data) {

            $('#modalScreen').html(data.modal);
            var myModal = new bootstrap.Modal(document.getElementById(data.modalId), {
                backdrop: 'static',
                keyboard: false
            });
            myModal.show();

        }, 'pageLoader');
    });


    $(document).on("click", ".addToCart", function (e) {
        e.preventDefault();

        var $btn = $(this);
        var productId = $btn.attr('id').replace('myProduct-', '');
        var category = $btn.attr('category')
        var button = $btn.html();
        var getCartID = storage.get(category + '_productOrderId');

        var formData = new FormData();
        formData.append('fingerprint', radar._Tracker().deviceFingerPrint);
        formData.append('request', 'product_cart_' + category);
        formData.append('product_id', productId);
        formData.append('cart_id', getCartID);

        general.ajaxFormData('#' + this.id, 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '#' + this.id, button, function (data) {
            //render card

            $('#newOrderTab').html(data.cart);
            gToast.success(data.message);

            const newOrderTabCount = updateProductCount('#newOrderTab');
            $('.countNewOrder').text("New Order (" + newOrderTabCount + ")");

            $('.totalCart').text(newOrderTabCount);

            var subTotal = data.subTotal;
            var cartTotal = data.total;
            var tax = data.tax;

            $('.subTotalAmount').text('₦' + parseFloat(subTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            $('.taxAmount').text('₦' + parseFloat(tax).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            $('.totalAmount').text('₦' + parseFloat(cartTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

            //close modal
            $('#modal_view_course').modal('hide');


        }, 'centerLoader');
    });

    $(document).on("click", ".removeItem", function (e) {
        e.preventDefault();

        var $btn = $(this);
        var productId = $btn.attr('id').replace('myProductRem_', '');
        var category = $btn.attr('category')
        var button = $btn.html();
        var getCartID = storage.get(category + '_productOrderId');

        if (typeof confirmDialog !== 'undefined') {
            confirmDialog('Are you sure you want to remove this item?').then(function (result) {
                if (result) {

                    var formData = new FormData();
                    formData.append('fingerprint', radar._Tracker().deviceFingerPrint);
                    formData.append('request', 'product_cart_remove_' + category);
                    formData.append('product_id', productId);
                    formData.append('cart_id', getCartID);

                    general.ajaxFormData('#' + $btn.attr('id'), 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '#' + $btn.attr('id'), button, function (data) {
                        $('.myProductItem_' + productId).remove();
                        gToast.success(data.message);

                        const newOrderTabCount = updateProductCount('#newOrderTab');
                        if(parseFloat(data.subTotal) == 0){
                            $('.countNewOrder').text("New Order (0)");
                            $('.totalCart').text('0');
                            $('.countHistoryOrder').text("Order History (0)");
                            $('#newOrderTab').html(data.cart);
                            $('#orderHistoryTab').html(data.cart);
                        } else {
                            $('.countNewOrder').text("New Order (" + newOrderTabCount + ")");
                            $('.totalCart').text(newOrderTabCount);

                            //If its from order history cart 
                            const historyOrderTabCount = updateProductCount('.orderHistoryTab');
                            $('.countHistoryOrder').text("Order History (" + historyOrderTabCount + ")");
                            
                            if(parseFloat(historyOrderTabCount) !== 0){
                                $('.totalCart').text(historyOrderTabCount);
                                $('#orderHistoryTab').html(data.cart);
                            } else {
                                $('#newOrderTab').html(data.cart);
                            }
                        }

                        var subTotal = data.subTotal;
                        var cartTotal = data.total;
                        var tax = data.tax;

                        $('.subTotalAmount').text('₦' + parseFloat(subTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
                        $('.taxAmount').text('₦' + parseFloat(tax).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
                        $('.totalAmount').text('₦' + parseFloat(cartTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

                    }, 'themeLoader');
                }
            });
        }
    });

    $(document).on("click", ".submitCart", function (e) {
        e.preventDefault();

        var $btn = $(this);
        var cartId = $btn.attr('id').replace('cartProcessor_', '');
        var category = $btn.attr('category')
        var button = $btn.html();
       
        if (typeof confirmDialog !== 'undefined') {
            confirmDialog('Are you sure you want to submit this order?').then(function (result) {
                if (result) {

                    var formData = new FormData();
                    formData.append('fingerprint', radar._Tracker().deviceFingerPrint);
                    formData.append('request', 'product_cart_process_' + category);
                    formData.append('cart_id', cartId);

                    general.ajaxFormData('#' + $btn.attr('id'), 'POST', BASE + 'src/Processor/Auth/auth.php', formData, '#' + $btn.attr('id'), button, function (data) {
                        console.log(data);
                        if(data.instructions && data.instructions != ''){
                            //If user not loggedIn or session expired
                            $('#' + $btn.attr('id')).attr('disabled', true);
                            $('#' + $btn.attr('id')).attr('style', 'opacity: 0.5');
                            document.querySelector('#' + $btn.attr('id')).style.pointerEvents = "none";
                            $('#' + $btn.attr('id')).html('Redirecting...');
                            storage.set('temp_redirect', data.temp_redirect);
                            general.redirect(data.instructions);
                            return;
                        }

                        if(data.free === true){
                            storage.set(category+'_productOrderId', '');
                            gToast.success(data.message);
                            storage.set('temp_redirect', '');
                            general.redirect(data.url);
                            return;
                        } 
                        //Load paystack payment modal
                        paystackInlineController({
                            key: data.key,
                            ref: data.ref,
                            email: data.email,
                            amount: data.amount,
                            currency: 'NGN',
                            onSuccess: async (transaction) => {
                                var verifyFormData = new FormData();
                                verifyFormData.append('fingerprint', radar._Tracker().deviceFingerPrint);
                                verifyFormData.append('request', 'paymentVerify');
                                verifyFormData.append('reference', transaction.reference);
                                verifyFormData.append('category', category);
                                general.ajaxFormData('#' + $btn.attr('id'), 'POST', BASE + 'src/Processor/Auth/auth.php', verifyFormData, '#' + $btn.attr('id'), button, function (verifyData) {
                                    storage.set(category+'_productOrderId', '');
                                    gToast.success(data.message);
                                    storage.set('temp_redirect', '');
                                    general.redirect(verifyData.url);
                                    return;
                                }, 'centerLoader');
                            }
                        }).catch(error => {
                            gToast.error('Payment error: ' + error.message);
                        });

                    }, 'themeLoader');
                }
            });
        }
    });

    $(document).on('click', '.counterModule', function (e) {
        e.preventDefault();
        var $btn = $(this);
        var moduleId = $btn.attr('id');
        var moduleType = $btn.attr('type');
        var category = $btn.attr('category');

        if (moduleType == 'increase') {
            var currentVal = parseInt($('.valueCount-' + moduleId.replace('increase_', '')).val());
        } else if (moduleType == 'decrease') {
            var currentVal = parseInt($('.valueCount-' + moduleId.replace('decrease_', '')).val());
        }

        $('.valueCount-' + moduleId.replace('increase_', '').replace('decrease_', '')).val(
            moduleType == 'increase' ? (currentVal + 1).toString() : (currentVal > 1 ? (currentVal - 1).toString() : '1')
        );

        var amount = parseInt($('.valueCount-' + moduleId.replace('increase_', '').replace('decrease_', '')).attr('amount'));

        var totalAmount = amount * parseInt($('.valueCount-' + moduleId.replace('increase_', '').replace('decrease_', '')).val());

        $('#totalAmount_' + moduleId.replace('increase_', '').replace('decrease_', '')).text('₦' + totalAmount.toFixed(2));

        // Calculate subtotal based on current quantity, not cumulative
        var quantity = parseInt($('.valueCount-' + moduleId.replace('increase_', '').replace('decrease_', '')).val());
        var subTotal = amount * quantity;
        var tax = subTotal * 0.075;
        var cartTotal = subTotal + tax;

        storage.set(category + '_cartSubTotal', subTotal);
        storage.set(category + '_tax', tax);
        storage.set(category + '_cartTotal', cartTotal);

        $('.subTotalAmount').text('₦' + parseFloat(subTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        $('.taxAmount').text('₦' + parseFloat(tax).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        $('.totalAmount').text('₦' + parseFloat(cartTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

    });

    // Mobile sidebar toggle (cart) - toggles class on target and manages overlay
    $(document).on('click', '.pos-mobile-sidebar-toggler', function (e) {
        e.preventDefault();
        var $btn = $(this);
        var toggleClass = $btn.attr('data-toggle-class') || 'pos-mobile-sidebar-toggled';
        var targetSelector = $btn.attr('data-toggle-target') || '#pos';
        var $target = $(targetSelector);

        if (!$target.length) return;

        $target.toggleClass(toggleClass);
        var isOpen = $target.hasClass(toggleClass);

        // manage overlay which closes the sidebar when clicked
        var $overlay = $('#pos-mobile-overlay');
        if (isOpen) {
            if (!$overlay.length) {
                $overlay = $('<div id="pos-mobile-overlay"></div>');
                $overlay.css({ position: 'fixed', inset: 0, 'z-index': 998, background: 'rgba(0,0,0,0.35)' }).appendTo('body');
                $overlay.on('click', function () {
                    $target.removeClass(toggleClass);
                    $(this).remove();
                });
            }
            // optional: prevent body scroll while sidebar open
            $('body').addClass('pos-sidebar-open');
        } else {
            $overlay.remove();
            $('body').removeClass('pos-sidebar-open');
        }

        // emit an event for other scripts to react (e.g., update focus)
        $(document).trigger('pos:sidebar:toggled', [isOpen, $target]);
    });

})

if (document.getElementsByClassName('MAnchors_').length) {
    let clearAnalyticsInterval = setInterval(function () {
        const anchorKey = storage.get('anchorKey');
        if (anchorKey != 'undefined' && anchorKey !== '') {
            clearInterval(clearAnalyticsInterval);

            var tracking = document.getElementsByClassName('MAnchors_');
            var anchor = new Anchor;
            anchor.endpoint = BASE + 'src/Addons/anchor.php';
            anchor.token = JSON.stringify({ token: anchorKey, 'fingerprint': radar._Tracker().deviceFingerPrint });
            for (const tt of tracking) {
                anchor.init({
                    clickCount: true,
                    clickDetails: true,
                    context: true,
                    textCopy: true,
                    actionItem: {
                        processOnAction: true,
                        selector: tt
                    },
                });
            }
        }
    }, 1000);
}