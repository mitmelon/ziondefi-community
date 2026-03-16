if (typeof ModalController === 'undefined') {
window.ModalController = class ModalController {
    constructor(element, options = {}) {
        this.modal = element;
        this.options = {
            bgClose: false,
            keyboard: false,
            ...options
        };
        this.isOpen = false;
        this.sizeClasses = {
            small: 'w-full max-w-xs',
            medium: 'w-full max-w-md',
            large: 'w-full max-w-4xl',
            xl: 'w-full max-w-5xl',
            xxl: 'w-full max-w-7xl',
            full: 'w-full max-w-none h-full'
        };

        // Bind event listeners
        this.handleOutsideClick = this.handleOutsideClick.bind(this);
        this.handleEscapeKey = this.handleEscapeKey.bind(this);
    }

    init() {
        if (!this.modal) {
            console.error('Modal element not found');
            return this;
        }

        this.modal.classList.add('hidden');
        this.isOpen = false;

        const closeButtons = this.modal.querySelectorAll('[data-modal-close]');
        closeButtons.forEach(button => {
            button.addEventListener('click', () => this.hide());
        });

        return this;
    }

    show() {
        if (!this.modal) return this;

        this.modal.classList.remove('hidden');
        this.modal.classList.add('flex');
        this.isOpen = true;
        document.body.classList.add('overflow-hidden');

        if (this.options.bgClose) {
            document.addEventListener('click', this.handleOutsideClick);
        }
        if (this.options.keyboard) {
            document.addEventListener('keydown', this.handleEscapeKey);
        }

        setTimeout(() => {
            this.modal.classList.add('opacity-100');
            this.modal.classList.remove('opacity-0');
            const dialog = this.modal.querySelector('.custom-modal-dialog');
            if (dialog) {
                dialog.classList.add('animate__slideInLeft');
                dialog.classList.remove('animate__slideOutLeft');
            }
        }, 10);

        return this;
    }

    hide() {
        if (!this.modal) return this;

        this.modal.classList.add('opacity-0');
        this.modal.classList.remove('opacity-100');
        const dialog = this.modal.querySelector('.custom-modal-dialog');
        if (dialog) {
            dialog.classList.add('animate__slideOutLeft');
            dialog.classList.remove('animate__slideInLeft');
        }

        setTimeout(() => {
            this.modal.classList.add('hidden');
            this.modal.classList.remove('flex');
            this.isOpen = false;
            document.body.classList.remove('overflow-hidden');

            document.removeEventListener('click', this.handleOutsideClick);
            document.removeEventListener('keydown', this.handleEscapeKey);
        }, 300);

        return this;
    }

    setSize(size) {
        if (!this.modal) return this;

        const modalContent = this.modal.querySelector('.custom-modal-dialog');
        if (!modalContent) return this;

        Object.values(this.sizeClasses).forEach(cls => {
            modalContent.classList.remove(...cls.split(' '));
        });

        if (this.sizeClasses[size]) {
            modalContent.classList.add(...this.sizeClasses[size].split(' '));
        }

        return this;
    }

    handleOutsideClick(event) {
        if (this.options.bgClose && event.target === this.modal) {
            this.hide();
        }
    }

    handleEscapeKey(event) {
        if (this.options.keyboard && event.key === 'Escape' && this.isOpen) {
            this.hide();
        }
    }
}
} // end if guard