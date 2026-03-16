var general = new General;

(function () {
    // Define the global modalController function
    window.modalController = function (modalId, options = { bgClose: false, keyboard: false }) {
        return new Promise((resolve, reject) => {
            // Use loadjs to load the ModalController script
            loadjs(["/public/home/ui/js/components/modal.js"], {
                async: true,
                success: function () {
                    try {
                        const modalElement = document.getElementById(modalId);
                        if (!modalElement) {
                            console.error(`Modal with ID ${modalId} not found`);
                            reject(new Error(`Modal with ID ${modalId} not found`));
                            return;
                        }

                        const modal = new ModalController(modalElement, options).init();
                        resolve(modal);
                    } catch (error) {
                        console.error('Error initializing modal:', error);
                        reject(error);
                    }
                },
                error: function () {
                    console.error('Failed to load ModalController script');
                    reject(new Error('Failed to load ModalController script'));
                }
            });
        });
    };
})();

/* FormStepper
 * A reusable multi-step form controller.
 * Usage:
 *   var stepper = new FormStepper({
 *       container: '#myModal',           // Container element or selector
 *       stepSelector: '.step',           // Step content selector (with data-step="N")
 *       stepItemSelector: '.step-item',  // Step indicator selector (with data-step="N")
 *       btnNext: '#btn_next',            // Next button selector
 *       btnPrev: '#btn_prev',            // Previous button selector
 *       activeClass: 'fw-bold',          // Class for active step indicator
 *       inactiveClass: 'stripe-muted',   // Class for inactive step indicators
 *       onStepChange: function(step, totalSteps) {},  // Callback on step change
 *       onComplete: function() {}        // Callback when user clicks Next on last step
 *   });
 */
class FormStepper {
    constructor(opts) {
        this.container = (typeof opts.container === 'string') ? document.querySelector(opts.container) : opts.container;
        if (!this.container) return;

        this.stepSelector = opts.stepSelector || '[id^="step-"]';
        this.stepItemSelector = opts.stepItemSelector || '[data-step-item]';
        this.activeClass = opts.activeClass || 'text-indigo-600';
        this.inactiveClass = opts.inactiveClass || 'text-slate-400';
        this.onStepChange = opts.onStepChange || null;
        this.onComplete = opts.onComplete || null;
        this.lastStepBtnText = opts.lastStepBtnText || 'Finish';
        this.nextBtnText = opts.nextBtnText || 'Next';

        // Collect step elements by either id="step-N" or data-step="N" and sort numerically.
        // This allows using either pattern: <div id="step-1"> or <div class="step" data-step="1">.
        (function(){
            const els = Array.from(this.container.querySelectorAll(this.stepSelector));
            const mapped = els.map(function(s){
                var num = null;
                var idMatch = (s.id || '').match(/^step-(\d+)$/);
                if(idMatch) num = parseInt(idMatch[1], 10);
                else {
                    var ds = s.getAttribute('data-step');
                    if(ds && /^\d+$/.test(ds)) num = parseInt(ds, 10);
                }
                return { el: s, num: num };
            }).filter(function(o){ return o.num !== null; });
            mapped.sort(function(a,b){ return a.num - b.num; });
            this.steps = mapped.map(function(o){ return o.el; });
        }).call(this);
        // step items (indicators) are likely outside the container (sidebar), query globally
        this.stepItems = Array.from(document.querySelectorAll(this.stepItemSelector));
        this.btnNext = opts.btnNext ? (this.container.querySelector(opts.btnNext) || document.querySelector(opts.btnNext)) : null;
        this.btnPrev = opts.btnPrev ? (this.container.querySelector(opts.btnPrev) || document.querySelector(opts.btnPrev)) : null;

        this.currentStep = 1;
        this.previousStep = 1;
        this._bindEvents();
        this.goToStep(1);
    }

    _bindEvents() {
        var self = this;
        if (this.btnNext) {
            this.btnNext.addEventListener('click', function () {
                if (self.currentStep < self.steps.length) {
                    self.next();
                } else {
                    if (typeof self.onComplete === 'function') self.onComplete();
                }
            });
        }
        if (this.btnPrev) {
            this.btnPrev.addEventListener('click', function () {
                self.prev();
            });
        }
    }

