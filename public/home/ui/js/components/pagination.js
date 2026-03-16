class Pagination {
    /**
     * @param {string} apiEndpoint - URL to fetch data (e.g., '/api/transactions')
     * @param {string} tableBodyId - ID of the <tbody> to render rows into
     * @param {function} renderRowCallback - Function that returns HTML for a single row
     * @param {object} options - Optional settings (limit, etc.)
     */
    constructor(apiEndpoint, tableBodyId, renderRowCallback, options = {}) {
        this.apiEndpoint = apiEndpoint;
        this.tableBody = document.getElementById(tableBodyId);
        this.renderRow = renderRowCallback;
        
        // Settings
        this.currentPage = 1;
        this.limit = options.limit || 5;
        this.loadingText = options.loadingText || 'Loading...';
        this.emptyText = options.emptyText || 'No records found';

        // UI Elements (Using standard IDs you provided)
        this.elStart = document.getElementById('pg-start');
        this.elEnd = document.getElementById('pg-end');
        this.elTotal = document.getElementById('pg-total');
        this.btnPrev = document.getElementById('btn-prev');
        this.btnNext = document.getElementById('btn-next');

        // Bind Events
        if(this.btnPrev) this.btnPrev.onclick = () => this.changePage(-1);
        if(this.btnNext) this.btnNext.onclick = () => this.changePage(1);

        // Initial Load
        this.load(1);
    }

    async load(page) {
        if (!this.tableBody) return;
        
        // 1. UI Loading State
        this.tableBody.style.opacity = '0.5';
        this.tableBody.style.pointerEvents = 'none';

        try {
            // 2. Fetch Data
            const response = await fetch(`${this.apiEndpoint}?page=${page}&limit=${this.limit}`);
            const result = await response.json();

            if (result.status === 200 || result.status === 'success') {
                this.currentPage = page;
                this.render(result.data);
                this.updateControls(result.meta);
            } else {
                console.error('API Error:', result);
            }
        } catch (err) {
            console.error('Pagination Fetch Error:', err);
            this.tableBody.innerHTML = `<tr><td colspan="100%" class="text-center py-6 text-red-400">Failed to load data</td></tr>`;
        } finally {
            // 3. Restore UI
            this.tableBody.style.opacity = '1';
            this.tableBody.style.pointerEvents = 'auto';
        }
    }

    render(items) {
        this.tableBody.innerHTML = ''; // Clear

        if (!items || items.length === 0) {
            this.tableBody.innerHTML = `<tr><td colspan="100%" class="text-center py-8 text-slate-400 text-xs">${this.emptyText}</td></tr>`;
            return;
        }

        // Loop through items and use the User's callback to create HTML
        const rowsHtml = items.map(item => this.renderRow(item)).join('');
        this.tableBody.innerHTML = rowsHtml;
    }

    updateControls(meta) {
        const { current_page, per_page, total_results, total_pages } = meta;

        // Math: Showing X to Y
        const start = total_results === 0 ? 0 : ((current_page - 1) * per_page) + 1;
        const end = Math.min(current_page * per_page, total_results);

        // Update Text
        if(this.elStart) this.elStart.innerText = start;
        if(this.elEnd) this.elEnd.innerText = end;
        if(this.elTotal) this.elTotal.innerText = total_results;

        // Update Buttons
        if(this.btnPrev) {
            this.btnPrev.disabled = current_page <= 1;
            this.btnPrev.classList.toggle('opacity-50', current_page <= 1);
            this.btnPrev.classList.toggle('cursor-not-allowed', current_page <= 1);
        }
        
        if(this.btnNext) {
            this.btnNext.disabled = current_page >= total_pages;
            this.btnNext.classList.toggle('opacity-50', current_page >= total_pages);
            this.btnNext.classList.toggle('cursor-not-allowed', current_page >= total_pages);
        }
    }

    changePage(direction) {
        this.load(this.currentPage + direction);
    }
}