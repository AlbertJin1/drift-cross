/** Tailwind utilities for Drift's local, offline-first Electron chrome. */
module.exports = {
  content: ['./ui/**/*.html', './ui/**/*.js'],
  theme: {
    extend: {
      colors: {
        drift: {
          ink: '#11131b',
          panel: '#202535',
          violet: '#8064f4',
          cyan: '#61e3dc'
        }
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif']
      }
    }
  },
  plugins: []
};
