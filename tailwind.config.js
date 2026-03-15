/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        './src/**/*.ejs',
        './src/views/**/*.ejs',
        './**/*.js',
        './public/home/ui/**/*.js',
        './public/home/ui/**/*.html'
    ],
    safelist: [
        'sidebar-open-mobile',
        'sidebar-closed-mobile',
        'ease-smooth-glide',
        'dropdown-enter',
        'dropdown-active',
        'transition-card',
        'rotate-90',
        'hidden',
        { pattern: /^(md|sm|lg):/ },
        { pattern: /^(hover|group-hover|focus|active):/ }
    ],
    theme: {
        extend: {
            fontFamily: { sans: ['Inter', 'sans-serif'] },
            colors: {
                brandBlack: '#0a0a0a',
                brandGray: '#f4f4f5',
                brandDarkGray: '#27272a'
            }
        }
    },
    
    plugins: [],
};