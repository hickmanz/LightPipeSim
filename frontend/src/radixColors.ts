/**
 * Radix Colors — 12-step color scales for the CAD Review design system.
 *
 * Each scale provides 12 semantic steps:
 *   1-2   App / subtle backgrounds
 *   3-5   Component backgrounds (normal, hover, active)
 *   6-8   Borders and separators (subtle → strong)
 *   9-10  Solid colored backgrounds
 *   11-12 Text (low-contrast, high-contrast)
 *
 * Values sourced from @radix-ui/colors v3.
 * "Charcoal" is a custom warm neutral using OKLCH.
 * "Axon Yellow" is a custom accent using OKLCH (based on RGB 255 215 0).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Accent (chromatic) scale names */
export type AccentScaleName =
  | "indigo"
  | "cyan"
  | "violet"
  | "pink"
  | "crimson"
  | "red"
  | "orange"
  | "axonyellow"
  | "teal"
  | "green";

/** Neutral (gray-ish) scale names */
export type NeutralScaleName =
  | "slate"
  | "gray"
  | "mauve"
  | "sage"
  | "olive"
  | "sand"
  | "charcoal";

/** 12-step values keyed 1–12 */
export type TwelveSteps = Record<
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
  string
>;

export interface ColorScale {
  label: string;
  light: TwelveSteps;
  dark: TwelveSteps;
}

// ---------------------------------------------------------------------------
// Accent scales
// ---------------------------------------------------------------------------

