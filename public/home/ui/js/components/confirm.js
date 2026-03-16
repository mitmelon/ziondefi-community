if (typeof ConfirmModal === 'undefined') {
(function(){
class ConfirmModal {
    constructor() {
        this.modal = null;
        this.resolvePromise = null;
        this.createModal();
    }

    createModal() {
        // Create modal container (Tailwind-only utility classes)
        this.modal = document.createElement('div');
        this.modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm hidden';
        this.modal.innerHTML = `
            <div class="bg-white rounded-xl shadow-lg max-w-md w-full mx-4">
                <div class="p-6 flex items-start gap-4">
                    <div class="flex-shrink-0 rounded-full bg-indigo-50 p-3">
                        <svg class="w-6 h-6 text-indigo-600" viewBox="0 0 16 16" width="24" height="24" aria-hidden="true">
                            <path d="M8 0C3.6 0 0 3.6 0 8s3.6 8 8 8 8-3.6 8-8-3.6-8-8-8zm1 12H7V7h2v5zM8 6c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"></path>
                        </svg>
                    </div>
                    <div class="flex-1">
                        <h3 id="modal-title" class="text-lg font-semibold text-slate-900">Confirm Action</h3>
                        <p id="modal-message" class="text-sm text-slate-500 mt-2">Are you sure you want to proceed?</p>
                        <div class="mt-6 flex justify-end gap-3">
                            <button id="cancel-btn" class="px-4 py-2 rounded-md text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200">Cancel</button>
                            <button id="confirm-btn" class="px-4 py-2 rounded-md text-sm font-medium bg-rose-600 text-white hover:bg-rose-700">Confirm</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Event listeners (guard selectors)
        const cancel = this.modal.querySelector('#cancel-btn');
        const confirm = this.modal.querySelector('#confirm-btn');
        if (cancel) cancel.addEventListener('click', () => this.close(false));
        if (confirm) confirm.addEventListener('click', () => this.close(true));

        // Close on outside click if enabled
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal && this.modal.dataset.bgClose !== 'false') {
                this.close(false);
            }
        });

        // Close on escape key if enabled
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal.classList.contains('flex') && this.modal.dataset.keyboard !== 'false') {
                this.close(false);
            }
        });
    }

    confirm({ title = 'Confirm Action', message = 'Are you sure you want to proceed?', confirmText = 'Confirm', cancelText = 'Cancel', bgClose = true, keyboard = true } = {}) {
        // Update modal content with guards
        const titleEl = this.modal.querySelector('#modal-title');
        const msgEl = this.modal.querySelector('#modal-message');
        const okEl = this.modal.querySelector('#confirm-btn');
        const cancelEl = this.modal.querySelector('#cancel-btn');
        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;
        if (okEl) okEl.textContent = confirmText;
        if (cancelEl) cancelEl.textContent = cancelText;
        this.modal.dataset.bgClose = bgClose;
        this.modal.dataset.keyboard = keyboard;

        // Show modal
        this.modal.classList.remove('hidden');
        this.modal.classList.add('flex');
        // Optional animation container (use created tailwind container)
        const modalContent = this.modal.querySelector('.max-w-md') || this.modal.querySelector('.bg-white') || this.modal.firstElementChild;
        if (modalContent) {
            try { modalContent.classList.remove('animate__fadeOut'); modalContent.classList.add('animate__fadeIn'); } catch (e) {}
        }

        // Return promise
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    }

    close(confirmed) {
        const modalContent = this.modal.querySelector('.max-w-md') || this.modal.querySelector('.bg-white') || this.modal.firstElementChild;
        if (modalContent) {
            try { modalContent.classList.remove('animate__fadeIn'); modalContent.classList.add('animate__fadeOut'); } catch (e) {}
        }

        // Wait for animation to complete before hiding (graceful)
        setTimeout(() => {
            try { this.modal.classList.add('hidden'); this.modal.classList.remove('flex'); } catch (e) {}
            if (this.resolvePromise) { this.resolvePromise(confirmed); this.resolvePromise = null; }
        }, 300);
    }
}
// expose globally
window.ConfirmModal = ConfirmModal;
})();
}