    goToStep(n) {
        this.currentStep = Math.max(1, Math.min(n, this.steps.length));
        var self = this;

        // hide all steps then show by id (#step-N) as a primary lookup
        this.steps.forEach(function (s) { s.classList.add('hidden'); });
        var active = document.getElementById('step-' + this.currentStep) || this.container.querySelector(this.stepSelector + '[data-step="' + this.currentStep + '"]');
        if (active) {
            active.classList.remove('hidden');
            // choose slide animation based on direction
            var animation = (this.currentStep >= this.previousStep) ? 'slideInRight' : 'slideInLeft';
            try { if (window.animateCSS) window.animateCSS(active, animation).catch(()=>{}); } catch(e){}
        }

        this.stepItems.forEach(function (it) {
            it.classList.remove(self.activeClass);
            it.classList.add(self.inactiveClass);
        });
        var sit = document.querySelector(this.stepItemSelector + '[data-step="' + this.currentStep + '"]');
        if (sit) {
            sit.classList.add(this.activeClass);
            sit.classList.remove(this.inactiveClass);
        }

        if (this.btnNext) {
            var label = (this.currentStep === this.steps.length) ? this.lastStepBtnText : this.nextBtnText;
            var labelEl = this.btnNext.querySelector('.stepper-label');
            if (labelEl) labelEl.textContent = label; else this.btnNext.textContent = label;
        }
        if (this.btnPrev) this.btnPrev.style.visibility = (this.currentStep === 1) ? 'hidden' : 'visible';

        if (typeof this.onStepChange === 'function') this.onStepChange(this.currentStep, this.steps.length);
        // update previousStep after showing
        this.previousStep = this.currentStep;
    }

    next() {
        if (this.currentStep < this.steps.length) this.goToStep(this.currentStep + 1);
    }

    prev() {
        if (this.currentStep > 1) this.goToStep(this.currentStep - 1);
    }

    reset() {
        this.goToStep(1);
    }

    getCurrentStep() {
        return this.currentStep;
    }

    getTotalSteps() {
        return this.steps.length;
    }
}
window.FormStepper = FormStepper;

/**
 * animateCSS
 * Helper to add animate.css animations to an element and return a Promise when finished.
 * @param {HTMLElement} element
 * @param {string} animation - animation name without prefix, e.g. 'slideInRight'
 * @param {number|null} seconds - optional duration in seconds
 * @param {string} prefix - class prefix, default 'animate__'
 */
window.animateCSS = function(element, animation, seconds = 0.45, prefix = 'animate__') {
    return new Promise((resolve, reject) => {
        if (!element) return resolve();
        const animationName = `${prefix}${animation}`;
        const animatedClass = `${prefix}animated`;

        // Clean up any leftover animation classes that use the prefix
        element.classList.forEach(cl => { if (cl.indexOf(prefix) === 0) element.classList.remove(cl); });

        element.classList.add(animatedClass, animationName);
        if (seconds) element.style.setProperty('--animate-duration', `${seconds}s`);
        // smoother timing function
        element.style.setProperty('animation-timing-function', 'cubic-bezier(0.22, 0.8, 0.24, 1)');

        function handleAnimationEnd(event) {
            event.stopPropagation();
            element.classList.remove(animatedClass, animationName);
            if (seconds) element.style.removeProperty('--animate-duration');
            element.style.removeProperty('animation-timing-function');
            element.removeEventListener('animationend', handleAnimationEnd);
            resolve();
        }

        element.addEventListener('animationend', handleAnimationEnd);
    });
};