export const ACCENT_SCALES: Record<AccentScaleName, ColorScale> = {
  indigo: {
    label: "Indigo",
    light: {
      1: "#fdfdfe",
      2: "#f7f9ff",
      3: "#edf2fe",
      4: "#e1e9ff",
      5: "#d2deff",
      6: "#c1d0ff",
      7: "#abbdf9",
      8: "#8da4ef",
      9: "#3e63dd",
      10: "#3358d4",
      11: "#3a5bc7",
      12: "#1f2d5c",
    },
    dark: {
      1: "#11131f",
      2: "#141726",
      3: "#182449",
      4: "#1d2e62",
      5: "#253974",
      6: "#304384",
      7: "#3a4f97",
      8: "#435db1",
      9: "#3e63dd",
      10: "#5472e4",
      11: "#9eb1ff",
      12: "#d6e1ff",
    },
  },
  violet: {
    label: "Violet",
    light: {
      1: "#fdfcfe",
      2: "#faf8ff",
      3: "#f4f0fe",
      4: "#ebe4ff",
      5: "#e1d9ff",
      6: "#d4cafe",
      7: "#c2b5f5",
      8: "#aa99ec",
      9: "#6e56cf",
      10: "#654dc4",
      11: "#6550b9",
      12: "#2f265f",
    },
    dark: {
      1: "#14121f",
      2: "#1b1525",
      3: "#291f43",
      4: "#33255b",
      5: "#3c2e69",
      6: "#473876",
      7: "#56468b",
      8: "#6958ad",
      9: "#6e56cf",
      10: "#7d66d9",
      11: "#baa7ff",
      12: "#e2ddfe",
    },
  },
  pink: {
    label: "Pink",
    light: {
      1: "#fffcfe",
      2: "#fef7fb",
      3: "#fee9f5",
      4: "#fbdcef",
      5: "#f6cee7",
      6: "#efbfdd",
      7: "#e7acd0",
      8: "#dd93c2",
      9: "#d6409f",
      10: "#cf3897",
      11: "#c2298a",
      12: "#651249",
    },
    dark: {
      1: "#191117",
      2: "#21121d",
      3: "#37172f",
      4: "#4b143d",
      5: "#591c47",
      6: "#692955",
      7: "#833869",
      8: "#a84885",
      9: "#d6409f",
      10: "#de51a8",
      11: "#ff8dcc",
      12: "#fdd1ea",
    },
  },
  crimson: {
    label: "Crimson",
    light: {
      1: "#fffcfd",
      2: "#fef7f9",
      3: "#ffe9f0",
      4: "#fedce7",
      5: "#facedd",
      6: "#f3bed1",
      7: "#eaacc3",
      8: "#e093b2",
      9: "#e93d82",
      10: "#df3478",
      11: "#cb1d63",
      12: "#621639",
    },
    dark: {
      1: "#191114",
      2: "#201318",
      3: "#381525",
      4: "#4d122f",
      5: "#5c1839",
      6: "#6d2545",
      7: "#873356",
      8: "#b0436e",
      9: "#e93d82",
      10: "#ee518a",
      11: "#ff92ad",
      12: "#fdd3e8",
    },
  },
  red: {
    label: "Red",
    light: {
      1: "#fffcfc",
      2: "#fff7f7",
      3: "#feebec",
      4: "#ffdbdc",
      5: "#ffcdce",
      6: "#fdbdbe",
      7: "#f4a9aa",
      8: "#eb8e90",
      9: "#e5484d",
      10: "#dc3e42",
      11: "#ce2c31",
      12: "#641723",
    },
    dark: {
      1: "#191111",
      2: "#201314",
      3: "#3b1219",
      4: "#500f1c",
      5: "#611623",
      6: "#72232d",
      7: "#8c333a",
      8: "#b54548",
      9: "#e5484d",
      10: "#ec5d5e",
      11: "#ff9592",
      12: "#ffd1d9",
    },
  },
  orange: {
    label: "Orange",
    light: {
      1: "#fefcfb",
      2: "#fff7ed",
      3: "#ffefd6",
      4: "#ffdfb5",
      5: "#ffd19a",
      6: "#ffc182",
      7: "#f5ae73",
      8: "#ec9455",
      9: "#f76b15",
      10: "#ef5f00",
      11: "#cc4e00",
      12: "#582d1d",
    },
    dark: {
      1: "#17120e",
      2: "#1e160f",
      3: "#331e0b",
      4: "#462100",
      5: "#562800",
      6: "#66350c",
      7: "#7e451d",
      8: "#a35829",
      9: "#f76b15",
      10: "#ff801f",
      11: "#ffa057",
      12: "#ffe0c2",
    },
  },
  axonyellow: {
    label: "Axon Yellow",
    light: {
      1: "oklch(0.995 0.012 95)",
      2: "oklch(0.980 0.028 95)",
      3: "oklch(0.955 0.058 95)",
      4: "oklch(0.930 0.085 95)",
      5: "oklch(0.905 0.110 95)",
      6: "oklch(0.870 0.125 95)",
      7: "oklch(0.830 0.140 95)",
      8: "oklch(0.790 0.155 95)",
      9: "oklch(0.895 0.193 95)",
      10: "oklch(0.860 0.185 95)",
      11: "oklch(0.530 0.130 95)",
      12: "oklch(0.340 0.080 95)",
    },
    dark: {
      1: "oklch(0.155 0.015 95)",
      2: "oklch(0.190 0.025 95)",
      3: "oklch(0.245 0.050 95)",
      4: "oklch(0.295 0.068 95)",
      5: "oklch(0.345 0.082 95)",
      6: "oklch(0.405 0.098 95)",
      7: "oklch(0.475 0.115 95)",
      8: "oklch(0.555 0.140 95)",
      9: "oklch(0.895 0.193 95)",
      10: "oklch(0.920 0.175 95)",
      11: "oklch(0.845 0.150 95)",
      12: "oklch(0.940 0.070 95)",
    },
  },
  teal: {
    label: "Teal",
    light: {
      1: "#fafefd",
      2: "#f3fbf9",
      3: "#e0f8f3",
      4: "#ccf3ea",
      5: "#b8eae0",
      6: "#a1ded2",
      7: "#83cdc1",
      8: "#53b9ab",
      9: "#12a594",
      10: "#0d9b8a",
      11: "#008573",
      12: "#0d3d38",
    },
    dark: {
      1: "#0d1514",
      2: "#111c1b",
      3: "#0d2d2a",
      4: "#023b37",
      5: "#084843",
      6: "#145750",
      7: "#1c6961",
      8: "#207e73",
      9: "#12a594",
      10: "#0eb39e",
      11: "#0bd8b6",
      12: "#adf0dd",
    },
  },
  cyan: {
    label: "Cyan",
    light: {
      1: "#fafdfe",
      2: "#f2fafb",
      3: "#def7f9",
      4: "#caf1f6",
      5: "#b5e9f0",
      6: "#9ddde7",
      7: "#7dcedc",
      8: "#3db9cf",
      9: "#00a2c7",
      10: "#0797b9",
      11: "#107d98",
      12: "#0d3c48",
    },
    dark: {
      1: "#0b161a",
      2: "#101b20",
      3: "#082c36",
      4: "#003848",
      5: "#004558",
      6: "#045468",
      7: "#12677e",
      8: "#11809c",
      9: "#00a2c7",
      10: "#23afd0",
      11: "#4ccce6",
      12: "#b6ecf7",
    },
  },
  green: {
    label: "Green",
    light: {
      1: "#fbfefc",
      2: "#f4fbf6",
      3: "#e6f6eb",
      4: "#d6f1df",
      5: "#c4e8d1",
      6: "#adddc0",
      7: "#8eceaa",
      8: "#5bb98b",
      9: "#30a46c",
      10: "#2b9a66",
      11: "#218358",
      12: "#193b2d",
    },
    dark: {
      1: "#0e1512",
      2: "#121b17",
      3: "#132d21",
      4: "#113b29",
      5: "#174933",
      6: "#20573e",
      7: "#28684a",
      8: "#2f7c57",
      9: "#30a46c",
      10: "#33b074",
      11: "#3dd68c",
      12: "#b1f1cb",
    },
  },
};

