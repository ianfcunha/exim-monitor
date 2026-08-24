import tailwindcssAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta AVILI
        avili: {
          sky:   '#E4572E',
          cyan:  '#F2946B',
          night: '#16233D',
          navy:  '#1B2A48',
          deep:  '#0F1830',
        },
        // Paleta de severidade
        severity: {
          ok:       '#1E7355',
          low:      '#E4572E',
          medium:   '#B0731A',
          high:     '#C2410C',
          critical: '#A81E14',
        },
        // Tokens semânticos — consomem as CSS variables de index.css
        // (:root = tema claro, .dark = tema escuro). Usados pelos
        // primitivos em components/ui e components/primitives.
        border:   'var(--border)',
        input:    'var(--border)',
        ring:     'var(--sky)',
        surface:  'var(--surface)',
        card: {
          DEFAULT:    'var(--card)',
          foreground: 'var(--text)',
        },
        popover: {
          DEFAULT:    'var(--card)',
          foreground: 'var(--text)',
        },
        foreground: 'var(--text)',
        muted: {
          DEFAULT:    'var(--muted)',
          foreground: 'var(--muted)',
        },
        dim: 'var(--dim)',
        primary: {
          DEFAULT:    'var(--sky)',
          dark:       'var(--sky-dark)',
          foreground: '#FFFFFF',
        },
        accent: {
          DEFAULT:    'var(--accent-bg)',
          foreground: 'var(--accent-fg)',
        },
        destructive: {
          DEFAULT:    'var(--danger)',
          bg:         'var(--danger-bg)',
          border:     'var(--danger-border)',
          foreground: 'var(--danger)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      backdropBlur: {
        xs: '4px',
        '2xl': '40px',
      },
      boxShadow: {
        'glow-sky':  '0 0 20px rgba(228,87,46,0.20)',
        'glow-cyan': '0 0 16px rgba(242,148,107,0.18)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up':   { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up':   'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