(function () {
    window.confirmModalController = function (options = { 
        title: 'Confirm Action',
        message: 'Are you sure you want to proceed?',
        confirmText: 'Confirm',
        cancelText: 'Cancel',
        bgClose: true,
        keyboard: true 
    }) {
        return new Promise((resolve, reject) => {
            // Dynamically load the ConfirmModal script
            loadjs(["/public/home/ui/js/components/confirm.js"], {
                async: true,
                success: function () {
                    try {
                        // Initialize ConfirmModal
                        const modal = new ConfirmModal();
                        
                        // Configure modal with options
                        modal.confirm({
                            title: options.title,
                            message: options.message,
                            confirmText: options.confirmText,
                            cancelText: options.cancelText
                        }).then(result => {
                            resolve(result);
                        });
                        
                        // Update modal behavior based on options
                        modal.modal.dataset.bgClose = options.bgClose;
                        modal.modal.dataset.keyboard = options.keyboard;
                        
                    } catch (error) {
                        console.error('Error initializing ConfirmModal:', error);
                        reject(error);
                    }
                },
                error: function () {
                    console.error('Failed to load ConfirmModal script');
                    reject(new Error('Failed to load ConfirmModal script'));
                }
            });
        });
    };
})();

(function () {
    window.paginationController = function (options = { 
        url: '',           // API Endpoint
        tableId: '',       // ID of the <tbody>
        renderer: null,    // Function to generate row HTML
        limit: 5,          // Items per page
        loadingText: 'Loading...',
        emptyText: 'No records found'
    }) {
        return new Promise((resolve, reject) => {
            loadjs(["/public/home/ui/js/components/pagination.js"], {
                async: true,
                success: function () {
                    try {
                        if (!options.url || !options.tableId || !options.renderer) {
                            throw new Error('Pagination requires url, tableId, and renderer options.');
                        }

                        const pager = new Pagination(
                            options.url, 
                            options.tableId, 
                            options.renderer, 
                            { 
                                limit: options.limit,
                                loadingText: options.loadingText,
                                emptyText: options.emptyText
                            }
                        );
                        
                        resolve(pager);
                        
                    } catch (error) {
                        console.error('Error initializing Pagination:', error);
                        reject(error);
                    }
                },
                error: function () {
                    console.error('Failed to load Pagination script');
                    reject(new Error('Failed to load Pagination script'));
                }
            });
        });
    };
})();

function telephone(){
  if($('#phone').length){
        loadjs(["/public/home/plugin/tel/js/intlTelInput.min.js", "/public/home/plugin/tel/css/intlTelInput.min.css"], {
        async: true,
        success: function () {
          const input = document.querySelector("#phone");
          if(input){
            intl = window.intlTelInput(input, {
              preferredCountries: ["ng"],
              separateDialCode: true,
              initialCountry: "ng",
              loadUtils: () => import("/public/home/plugin/tel/js/utils.js"),
            });
          }
        }
      });
    }
}


function formatMoneyInput(className, decimalPlaces = 2) {
    const inputs = document.querySelectorAll(`.${className}`);

    inputs.forEach(input => {
        input.addEventListener('input', function(e) {
            // Get the raw value and remove non-numeric characters except decimal
            let value = e.target.value.replace(/[^0-9.]/g, '');

            // Ensure only one decimal point
            const parts = value.split('.');
            if (parts.length > 2) {
                parts.length = 2;
                value = parts.join('.');
            }

            // Format the number
            if (value) {
                // Split into integer and decimal parts
                let [integerPart, decimalPart = ''] = value.split('.');

                // Add commas to integer part and format with specified decimal places
                integerPart = parseInt(integerPart.replace(/^0+/, '')) || 0;
                integerPart = integerPart.toLocaleString('en-US', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0
                });

                // Handle decimal part
                if (decimalPart) {
                    // Truncate decimal part to specified decimal places
                    decimalPart = decimalPart.slice(0, decimalPlaces);
                    // Pad with zeros if needed
                    decimalPart = decimalPart.padEnd(decimalPlaces, '0');
                    value = `${integerPart}.${decimalPart}`;
                } else {
                    // Add decimal places with zeros if no decimal part exists
                    value = `${integerPart}.${'0'.repeat(decimalPlaces)}`;
                }

                e.target.value = value;
            } else {
                e.target.value = `0.${'0'.repeat(decimalPlaces)}`;
            }
        });

        // Handle paste to ensure proper formatting
        input.addEventListener('paste', function(e) {
            setTimeout(() => {
                // Trigger input event to format pasted content
                input.dispatchEvent(new Event('input'));
            }, 0);
        });
    });
}

