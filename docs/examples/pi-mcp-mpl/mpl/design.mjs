// Reusable restrained light defaults for clear, editorial technical charts.
// Plain rc values: pass as `subplots({ rc: cleanLight })` and override only what the data needs.
export const cleanLight = Object.freeze({
  "font.family": "Inter",
  "font.size": 10,
  "figure.facecolor": "#FAF9F6",
  "axes.facecolor": "#FAF9F6",
  "savefig.facecolor": "#FAF9F6",
  "text.color": "#171714",
  "axes.labelcolor": "#696761",
  "axes.edgecolor": "#FAF9F6",
  "axes.linewidth": 0,
  "axes.spines.left": false,
  "axes.spines.bottom": false,
  "axes.spines.top": false,
  "axes.spines.right": false,
  "axes.grid": true,
  "axes.grid.axis": "y",
  "axes.axisbelow": true,
  "grid.color": "#DEDCD5",
  "grid.linewidth": 0.55,
  "grid.linestyle": "-",
  "xtick.major.size": 0,
  "ytick.major.size": 0,
  "xtick.major.pad": 9,
  "ytick.major.pad": 11,
  "xtick.labelsize": 9,
  "ytick.labelsize": 9,
  "xtick.color": "#FAF9F6",
  "ytick.color": "#FAF9F6",
  "xtick.labelcolor": "#77746D",
  "ytick.labelcolor": "#77746D",
  "lines.linewidth": 2,
  "lines.solid_capstyle": "round",
  "lines.solid_joinstyle": "round",
  "lines.markersize": 6,
  "lines.markeredgewidth": 1.5,
  "lines.markeredgecolor": "#FAF9F6",
  "axes.xmargin": 0.015,
  "axes.ymargin": 0.06,
  "figure.subplot.left": 0.12,
  "figure.subplot.right": 0.94,
  "figure.subplot.bottom": 0.18,
  "figure.subplot.top": 0.6,
})

export const cleanLightColors = Object.freeze({
  ink: "#171714",
  secondary: "#696761",
  muted: "#8A877F",
  accent: "#D85B24",
  surface: "#FAF9F6",
})

/**
 * Add an unclipped title, eyebrow, up to three top-line stats, and a quiet footer.
 * The cleanLight subplot margins reserve the space. Stats are
 * `{ label, value }`; footer text stays outside the plotting region.
 */
export function addEditorialFrame(ax, { eyebrow, title, stats = [], footer = "" }) {
  const t = ax.transAxes
  ax.text(0, 1.55, eyebrow, {
    transform: t,
    color: cleanLightColors.secondary,
    fontsize: 8.5,
    fontweight: 600,
    ha: "left",
    va: "top",
  })
  ax.text(0, 1.43, title, {
    transform: t,
    color: cleanLightColors.ink,
    fontsize: 26,
    fontweight: 600,
    ha: "left",
    va: "top",
  })

  const positions = stats.length <= 1 ? [0] : stats.length === 2 ? [0, 0.5] : [0, 0.34, 0.68]
  stats.slice(0, 3).forEach((stat, index) => {
    const x = positions[index]
    ax.text(x, 1.19, stat.label, {
      transform: t,
      color: cleanLightColors.muted,
      fontsize: 7.5,
      fontweight: 600,
      ha: "left",
      va: "top",
    })
    ax.text(x, 1.1, stat.value, {
      transform: t,
      color: cleanLightColors.ink,
      fontsize: 14,
      fontweight: 500,
      ha: "left",
      va: "top",
    })
  })

  if (footer) {
    ax.text(0, -0.27, footer, {
      transform: t,
      color: cleanLightColors.muted,
      fontsize: 7.5,
      ha: "left",
      va: "bottom",
    })
  }
  return ax
}