// ---------------------------------------------------------------------------
// Neutral scales
// ---------------------------------------------------------------------------

export const NEUTRAL_SCALES: Record<NeutralScaleName, ColorScale> = {
  slate: {
    label: "Slate",
    light: {
      1: "#fcfcfd",
      2: "#f9f9fb",
      3: "#f0f0f3",
      4: "#e8e8ec",
      5: "#e0e1e6",
      6: "#d9d9e0",
      7: "#cdced6",
      8: "#b9bbc6",
      9: "#8b8d98",
      10: "#80838d",
      11: "#60646c",
      12: "#1c2024",
    },
    dark: {
      1: "#111113",
      2: "#18191b",
      3: "#212225",
      4: "#272a2d",
      5: "#2e3135",
      6: "#363a3f",
      7: "#43484e",
      8: "#5a6169",
      9: "#696e77",
      10: "#777b84",
      11: "#b0b4ba",
      12: "#edeef0",
    },
  },
  gray: {
    label: "Gray",
    light: {
      1: "#fcfcfc",
      2: "#f9f9f9",
      3: "#f0f0f0",
      4: "#e8e8e8",
      5: "#e0e0e0",
      6: "#d9d9d9",
      7: "#cecece",
      8: "#bbbbbb",
      9: "#8d8d8d",
      10: "#838383",
      11: "#646464",
      12: "#202020",
    },
    dark: {
      1: "#111111",
      2: "#191919",
      3: "#222222",
      4: "#2a2a2a",
      5: "#313131",
      6: "#3a3a3a",
      7: "#484848",
      8: "#606060",
      9: "#6e6e6e",
      10: "#7b7b7b",
      11: "#b4b4b4",
      12: "#eeeeee",
    },
  },
  mauve: {
    label: "Mauve",
    light: {
      1: "#fdfcfd",
      2: "#faf9fb",
      3: "#f2eff3",
      4: "#eae7ec",
      5: "#e3dfe6",
      6: "#dbd8e0",
      7: "#d0cdd7",
      8: "#bcbac7",
      9: "#8e8c99",
      10: "#84828e",
      11: "#65636d",
      12: "#211f26",
    },
    dark: {
      1: "#121113",
      2: "#1a191b",
      3: "#232225",
      4: "#2b292d",
      5: "#323035",
      6: "#3c393f",
      7: "#49474e",
      8: "#625f69",
      9: "#6f6d78",
      10: "#7c7a85",
      11: "#b5b2bc",
      12: "#eeeef0",
    },
  },
  sage: {
    label: "Sage",
    light: {
      1: "#fbfdfc",
      2: "#f7f9f8",
      3: "#eef1f0",
      4: "#e6e9e8",
      5: "#dfe2e0",
      6: "#d7dad9",
      7: "#cbcfcd",
      8: "#b8bcba",
      9: "#868e8b",
      10: "#7c8481",
      11: "#5f6563",
      12: "#1a211e",
    },
    dark: {
      1: "#101211",
      2: "#171918",
      3: "#202221",
      4: "#272a29",
      5: "#2e3130",
      6: "#373b39",
      7: "#444947",
      8: "#5b625f",
      9: "#63706b",
      10: "#717d79",
      11: "#adb5b2",
      12: "#eceeed",
    },
  },
  olive: {
    label: "Olive",
    light: {
      1: "#fcfdfc",
      2: "#f8faf8",
      3: "#eff1ef",
      4: "#e7e9e7",
      5: "#dfe2df",
      6: "#d7dad7",
      7: "#cccfcc",
      8: "#b9bcb8",
      9: "#898e87",
      10: "#7f847d",
      11: "#60655f",
      12: "#1d211c",
    },
    dark: {
      1: "#111210",
      2: "#181917",
      3: "#212220",
      4: "#282a27",
      5: "#2f312e",
      6: "#383a36",
      7: "#454843",
      8: "#5c625b",
      9: "#687066",
      10: "#767d74",
      11: "#afb5ad",
      12: "#eceeec",
    },
  },
  sand: {
    label: "Sand",
    light: {
      1: "#fdfdfc",
      2: "#f9f9f8",
      3: "#f1f0ef",
      4: "#e9e8e6",
      5: "#e2e1de",
      6: "#dad9d6",
      7: "#cfceca",
      8: "#bcbbb5",
      9: "#8d8d86",
      10: "#82827c",
      11: "#63635e",
      12: "#21201c",
    },
    dark: {
      1: "#111110",
      2: "#191918",
      3: "#222221",
      4: "#2a2a28",
      5: "#31312e",
      6: "#3b3a37",
      7: "#494844",
      8: "#62605b",
      9: "#6f6d66",
      10: "#7c7b74",
      11: "#b5b3ad",
      12: "#eeeeec",
    },
  },
  charcoal: {
    label: "Charcoal",
    light: {
      1: "oklch(0.985 0.005 270)",
      2: "oklch(0.965 0.006 270)",
      3: "oklch(0.925 0.008 270)",
      4: "oklch(0.870 0.010 270)",
      5: "oklch(0.800 0.010 270)",
      6: "oklch(0.700 0.012 270)",
      7: "oklch(0.560 0.012 270)",
      8: "oklch(0.450 0.012 270)",
      9: "oklch(0.350 0.010 270)",
      10: "oklch(0.280 0.008 270)",
      11: "oklch(0.220 0.006 270)",
      12: "oklch(0.160 0.005 270)",
    },
    dark: {
      1: "oklch(0.175 0.005 270)",
      2: "oklch(0.210 0.006 270)",
      3: "oklch(0.260 0.008 270)",
      4: "oklch(0.310 0.010 270)",
      5: "oklch(0.360 0.010 270)",
      6: "oklch(0.420 0.012 270)",
      7: "oklch(0.500 0.012 270)",
      8: "oklch(0.580 0.012 270)",
      9: "oklch(0.650 0.010 270)",
      10: "oklch(0.720 0.008 270)",
      11: "oklch(0.820 0.006 270)",
      12: "oklch(0.905 0.005 270)",
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const ACCENT_SCALE_NAMES = Object.keys(
  ACCENT_SCALES,
) as AccentScaleName[];
export const NEUTRAL_SCALE_NAMES = Object.keys(
  NEUTRAL_SCALES,
) as NeutralScaleName[];

export const VALID_ACCENT_SCALES = ACCENT_SCALE_NAMES;
export const VALID_NEUTRAL_SCALES = NEUTRAL_SCALE_NAMES;
