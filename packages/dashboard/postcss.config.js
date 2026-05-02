// PostCSS pipeline: Tailwind + Autoprefixer.
//
// Autoprefixer is conservative — the dashboard targets evergreen
// browsers (last 2 versions, not dead, > 0.5%); we don't pay for
// IE11 prefixes.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