/* @param {string} futureDateString - The target date and time. Can be a timestamp,
 * or a string in formats like 'YYYY-MM-DD HH:mm:ss', 'Month Day, YYYY HH:mm:ss', etc.
 * The JavaScript `new Date()` constructor will parse it.
 * @param {HTMLElement} containerElement - The DOM element that contains the countdown display spans.
 */
function startCountdown(futureDateString, containerElement, onCompleteCallback) {
    if (!containerElement) {
        console.error("Countdown Error: The container element provided is invalid.");
        return;
    }

    // Select the display elements once to avoid querying the DOM on every tick (for efficiency).
    const daysEl = containerElement.querySelector('span:nth-child(1)');
    const hoursEl = containerElement.querySelector('div:nth-child(2) > span');
    const minutesEl = containerElement.querySelector('div:nth-child(3) > span');
    const secondsEl = containerElement.querySelector('div:nth-child(4) > span');

    if (!daysEl || !hoursEl || !minutesEl || !secondsEl) {
        console.error("Countdown Error: Could not find all the required <span> elements within the container.");
        return;
    }

    const targetDate = new Date(futureDateString);

    if (isNaN(targetDate.getTime())) {
        console.error(`Countdown Error: Invalid date format provided: "${futureDateString}"`);
        [daysEl, hoursEl, minutesEl, secondsEl].forEach(el => el.textContent = '??');
        return;
    }

    // --- 2. THE COUNTDOWN LOGIC ---
    const intervalId = setInterval(() => {
        const now = new Date().getTime();
        const distance = targetDate.getTime() - now;

        // If the countdown is finished.
        if (distance < 0) {
            clearInterval(intervalId); // Stop the timer.
            daysEl.textContent = '00';
            hoursEl.textContent = '00';
            minutesEl.textContent = '00';
            secondsEl.textContent = '00';

            // NEW: Execute the callback function if it exists.
            if (typeof onCompleteCallback === 'function') {
                onCompleteCallback(containerElement.parentElement); // Pass the parent card for more control
            }
            return;
        }

        // Time calculations
        const days = Math.floor(distance / (1000 * 60 * 60 * 24));
        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);

        // --- 3. UPDATE THE DOM ---
        daysEl.textContent = String(days).padStart(2, '0');
        hoursEl.textContent = String(hours).padStart(2, '0');
        minutesEl.textContent = String(minutes).padStart(2, '0');
        secondsEl.textContent = String(seconds).padStart(2, '0');

    }, 1000);
}

class SimpleRoute {
  constructor() {
    this.routes = new Map();
    this.registeredRoute = [];
  }

  route(action, callback) {
    if (typeof action !== 'string' || typeof callback !== 'function') {
      throw new TypeError('Action must be a string and callback must be a function');
    }
    const cleanAction = action.trim().replace(/^\/+|\/+$/g, '');
    this.registeredRoute.push(cleanAction);
    this.routes.set(cleanAction, callback);
  }

  dispatch(action) {
    if (typeof action !== 'string') {
      throw new TypeError('Action must be a string');
    }
    const cleanAction = action.trim().replace(/^\/+|\/+$/g, '');
    if (this.validateRoute(cleanAction)) {
      const callback = this.routes.get(cleanAction);
      return callback ? callback() : null;
    }
    return null;
  }

  validateRoute(action) {
    const cleanAction = action.trim().replace(/^\/+|\/+$/g, '');
    return this.registeredRoute.includes(cleanAction);
  }
}

function isNumber(x, noStr) {
  return (
    (typeof x === 'number' || x instanceof Number || (!noStr && x && typeof x === 'string' && !isNaN(x))) &&
    isFinite(x)
  ) || false;
};

function isEmpty(value) {
  return (
    (value == null) ||
    (value.hasOwnProperty('length') && value.length === 0) ||
    (value.constructor === Object && Object.keys(value).length === 0)
  )
}


var substringMatcher = function (strs) {
  return function findMatches(q, cb) {
    var matches, substrRegex;
    matches = [];
    substrRegex = new RegExp(q, 'i');
    $.each(strs, function (i, str) {
      if (substrRegex.test(str)) {
        matches.push(str);
      }
    });

    cb(matches);
  };
};

let currentIndex = 0;

