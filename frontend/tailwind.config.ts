import type { Config } from 'tailwindcss';

/**
 * Colours are CSS variables rather than literals so the whole app can switch between
 * dark, light and whatever the phone is set to, without every component knowing.
 * The channel triplets live in index.css; the `<alpha-value>` form keeps Tailwind's
 * opacity modifiers (`bg-surface/60`) working.
 */
const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('--c-bg'),
        surface: v('--c-surface'),
        surface2: v('--c-surface2'),
        border: v('--c-border'),
        /** Primary text. Near-white in the dark theme, near-black in the light one. */
        ink: v('--c-ink'),
        muted: v('--c-muted'),

        accent: {
          DEFAULT: '#f97316',
          hover: '#ea6c0d',
          /**
           * Text and icons that sit ON the orange.
           *
           * White on #f97316 measures 2.8:1 — under the 3:1 floor and hard to read on a
           * handlebar in daylight. Near-black is about 7:1 on the same orange.
           */
          ink: '#140b02',
        },
        primary: { DEFAULT: '#3b82f6', hover: '#2563eb' },
        danger: '#ef4444',
        success: '#22c55e',
        warning: '#eab308',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: { xl: '12px', '2xl': '16px' },
      screens: {
        xs: '380px',
        /** A phone held sideways: wide but very short. */
        short: { raw: '(max-height: 500px)' },
      },
    },
  },
  plugins: [],
} satisfies Config;
