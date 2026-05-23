/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta AVILI
        avili: {
          sky:   '#0EA5E9',
          cyan:  '#22D3EE',
          night: '#080F1E',
          navy:  '#0F1A2E',
          deep:  '#061020',
        },
        // Paleta de severidade
        severity: {
          ok:       '#16a34a',
          low:      '#0EA5E9',
          medium:   '#d97706',
          high:     '#ea580c',
          critical: '#dc2626',
        },
      },
      backdropBlur: {
        xs: '4px',
        '2xl': '40px',
      },
      boxShadow: {
        'glow-sky':  '0 0 20px rgba(14,165,233,0.20)',
        'glow-cyan': '0 0 16px rgba(34,211,238,0.18)',
      },
    },
  },
  plugins: [],
}