// Function to initialize or reinitialize Typed.js
function startTyping(selector, message, speed) {

  // Create a new span for the current string
  const typedElement = document.createElement('span');
  typedElement.className = 'typed-sentence';
  document.querySelector(selector).appendChild(typedElement);

  // Initialize Typed.js for the current string
  window.typed = new Typed(typedElement, {
    strings: [message[currentIndex]],
    typeSpeed: speed,
    showCursor: false, // Optional: Show cursor during typing
    onComplete: () => {
      currentIndex++;
      // If there are more strings, append a line break and continue typing
      if (currentIndex < message.length) {
        const br1 = document.createElement('br');
        const br2 = document.createElement('br');
        document.querySelector(selector).appendChild(br1);
        document.querySelector(selector).appendChild(br2);
        startTyping(selector, message, speed); // Start typing the next string
      }
    }
  });
}

/**
 * Create a poller that repeatedly fetches a URL and passes the parsed JSON
 * to a handler. The handler should return `true` to stop polling or `false` to
 * continue. The poller supports linear or exponential backoff and an optional
 * maximum attempts limit.
 *
 * Usage:
 * const p = createPoller({ url, handler, interval: 3000 });
 * p.start(); // returns a promise that resolves when polling stops
 * p.stop();  // stops early
 */
function createPoller({
  url,
  handler, // async function(data) => true|false (true stops)
  interval = 5000,
  maxAttempts = null, // null = infinite
  backoff = 'linear', // 'linear' or 'exponential'
  fetchOptions = {},
  parseJson = true
} = {}) {
  if (typeof url === 'undefined' || typeof handler !== 'function') {
    throw new Error('createPoller requires {url, handler}');
  }

  let attempts = 0;
  let running = false;
  let stopped = false;
  let timer = null;
  let controller = null;

  const stop = () => {
    stopped = true;
    running = false;
    if (timer) clearTimeout(timer);
    if (controller) controller.abort();
  };

  const isRunning = () => running;

  const start = () => new Promise((resolve, reject) => {
    if (running) return resolve();
    running = true;
    stopped = false;

    const loop = async () => {
      if (stopped) return resolve();
      if (maxAttempts !== null && attempts >= maxAttempts) {
        running = false;
        return resolve();
      }

      attempts++;
      controller = new AbortController();
      const signal = controller.signal;

      try {
        const res = await fetch(url, Object.assign({ signal }, fetchOptions));
        let data = res;
        if (parseJson) data = await res.json();

        // Handler may be sync or async. If it returns true, stop polling.
        const shouldStop = await handler(data, { attempts, res });
        if (shouldStop === true) {
          running = false;
          return resolve({ reason: 'handler-stopped', attempts });
        }
      } catch (err) {
        // Network errors / aborts will surface here; pass to handler if it accepts errors
        try {
          const shouldStopOnError = await handler(null, { error: err, attempts });
          if (shouldStopOnError === true) {
            running = false;
            return resolve({ reason: 'handler-stopped-on-error', attempts });
          }
        } catch (e) {
          // swallow handler error
        }
      }

      // compute next delay
      let delay = interval;
      if (backoff === 'exponential') {
        delay = Math.min(60000, interval * Math.pow(2, attempts - 1));
      }

      timer = setTimeout(loop, delay);
    };

    // start first iteration immediately
    loop();
  });

  return { start, stop, isRunning };
}

/**
 * Simple one-off helper: poll a URL until `predicate(data)` returns true.
 * Returns a promise that resolves with the last data.
 */
async function pollUntil(url, predicate, options = {}) {
  return new Promise((resolve, reject) => {
    const p = createPoller(Object.assign({}, options, {
      url,
      handler: async (data, ctx) => {
        try {
          if (data !== null && typeof predicate === 'function') {
            const ok = await predicate(data, ctx);
            if (ok) {
              p.stop();
              resolve(data);
              return true;
            }
          }
        } catch (e) {
          p.stop();
          return reject(e);
        }
        return false;
      }
    }));

    p.start().then(() => {
      // if polling stopped without predicate true, resolve null
      resolve(null);
    }).catch(reject);
  });
}

// Example usage (commented):
// const poller = createPoller({ url: '/api/job/status', handler: async (d) => { if (d.status === 'done') return true; return false } });
// poller.start();