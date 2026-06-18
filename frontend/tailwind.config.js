/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0f1117',
        card: '#1a1d27',
        border: '#2a2d3a',
        accent: '#6366f1',
        'accent-hover': '#818cf8',
        up: '#22c55e',
        down: '#ef4444',
        warn: '#f59e0b'
      },
      fontFamily: {
        sans: ['Pretendard', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace']
      }
    }
  },
  plugins: []
};
